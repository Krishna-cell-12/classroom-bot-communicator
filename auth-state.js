'use strict';

/**
 * useSQLiteAuthState - A production-safe replacement for useMultiFileAuthState.
 *
 * WHY: useMultiFileAuthState writes many small JSON files on every signal key
 * update. On a slow EC2 disk, concurrent reads/writes during the startup burst
 * (incoming message arrives while keys are still flushing) causes the Signal
 * Protocol to see an inconsistent key set → WhatsApp server rejects with 500.
 *
 * This adapter stores ALL auth state in a single SQLite table using synchronous
 * better-sqlite3 transactions, which are atomic by definition and immune to the
 * race condition. We then wrap it with makeCacheableSignalKeyStore so hot-path
 * key lookups are served from an in-memory LRU cache instead of hitting disk.
 */

const { initAuthCreds, BufferJSON, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const Database = require('better-sqlite3');
const path = require('path');
const pino = require('pino');

const logger = pino({ level: 'silent' });

function useSQLiteAuthState(dbPath = path.join(__dirname, 'baileys_auth.db')) {
    const db = new Database(dbPath);

    // WAL mode: readers don't block writers and vice-versa.
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL'); // Faster than FULL, still crash-safe with WAL
    // Keep the DB from holding more than ~4 MB of WAL before checkpointing.
    db.pragma('wal_autocheckpoint = 100');

    db.exec(`
        CREATE TABLE IF NOT EXISTS auth_state (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS contacts_cache (
            lid TEXT PRIMARY KEY,
            jid TEXT NOT NULL
        );
    `);

    // --- Low-level helpers ---

    function dbGet(key) {
        const row = db.prepare('SELECT value FROM auth_state WHERE key = ?').get(key);
        if (!row) return null;
        return JSON.parse(row.value, BufferJSON.reviver);
    }

    function dbSet(key, value) {
        if (value == null) {
            db.prepare('DELETE FROM auth_state WHERE key = ?').run(key);
        } else {
            db.prepare('INSERT OR REPLACE INTO auth_state (key, value) VALUES (?, ?)')
                .run(key, JSON.stringify(value, BufferJSON.replacer));
        }
    }

    // --- Credentials ---

    let creds = dbGet('creds') || initAuthCreds();

    function saveCreds() {
        dbSet('creds', creds);
    }

    // --- Signal Key Store (raw, before caching) ---
    // Baileys calls keys.get(type, ids[]) and keys.set({ type: { id: value } })

    // Hoist prepared statements so they are compiled once and reused.
    const stmtUpsert = db.prepare('INSERT OR REPLACE INTO auth_state (key, value) VALUES (?, ?)');
    const stmtDel    = db.prepare('DELETE FROM auth_state WHERE key = ?');

    // Compiled transaction function – reused on every set() call.
    const writeAll = db.transaction((rows) => {
        for (const { key, value } of rows) {
            if (value !== null) {
                stmtUpsert.run(key, value);
            } else {
                stmtDel.run(key);
            }
        }
    });

    const rawKeyStore = {
        get: async (type, ids) => {
            const result = {};
            for (const id of ids) {
                const val = dbGet(`key:${type}:${id}`);
                if (val !== null) result[id] = val;
            }
            return result;
        },

        /**
         * set() – write Signal keys to SQLite WITHOUT blocking the event loop.
         *
         * During QR pairing Baileys calls set() with ~110 PreKeys in one batch.
         * Running that synchronous SQLite transaction directly on the call stack
         * can take 40-150 ms on a 1 GB EC2 instance, which starves the WebSocket
         * heartbeat and triggers the 408 timeout loop.
         *
         * Fix: pre-serialize every value (cheap, synchronous) then hand the
         * actual disk write to setImmediate so the event loop gets one full tick
         * to process pending I/O callbacks (Baileys ping/pong) before we block.
         */
        set: (data) => {
            // Serialize values on the current tick (fast, CPU-only).
            const rows = [];
            for (const type of Object.keys(data)) {
                for (const id of Object.keys(data[type])) {
                    const value = data[type][id];
                    rows.push({
                        key: `key:${type}:${id}`,
                        value: value != null
                            ? JSON.stringify(value, BufferJSON.replacer)
                            : null,
                    });
                }
            }

            // Yield one event-loop tick, then write atomically.
            return new Promise((resolve, reject) => {
                setImmediate(() => {
                    try {
                        writeAll(rows);
                        resolve();
                    } catch (err) {
                        reject(err);
                    }
                });
            });
        },
    };

    // Wrap with Baileys' own LRU cache layer – avoids redundant disk reads on
    // every single encrypt/decrypt operation during the startup burst.
    const keys = makeCacheableSignalKeyStore(rawKeyStore, logger);

    // -------------------------------------------------------------------------
    // Contacts cache helpers
    //
    // These persist the in-memory lidToJid Map across PM2 restarts so the bot
    // can resolve LID → @s.whatsapp.net JIDs immediately on boot, before the
    // contacts.upsert background sync completes (which can take 1-30 s).
    // -------------------------------------------------------------------------

    /**
     * Load all persisted LID → JID mappings from SQLite.
     * @returns {Map<string, string>}  key = "<numeric>@lid", value = "<phone>@s.whatsapp.net"
     */
    function loadContactsCache() {
        const rows = db.prepare('SELECT lid, jid FROM contacts_cache').all();
        return new Map(rows.map(r => [r.lid, r.jid]));
    }

    // Pre-compiled upsert for contacts rows.
    const stmtContactUpsert = db.prepare(
        'INSERT OR REPLACE INTO contacts_cache (lid, jid) VALUES (?, ?)'
    );
    const stmtContactDelete = db.prepare(
        'DELETE FROM contacts_cache WHERE lid = ?'
    );
    const writeContacts = db.transaction((entries) => {
        for (const [lid, jid] of entries) {
            stmtContactUpsert.run(lid, jid);
        }
    });

    /**
     * Persist new or updated LID → JID mappings to SQLite.
     * @param {Iterable<[string, string]>} entries  Array/Map of [lid, jid] pairs.
     */
    function saveContactsCache(entries) {
        try {
            writeContacts([...entries]);
        } catch (err) {
            console.error('⚠️  Failed to persist contacts cache to SQLite:', err.message);
        }
    }

    /**
     * Surgically remove a single LID entry from the SQLite contacts_cache.
     * @param {string} lid  The "<numeric>@lid" key to evict.
     */
    function deleteContactsCache(lid) {
        try {
            stmtContactDelete.run(lid);
        } catch (err) {
            console.error('⚠️  Failed to evict LID from SQLite contacts_cache:', err.message);
        }
    }

    return {
        state: { creds, keys },
        saveCreds,
        loadContactsCache,
        saveContactsCache,
        deleteContactsCache,
    };
}

module.exports = { useSQLiteAuthState };
