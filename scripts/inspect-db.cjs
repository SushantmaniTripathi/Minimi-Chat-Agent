const Database = require("better-sqlite3");
const db = new Database("data/minimi.db", { readonly: true });
for (const t of ["entities", "claims", "turn_metrics", "search_cache"]) {
  try {
    const n = db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
    const rows = db.prepare(`SELECT * FROM ${t} ORDER BY rowid DESC LIMIT 5`).all();
    console.log(`\n== ${t} (${n} rows) ==`);
    for (const r of rows) console.log(JSON.stringify(r).slice(0, 320));
  } catch (e) {
    console.log(`\n== ${t} == ERROR ${e.message}`);
  }
}
