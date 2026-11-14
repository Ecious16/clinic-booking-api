'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { createPool, migrate } = require('../src/db');

const API_KEY = 'test-key';
const DB_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@localhost:5433/clinic';

let server;
let base;
let pool;

const DAY = 24 * 60 * 60 * 1000;
const future = (hours) => new Date(Date.now() + DAY + hours * 3600_000).toISOString();

function slot(id, startIso, provider = 'Dr Ade') {
  const start = new Date(startIso);
  return { id, provider, start: start.toISOString(), end: new Date(start.getTime() + 30 * 60_000).toISOString() };
}

async function api(method, path, { body, key = API_KEY, headers = {} } = {}) {
  const h = { ...headers };
  if (key !== null) h['X-API-Key'] = key;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(base + path, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}

async function reset(slots) {
  const r = await api('POST', '/reset', { body: { slots } });
  assert.equal(r.status, 200);
}

before(async () => {
  pool = createPool({ connectionString: DB_URL });
  await migrate(pool);
  const app = createApp({ pool, apiKey: API_KEY });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await pool.end();
});

beforeEach(async () => {
  await reset([
    slot('s1', future(0)),
    slot('s2', future(1)),
    slot('s3', future(2)),
    slot('s4', future(3), 'Dr Bola'),
  ]);
});

// ---- Level 1 ----

test('L1: lists slots earliest first with availability', async () => {
  const r = await api('GET', '/slots');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.slots.map((s) => s.id), ['s1', 's2', 's3', 's4']);
  assert.equal(r.body.slots[0].available, true);
  assert.equal(r.body.slots[0].provider, 'Dr Ade');
});

test('L1: filters slots by provider (exact match)', async () => {
  const r = await api('GET', '/slots?provider=Dr%20Bola');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.slots.map((s) => s.id), ['s4']);
});

test('L1: books a slot and returns 201 confirmed, then gets it back', async () => {
  const r = await api('POST', '/bookings', { body: { slot_id: 's1', name: 'Ada Obi', email: 'ada@example.com' } });
  assert.equal(r.status, 201);
  assert.equal(r.body.status, 'confirmed');
  assert.equal(r.body.slot_id, 's1');
  assert.ok(r.body.id);
  assert.ok(!Number.isNaN(Date.parse(r.body.created_at)));

  const g = await api('GET', `/bookings/${r.body.id}`);
  assert.equal(g.status, 200);
  assert.deepEqual(g.body, r.body);

  const slots = await api('GET', '/slots');
  assert.equal(slots.body.slots.find((s) => s.id === 's1').available, false);
});

test('L1: unknown booking id returns 404 with error body', async () => {
  const r = await api('GET', '/bookings/nope');
  assert.equal(r.status, 404);
  assert.equal(typeof r.body.error, 'string');
});

// ---- Level 2 ----

test('L2: missing or wrong API key returns 401', async () => {
  assert.equal((await api('GET', '/slots', { key: null })).status, 401);
  assert.equal((await api('GET', '/slots', { key: 'wrong' })).status, 401);
  assert.equal((await api('GET', '/slots', { key: 'test-key-longer' })).status, 401);
});

test('L2: rejects missing or empty fields with 400', async () => {
  const cases = [
    {},
    { name: 'Ada', email: 'ada@example.com' },
    { slot_id: 's1', email: 'ada@example.com' },
    { slot_id: 's1', name: 'Ada' },
    { slot_id: '', name: 'Ada', email: 'ada@example.com' },
    { slot_id: 's1', name: '   ', email: 'ada@example.com' },
    { slot_id: 's1', name: 'Ada', email: 'not-an-email' },
  ];
  for (const body of cases) {
    const r = await api('POST', '/bookings', { body });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(typeof r.body.error, 'string');
  }
});

test('L2: 404 for a slot that does not exist', async () => {
  const r = await api('POST', '/bookings', { body: { slot_id: 'missing', name: 'Ada', email: 'ada@example.com' } });
  assert.equal(r.status, 404);
  assert.equal(typeof r.body.error, 'string');
});

test('L2: 400 for a slot that has already started', async () => {
  await reset([slot('past', new Date(Date.now() - 3600_000).toISOString())]);
  const r = await api('POST', '/bookings', { body: { slot_id: 'past', name: 'Ada', email: 'ada@example.com' } });
  assert.equal(r.status, 400);
});

test('L2: trims name and email and lower-cases email', async () => {
  const r = await api('POST', '/bookings', { body: { slot_id: 's1', name: '  Ada Obi  ', email: '  ADA@Example.COM ' } });
  assert.equal(r.status, 201);
  assert.equal(r.body.name, 'Ada Obi');
  assert.equal(r.body.email, 'ada@example.com');
});

// ---- Level 3 ----

test('L3: second booking of the same slot returns 409', async () => {
  const first = await api('POST', '/bookings', { body: { slot_id: 's1', name: 'Ada', email: 'ada@example.com' } });
  assert.equal(first.status, 201);
  const second = await api('POST', '/bookings', { body: { slot_id: 's1', name: 'Chi', email: 'chi@example.com' } });
  assert.equal(second.status, 409);
});

