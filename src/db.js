// Database access.
//
// Every query in this app is a single SQL statement that returns one JSON
// column called `r`. A single statement is atomic in Postgres, so the
// important guarantees (no double-booking, idempotency, rate limiting) are
// enforced by the database itself, not by JavaScript.

const fs = require("fs");
const path = require("path");

let driver;

function getDriver() {
  if (driver) return driver;

  if (process.env.DB_DRIVER === "psql") {
    // Test-only driver (see test/psql-driver.js). Not used in production.
    driver = require("../test/psql-driver");
    return driver;
  }

  const { Pool } = require("pg");
  const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.STORAGE_URL || process.env.NEON_DATABASE_URL || process.env.DATABASE_URL_UNPOOLED || process.env.POSTGRES_URL_NON_POOLING;
  if (!connectionString) throw new Error("DATABASE_URL is not set");

  const isLocal = /localhost|127\.0\.0\.1/.test(connectionString);
  const pool = new Pool({
    connectionString,
    ssl: isLocal ? false : { rejectUnauthorized: false },
    max: 5,
  });
  driver = {
    async query(sql, params = []) {
      const { rows } = await pool.query(sql, params);
      return rows;
    },
    async exec(sql) {
      await pool.query(sql);
    },
  };
  return driver;
}

// Runs a statement and returns the JSON value in column `r` of the first row.
async function one(sql, params = []) {
  const rows = await getDriver().query(sql, params);
  return rows.length ? rows[0].r : null;
}

// Creates the tables once per process (safe to run many times).
let schemaReady;
function ensureSchema() {
  if (!schemaReady) {
    const sql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
    schemaReady = getDriver()
      .exec(sql)
      .catch((err) => {
        schemaReady = undefined; // retry on the next request
        throw err;
      });
  }
  return schemaReady;
}

module.exports = { one, ensureSchema };
