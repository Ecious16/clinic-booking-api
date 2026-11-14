'use strict';

const crypto = require('crypto');
const express = require('express');
const path = require('path');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RATE_LIMIT_MAX = 5; // attempts per email...
const RATE_LIMIT_WINDOW_MS = 60_000; // ...per minute
const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 50;

class ApiError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function parseDate(v) {
  if (typeof v !== 'string') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toSlot(row) {
  return {
    id: row.id,
    provider: row.provider,
    start: new Date(row.start_at).toISOString(),
    end: new Date(row.end_at).toISOString(),
  };
}

function toBooking(row) {
  return {
    id: row.id,
    slot_id: row.slot_id,
    name: row.name,
    email: row.email,
    status: row.status,
    created_at: new Date(row.created_at).toISOString(),
  };
}

function encodeCursor(row) {
  const payload = [new Date(row.created_at).toISOString(), row.id];
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function decodeCursor(cursor) {
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new ApiError(400, 'invalid cursor');
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[0] !== 'string' ||
    typeof parsed[1] !== 'string' ||
    Number.isNaN(Date.parse(parsed[0]))
  ) {
    throw new ApiError(400, 'invalid cursor');
  }
  return { createdAt: new Date(parsed[0]), id: parsed[1] };
}

function parseSlotForReset(s) {
  if (!isPlainObject(s)) throw new ApiError(400, 'each slot must be an object');
  if (!isNonEmptyString(s.id)) throw new ApiError(400, 'slot id is required');
  if (!isNonEmptyString(s.provider)) throw new ApiError(400, 'slot provider is required');
  const start = parseDate(s.start);
  const end = parseDate(s.end);
  if (!start || !end) throw new ApiError(400, 'slot start and end must be date-times');
  if (end <= start) throw new ApiError(400, 'slot end must be after start');
  return { id: s.id, provider: s.provider, start, end };
}

function apiKeyAuth(apiKey) {
  const expected = Buffer.from(apiKey);
  return (req, res, next) => {
    const given = Buffer.from(req.get('X-API-Key') || '');
    const ok = given.length === expected.length && crypto.timingSafeEqual(given, expected);
    if (!ok) return res.status(401).json({ error: 'missing or invalid API key' });
    next();
  };
}

// Runs fn inside a transaction. Any thrown error rolls back and is rethrown.
async function withTx(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Level 5 + Level 2 + Level 3 + Level 4 booking logic. Runs inside a transaction
// that the caller commits, so rate-limit attempts are recorded even when the
// request is rejected.
async function createBooking(client, body, idempotencyKey, now) {
  // Rate limit (level 5). Only applies when the email is well-formed enough to
  // key on. Every attempt counts, including ones that fail validation.
  const emailNorm = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (EMAIL_RE.test(emailNorm)) {
    // Serialise attempts per email so concurrent requests can't slip past the limit.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`email:${emailNorm}`]);
    const windowStart = new Date(now.getTime() - RATE_LIMIT_WINDOW_MS);
    const { rows } = await client.query(
      'SELECT at FROM booking_attempts WHERE email = $1 AND at > $2 ORDER BY at ASC',
      [emailNorm, windowStart]
    );
    if (rows.length >= RATE_LIMIT_MAX) {
      const retryMs = new Date(rows[0].at).getTime() + RATE_LIMIT_WINDOW_MS - now.getTime();
      throw new ApiError(429, 'too many booking attempts for this email', {
        'Retry-After': String(Math.max(1, Math.ceil(retryMs / 1000))),
      });
    }
    await client.query('INSERT INTO booking_attempts (email, at) VALUES ($1, $2)', [emailNorm, now]);
    await client.query('DELETE FROM booking_attempts WHERE email = $1 AND at <= $2', [
      emailNorm,
      windowStart,
    ]);
  }

  // Validation (level 2).
  if (!isNonEmptyString(body.slot_id)) throw new ApiError(400, 'slot_id is required');
  if (!isNonEmptyString(body.name)) throw new ApiError(400, 'name is required');
  if (!EMAIL_RE.test(emailNorm)) throw new ApiError(400, 'a valid email is required');
  const slotId = body.slot_id;
  const name = body.name.trim();

  // Idempotency (level 4).
  const bodyHash = crypto
    .createHash('sha256')
    .update(JSON.stringify([slotId, name, emailNorm]))
    .digest('hex');
  if (idempotencyKey !== undefined) {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`idem:${idempotencyKey}`]);
    const { rows } = await client.query(
      'SELECT body_hash, response FROM idempotency_keys WHERE key = $1',
      [idempotencyKey]
    );
    if (rows.length > 0) {
      if (rows[0].body_hash !== bodyHash) {
        throw new ApiError(422, 'Idempotency-Key was already used with a different request body');
      }
      return { status: 201, body: rows[0].response };
    }
  }