test('L3: concurrent bookings of one slot yield exactly one 201', async () => {
  const attempts = Array.from({ length: 25 }, (_, i) =>
    api('POST', '/bookings', { body: { slot_id: 's2', name: `Person ${i}`, email: `p${i}@example.com` } })
  );
  const results = await Promise.all(attempts);
  const statuses = results.map((r) => r.status).sort();
  assert.equal(statuses.filter((s) => s === 201).length, 1, JSON.stringify(statuses));
  assert.equal(statuses.filter((s) => s === 409).length, 24, JSON.stringify(statuses));
});

test('L3: cancelling sets status cancelled and frees the slot', async () => {
  const b = await api('POST', '/bookings', { body: { slot_id: 's1', name: 'Ada', email: 'ada@example.com' } });
  const c = await api('DELETE', `/bookings/${b.body.id}`);
  assert.equal(c.status, 200);
  assert.equal(c.body.status, 'cancelled');

  const again = await api('DELETE', `/bookings/${b.body.id}`);
  assert.equal(again.status, 409);

  assert.equal((await api('DELETE', '/bookings/nope')).status, 404);

  const rebook = await api('POST', '/bookings', { body: { slot_id: 's1', name: 'Chi', email: 'chi@example.com' } });
  assert.equal(rebook.status, 201);
});

// ---- Level 4 ----

test('L4: same Idempotency-Key and body returns the same booking, no duplicate', async () => {
  const headers = { 'Idempotency-Key': 'key-1' };
  const body = { slot_id: 's1', name: 'Ada', email: 'ada@example.com' };
  const first = await api('POST', '/bookings', { body, headers });
  const second = await api('POST', '/bookings', { body, headers });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal(second.body.id, first.body.id);

  const list = await api('GET', '/bookings?email=ada@example.com');
  assert.equal(list.body.bookings.length, 1);
});

test('L4: same Idempotency-Key with a different body returns 422', async () => {
  const headers = { 'Idempotency-Key': 'key-2' };
  await api('POST', '/bookings', { body: { slot_id: 's1', name: 'Ada', email: 'ada@example.com' }, headers });
  const r = await api('POST', '/bookings', { body: { slot_id: 's2', name: 'Ada', email: 'ada@example.com' }, headers });
  assert.equal(r.status, 422);
});

test('L4: pages through a person\'s bookings with cursors, oldest first', async () => {
  for (const id of ['s1', 's2', 's3']) {
    const r = await api('POST', '/bookings', { body: { slot_id: id, name: 'Ada', email: 'ada@example.com' } });
    assert.equal(r.status, 201);
  }
  await api('POST', '/bookings', { body: { slot_id: 's4', name: 'Other', email: 'other@example.com' } });

  const p1 = await api('GET', '/bookings?email=ADA@example.com&limit=2');
  assert.equal(p1.status, 200);
  assert.equal(p1.body.bookings.length, 2);
  assert.ok(p1.body.next_cursor);

  const p2 = await api('GET', `/bookings?email=ada@example.com&limit=2&cursor=${encodeURIComponent(p1.body.next_cursor)}`);
  assert.equal(p2.body.bookings.length, 1);
  assert.equal(p2.body.next_cursor, null);

  const seen = [...p1.body.bookings, ...p2.body.bookings].map((b) => b.slot_id);
  assert.deepEqual(seen, ['s1', 's2', 's3']);
});

test('L4: invalid limit returns 400', async () => {
  for (const limit of ['0', '51', 'abc', '-1', '1.5']) {
    const r = await api('GET', `/bookings?email=ada@example.com&limit=${limit}`);
    assert.equal(r.status, 400, limit);
  }
  const ok = await api('GET', '/bookings?email=ada@example.com&limit=50');
  assert.equal(ok.status, 200);
});

test('L4: default page size is 10', async () => {
  const r = await api('GET', '/bookings?email=nobody@example.com');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { bookings: [], next_cursor: null });
});

// ---- Level 5 ----

test('L5: 6th attempt within a minute returns 429 with Retry-After; other emails unaffected', async () => {
  for (let i = 0; i < 5; i++) {
    const r = await api('POST', '/bookings', { body: { slot_id: 'missing', name: 'Spam', email: 'spam@example.com' } });
    assert.equal(r.status, 404, `attempt ${i + 1}`);
  }
  const blocked = await api('POST', '/bookings', { body: { slot_id: 's1', name: 'Spam', email: 'spam@example.com' } });
  assert.equal(blocked.status, 429);
  const retry = Number(blocked.headers.get('Retry-After'));
  assert.ok(Number.isInteger(retry) && retry >= 1 && retry <= 60, `Retry-After=${retry}`);

  const other = await api('POST', '/bookings', { body: { slot_id: 's1', name: 'Ada', email: 'ada@example.com' } });
  assert.equal(other.status, 201);
});