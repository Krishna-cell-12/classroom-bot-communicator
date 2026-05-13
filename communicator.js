'use strict';

require('dotenv').config();

// ---------------------------------------------------------------------------
// Global safety nets – must be registered before any async work starts.
// Unhandled rejections in event-listener callbacks (e.g. messages.upsert) won't
// crash the process; they are logged instead.  PM2 will still restart on a true
// uncaughtException (e.g. a synchronous throw outside any try/catch).
// ---------------------------------------------------------------------------
process.on('unhandledRejection', (reason, promise) => {
    console.error('⚠️  Unhandled Promise Rejection (safe – process continues):', reason);
});
process.on('uncaughtException', (err) => {
    console.error('💥 Uncaught Exception – PM2 will restart:', err);
    process.exit(1); // let PM2 handle the restart
});
const express = require('express');
const {
    default: makeWASocket,
    DisconnectReason,
    fetchLatestBaileysVersion,
    Browsers,
    jidNormalizedUser,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const { useSQLiteAuthState } = require('./auth-state');

// Stable Baileys protocol version – avoids being caught on a bad Meta beta push.
// To update: run `node -e "require('@whiskeysockets/baileys').fetchLatestBaileysVersion().then(v=>console.log(v.version))"`
// and paste the result here after verifying it pairs successfully.
const BAILEYS_VERSION = [2, 3000, 1023625985];

// ---------------------------------------------------------------------------
// App bootstrap
// ---------------------------------------------------------------------------

const app = express();
// Limit JSON body to 64 KB – prevents memory pressure from oversized payloads.
app.use(express.json({ limit: '64kb' }));
const PORT = 3000;

// Maximum number of outbound messages that can queue while the socket is
// reconnecting (used by safeSend for /send-alert only – NOT for incoming
// message routing, which is always instant pass-through).
const MSG_QUEUE_MAX = 500;

// ---------------------------------------------------------------------------
// Connection state
//
// `sock`    – the live Baileys socket (null while connecting).
// `isReady` – true only after 'connection === open'. Guards sendMessage.
// `msgQueue`– buffers outbound /send-alert replies while the socket is
//             reconnecting. Drained once the connection opens.
// ---------------------------------------------------------------------------

let sock            = null;
let isReady         = false;
const msgQueue      = [];

// Module-level references to SQLite persistence helpers.
// Assigned inside connectToWhatsApp() on first call and kept alive across
// reconnects.  Start as no-ops until the DB connection is established.
let saveContactsCache   = () => {};
let deleteContactsCache = (_lid) => {};

let reconnectAttempts = 0;  // tracks consecutive failures for exponential backoff

// LID → @s.whatsapp.net contacts cache.
// Still populated from contacts.upsert / contacts.update for outbound
// /send-alert replies.  Incoming message routing NO LONGER consults this map –
// @lid is forwarded directly to Brain as the user's permanent unique ID.
// Key:   "<lid-numeric>@lid"
// Value: "<phone>@s.whatsapp.net"
const lidToJid = new Map();

// The bot's own LID (e.g. "249241297522744@lid"), derived from sock.user after
// connection open.  Used only to skip echoes of the bot's own messages.
let selfLid = null;

// ---------------------------------------------------------------------------
// Message queue helpers
// ---------------------------------------------------------------------------

/**
 * Drain every pending message that arrived while the socket was connecting.
 * Called exactly once per successful connection open.
 */
async function drainQueue() {
    if (msgQueue.length === 0) return;
    console.log(`📨 Draining ${msgQueue.length} queued message(s)…`);

    // Snapshot and clear queue atomically before we start sending so that
    // any messages arriving mid-drain go into a fresh queue round.
    const pending = msgQueue.splice(0, msgQueue.length);

    for (const { chatId, message, resolve, reject } of pending) {
        try {
            await sock.sendMessage(chatId, { text: message });
            console.log(`✅ Queued reply sent to ${chatId}`);
            resolve({ success: true });
        } catch (err) {
            console.error(`❌ Failed to send queued message to ${chatId}:`, err.message);
            reject(err);
        }
    }
}

/**
 * Safe wrapper around sock.sendMessage.
 *
 * If the socket isn't ready yet, the message is queued and a Promise is
 * returned that resolves/rejects when the message is eventually sent. This
 * means the /send-alert HTTP response still returns immediately with
 * { queued: true } without blocking – the Brain server doesn't need to wait.
 *
 * @returns {Promise<{ success: boolean, queued?: boolean }>}
 */
async function safeSend(chatId, message) {
    if (isReady && sock) {
        await sock.sendMessage(chatId, { text: message });
        return { success: true };
    }

    // Socket not ready – queue the message, but cap the queue to prevent OOM.
    if (msgQueue.length >= MSG_QUEUE_MAX) {
        const err = new Error(`Message queue full (${MSG_QUEUE_MAX} items). Brain outage suspected.`);
        console.error('❌', err.message);
        throw err;
    }

    return new Promise((resolve, reject) => {
        msgQueue.push({ chatId, message, resolve, reject });
        console.log(`⏳ Socket not ready. Message to ${chatId} queued (queue depth: ${msgQueue.length})`);
    });
}

// ---------------------------------------------------------------------------
// WhatsApp connection
// ---------------------------------------------------------------------------

async function connectToWhatsApp() {
    // Reset readiness flag every time we (re)connect.
    isReady = false;

    // SQLite-backed auth – atomic writes, no race condition on slow EC2 I/O.
    const { state, saveCreds, loadContactsCache, saveContactsCache: _saveCC, deleteContactsCache: _delCC } = useSQLiteAuthState();

    // Hoist to module scope so admin endpoints and retry helpers can persist
    // or evict LID→JID pairs without a reference to the closure.
    saveContactsCache   = _saveCC;
    deleteContactsCache = _delCC;

    // ── Persistent contact cache ──────────────────────────────────────────────
    // Pre-load every LID→JID mapping saved from previous sessions so we can
    // resolve messages that arrive during the 1-30 s contacts.upsert sync window.
    const persisted = loadContactsCache();
    if (persisted.size > 0) {
        for (const [lid, jid] of persisted) lidToJid.set(lid, jid);
        console.log(`📇 Loaded ${persisted.size} LID→JID mapping(s) from persistent cache.`);
    }

    // Use a pinned stable version. fetchLatestBaileysVersion() makes a live HTTP
    // call on every reconnect and can return a beta version that rejects pairings.
    let version = BAILEYS_VERSION;
    try {
        const fetched = await fetchLatestBaileysVersion();
        // Only use the fetched version if it's NOT a beta (last segment < 1e12).
        if (fetched.version[2] < 1_000_000_000_000) {
            version = fetched.version;
        } else {
            console.log(`⚠️  Fetched beta version ${fetched.version.join('.')} – using pinned ${version.join('.')} instead.`);
        }
    } catch (e) {
        console.warn(`⚠️  fetchLatestBaileysVersion failed (${e.message}), using pinned version ${version.join('.')}.`);
    }

    sock = makeWASocket({
        version,
        auth: state,                         // state.keys is already wrapped with makeCacheableSignalKeyStore
        logger: pino({ level: 'fatal' }),  // 'silent' still leaks some internal console output; 'fatal' suppresses it cleanly
        browser: Browsers.ubuntu('Chrome'),
        syncFullHistory: false,
        markOnlineOnConnect: false,
        /**
         * Timeout tuning for 1 GB EC2 with synchronous SQLite writes:
         *
         * connectTimeoutMs  – how long Baileys waits for the initial WS handshake.
         *   60 s gives plenty of room for the ~110-PreKey SQLite burst at QR time.
         *
         * keepAliveIntervalMs – how often Baileys sends a WS ping to keep the
         *   connection alive. 30 s is long enough to survive a 150 ms SQLite
         *   transaction without the ping timer firing mid-write.
         */
        connectTimeoutMs: 60_000,
        keepAliveIntervalMs: 30_000,
        // getMessage is required so Baileys can re-decrypt messages whose
        // plaintext it no longer has in memory (avoids "no msg found" errors).
        getMessage: async (key) => ({ conversation: 'placeholder' }),
    });

    sock.ev.on('creds.update', saveCreds);

    // -------------------------------------------------------------------------
    // Connection lifecycle
    // -------------------------------------------------------------------------
    sock.ev.on('connection.update', async (update) => {
        try {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                console.log('\n📱 SCAN THIS QR CODE WITH WHATSAPP 📱');
                qrcode.generate(qr, { small: true });
            }

            if (connection === 'close') {
                isReady = false;
                const reason = lastDisconnect?.error?.output?.statusCode;
                console.log(`⚠️  Connection closed. Reason code: ${reason ?? 'unknown'}`);

                if (reason === DisconnectReason.loggedOut) {
                    console.error('❌ Logged out. Delete "baileys_auth.db" and restart to re-pair.');
                    process.exit(1);
                }

                // Exponential back-off: 4 s → 8 s → 16 s → capped at 60 s.
                // Reset counter on a clean 515 (stream sync) since that's usually
                // a server-side blip, not a persistent failure.
                if (reason === 515) {
                    reconnectAttempts = 0; // stream sync is transient – reset backoff
                } else {
                    reconnectAttempts++;
                }
                const baseDelay  = reason === 500 ? 8000 : 4000;
                const backoff     = Math.min(baseDelay * Math.pow(2, reconnectAttempts - 1), 60_000);
                console.log(`🔄 Reconnecting in ${backoff / 1000}s… (attempt ${reconnectAttempts})`);
                setTimeout(connectToWhatsApp, backoff);

            } else if (connection === 'open') {
                isReady = true;
                reconnectAttempts = 0; // reset on successful connection
                console.log('✅ WhatsApp Ready');

                // ── Stage 0 seed: map the bot's own LID → its @s.whatsapp.net JID ──
                // sock.user is populated synchronously by Baileys before 'open' fires.
                // sock.user.id  = phone JID  e.g. "91XXXXXXXXXX:12@s.whatsapp.net"
                // sock.user.lid = account LID e.g. "249241297522744@lid"
                // Seeding lidToJid here means loopback messages (admin messaging the
                // bot from a linked device on the same account) are resolved instantly
                // without any DB or network lookup.
                if (sock.user?.lid && sock.user?.id) {
                    const myLid = sock.user.lid;
                    const myJid = jidNormalizedUser(sock.user.id);
                    selfLid = myLid;
                    if (!lidToJid.has(myLid)) {
                        lidToJid.set(myLid, myJid);
                        saveContactsCache([[myLid, myJid]]);
                        console.log(`🪪 Seeded own LID → JID: ${myLid} → ${myJid}`);
                    }
                }

                // Give Baileys a brief moment to finish internal post-handshake
                // setup (e.g. flushing any pending protocol messages) before we
                // start sending. 1 s is enough; this is NOT a guess-and-pray delay
                // – it specifically covers the Signal ratchet finalization window.
                setTimeout(drainQueue, 1000);
            }
        } catch (err) {
            console.error('❌ Error inside connection.update handler:', err);
        }
    });

    // -------------------------------------------------------------------------
    // Contacts store – builds the LID → @s.whatsapp.net reverse-lookup map.
    // Baileys emits 'contacts.upsert' after session sync with every known
    // contact.  Each contact object has both .id (@s.whatsapp.net) and .lid
    // (@lid) when the account is in multi-device/LID mode.
    // -------------------------------------------------------------------------
    sock.ev.on('contacts.upsert', (contacts) => {
        const newEntries = [];
        for (const c of contacts) {
            if (c.lid && c.id) {
                // Always normalize to a canonical @s.whatsapp.net JID before
                // storing. Raw c.id from Baileys can carry a device suffix
                // (e.g. "91XXX:5@s.whatsapp.net") that would cause subtle
                // mismatches on later resolveJid() calls.
                const normalizedJid = resolveJid(c.id);
                if (!normalizedJid) continue; // skip malformed entries
                lidToJid.set(c.lid, normalizedJid);
                newEntries.push([c.lid, normalizedJid]);
            }
        }
        if (contacts.length > 0) {
            console.log(`📇 Contacts cache updated (${lidToJid.size} LID→JID mappings)`);
        }
        // Persist new/updated entries to SQLite so the cache survives restarts.
        if (newEntries.length > 0) {
            saveContactsCache(newEntries);
        }
    });
    sock.ev.on('contacts.update', (updates) => {
        const newEntries = [];
        for (const c of updates) {
            if (c.lid && c.id) {
                const normalizedJid = resolveJid(c.id);
                if (!normalizedJid) continue;
                lidToJid.set(c.lid, normalizedJid);
                newEntries.push([c.lid, normalizedJid]);
            }
        }
        if (newEntries.length > 0) {
            saveContactsCache(newEntries);
        }
    });

    // -------------------------------------------------------------------------
    // Incoming messages → instant pass-through to Brain server
    //
    // Resolution is a clean 2-stage process – no queues, no waits:
    //
    //  Stage 1: Real number (@s.whatsapp.net / @c.us)
    //           msg.key.participant is checked first (multi-device DMs), then
    //           msg.key.remoteJid.  The JID is normalised and forwarded as-is.
    //
    //  Stage 2: Linked-device user (@lid)
    //           The raw @lid string IS the user's permanent unique ID.
    //           It is forwarded directly to Brain with ZERO lookup or delay.
    //           Brain owns all LID → email identity resolution.
    // -------------------------------------------------------------------------
    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg?.message || msg.key.fromMe) return;

        // Mark as read so this message doesn't re-appear on reconnect.
        try { await sock.readMessages([msg.key]); } catch (_) {}

        let from = null;
        const rawJid = msg.key.participant || msg.key.remoteJid;

        // Stage 1: real @s.whatsapp.net sender (standard DM or multi-device)
        if (rawJid && !rawJid.endsWith('@lid')) {
            from = resolveJid(rawJid);
        }

        // Stage 2: @lid sender – pass through directly, no cache lookup.
        if (!from && rawJid && rawJid.endsWith('@lid')) {
            from = rawJid;
            console.log(`🆔 @lid instant pass-through: ${from}`);
        }

        if (!from) {
            console.warn(
                `⚠️  Cannot determine sender for message from "${msg.pushName ?? '(unknown)'}" ` +
                `(remoteJid: ${msg.key.remoteJid}). Message skipped.`
            );
            return;
        }

        const body =
            msg.message.conversation ??
            msg.message.extendedTextMessage?.text ??
            msg.message.imageMessage?.caption ??
            '';

        if (!body.trim()) return;

        console.log(`📩 Received: "${body}" from ${from}`);

        // ── !myclass command ─────────────────────────────────────────────────
        // Handled locally on Server 1 (Communicator) – no Brain forward needed.
        // Makes a GET request to Server 2 (Brain) REST API, formats the result,
        // and replies directly to the WhatsApp user.
        if (body.trim() === '!myclass') {
            try {
                // 1. Tell the user we are working on it
                await sock.sendMessage(from, { text: 'Fetching your assignments... Please wait.' });

                // 2. Ask Server 2 (The Brain) for the data
                const userPhoneNumber = from; // @lid or @s.whatsapp.net JID – Brain resolves identity
                const response = await fetch(`${process.env.BRAIN_URL}/api/assignments/${encodeURIComponent(userPhoneNumber)}`);
                const result = await response.json();

                // 3. If Server 2 says they aren't registered, tell the user
                if (!result.success) {
                    return await sock.sendMessage(from, { text: result.message });
                }

                // 4. If Server 2 says they have no homework, celebrate!
                if (!result.data || result.data.length === 0) {
                    return await sock.sendMessage(from, { text: 'You have no pending assignments! 🎉' });
                }

                // 5. Format the raw JSON data into a beautiful WhatsApp message
                let replyText = '📚 *Your Pending Assignments:*\n\n';
                result.data.forEach(task => {
                    replyText += `🔹 *${task.courseName || 'Class'}*\n📌 ${task.assignmentTitle}\n⏰ Due: ${task.due}\n🔗 ${task.url}\n\n`;
                });

                // 6. Send the final message back to the user
                await sock.sendMessage(from, { text: replyText });

            } catch (error) {
                console.error('Error contacting Brain server:', error);
                await sock.sendMessage(from, { text: 'Failed to contact the Classroom server. Please try again later.' });
            }
            return; // Do NOT forward !myclass to Brain's /incoming endpoint
        }
        // ── End !myclass ─────────────────────────────────────────────────────

        // ── !register command ────────────────────────────────────────────────
        // Handled locally on Server 1 – generates the OAuth link and sends it
        // directly to the user without touching Brain's /incoming route.
        if (body.trim() === '!register') {
            // Build the auth link – encode the JID so it passes safely in the URL.
            const authLink = `${process.env.BRAIN_URL}/auth?phone=${encodeURIComponent(from)}`;

            const replyMsg =
                `Welcome! To connect your Google Classroom, click this secure link:\n\n` +
                `${authLink}\n\n` +
                `After logging in and seeing the Success screen, return here and type !myclass`;

            await sock.sendMessage(from, { text: replyMsg });
            return; // Do NOT forward !register to Brain's /incoming endpoint
        }
        // ── End !register ────────────────────────────────────────────────────

        try {
            const res = await fetch(`${process.env.BRAIN_URL}/incoming`, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ from, body }),
            });
            if (res.ok) {
                console.log('✅ Forwarded to Brain');
            } else {
                console.warn(`⚠️  Brain returned HTTP ${res.status}`);
            }
        } catch (e) {
            console.error('❌ Brain unreachable:', e.message);
        }
    });
}