  // Slot checks (level 2). FOR UPDATE serialises competing bookings for this slot.
  const { rows: slotRows } = await client.query(
    'SELECT id, start_at FROM slots WHERE id = $1 FOR UPDATE',
    [slotId]
  );
  if (slotRows.length === 0) throw new ApiError(404, 'slot not found');
  if (new Date(slotRows[0].start_at) <= now) throw new ApiError(400, 'slot has already started');

  // Double-booking guard (level 3). The partial unique index is the backstop.
  const booking = {
    id: crypto.randomUUID(),
    slot_id: slotId,
    name,
    email: emailNorm,
    status: 'confirmed',
    created_at: now.toISOString(),
  };
  const insert = await client.query(
    `INSERT INTO bookings (id, slot_id, name, email, status, created_at)
     VALUES ($1, $2, $3, $4, 'confirmed', $5)
     ON CONFLICT (slot_id) WHERE status = 'confirmed' DO NOTHING`,
    [booking.id, booking.slot_id, booking.name, booking.email, now]
  );
  if (insert.rowCount === 0) throw new ApiError(409, 'slot already booked');

  if (idempotencyKey !== undefined) {
    await client.query(
      'INSERT INTO idempotency_keys (key, body_hash, response, created_at) VALUES ($1, $2, $3, $4)',
      [idempotencyKey, bodyHash, JSON.stringify(booking), now]
    );
  }
  return { status: 201, body: booking };
}

