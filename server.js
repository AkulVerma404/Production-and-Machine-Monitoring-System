const express = require('express');
const mysql = require('mysql2/promise');
const crypto = require('crypto');
const joi = require('joi');
const fs   = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());

// ============================================================
// DATABASE POOL
// ============================================================
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    connectionLimit: 10
});

// ============================================================
// CONSTANTS / HELPERS
// ============================================================
const usedSignatures = new Set();
const MASTER_KEY = process.env.MASTER_KEY;
const DASHBOARD_KEY = process.env.DASHBOARD_KEY;
const PANEL_PASSWORD = process.env.PANEL_PASSWORD;

// ============================================================
// PANEL SESSION TOKENS (in-memory, 4-hour expiry)
// ============================================================
const panelTokens = new Map(); // token -> expiry timestamp
const PANEL_TOKEN_TTL = 4 * 60 * 60 * 1000; // 4 hours

function genPanelToken() {
    return crypto.randomBytes(32).toString('hex');
}
function validatePanelToken(token) {
    if (!token || !panelTokens.has(token)) return false;
    const exp = panelTokens.get(token);
    if (Date.now() > exp) { panelTokens.delete(token); return false; }
    // Slide expiry on activity
    panelTokens.set(token, Date.now() + PANEL_TOKEN_TTL);
    return true;
}
// Purge expired tokens every hour
setInterval(() => {
    const now = Date.now();
    for (const [t, exp] of panelTokens) if (now > exp) panelTokens.delete(t);
}, 60 * 60 * 1000);

// ============================================================
// IN-MEMORY STORES: device commands & logs
// ============================================================
// commandQueue: { device_id -> [{ cmd, ts }] }
const commandQueue = new Map();
// deviceLogs:   { device_id -> [ { ts, message } ] }  (ring buffer, last 200)
const deviceLogs = new Map();
const LOG_LIMIT = 200;
// deviceState:  { device_id -> { last_ping, status, error_msg, error_solution, idle_time } }
const deviceState = new Map();
// deviceUptime: { device_id -> { online, idle, warning, offline } }  accumulates seconds in each state
const deviceUptime = new Map();
// Track previous status so we can accumulate time-in-state when it changes
const deviceLastStatusAt = new Map(); // device_id -> { status, since }

// pendingFlush: { device_id -> { date -> { online, idle, warning, offline } } }
// Accumulates increments **in milliseconds** to preserve sub-second precision.
// Converted to whole seconds only at the DB boundary (flushStatsToDB).
const pendingFlush = new Map();

// addToFlush: accepts MILLISECONDS (same unit as pendingFlush).
// Only used by flushStatsToDB error retry to re-queue failed increments.
function addToFlush(device_id, status, valueMs) {
    if (valueMs <= 0) return;
    const date = todayKey();
    if (!pendingFlush.has(device_id)) pendingFlush.set(device_id, new Map());
    const byDate = pendingFlush.get(device_id);
    const row = byDate.get(date) || { online: 0, idle: 0, warning: 0, offline: 0 };
    row[status] = (row[status] || 0) + valueMs;
    byDate.set(date, row);
}

function todayKey() {
    // Use IST (UTC+5:30) for the day boundary
    const d = new Date(Date.now() + 5.5 * 3600 * 1000);
    return d.toISOString().slice(0, 10);
}

// ── Midnight-aware credit helper ─────────────────────────────────────────────
// Splits the [fromMs, toMs) window at each IST midnight and stages the
// result in pendingFlush. Values are stored as MILLISECONDS to avoid the
// systematic time loss that Math.floor per-heartbeat caused (~1-2 hours/day).
const IST_MS = 5.5 * 3600 * 1000;
function creditToFlush(device_id, status, fromMs, toMs) {
    let cursor = fromMs;
    while (cursor < toMs) {
        const cIST = new Date(cursor + IST_MS);
        const nextMidnight = new Date(Date.UTC(
            cIST.getUTCFullYear(), cIST.getUTCMonth(), cIST.getUTCDate() + 1
        ) - IST_MS);
        const segEnd  = Math.min(toMs, nextMidnight.getTime());
        const segMs = segEnd - cursor; // Keep full millisecond precision
        if (segMs > 0) {
            const segDate = new Date(cursor + IST_MS).toISOString().slice(0, 10);
            if (!pendingFlush.has(device_id)) pendingFlush.set(device_id, new Map());
            const byDate = pendingFlush.get(device_id);
            const row = byDate.get(segDate) || { online: 0, idle: 0, warning: 0, offline: 0 };
            row[status] = (row[status] || 0) + segMs;
            byDate.set(segDate, row);
        }
        cursor = segEnd;
    }
}

