'use strict';

const Database = require('better-sqlite3');
const path = require('path');

// Connect to the database (creates the file if it doesn't exist)
const dbPath = path.join(__dirname, 'database.sqlite');
const db = new Database(dbPath);

// Enable Write-Ahead Logging (WAL) for better performance on limited RAM
db.pragma('journal_mode = WAL');

// ── Schema ──────────────────────────────────────────────────────────────────
//
// users            – one row per registered WhatsApp user
//   whatsapp_id    – canonical @s.whatsapp.net JID or @lid (PRIMARY KEY)
//   email          – Google account email (filled after OAuth completes)
//   refresh_token  – Google OAuth refresh token
//   access_token   – Google OAuth access token (short-lived)
//   token_expiry   – access token expiry timestamp (ms)
//   sync_status    – 'pending' | 'active'
//
// seen_assignments  – prevents duplicate "new assignment" alerts per user
//   user_id        – FK → users.whatsapp_id
//   assignment_key – "<courseName>::<title>"
//
// alarmed_assignments – prevents duplicate "<1hr" reminders per user
//   user_id        – FK → users.whatsapp_id
//   assignment_key – "<courseName>::<title>"
//
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    whatsapp_id   TEXT PRIMARY KEY,
    email         TEXT,
    refresh_token TEXT,
    access_token  TEXT,
    token_expiry  INTEGER,
    sync_status   TEXT DEFAULT 'pending'
  );

  CREATE TABLE IF NOT EXISTS seen_assignments (
    user_id        TEXT NOT NULL,
    assignment_key TEXT NOT NULL,
    PRIMARY KEY (user_id, assignment_key)
  );

  CREATE TABLE IF NOT EXISTS alarmed_assignments (
    user_id        TEXT NOT NULL,
    assignment_key TEXT NOT NULL,
    PRIMARY KEY (user_id, assignment_key)
  );
`);

// Safe migration: add email column if upgrading from old schema (no-op if exists)
try {
  db.exec(`ALTER TABLE users ADD COLUMN email TEXT;`);
} catch (_) { /* column already exists */ }

console.log('[DB] Initialized — users / seen_assignments / alarmed_assignments tables ready.');

module.exports = db;
