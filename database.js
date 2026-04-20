const Database = require('better-sqlite3');
const path = require('path');

// Connect to the database (creates the file if it doesn't exist)
const dbPath = path.join(__dirname, 'database.sqlite');
const db = new Database(dbPath, { verbose: console.log });

// Enable Write-Ahead Logging (WAL) for better performance on limited RAM
db.pragma('journal_mode = WAL');

// Define and create the schema
const createTable = `
  CREATE TABLE IF NOT EXISTS users (
    whatsapp_id TEXT PRIMARY KEY,
    refresh_token TEXT,
    access_token TEXT,
    token_expiry INTEGER,
    sync_status TEXT DEFAULT 'pending'
  );
`;

db.exec(createTable);
console.log('Database initialized and users table checked/created successfully.');

module.exports = db;
