const Database = require("better-sqlite3");
const db = new Database("data/minimi.db");
const hours = Number(process.argv[2] || 48);
const row = db
  .prepare(
    `UPDATE claims SET verified_at = datetime('now', ?) WHERE status = 'active' AND predicate = 'price'`
  )
  .run(`-${hours} hours`);
console.log(`backdated ${row.changes} price claim(s) by ${hours}h`);
console.log(
  JSON.stringify(
    db.prepare(`SELECT value, asserted_at, verified_at, status FROM claims WHERE predicate='price'`).all()
  )
);