function accumulateUptime(device_id, newStatus) {
    const now = Date.now();
    const prev = deviceLastStatusAt.get(device_id);
    if (prev) {
        const elapsed = Math.floor((now - prev.since) / 1000);
        // In-memory running total (for /api/device/uptime)
        const ut = deviceUptime.get(device_id) || { online: 0, idle: 0, warning: 0, offline: 0 };
        if (ut[prev.status] !== undefined) ut[prev.status] += elapsed;
        deviceUptime.set(device_id, ut);
        creditToFlush(device_id, prev.status, prev.since, now);
    }
    deviceLastStatusAt.set(device_id, { status: newStatus, since: now });
}

// ── Cursor persistence: save last-known state to disk so restarts/reboots ────
// can retroactively credit the gap as offline rather than losing it entirely.
const CURSOR_FILE = path.join(__dirname, 'device_cursor.json');

function saveCursors() {
    try {
        const obj = {};
        for (const [device_id, cur] of deviceLastStatusAt) obj[device_id] = cur;
        fs.writeFileSync(CURSOR_FILE, JSON.stringify(obj));
    } catch (e) { console.error('[CURSOR] Save failed:', e.message); }
}

function loadCursors() {
    try {
        if (!fs.existsSync(CURSOR_FILE)) return;
        const obj = JSON.parse(fs.readFileSync(CURSOR_FILE, 'utf8'));
        const now = Date.now();
        let count = 0;
        for (const [device_id, cur] of Object.entries(obj)) {
            if (!cur || !cur.since || !cur.status) continue;
            const gapMs = now - cur.since;
            // Sanity: ignore cursors older than 7 days (stale / wrong clock)
            if (gapMs <= 0 || gapMs > 7 * 24 * 3600 * 1000) continue;
            // Credit the entire gap since last shutdown as offline.
            // We cannot know if the device was truly online during the restart,
            // so 'offline' is the safe conservative choice.
            creditToFlush(device_id, 'offline', cur.since, now);
            // Restore cursor so the offline timer continues from now
            deviceLastStatusAt.set(device_id, { status: 'offline', since: now });
            // Ensure offline timer sees this device
            if (!deviceState.has(device_id)) {
                deviceState.set(device_id, { last_ping: cur.since, status: 'offline',
                    error_msg: '', error_solution: '', idle_time: 0 });
            }
            count++;
        }
        if (count > 0) console.log(`[CURSOR] Restored ${count} device cursor(s); gap credited as offline.`);
    } catch (e) { console.error('[CURSOR] Load failed:', e.message); }
}

// ── Background: flush accumulated milliseconds to DB every 10 s ──────────────
// pendingFlush stores milliseconds. We convert to whole seconds via Math.floor
// and carry forward the sub-second remainder so it's never lost. This guarantees:
//   - Never over-counts (Math.floor can't round up)
//   - Never loses time   (remainder carries forward to the next flush cycle)
const flushRemainders = new Map(); // device_id -> { date -> { online, idle, warning, offline } }

async function flushStatsToDB() {
    if (pendingFlush.size === 0) return;
    // Drain the map atomically so a long DB write doesn't lose new data
    const snapshot = new Map(pendingFlush);
    pendingFlush.clear();

    for (const [device_id, byDate] of snapshot) {
        if (!flushRemainders.has(device_id)) flushRemainders.set(device_id, new Map());
        const remByDate = flushRemainders.get(device_id);

        for (const [stat_date, inc] of byDate) {
            // Get carried-forward remainders from previous flush for this date
            const rem = remByDate.get(stat_date) || { online: 0, idle: 0, warning: 0, offline: 0 };

            // Add remainder from previous flush to current ms
            const onlineTotal  = (inc.online  || 0) + rem.online;
            const idleTotal    = (inc.idle    || 0) + rem.idle;
            const warningTotal = (inc.warning || 0) + rem.warning;
            const offlineTotal = (inc.offline || 0) + rem.offline;

            // Floor to whole seconds — guaranteed never to overcount
            const onlineSecs  = Math.floor(onlineTotal  / 1000);
            const idleSecs    = Math.floor(idleTotal    / 1000);
            const warningSecs = Math.floor(warningTotal / 1000);
            const offlineSecs = Math.floor(offlineTotal / 1000);

            // Carry forward the sub-second remainder for next flush
            rem.online  = onlineTotal  - onlineSecs  * 1000;
            rem.idle    = idleTotal    - idleSecs    * 1000;
            rem.warning = warningTotal - warningSecs * 1000;
            rem.offline = offlineTotal - offlineSecs * 1000;
            remByDate.set(stat_date, rem);

            // Skip if all values floor to zero (avoids unnecessary DB writes)
            if (onlineSecs === 0 && idleSecs === 0 && warningSecs === 0 && offlineSecs === 0) continue;

            try {
                await pool.execute(
                    `INSERT INTO device_daily_stats
                       (device_id, stat_date, online_secs, idle_secs, warning_secs, offline_secs)
                     VALUES (?, ?, ?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE
                       online_secs  = online_secs  + VALUES(online_secs),
                       idle_secs    = idle_secs    + VALUES(idle_secs),
                       warning_secs = warning_secs + VALUES(warning_secs),
                       offline_secs = offline_secs + VALUES(offline_secs)`,
                    [device_id, stat_date, onlineSecs, idleSecs, warningSecs, offlineSecs]
                );
            } catch (err) {
                console.error(`[STATS] DB flush error for ${device_id} on ${stat_date}:`, err.message);
                // Re-queue the failed increment (in ms) so it's retried next cycle
                addToFlush(device_id, 'online', inc.online || 0);
                addToFlush(device_id, 'idle', inc.idle || 0);
                addToFlush(device_id, 'warning', inc.warning || 0);
                addToFlush(device_id, 'offline', inc.offline || 0);
            }
        }
    }

    // Housekeeping: prune remainders for dates older than today
    // (prevents unbounded memory growth over weeks/months)
    const today = todayKey();
    for (const [device_id, remByDate] of flushRemainders) {
        for (const dateKey of remByDate.keys()) {
            if (dateKey < today) remByDate.delete(dateKey);
        }
        if (remByDate.size === 0) flushRemainders.delete(device_id);
    }
}
setInterval(() => { flushStatsToDB(); saveCursors(); }, 10 * 1000);

