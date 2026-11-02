// In-memory Postgres (PGlite) for tests, loaded with the real db/schema.sql.
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');
const { setQueryImplementation } = require('../../db/client');

const SCHEMA = fs.readFileSync(path.join(__dirname, '../../db/schema.sql'), 'utf8');

async function freshDb() {
  const db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(SCHEMA); // must be safe to run twice
  setQueryImplementation(async (text, params) => {
    const r = await db.query(text, params || []);
    return { rows: r.rows, rowCount: r.rows.length || r.affectedRows || 0 };
  });
  return db;
}

module.exports = { freshDb };
