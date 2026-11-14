'use strict';

const { Pool } = require('pg');

// Schema is idempotent (IF NOT EXISTS) so it is safe to run on every boot.
// The partial unique index is the database-level guarantee that a slot can
// hold at most one confirmed booking, even under concurrent requests.
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS slots (
  id        TEXT PRIMARY KEY,
  provider  TEXT NOT NULL,
  start_at  TIMESTAMPTZ NOT NULL,
  end_at    TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS bookings (
  id          TEXT PRIMARY KEY,
  slot_id     TEXT NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  email       TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('confirmed', 'cancelled')),
  created_at  TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS bookings_one_confirmed_per_slot
  ON bookings (slot_id) WHERE status = 'confirmed';

CREATE INDEX IF NOT EXISTS bookings_email_created
  ON bookings (email, created_at, id);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key         TEXT PRIMARY KEY,
  body_hash   TEXT NOT NULL,
  response    JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS booking_attempts (
  id     BIGSERIAL PRIMARY KEY,
  email  TEXT NOT NULL,
  at     TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS booking_attempts_email_at
  ON booking_attempts (email, at);
`;

function createPool({ connectionString, ssl = false }) {
  return new Pool({ connectionString, max: 10, ssl });
}

async function migrate(pool) {
  await pool.query(SCHEMA_SQL);
}

module.exports = { createPool, migrate };