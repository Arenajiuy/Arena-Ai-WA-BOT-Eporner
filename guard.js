/**
 * guard.js — Arena AI safety + anti-ban helpers (v2.8)
 *
 *  🔒 Owner-only:  commands run ONLY for messages YOU send (fromMe + participant check)
 *                  default = "Message yourself" chat only  (.mode all → your commands work in any chat)
 *  🛡️ Anti-ban:    rate limit, human-like reply delay, paced sending (one message at a time),
 *                  reconnect backoff, stop on ban / 2nd instance, no spam announcements
 *  🙈 Privacy:     secrets masked in logs, no phone number on the status page
 *
 *  ⚠️ No bot can be 100% ban-proof — WhatsApp does not allow unofficial clients.
 *     This keeps the account looking like a normal, quiet linked device.
 */
const fs = require('fs');
const path = require('path');

const SET = path.join(__dirname, 'settings.json');
const readSet = () => { try { return JSON.parse(fs.readFileSync(SET, 'utf8')); } catch { return {}; } };
const writeSet = (d) => { try { fs.writeFileSync(SET, JSON.stringify(d, null, 2)); } catch { } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── chat mode ─────────────────────────────────────────────
function chatMode() { return (process.env.ARENA_CHATS || readSet().chats || 'self') === 'all' ? 'all' : 'self'; }
function setChatMode(m) { const d = readSet(); d.chats = m === 'all' ? 'all' : 'self'; writeSet(d); }

/** never react in these chats (status updates, channels, broadcast lists) */
const ignoredChat = (jid) => !jid || jid === 'status@broadcast' || /@(newsletter|broadcast)$/.test(jid);

// ── rate limit (commands) ─────────────────────────────────
const hits = [];
let lastWarn = 0;
function rateCheck(now = Date.now()) {
    const perMin = parseInt(process.env.ARENA_RATE_MIN || '10', 10);
    const perHour = parseInt(process.env.ARENA_RATE_HOUR || '120', 10);
    while (hits.length && now - hits[0] > 3600e3) hits.shift();
    const inMin = hits.filter((t) => now - t < 60e3);
    let wait = 0;
    if (inMin.length >= perMin) wait = 60e3 - (now - inMin[0]);
    else if (hits.length >= perHour) wait = 3600e3 - (now - hits[0]);
    if (wait > 0) {
        const warn = now - lastWarn > 60e3;          // warn at most once a minute (no reply spam)
        if (warn) lastWarn = now;
        return { ok: false, wait: Math.ceil(wait / 1000), warn };
    }
    hits.push(now);
    return { ok: true };
}

// ── human-like pacing for outgoing messages ───────────────
/** run send jobs one by one, with a minimum gap between them */
function pacer(minGap = parseInt(process.env.ARENA_SEND_GAP || '1200', 10)) {
    let chain = Promise.resolve(), last = 0;
    return (fn) => {
        const p = chain.then(async () => {
            const w = last + minGap - Date.now();
            if (w > 0) await sleep(w);
            try { return await fn(); } finally { last = Date.now(); }
        });
        chain = p.catch(() => { });
        return p;
    };
}
/** small random "typing" delay before the FIRST reply to a command (not for edits) */
const humanDelay = () => process.env.ARENA_NO_DELAY ? Promise.resolve() : sleep(700 + Math.floor(Math.random() * 1300));

// ── reconnect backoff ─────────────────────────────────────
const backoff = (n) => Math.min(3000 * 2 ** n, 5 * 60e3) + Math.floor(Math.random() * 2000);

// ── announce "online" at most once every 6 h (restarts don't spam) ──
function shouldAnnounce(now = Date.now()) {
    const d = readSet();
    if (d.lastAnnounce && now - d.lastAnnounce < 6 * 3600e3) return false;
    d.lastAnnounce = now; writeSet(d); return true;
}

// ── hide secrets in console logs ──────────────────────────
function maskLog(t) {
    return String(t)
        .replace(/(\.(?:setkey|delkey)\s+\S+\s+)\S+/i, '$1••••')
        .replace(/\/\/[^@/\s]*@/g, '//***@')
        .replace(/\b(AIza[\w-]{6})[\w-]+/g, '$1••••')
        .replace(/\b(gsk_\w{4})\w+/g, '$1••••');
}

module.exports = { chatMode, setChatMode, ignoredChat, rateCheck, pacer, humanDelay, backoff, shouldAnnounce, maskLog, sleep, _hits: hits };
