const { initDb } = require('./shared/db');
const db = initDb();
const row = db.prepare("SELECT files FROM captures WHERE files != '{}' LIMIT 1").get();
if (row) {
    const files = JSON.parse(row.files);
    console.log(Object.values(files)[0]);
} else {
    console.log("No screenshots found in DB");
}
process.exit(0);
