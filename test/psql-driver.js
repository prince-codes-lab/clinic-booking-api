// TEST-ONLY database driver that runs each statement through the `psql` CLI.
// Production uses the `pg` package (see src/db.js). This exists so the SQL can
// be tested against a real Postgres where npm packages aren't installed.
// Each call is a separate psql process = a separate database session, so
// concurrency tests are real.
//
// Enable with: DB_DRIVER=psql PSQL_URL=postgres://... node server.js

const { execFile } = require("child_process");

function literal(v) {
  if (v === null || v === undefined) return "NULL";
  return "'" + String(v).replace(/'/g, "''") + "'";
}

function inline(sql, params) {
  return sql.replace(/\$(\d+)/g, (_, n) => literal(params[Number(n) - 1]));
}

function run(sql) {
  return new Promise((resolve, reject) => {
    execFile(
      "psql",
      [process.env.PSQL_URL, "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", sql],
      { maxBuffer: 50 * 1024 * 1024 },
      (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout))
    );
  });
}

module.exports = {
  async query(sql, params = []) {
    const out = (await run(inline(sql, params))).trim();
    if (out === "") return [];
    // Every app query returns at most one row with one JSON column.
    return [{ r: JSON.parse(out) }];
  },
  async exec(sql) {
    await run(sql);
  },
};
