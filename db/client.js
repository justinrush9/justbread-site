/**
 * Shared Postgres client for JustBread order management.
 * Reads DATABASE_URL from the environment (set in Vercel dashboard).
 * Reused across serverless invocations via module-level caching —
 * Vercel keeps warm functions alive between requests.
 */

const { Pool } = require('pg');

let pool;

function getPool() {
  if (!pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is not set');
    }
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }, // required by most managed Postgres (Neon, Supabase, Vercel Postgres)
      max: 3, // serverless — keep the pool small per instance
    });
  }
  return pool;
}

async function query(text, params) {
  const client = getPool();
  return client.query(text, params);
}

module.exports = { query, getPool };