function createApp({ pool, apiKey }) {
  const app = express();
  const auth = apiKeyAuth(apiKey);

  app.use(express.json({ limit: '100kb' }));

  // CORS, so the web page can also be hosted elsewhere if needed.
  app.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, Idempotency-Key');
    res.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.set('Access-Control-Expose-Headers', 'Retry-After');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  // The web page. Static files only; the API lives under the paths below.
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // Reset (used by the checker to load slots). Level 1.
  app.post('/reset', auth, async (req, res) => {
    const slots = req.body && req.body.slots;
    if (!Array.isArray(slots)) throw new ApiError(400, 'slots must be an array');
    const parsed = slots.map(parseSlotForReset);
const ids = new Set(parsed.map((s) => s.id));
    if (ids.size !== parsed.length) throw new ApiError(400, 'slot ids must be unique');

    await withTx(pool, async (client) => {
      await client.query('DELETE FROM bookings');
      await client.query('DELETE FROM slots');
      await client.query('DELETE FROM idempotency_keys');
      await client.query('DELETE FROM booking_attempts');
      for (const s of parsed) {
        await client.query(
          'INSERT INTO slots (id, provider, start_at, end_at) VALUES ($1, $2, $3, $4)',
          [s.id, s.provider, s.start, s.end]
        );
      }
    });
    res.json({ ok: true });
  });

  // List slots. Level 1.
  app.get('/slots', auth, async (req, res) => {
    const { provider } = req.query;
    if (provider !== undefined && typeof provider !== 'string') {
      throw new ApiError(400, 'provider must be a string');
    }
    const params = [];
    let where = '';
    if (provider !== undefined) {
      params.push(provider);
      where = 'WHERE s.provider = $1';
    }
    const { rows } = await pool.query(
      `SELECT s.id, s.provider, s.start_at, s.end_at,
              NOT EXISTS (
                SELECT 1 FROM bookings b
                WHERE b.slot_id = s.id AND b.status = 'confirmed'
              ) AS available
       FROM slots s
       ${where}
       ORDER BY s.start_at ASC, s.id ASC`,
      params
    );
    res.json({
      slots: rows.map((r) => ({ ...toSlot(r), available: r.available })),
    });
  });

  // Book a slot. Levels 1-5.
  app.post('/bookings', auth, async (req, res) => {
    const body = isPlainObject(req.body) ? req.body : {};
    const idempotencyKey = req.get('Idempotency-Key');
    if (idempotencyKey !== undefined && !isNonEmptyString(idempotencyKey)) {
      throw new ApiError(400, 'Idempotency-Key must not be empty');
    }

    const now = new Date();
    const client = await pool.connect();
    let outcome;
    try {
      await client.query('BEGIN');
      try {
        outcome = { ok: true, ...(await createBooking(client, body, idempotencyKey, now)) };
      } catch (err) {
        if (!(err instanceof ApiError)) throw err;
        outcome = { ok: false, err };
      }
      // Commit even on client errors: the only write those paths make is the
      // rate-limit attempt record, which must persist.
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    if (!outcome.ok) {
      res.set(outcome.err.headers);
      return res.status(outcome.err.status).json({ error: outcome.err.message });
    }
    res.status(outcome.status).json(outcome.body);
  });

  // List a person's bookings, oldest first, cursor-paginated. Level 4.
  app.get('/bookings', auth, async (req, res) => {
    const { email, limit: limitParam, cursor } = req.query;
    if (!isNonEmptyString(email)) throw new ApiError(400, 'email is required');

    let limit = DEFAULT_PAGE_SIZE;
    if (limitParam !== undefined) {
      const n = typeof limitParam === 'string' && /^\d+$/.test(limitParam) ? Number(limitParam) : NaN;
      if (!(n >= 1 && n <= MAX_PAGE_SIZE)) {
        throw new ApiError(400, `limit must be an integer from 1 to ${MAX_PAGE_SIZE}`);
      }
      limit = n;
    }

    const params = [email.trim().toLowerCase()];
    let cursorClause = '';
    if (cursor !== undefined) {
      if (typeof cursor !== 'string') throw new ApiError(400, 'invalid cursor');
      const c = decodeCursor(cursor);
      params.push(c.createdAt, c.id);
      cursorClause = 'AND (created_at, id) > ($2, $3)';
    }
    params.push(limit + 1);

    const { rows } = await pool.query(
      `SELECT id, slot_id, name, email, status, created_at
       FROM bookings
       WHERE email = $1 ${cursorClause}
       ORDER BY created_at ASC, id ASC
       LIMIT $${params.length}`,
      params
    );

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    res.json({
      bookings: page.map(toBooking),
      next_cursor: hasMore ? encodeCursor(page[page.length - 1]) : null,
    });
  });

  // Get a booking. Level 1.
  app.get('/bookings/:id', auth, async (req, res) => {
    const { rows } = await pool.query(
      'SELECT id, slot_id, name, email, status, created_at FROM bookings WHERE id = $1',
      [req.params.id]
    );
    if (rows.length === 0) throw new ApiError(404, 'booking not found');
    res.json(toBooking(rows[0]));
  });

  // Cancel a booking. Level 3.
  app.delete('/bookings/:id', auth, async (req, res) => {
    const booking = await withTx(pool, async (client) => {
      const { rows } = await client.query(
        'SELECT id, slot_id, name, email, status, created_at FROM bookings WHERE id = $1 FOR UPDATE',
        [req.params.id]
      );
      if (rows.length === 0) throw new ApiError(404, 'booking not found');
      if (rows[0].status === 'cancelled') throw new ApiError(409, 'booking already cancelled');
      const updated = await client.query(
        `UPDATE bookings SET status = 'cancelled' WHERE id = $1
         RETURNING id, slot_id, name, email, status, created_at`,
        [req.params.id]
      );
      return updated.rows[0];
    });
    res.json(toBooking(booking));
  });

  app.use((req, res) => {
    res.status(404).json({ error: 'not found' });
  });

  // Error handler. ApiError carries its own status and headers.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof ApiError) {
      res.set(err.headers);
      return res.status(err.status).json({ error: err.message });
    }
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'request body must be valid JSON' });
    }
    if (err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'request body too large' });
    }
    console.error(err);
    res.status(500).json({ error: 'internal server error' });
  });

  return app;
}

module.exports = { createApp, ApiError };