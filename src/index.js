'use strict';

const { createApp } = require('./app');
const { createPool, migrate } = require('./db');

async function main() {
  const { DATABASE_URL, API_KEY, PORT = '8080', DATABASE_SSL } = process.env;
  if (!DATABASE_URL) throw new Error('DATABASE_URL is required');
  if (!API_KEY) throw new Error('API_KEY is required');

  const pool = createPool({
    connectionString: DATABASE_URL,
    ssl: DATABASE_SSL === 'true' ? {} : false,
  });
  await migrate(pool);

  const app = createApp({ pool, apiKey: API_KEY });
  app.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`clinic-booking-api listening on port ${PORT}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});