// ---------------------------------------------------------------------------
// JID helpers
// ---------------------------------------------------------------------------

/**
 * Resolve an arbitrary JID string to a canonical @s.whatsapp.net JID.
 *
 * Handles:
 *   - Plain phone numbers   e.g. "1234567890"   → "1234567890@s.whatsapp.net"
 *   - @c.us JIDs            e.g. "...@c.us"     → "...@s.whatsapp.net"
 *   - @s.whatsapp.net JIDs  – returned as-is after normalisation
 *   - @lid JIDs             – returned as-is; the @lid is the user's permanent
 *                             unique ID.  Brain (Server 2) owns all identity
 *                             resolution.  This function does NOT attempt to
 *                             upgrade @lid to a phone number.
 *
 * @param {string} jid
 * @returns {string|null}  Canonical JID string, or null if input is empty/invalid.
 */
function resolveJid(jid) {
    if (!jid) return null;

    // @lid: permanent unique ID – pass through as-is, no upgrade attempted.
    if (jid.endsWith('@lid')) return jid;

    // Strip any known suffixes, leaving the raw numeric ID.
    const numeric = jid
        .replace(/@c\.us$/,           '')
        .replace(/@s\.whatsapp\.net$/, '')
        .replace(/:.*$/,               ''); // strip device suffix e.g. "123:5@..."

    if (!numeric) return null;

    // jidNormalizedUser canonicalises the suffix to @s.whatsapp.net.
    try {
        return jidNormalizedUser(`${numeric}@s.whatsapp.net`);
    } catch {
        return `${numeric}@s.whatsapp.net`;
    }
}