// Graceful shutdown: flush remaining pending data before pm2 restarts/stops.
// pm2 sends SIGINT on restart; without this handler the in-memory buffer is
// permanently lost, causing the 2-3 hour daily gaps seen in history stats.
async function gracefulShutdown(signal) {
    console.log(`[STATS] ${signal} received — flushing pending stats before exit...`);
    saveCursors(); // persist cursors FIRST so restart can credit the gap
    try { await flushStatsToDB(); } catch (e) { console.error('[STATS] Flush on exit failed:', e.message); }
    process.exit(0);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ── Background: credit offline_secs for devices that have gone silent ────────
// Runs every 15 s. If a device has been silent for >= 15 s since its last ping,
// it is considered offline right now and we credit those elapsed seconds.
setInterval(() => {
    const OFFLINE_THRESH_MS = 15 * 1000;
    const now = Date.now();
    for (const [device_id, state] of deviceState) {
        const silentMs = now - state.last_ping;
        if (silentMs < OFFLINE_THRESH_MS) continue; // still alive — heartbeat handles this
        // Device is offline. Credit however many seconds elapsed since we last credited it.
        const prev = deviceLastStatusAt.get(device_id);
        const sinceMs = prev ? (now - prev.since) : silentMs;
        const elapsed = Math.floor(sinceMs / 1000);
        if (elapsed > 0) {
            // Use midnight-aware helper so offline time spanning midnight is
            // attributed to the correct IST date (prev.since → now).
            const offlineSince = prev ? prev.since : (now - sinceMs);
            creditToFlush(device_id, 'offline', offlineSince, now);
            // In-memory uptime counter
            const ut = deviceUptime.get(device_id) || { online: 0, idle: 0, warning: 0, offline: 0 };
            ut.offline += elapsed;
            deviceUptime.set(device_id, ut);
            // Advance the cursor so we don't double-count
            deviceLastStatusAt.set(device_id, { status: 'offline', since: now });
        }
    }
}, 15 * 1000);

function deriveDeviceKey(deviceId) {
    return crypto.createHmac('sha256', MASTER_KEY).update(deviceId).digest('hex');
}

// ============================================================
// CORS — allow the standalone dashboard.html to connect
// Public read endpoints get a wildcard; authenticated panel/device
// endpoints are restricted so arbitrary sites cannot probe them.
// ============================================================
// /api/panel/auth is also public CORS: it's password-protected, so any origin may call it
// (the panel HTML may be opened from file:// or a different host).
const PUBLIC_CORS_PATHS = ['/api/data', '/api/panel/auth'];
app.use((req, res, next) => {
    const isPublic = PUBLIC_CORS_PATHS.some(p => req.path.startsWith(p));
    if (isPublic) {
        res.setHeader('Access-Control-Allow-Origin', '*');
    } else {
        // Restrict to the server's own origin and known admin clients.
        // Adjust this if your panel is hosted on a different domain.
        const allowed = process.env.PANEL_ORIGIN || 'https://YOUR_SERVER_IP_OR_DOMAIN';
        res.setHeader('Access-Control-Allow-Origin', allowed);
        res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-dashboard-key, x-signature, x-timestamp, x-panel-token');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// ============================================================
// SCHEMA VALIDATION
// ============================================================
const batchSchema = joi.object({
    start_time: joi.number().required(),
    end_time: joi.number().required(),
    lot_id: joi.string().max(64).required(),
    units_produced: joi.number().integer().min(1).required(),
    device_id: joi.string().max(32).required(),
    batch_uuid: joi.string().guid({ version: 'uuidv4' }).required(),
    duration: joi.number().integer().min(0).optional(),
    notes: joi.string().max(32).optional().allow('', null)
}).custom((value, helpers) => {
    if (value.end_time <= value.start_time) {
        return helpers.message('end_time must be greater than start_time');
    }
    return value;
});

// ============================================================
// POST /api/upload  —  ESP32 device data ingestion
// ============================================================
app.post('/api/upload', async (req, res) => {
    const { device_id } = req.body;
    const signature = req.headers['x-signature'];
    const timestamp = parseInt(req.headers['x-timestamp']);

    // 1. Replay Protection (5-minute window + signature uniqueness)
    const now = Math.floor(Date.now() / 1000);
    if (!timestamp || Math.abs(now - timestamp) > 300) {
        return res.status(403).json({ error: 'Clock out of sync' });
    }
    if (usedSignatures.has(signature)) {
        return res.status(403).json({ error: 'Replay' });
    }

    // 2. Per-Device HMAC Signature Verification
    const deviceKey = deriveDeviceKey(device_id);
    const payloadString = JSON.stringify(req.body);
    const expectedSignature = crypto
        .createHmac('sha256', deviceKey)
        .update(payloadString + timestamp)
        .digest('hex');

    if (signature !== expectedSignature) {
        return res.status(401).json({ error: 'Invalid authentication' });
    }

    usedSignatures.add(signature);
    // Cap Set size to prevent unbounded memory growth under replay floods
    if (usedSignatures.size > 10000) {
        const oldest = usedSignatures.values().next().value;
        usedSignatures.delete(oldest);
    }
    setTimeout(() => usedSignatures.delete(signature), 310000);

    // 3. Schema Validation
    const { error, value } = batchSchema.validate(req.body);
    if (error) {
        return res.status(400).json({ error: error.details[0].message });
    }

    // 4. Physics-based duration arbitration (3-signal system)
    //
    //  Signal A: value.duration  — reported by ESP32 (wrong after reboot/NTP loss)
    //  Signal B: end_time - start_time — timestamp delta (also wrong after reboot)
    //  Signal C: units / MAX_RATE  — physics floor (independent, always valid)
    //
    //  Observed machine rate: 35–100 units/min → ~1.67 units/sec peak.
    //  MAX_UNITS_PER_SEC = 3 gives a generous physical ceiling.
    //  AVG_UNITS_PER_SEC = 1.25 (75/min) is used to ESTIMATE when both A & B fail.
    {
        const MAX_UNITS_PER_SEC = 3;    // absolute physical maximum (safety margin above observed peak)
        const AVG_UNITS_PER_SEC = 1.25; // observed average — estimation fallback only
        const u = value.units_produced;

        const tsDuration = value.end_time - value.start_time; // seconds
        const reportedDur = value.duration;                     // may be undefined

        // Minimum duration physically possible for this many units
        const physicsMin = Math.ceil(u / MAX_UNITS_PER_SEC);

        const tsOk = tsDuration >= physicsMin;
        const reportedOk = (reportedDur !== undefined) && (reportedDur >= physicsMin);

        if (tsOk && reportedOk) {
            // ── CASE 1: Both plausible ──────────────────────────────────────────
            // Prefer reported duration if it differs meaningfully from ts delta;
            // the ESP32's sys-time is more drift-resistant than NTP timestamps.
            if (reportedDur !== undefined && Math.abs(tsDuration - reportedDur) > 10) {
                value.start_time = value.end_time - reportedDur;
            }
            // Leave value.duration as-is (already the best signal)

        } else if (!tsOk && reportedOk) {
            // ── CASE 2: Timestamps corrupted, duration is plausible ─────────────
            // Reconstruct start_time from the reliable reported duration.
            value.start_time = value.end_time - reportedDur;
            value.duration = reportedDur;
            console.log(`[PHYSICS] ${value.lot_id}: ts delta ${tsDuration}s failed physics (min ${physicsMin}s for ${u} units), using reported ${reportedDur}s`);

        } else if (tsOk && !reportedOk) {
            // ── CASE 3: Duration corrupted, timestamps are plausible ────────────
            // Use the timestamp delta as the authoritative duration.
            value.duration = tsDuration;
            console.log(`[PHYSICS] ${value.lot_id}: reported ${reportedDur}s failed physics (min ${physicsMin}s for ${u} units), using ts delta ${tsDuration}s`);

        } else {
            // ── CASE 4: Both signals corrupted (reboot + NTP loss) ──────────────
            // Fall back to physics estimate. Conservative (avg rate) so we never
            // understate duration. Log clearly so this is visible in server output.
            const estimated = Math.ceil(u / AVG_UNITS_PER_SEC);
            value.duration = estimated;
            value.start_time = value.end_time - estimated;
            console.log(`[PHYSICS] ${value.lot_id}: BOTH signals invalid (ts=${tsDuration}s, reported=${reportedDur}s, min=${physicsMin}s for ${u} units). Estimated ${estimated}s from avg rate.`);
        }
    }


    // 5. Insert (idempotent on duplicate batch_uuid)
    try {
        await pool.execute(
            'INSERT INTO batch_data (start_time, end_time, lot_id, units_produced, device_id, batch_uuid, duration, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [value.start_time, value.end_time, value.lot_id, value.units_produced, value.device_id, value.batch_uuid, value.duration ?? null, value.notes || null]
        );
        res.json({ status: 'success' });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
            return res.json({ status: 'success', note: 'Duplicate ignored' });
        }
        console.error('Upload error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ============================================================
// POST /api/panel/auth  —  IT panel login
// ============================================================
app.post('/api/panel/auth', (req, res) => {
    const { password } = req.body;
    if (!PANEL_PASSWORD) return res.status(500).json({ error: 'PANEL_PASSWORD not configured on server' });
    if (!password || password !== PANEL_PASSWORD) {
        return res.status(401).json({ error: 'Invalid password' });
    }
    const token = genPanelToken();
    panelTokens.set(token, Date.now() + PANEL_TOKEN_TTL);
    return res.json({ token });
});

// Panel auth middleware — used by all /api/panel/* and /api/device/* routes
function requirePanelToken(req, res, next) {
    const token = req.headers['x-panel-token'];
    if (!validatePanelToken(token)) return res.status(401).json({ error: 'Unauthorized — invalid or expired session' });
    next();
}

// ============================================================
// GET /api/devices  —  List all devices with last-seen & stats
// ============================================================
app.get('/api/devices', requirePanelToken, async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT device_id,
                    MAX(created_at)                    AS last_seen,
                    COUNT(*)                           AS total_batches,
                    SUM(CASE WHEN DATE(created_at) = CURDATE() THEN 1 ELSE 0 END) AS batches_today,
                    SUM(CASE WHEN DATE(created_at) = CURDATE() THEN units_produced ELSE 0 END) AS units_today
             FROM batch_data
             GROUP BY device_id
             ORDER BY last_seen DESC`
        );

        const deviceMap = new Map();

        // Populate from DB stats
        for (const row of rows) {
            deviceMap.set(row.device_id, {
                device_id: row.device_id,
                last_seen: new Date(row.last_seen).toISOString(),
                total_batches: row.total_batches,
                batches_today: row.batches_today,
                units_today: row.units_today,
                pending_commands: (commandQueue.get(row.device_id) || []).length,
                status: 'Unknown',
                error_msg: '',
                error_solution: ''
            });
        }

        // Merge with real-time heartbeat state
        for (const [did, state] of deviceState.entries()) {
            if (!deviceMap.has(did)) {
                deviceMap.set(did, {
                    device_id: did,
                    last_seen: new Date(state.last_ping).toISOString(),
                    total_batches: 0,
                    batches_today: 0,
                    units_today: 0,
                    pending_commands: (commandQueue.get(did) || []).length,
                    status: state.status,
                    error_msg: state.error_msg,
                    error_solution: state.error_solution,
                    idle_time: state.idle_time // new explicit field sent by esp32
                });
            } else {
                const dev = deviceMap.get(did);
                const dbTime = new Date(dev.last_seen).getTime();
                // If heartbeat was more recent, update last_seen
                if (state.last_ping > dbTime) {
                    dev.last_seen = new Date(state.last_ping).toISOString();
                }
                dev.status = state.status;
                dev.error_msg = state.error_msg;
                dev.error_solution = state.error_solution;
                dev.idle_time = state.idle_time;
                dev.current_strokes = state.current_strokes || 0;
                dev.batch_lot = state.batch_lot || 'Idle';
            }
        }

        // Apply offline inference
        const now = Date.now();
        const devices = Array.from(deviceMap.values());
        for (const d of devices) {
            const diffMin = (now - new Date(d.last_seen).getTime()) / 60000;
            // If device idle for > 10 min, assume it lost connection regardless of its reported state
            if (diffMin > 10 && d.status !== 'Unknown') {
                d.status = 'Device lost connection';
                d.error_msg = 'Device has missed heartbeats';
                d.error_solution = 'Check device power and WiFi/Internet access';
            }
        }

        devices.sort((a, b) => new Date(b.last_seen) - new Date(a.last_seen));

        return res.json({ devices });
    } catch (err) {
        console.error('Devices API error:', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================================
// POST /api/device/restart  —  Queue a restart command
// ============================================================
app.post('/api/device/restart', requirePanelToken, (req, res) => {
    const { device_id } = req.body;
    if (!device_id) return res.status(400).json({ error: 'device_id required' });
    const queue = commandQueue.get(device_id) || [];
    queue.push({ cmd: 'RESTART', ts: Date.now() });
    commandQueue.set(device_id, queue);
    return res.json({ status: 'queued', pending: queue.length });
});

// ============================================================
// POST /api/device/command  —  Queue any named command
// ============================================================
app.post('/api/device/command', requirePanelToken, (req, res) => {
    const { device_id, cmd } = req.body;
    if (!device_id || !cmd) return res.status(400).json({ error: 'device_id and cmd required' });
    const allowed = ['RESTART', 'CLEAR_FLAGS', 'FORCE_SYNC'];
    if (!allowed.includes(cmd)) return res.status(400).json({ error: 'Unknown command' });
    const queue = commandQueue.get(device_id) || [];
    queue.push({ cmd, ts: Date.now() });
    commandQueue.set(device_id, queue);
    return res.json({ status: 'queued', pending: queue.length });
});

// ============================================================
// POST /api/device/heartbeat  —  ESP32 sends status and gets commands
// ============================================================
app.post('/api/device/heartbeat', async (req, res) => {
    const { device_id, status, error_msg, error_solution, idle_time, current_strokes, batch_lot } = req.body;
    const signature = req.headers['x-signature'];
    const timestamp = parseInt(req.headers['x-timestamp']);
    const now = Math.floor(Date.now() / 1000);

    if (!device_id) return res.status(400).json({ error: 'device_id required' });
    if (!timestamp || Math.abs(now - timestamp) > 300) return res.status(403).json({ error: 'Clock out of sync' });

    const deviceKey = deriveDeviceKey(device_id);
    const payloadStr = JSON.stringify(req.body);
    const expected = crypto.createHmac('sha256', deviceKey).update(payloadStr + timestamp).digest('hex');

    if (signature !== expected) {
        console.log(`[AUTH FAILED] Device: ${device_id}`);
        console.log(`[AUTH FAILED] Received Sig: ${signature}`);
        console.log(`[AUTH FAILED] Expected Sig: ${expected}`);
        console.log(`[AUTH FAILED] Payload String Used: ${payloadStr}`);
        console.log(`[AUTH FAILED] Timestamp Used: ${timestamp}`);
        return res.status(401).json({ error: 'Invalid authentication' });
    }

    // Track heartbeat state
    const prevState = deviceState.get(device_id);

    // Compute current UI status to accumulate uptime accurately
    const nowMs = Date.now();
    let derivedStatus = 'online';
    if (!status || status === '' || status === 'Unknown') derivedStatus = 'online';
    else if (status !== 'Running Normally') derivedStatus = 'warning';
    if (idle_time > 300) derivedStatus = 'idle'; // >5 min idle overrides warning if no errors
    if (status !== 'Running Normally' && status !== '' && status !== 'Unknown' && status !== undefined) derivedStatus = 'warning';
    // Resolved: online wins only when running normally + activity
    if (status === 'Running Normally' && (!idle_time || idle_time <= 300)) derivedStatus = 'online';
    if (status === 'Running Normally' && idle_time > 300) derivedStatus = 'idle';

    accumulateUptime(device_id, derivedStatus);

    deviceState.set(device_id, {
        last_ping: Date.now(),
        status: status || 'Running Normally',
        error_msg: error_msg || '',
        error_solution: error_solution || '',
        idle_time: idle_time || 0,
        current_strokes: current_strokes !== undefined ? parseInt(current_strokes) : 0,
        batch_lot: batch_lot || 'Idle'
    });

    // NOTE: active_secs / idle_secs from the ESP32 payload are NOT used for
    // uptime accounting. `accumulateUptime()` above already tracks every
    // second accurately via status-transition wall-clock cursors (shared with
    // the 15s offline timer). Adding the ESP32 pools on top caused every
    // online/idle period to be counted twice, producing >24h daily totals.

    const COMMAND_TTL_MS = 10 * 60 * 1000; // 10 minutes — discard stale commands
    const allQueued = commandQueue.get(device_id) || [];
    const freshQueue = allQueued.filter(c => Date.now() - c.ts < COMMAND_TTL_MS);
    const staleCount = allQueued.length - freshQueue.length;
    if (staleCount > 0) console.log(`[CMD] Dropped ${staleCount} stale command(s) for ${device_id}`);
    commandQueue.set(device_id, []); // Clear after fetch
    return res.json({ commands: freshQueue });
});

// ============================================================
// GET /api/device/uptime  —  Return accumulated time per status
// ============================================================
app.get('/api/device/uptime', requirePanelToken, (req, res) => {
    const { device_id } = req.query;
    if (!device_id) return res.status(400).json({ error: 'device_id required' });
    const ut = deviceUptime.get(device_id) || { online: 0, idle: 0, warning: 0, offline: 0 };
    // Add currently-accumulating slot
    const current = deviceLastStatusAt.get(device_id);
    const result = { ...ut };
    if (current) {
        const elapsed = Math.floor((Date.now() - current.since) / 1000);
        result[current.status] = (result[current.status] || 0) + elapsed;
    }
    return res.json({ device_id, uptime: result });
});

// ============================================================
// POST /api/device/uptime/reset  —  Reset in-memory uptime counters only
// ============================================================
app.post('/api/device/uptime/reset', requirePanelToken, (req, res) => {
    const { device_id } = req.body;
    if (!device_id) return res.status(400).json({ error: 'device_id required' });
    deviceUptime.set(device_id, { online: 0, idle: 0, warning: 0, offline: 0 });
    const current = deviceLastStatusAt.get(device_id);
    if (current) deviceLastStatusAt.set(device_id, { status: current.status, since: Date.now() });
    return res.json({ status: 'reset', device_id });
});

// ============================================================
// GET /api/device/stats  —  Historical daily stats for a device
// Query params: device_id (required), from (YYYY-MM-DD), to (YYYY-MM-DD)
// Defaults to last 30 days if no range supplied.
// ============================================================
app.get('/api/device/stats', requirePanelToken, async (req, res) => {
    const { device_id } = req.query;
    if (!device_id) return res.status(400).json({ error: 'device_id required' });

    // Default: last 30 days
    const toDate = req.query.to || todayKey();
    const fromDate = req.query.from || (() => {
        const d = new Date(Date.now() + 5.5 * 3600 * 1000 - 29 * 86400 * 1000);
        return d.toISOString().slice(0, 10);
    })();

    try {
        const [rows] = await pool.execute(
            `SELECT stat_date,
                    online_secs, idle_secs, warning_secs, offline_secs,
                    (online_secs + idle_secs + warning_secs + offline_secs) AS total_secs
             FROM device_daily_stats
             WHERE device_id = ? AND stat_date BETWEEN ? AND ?
             ORDER BY stat_date ASC`,
            [device_id, fromDate, toDate]
        );

        // Merge today's in-memory pending data if not yet flushed
        const todayStr = todayKey();
        const pending = (pendingFlush.get(device_id) || new Map()).get(todayStr);
        let result = rows.map(r => ({
            date: r.stat_date instanceof Date ? r.stat_date.toISOString().slice(0, 10) : String(r.stat_date).slice(0, 10),
            online: r.online_secs,
            idle: r.idle_secs,
            warning: r.warning_secs,
            offline: r.offline_secs,
            total: r.total_secs
        }));

        if (pending) {
            // pendingFlush stores milliseconds; convert to seconds for the API
            // Include carried-forward remainder for accuracy
            const rem = ((flushRemainders.get(device_id) || new Map()).get(todayStr)) || { online: 0, idle: 0, warning: 0, offline: 0 };
            const pendOnline  = Math.floor(((pending.online  || 0) + rem.online)  / 1000);
            const pendIdle    = Math.floor(((pending.idle    || 0) + rem.idle)    / 1000);
            const pendWarning = Math.floor(((pending.warning || 0) + rem.warning) / 1000);
            const pendOffline = Math.floor(((pending.offline || 0) + rem.offline) / 1000);

            const existing = result.find(r => r.date === todayStr);
            if (existing) {
                existing.online += pendOnline;
                existing.idle += pendIdle;
                existing.warning += pendWarning;
                existing.offline += pendOffline;
                existing.total = existing.online + existing.idle + existing.warning + existing.offline;
            } else if (toDate >= todayStr) {
                result.push({
                    date: todayStr,
                    online: pendOnline,
                    idle: pendIdle,
                    warning: pendWarning,
                    offline: pendOffline,
                    total: pendOnline + pendIdle + pendWarning + pendOffline
                });
            }
        }

        return res.json({ device_id, from: fromDate, to: toDate, rows: result });
    } catch (err) {
        console.error('[STATS] Query error:', err.message);
        return res.status(500).json({ error: 'Database error' });
    }
});

// ============================================================
// GET /api/device/stats/summary  —  Totals across a date range
// ============================================================
app.get('/api/device/stats/summary', requirePanelToken, async (req, res) => {
    const { device_id } = req.query;
    if (!device_id) return res.status(400).json({ error: 'device_id required' });
    const toDate = req.query.to || todayKey();
    const fromDate = req.query.from || (() => {
        const d = new Date(Date.now() + 5.5 * 3600 * 1000 - 29 * 86400 * 1000);
        return d.toISOString().slice(0, 10);
    })();
    try {
        const [rows] = await pool.execute(
            `SELECT
                SUM(online_secs)  AS online,
                SUM(idle_secs)    AS idle,
                SUM(warning_secs) AS warning,
                SUM(offline_secs) AS offline
             FROM device_daily_stats
             WHERE device_id = ? AND stat_date BETWEEN ? AND ?`,
            [device_id, fromDate, toDate]
        );
        const r = rows[0] || {};
        return res.json({
            device_id, from: fromDate, to: toDate,
            summary: { online: r.online || 0, idle: r.idle || 0, warning: r.warning || 0, offline: r.offline || 0 }
        });
    } catch (err) {
        return res.status(500).json({ error: 'Database error' });
    }
});

// ============================================================
// POST /api/device/log  —  ESP32 sends serial log lines (HMAC)
// ============================================================
app.post('/api/device/log', async (req, res) => {
    const { device_id, message } = req.body;
    const signature = req.headers['x-signature'];
    const timestamp = parseInt(req.headers['x-timestamp']);
    const now = Math.floor(Date.now() / 1000);
    if (!device_id || !message) return res.status(400).json({ error: 'device_id and message required' });
    if (!timestamp || Math.abs(now - timestamp) > 300) return res.status(403).json({ error: 'Clock out of sync' });
    const deviceKey = deriveDeviceKey(device_id);
    const payloadStr = JSON.stringify(req.body);
    const expected = crypto.createHmac('sha256', deviceKey).update(payloadStr + timestamp).digest('hex');
    if (signature !== expected) return res.status(401).json({ error: 'Invalid authentication' });
    const logs = deviceLogs.get(device_id) || [];
    logs.push({ ts: Date.now(), message: String(message).substring(0, 512) });
    if (logs.length > LOG_LIMIT) logs.splice(0, logs.length - LOG_LIMIT);
    deviceLogs.set(device_id, logs);
    return res.json({ status: 'ok' });
});

// ============================================================
// GET /api/device/logs  —  Retrieve serial logs for a device
// ============================================================
app.get('/api/device/logs', requirePanelToken, (req, res) => {
    const { device_id, limit } = req.query;
    if (!device_id) return res.status(400).json({ error: 'device_id required' });
    const n = Math.min(200, Math.max(1, parseInt(limit) || 50));
    const logs = (deviceLogs.get(device_id) || []).slice(-n);
    return res.json({ logs });
});

// ============================================================
// GET /api/data  —  Dashboard data with filtering & pagination
// ============================================================
app.get('/api/data', async (req, res) => {
    // Authenticate with the separate dashboard-only key
    if (!DASHBOARD_KEY || req.headers['x-dashboard-key'] !== DASHBOARD_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(10000, Math.max(1, parseInt(req.query.limit) || 50));
        const offset = (page - 1) * limit;
        const lot_id = req.query.lot_id || null;
        const device_id = req.query.device_id || null;
        const from = req.query.from || null; // YYYY-MM-DD
        const to = req.query.to || null;

        // Build dynamic WHERE clause
        const conditions = [];
        const params = [];
        if (lot_id) { conditions.push('lot_id LIKE ?'); params.push(`%${lot_id}%`); }
        if (device_id) { conditions.push('device_id LIKE ?'); params.push(`%${device_id}%`); }
        // Shift-aware date filtering: a batch belongs to "shift date YYYY-MM-DD"
        // when its start_time falls in [06:30 IST on that date, 06:30 IST on next date).
        // 06:30 IST = 01:00 UTC, so offset = 1 hour = 3600 seconds.
        // The `from` and `to` query params are YYYY-MM-DD strings in IST.
        if (from) {
            // Shift day starts at 06:30 IST = 01:00 UTC on the given date
            const fromEpoch = Math.floor(new Date(from + 'T01:00:00Z').getTime() / 1000);
            conditions.push('start_time >= ?');
            params.push(fromEpoch);
        }
        if (to) {
            // Shift day ends (exclusive) at 06:30 IST = 01:00 UTC on the NEXT date
            const toDate = new Date(to + 'T01:00:00Z');
            toDate.setUTCDate(toDate.getUTCDate() + 1); // advance to next day's 06:30 IST
            const toEpoch = Math.floor(toDate.getTime() / 1000);
            conditions.push('start_time < ?');
            params.push(toEpoch);
        }

        const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

        // Aggregate stats (for KPI cards — across the full filter, not just this page)
        const [statsRows] = await pool.query(
            `SELECT COUNT(*)                      AS total,
              COALESCE(SUM(units_produced), 0) AS totalUnits,
              COUNT(DISTINCT lot_id)           AS uniqueLots,
              COUNT(DISTINCT device_id)        AS uniqueDevices
       FROM batch_data ${where}`,
            params
        );
        const stats = statsRows[0];
        const totalPages = Math.ceil(stats.total / limit) || 1;

        // Paginated rows
        const [rows] = await pool.query(
            `SELECT id, lot_id, units_produced, device_id, start_time, end_time,
                    IFNULL(duration, end_time - start_time) AS duration,
                    created_at, batch_uuid, notes
       FROM batch_data ${where}
       ORDER BY id DESC
       LIMIT ? OFFSET ?`,
            [...params, limit, offset]
        );

        return res.json({
            data: rows,
            meta: {
                page,
                limit,
                total: Number(stats.total),
                totalPages,
                totalUnits: Number(stats.totalUnits),
                uniqueLots: Number(stats.uniqueLots),
                uniqueDevices: Number(stats.uniqueDevices)
            }
        });
    } catch (err) {
        console.error('Dashboard API error:', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================================
// START
// ============================================================
loadCursors(); // retroactively credit gap since last shutdown as offline
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
