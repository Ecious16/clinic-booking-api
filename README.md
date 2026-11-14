# clinic-booking-api
Clinic booking API
Node.js + Express + Postgres implementation of the Koya Cohort 4 Task 1 contract (spec/openapi.json, copied from koyaacademy.com/assessment-api).

Covers levels 1–5:

L1 list slots, book, get a booking
L2 X-API-Key auth (401), field validation (400), unknown slot (404), started slot (400), trimmed name and lower-cased email
L3 one confirmed booking per slot, enforced with a row lock plus a partial unique index (safe under concurrent requests); cancellation
L4 Idempotency-Key replay (same response) and 422 for a reused key with a different body; cursor-paginated GET /bookings?email=
L5 5 attempts per email per minute (failed attempts included), then 429 with Retry-After
The web page is served at / and uses the API on the same origin. The API key is typed into the page and kept in sessionStorage only.

Run locally
docker run -d --name clinic-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=clinic -p 5433:5432 postgres:16-alpine
npm install
DATABASE_URL=postgres://postgres:postgres@localhost:5433/clinic API_KEY=local-dev-key node src/index.js
npm test   # uses TEST_DATABASE_URL, default postgres://postgres:postgres@localhost:5433/clinic

Deploy (Render + Neon, both free)
Create a Neon project and copy its connection string (postgresql://…?sslmode=require).
Create a Render Web Service from this repo (render.yaml is included). Set:
DATABASE_URL = the Neon connection string
API_KEY = a key you choose
DATABASE_SSL = true (already in render.yaml)
Tables are created on boot. Load slots with POST /reset.
Environment variables:

Name	Purpose
DATABASE_URL	Postgres connection string (required)
API_KEY	Value expected in X-API-Key (required)
DATABASE_SSL	true to enable TLS to the database (needed for Neon/Supabase)
PORT	Set by the host; defaults to 8080