// ---------------------------------------------------------------------------
// Express API
// ---------------------------------------------------------------------------

/**
 * POST /send-alert
 * Body: { phone: string, message: string }
 * Header: x-secret-key
 *
 * Responds immediately with { success: true } or { queued: true }.
 * If the socket is not yet open the message is queued and sent as soon as
 * the connection is established (within the same process lifetime).
 */
app.post('/send-alert', async (req, res) => {
    if (req.headers['x-secret-key'] !== process.env.SHARED_SECRET_KEY) {
        return res.sendStatus(403);
    }

    const { phone, message } = req.body ?? {};
    // Strict type checks: both must be non-empty strings.
    // Rejects undefined, null, numbers, arrays, and empty strings.
    if (typeof phone !== 'string' || !phone.trim()) {
        return res.status(400).json({ error: 'Missing or invalid "phone" field – must be a non-empty string.' });
    }
    if (typeof message !== 'string' || !message.trim()) {
        return res.status(400).json({ error: 'Missing or invalid "message" field – must be a non-empty string.' });
    }

    // Resolve / normalise the JID that Brain forwarded.
    // resolveJid() now accepts @lid as a valid pass-through ID, so Brain can
    // send replies to @lid users without knowing their phone number.
    const chatId = resolveJid(phone);
    if (!chatId) {
        console.warn(`⚠️  /send-alert rejected empty/invalid JID: "${phone}"`);
        return res.status(400).json({ error: `Invalid "phone" value: "${phone}".` });
    }

    console.log(`📤 Send request → ${chatId}`);

    if (isReady && sock) {
        // Happy path: socket is live, send right now.
        try {
            await sock.sendMessage(chatId, { text: message });
            console.log('✅ Reply sent');
            return res.json({ success: true });
        } catch (err) {
            console.error('❌ sendMessage failed:', err.message);
            return res.status(500).json({ error: err.message });
        }
    } else {
        // Socket still connecting: queue the message and return immediately.
        // The Brain server should treat "queued" as a successful acceptance.
        safeSend(chatId, message).catch((err) =>
            console.error('❌ Queued message eventually failed:', err.message)
        );
        console.log(`⏳ Queued message for ${chatId} (socket not ready)`);
        return res.json({ success: true, queued: true });
    }
});

// Simple health-check endpoint for load balancers / monitoring.
app.get('/health', (_req, res) => {
    res.json({ ready: isReady, queueDepth: msgQueue.length, lidCacheSize: lidToJid.size });
});

/**
 * POST /seed-lid
 * Body: { lid: string, jid: string }
 * Header: x-secret-key
 *
 * Manually inject a LID → JID mapping into both the in-memory cache and the
 * persistent SQLite store.  Use this to unblock a contact whose LID never
 * appears in contacts.upsert (e.g. yourself / admin on LID-mode accounts).
 *
 * Example:
 *   curl -X POST http://localhost:3000/seed-lid \
 *     -H 'x-secret-key: YOUR_KEY' \
 *     -H 'Content-Type: application/json' \
 *     -d '{"lid":"249241297522744@lid","jid":"91XXXXXXXXXX@s.whatsapp.net"}'
 */
app.post('/seed-lid', (req, res) => {
    if (req.headers['x-secret-key'] !== process.env.SHARED_SECRET_KEY) {
        return res.sendStatus(403);
    }
    const { lid, jid } = req.body ?? {};
    if (typeof lid !== 'string' || !lid.includes('@lid')) {
        return res.status(400).json({ error: 'Missing or invalid "lid" field – must be a "<numeric>@lid" string.' });
    }
    const resolvedJid = resolveJid(jid);
    if (!resolvedJid) {
        return res.status(400).json({ error: 'Missing or invalid "jid" field – must be a phone number or @s.whatsapp.net JID.' });
    }
    lidToJid.set(lid, resolvedJid);
    saveContactsCache([[lid, resolvedJid]]);
    console.log(`🌱 Admin seeded LID → JID: ${lid} → ${resolvedJid}`);
    return res.json({ success: true, lid, jid: resolvedJid, cacheSize: lidToJid.size });
});

/**
 * GET /debug/contacts
 * Header: x-secret-key
 *
 * Returns the current in-memory LID → JID mapping table.
 * Useful for diagnosing which contacts have been cached.
 */
app.get('/debug/contacts', (req, res) => {
    if (req.headers['x-secret-key'] !== process.env.SHARED_SECRET_KEY) {
        return res.sendStatus(403);
    }
    const entries = Object.fromEntries(lidToJid);
    return res.json({
        size: lidToJid.size,
        selfLid,
        botJid: sock?.user?.id ?? null,
        entries,
    });
});

/**
 * DELETE /debug/contacts/:lid
 * Header: x-secret-key
 *
 * Surgically evict a single LID → JID entry from both the in-memory cache
 * and the persistent SQLite store.  Use this to clear a bad entry introduced
 * by a Baileys sync quirk or a mis-typed /seed-lid call without restarting.
 *
 * Example:
 *   curl -X DELETE http://localhost:3000/debug/contacts/249241297522744%40lid \
 *     -H 'x-secret-key: YOUR_KEY'
 */
app.delete('/debug/contacts/:lid', (req, res) => {
    if (req.headers['x-secret-key'] !== process.env.SHARED_SECRET_KEY) {
        return res.sendStatus(403);
    }
    const lid = decodeURIComponent(req.params.lid);
    if (!lid.includes('@lid')) {
        return res.status(400).json({ error: 'Path param must be a "<numeric>@lid" string.' });
    }
    const existed = lidToJid.has(lid);
    lidToJid.delete(lid);
    // Surgically delete the row from SQLite so the bad entry doesn't return on restart.
    deleteContactsCache(lid);
    console.log(`🗑️  Evicted LID "${lid}" from cache (existed: ${existed}). Cache size now: ${lidToJid.size}`);
    return res.json({ success: true, lid, existed, cacheSize: lidToJid.size });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

connectToWhatsApp();
app.listen(PORT, () => console.log(`Communicator API on port ${PORT}`));
