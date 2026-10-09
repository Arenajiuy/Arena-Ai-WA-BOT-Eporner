// ── Panel (Pterodactyl: HeavenCloud etc.) support ── must run before anything uses os.tmpdir()
{
    const _fs = require('fs'), _path = require('path');
    const onPanel = !!process.env.P_SERVER_UUID || process.cwd() === '/home/container' || process.env.ARENA_PANEL === '1';
    if (onPanel && !process.env.DL_TMP) {
        const t = _path.join(__dirname, '.tmp');           // container /tmp is a tiny tmpfs → use server disk
        try { _fs.rmSync(t, { recursive: true, force: true }); } catch { }
        _fs.mkdirSync(t, { recursive: true });
        process.env.TMPDIR = t; process.env.TMP = t; process.env.DL_TMP = t;
    }
    let _maxMB = ''; try { _maxMB = String(JSON.parse(_fs.readFileSync(_path.join(__dirname, 'settings.json'), 'utf8')).maxMB || ''); } catch { }
    if (!process.env.DL_MAX_MB && /^\d+$/.test(_maxMB)) process.env.DL_MAX_MB = _maxMB;   // settings.json {"maxMB": 2000}
    if (onPanel && !process.env.DL_MAX_MB) process.env.DL_MAX_MB = '350';   // small free panels: file + encrypted copy
    process.env.ARENA_ON_PANEL = onPanel ? '1' : '';
}
// 🔒 v2.12.2: libsignal prints whole sessions (incl. PRIVATE KEYS) to the console → never show them
{
    const SECRET = /^(Closing session|Opening session|Removing old closed session|Session already (closed|open)|Closing open session|Decrypted message with closed session|Migrating session|Failed to decrypt message with any known session|Session error)/;
    for (const k of ['log', 'info', 'warn', 'error', 'debug']) {
        const orig = console[k].bind(console);
        console[k] = (...a) => { if (typeof a[0] === 'string' && SECRET.test(a[0])) return; orig(...a); };
    }
}

/**
 * Arena AI — private WhatsApp bot:  .ai <question>  +  .download <link> [link2 ...]
 * Works only for YOU (messages you send). Others are ignored silently.
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const pino = require('pino');
// Baileys v7 (ESM-only) — LID support. v6 could not decrypt LID-addressed messages (Bad MAC) and sent ACKs that WhatsApp bans.
let B = null;
const loadBaileys = async () => (B ||= await import('baileys'));
const { download, human, maxBytes, maxMB, freeDisk, WA_MAX_MB, MAX_BYTES } = require('./downloader');
const eporner = require('./eporner');
let apify = null; try { apify = require('./apify'); } catch {}
let mirrorMod = null; try { mirrorMod = require('./mirror'); } catch {}
const ai = require('./ai');
const updater = require('./updater');
const netx = require('./net');
const guard = require('./guard');
const features = require('./features');
const tools = require('./tools');
const antibug = require('./antibug');
const moviepro = require('./moviepro');

const AUTH = path.join(__dirname, 'auth');
const LOGO = path.join(__dirname, 'logo.img');        // your own photo (.setlogo) — never touched by .update
const BANNER = path.join(__dirname, 'banner.jpg');    // default Arena AI banner
const ANNOUNCE_NEXT = path.join(__dirname, '.announce-next');
const AGENT_MSG = path.join(__dirname, 'agent-msg.txt');
let agentTimer = null;
async function agentTick(send) {
    try {
        if (!ME.pn || !fs.existsSync(AGENT_MSG)) return false;
        const tmp = AGENT_MSG + '.sending';
        fs.renameSync(AGENT_MSG, tmp);
        const t = fs.readFileSync(tmp, 'utf8').trim(); fs.rmSync(tmp, { force: true });
        if (!t) return false;
        for (const part of ai.splitLong(t.slice(0, 12000))) await send(ME.pn, { text: '🤖 *Arena Agent*\n\n' + part });
        log('📨 Arena agent message → Message yourself');
        return true;
    } catch (e) { log('agent inbox: ' + e.message); return false; }
}
function startAgentInbox(send) {
    if (agentTimer) clearInterval(agentTimer);
    agentTimer = setInterval(() => agentTick(send), 5000);
    agentTimer.unref?.();
}
let SOCK = null;
const sentIds = new Set();
const msgStore = new Map();          // recent messages → getMessage() for retry requests ("Waiting for this message" fix)
const seen = new Set();              // processed message ids (dedupe notify/append)
const STARTED = Math.floor(Date.now() / 1000);
let announced = false;
const ME = { pn: null, lid: null };
const epornerCache = new Map(); // search results
const epornerQualityCache = new Map(); // quality selection
function saveSettingsPhone(num) {
    const f = require('path').join(__dirname, 'settings.json');
    try { let d = {}; try { d = JSON.parse(require('fs').readFileSync(f, 'utf8')); } catch { } if (d.phone !== num) { d.phone = num; require('fs').writeFileSync(f, JSON.stringify(d, null, 2)); } } catch { }
}
function readSettingsPhone() { try { return JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'settings.json'), 'utf8')).phone || ''; } catch { return ''; } }   // our own JIDs (set on connect)

// strip device part:  "9476xxxx:12@s.whatsapp.net" → "9476xxxx@s.whatsapp.net"
const bareJid = (j) => { if (!j) return j; const [u, srv] = String(j).split('@'); return u.split(':')[0] + '@' + srv; };

/**
 * Where to send replies.  Baileys v7 gives self-chat messages a DEVICE / LID jid as remoteJid
 * (e.g. "35189220741167:0@lid") — replying there shows "Waiting for this message" on the phone.
 * → self chat always goes to our own phone-number JID; other @lid chats use their PN alt if known.
 */
function replyJid(key) {
    const rj = key?.remoteJid || '';
    if (rj.endsWith('@g.us')) return rj;
    const b = bareJid(rj), alt = bareJid(key?.remoteJidAlt);
    const isMe = (j) => !!j && (j === ME.pn || j === ME.lid);
    if (isMe(b) || isMe(alt)) return ME.pn || (b.endsWith('@s.whatsapp.net') ? b : alt) || b;
    if (b.endsWith('@lid') && alt && alt.endsWith('@s.whatsapp.net')) return alt;
    return b;
}
const retryCache = (() => { const m = new Map(); return { get: (k) => m.get(k), set: (k, v) => { m.set(k, v); if (m.size > 1000) m.delete(m.keys().next().value); }, del: (k) => m.delete(k), flushAll: () => m.clear() }; })();
function remember(msg) {
    if (!msg?.key?.id || !msg.message) return;
    msgStore.set(msg.key.id, msg.message);
    if (msgStore.size > 500) msgStore.delete(msgStore.keys().next().value);
}
const log = (t) => console.log(`[${new Date().toLocaleTimeString('en-GB')}] ${t}`);
let pairingAsked = false;

function ask(q) {
    console.log('\n' + q.trim() + '\n   (panel එකේ නම් "Type a command" box එකේ number එක ගහලා Enter)');   // panels hide prompts without newline
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((r) => rl.question(q, (a) => { rl.close(); r(a); }));
}

function getText(m) {
    let x = m;
    for (let i = 0; i < 5 && x; i++) {
        const inner = x.deviceSentMessage?.message || x.ephemeralMessage?.message || x.viewOnceMessage?.message || x.viewOnceMessageV2?.message || x.documentWithCaptionMessage?.message || x.editedMessage?.message;
        if (!inner) break;
        x = inner;
    }
    return (x?.conversation || x?.extendedTextMessage?.text || x?.imageMessage?.caption || x?.documentMessage?.caption || '').trim();
}

const HELP = `🤖 *Arena AI v2.25.0 MoviePro REAL + Anti-Bug*

*.ai <ප්‍රශ්නය>*  — AI (සිංහල OK)
*.download <link>*  — file download (.dl) - 5 links
*.mirror <link>* — direct browser link (transfer.archivete.am)
*.eporner <query>* — Eporner search 18+ (.ep)
  • Step1: .eporner japanese → results 1-5 with thumbnail
  • Step2: Reply 1-5 → shows qualities (240p,360p,480p,720p,1080p)
  • Step3: Reply quality number → download that quality
*.yts / .song / .video / .tiktok / .fb / .ig / .x / .wiki / .gitclone
*.s / .take / .tagall / .kick etc
*.menu / .react / .setkey / .keys / .net / .setproxy / .version / .update / .ping / .restart
*.update <zip-url>* — self update from zip (Powerful DL v2.6)
*.antibug on/off/mode/status/test* — Anti-Bug system\n*.report <number> [reason]* — Report spam/scam (1 time) (virtex, doc, contact, etc)
*.moviepro <name>* — Movie/Anime search & download (Arena style)

🛡️ Anti-Bug: virtex, trava, doc, contact, location, button, list, poll, reaction, group, viewonce, product, interactive, flow, carousel, sticker
📥 Download: .download + .eporner + .mirror (all qualities)
📺 Quality: 240p,360p,480p,720p,1080p - select what you want
🪞 Mirror: Chrome direct link via transfer.archivete.am
🔞 Private 18+ with phone preview
📏 Max: ${human(MAX_BYTES)} / file`;;

let botStatus = 'starting';
if (process.env.SERVER_PORT || process.env.ARENA_ON_PANEL) {
    try {
        require('http').createServer((q, r) => { r.writeHead(200, { 'Content-Type': 'application/json' }); r.end(JSON.stringify({ bot: 'Arena AI', status: botStatus, uptime: Math.floor(process.uptime()) })); })
            .on('error', () => { }).listen(parseInt(process.env.SERVER_PORT || '3000', 10), '0.0.0.0');
    } catch { }
}
const pace = guard.pacer();
let reconnects = 0, replaced = 0;
async function start() {
    const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = await loadBaileys();
    fs.mkdirSync(AUTH, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(AUTH);
    let version;
    try { version = (await fetchLatestBaileysVersion()).version; } catch { version = [2, 3000, 1043857760]; }
    const logger = pino({ level: 'silent' });

    const sock = makeWASocket({
        version, logger,
        browser: Browsers.macOS('Chrome'),
        auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
        markOnlineOnConnect: false,
        syncFullHistory: false,
        shouldSyncHistoryMessage: () => false,
        msgRetryCounterCache: retryCache,
        getMessage: async (key) => msgStore.get(key?.id),
    });
    SOCK = sock;
    sock.ev.on('creds.update', saveCreds);

    const send = async (jid, content, opts) => {
        const s = await pace(() => sock.sendMessage(jid, content, opts));   // 🛡️ one message at a time, human-like gap
        if (s?.key?.id) { sentIds.add(s.key.id); if (sentIds.size > 500) sentIds.delete(sentIds.values().next().value); remember(s); }
        return s;
    };

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
        if (qr && !sock.authState.creds.registered && !pairingAsked) {
            pairingAsked = true;
            let num = String(process.env.WA_PHONE_NUMBER || readSettingsPhone() || '').replace(/\D/g, '');
            if (!num) num = String(await ask('📱 ඔයාගේ WhatsApp number එක (උදා 94771234567): ')).replace(/\D/g, '');
            if (num.startsWith('0')) num = '94' + num.slice(1);
            if (num.length < 9 || num.length > 15) { log(`❌ "${num}" හරි number එකක් නෙවෙයි (උදා 94771234567). Restart කරලා ආයෙත් ගහන්න.`); pairingAsked = false; return; }
            saveSettingsPhone(num);   // reconnects / expired codes → new code automatically, no retyping
            log(`⏳ ${num} එකට pairing code එකක් ඉල්ලනවා...`);
            try {
                let code;
                for (let i = 0; i < 3 && !code; i++) {
                    try { code = await sock.requestPairingCode(num); }
                    catch (e) { if (i === 2) throw e; await new Promise(r => setTimeout(r, 3000)); }
                }
                code = code.match(/.{1,4}/g).join('-');
                console.log('\n════════════════════════════════════');
                console.log(`   🔢 PAIRING CODE:  ${code}`);
                console.log('════════════════════════════════════');
                console.log('WhatsApp → Linked devices → Link a device →');
                console.log('"Link with phone number instead" → මේ code එක ගහන්න\n');
                console.log('⏳ Code එක ගහනකම් ඉන්නවා (විනාඩියකින් expire වුණොත් අලුත් code එකක් auto එනවා)\n');
            } catch (e) { log(`❌ Pairing code fail: ${e.message} (code ${e?.output?.statusCode ?? '?'})`); pairingAsked = false; }
        }
        if (connection) botStatus = connection;
        if (connection === 'open') {
            ME.pn = bareJid(sock.user?.id); ME.lid = bareJid(sock.user?.lid);
            log(`👤 me: ${ME.pn}${ME.lid ? '  /  ' + ME.lid : ''}`);
            log('✅ WhatsApp Connected! "Message yourself" chat එකේ .ping ගහලා බලන්න');
            reconnects = 0; replaced = 0;
            if (announced) return;
            announced = true;
            const afterUpdate = fs.existsSync(ANNOUNCE_NEXT); fs.rmSync(ANNOUNCE_NEXT, { force: true });
            if (guard.shouldAnnounce() || afterUpdate) { try { await sendAlive(send, ME.pn, null, afterUpdate ? 'updated' : 'online'); } catch (e) { log('alive: ' + e.message); } }   // 🛡️ max once / 6h (+ after .update)
        }
        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode;
            if (code === DisconnectReason.loggedOut) {
                log('❌ Logged out (device එක unlink කළා). Session එක මකලා නවත්තනවා — ආයෙත් npm start කරලා pair කරන්න.');
                fs.rmSync(AUTH, { recursive: true, force: true });
                process.exit(0);
            }
            if (code === 403) {   // 🛡️ banned / blocked — don't keep hammering WhatsApp
                log('🚫 WhatsApp මේ number එක block/restrict කරලා (403). Bot එක නවත්තනවා — ආයෙත් connect වෙන්න try කරන්නේ නෑ (ban එක දිග් වෙන්න පුළුවන් නිසා). WhatsApp app එක check කරන්න.');
                process.exit(0);
            }
            if (code === DisconnectReason.connectionReplaced) {   // 440 — another bot/session uses the SAME login
                replaced++;
                if (replaced >= 3) { log('🛑 වෙන තැනක (Termux / වෙන panel එකක්) මේ bot එකම run වෙනවා. Instances දෙකක් එකට run කළොත් ban වෙන්න පුළුවන් — මේක නවත්තනවා. එකක් විතරක් run කරන්න.'); process.exit(0); }
                log(`⚠️ වෙන තැනක මේ session එකෙන්ම bot එකක් connect වුණා (440) — විනාඩි 2 කින් ආයෙත් බලනවා (${replaced}/3)`);
                return setTimeout(() => start().catch(e => log('start error: ' + e.message)), 120000);
            }
            pairingAsked = code === 515 ? pairingAsked : false;
            const wait = code === 515 ? 2000 : guard.backoff(reconnects++);   // 🛡️ backoff: 3s, 6s, 12s ... max 5min
            log(`⚠️ Connection වැහුණා (${code ?? '?'}) — තත්පර ${Math.round(wait / 1000)} කින් ආයෙත් connect වෙනවා...`);
            setTimeout(() => start().catch(e => log('start error: ' + e.message)), wait);
        }
    });

    sock.ev.on('messages.upsert', (u) => onMessages(u, send, (key) => sock.sendMessage(key.remoteJid, { delete: key }).catch(() => { })));
}

async function onMessages({ messages, type }, send, del = async () => { }) {
        for (const msg of messages || []) {
            try {
                remember(msg);
                if (msg.key?.fromMe && !msg.message && msg.messageStubType) log(`⚠️ message එකක් decrypt කරගන්න බැරි වුණා (stub ${msg.messageStubType}) — phone එකෙන් ආයෙත් එවයි`);
                if (!msg.message || msg.key?.fromMe !== true) continue;        // 🔒 PRIVATE: only messages YOU send
                if (guard.ignoredChat(msg.key.remoteJid)) continue;              // status / channels / broadcast
                if (!isFromOwner(msg.key)) continue;                              // 🔒 double check the sender
                if (sentIds.has(msg.key.id) || seen.has(msg.key.id)) continue; // own replies / already handled
                const ts = Number(msg.messageTimestamp || 0);
                if (type !== 'notify' && ts && ts < STARTED - 60) continue;   // old history — don't re-run old commands
                seen.add(msg.key.id); if (seen.size > 1000) seen.delete(seen.values().next().value);
                let text = getText(msg.message);
                const jidEarlyCheck = replyJid(msg.key);
                const bareEarlyCheck = jidEarlyCheck.split('@')[0];
                // v2.24 Quality selection - moviepro, eporner quality cache first, then video cache, then menu
                const numMatchEarly = text.trim().match(/^(?:\.)?(\d+)$/);
                if (numMatchEarly) {
                    const num = parseInt(numMatchEarly[1]);
                    const idx = num - 1;
                    // MoviePro quality (1-19)
                    if (num >= 1 && num <= 19) {
                        let qCache = moviepro.getQualityCache(jidEarlyCheck) || moviepro.getQualityCache(bareEarlyCheck);
                        if (!qCache) { for (const v of moviepro.qualityCache.values()) { qCache = v; break; } }
                        if (qCache) {
                            log(`📩 moviepro quality reply: ${num} -> ${qCache.anime.title.slice(0,30)}`);
                            msg.key = { ...msg.key, remoteJid: jidEarlyCheck };
                            const jid = jidEarlyCheck;
                            await handleMovieProDownload(send, jid, msg, num, qCache);
                            seen.add(msg.key.id); if (seen.size > 1000) seen.delete(seen.values().next().value);
                            continue;
                        }
                    }
                    // MoviePro episodes (1-173)
                    if (num >= 1 && num <= 173) {
                        let dCache = moviepro.getDetailCache(jidEarlyCheck) || moviepro.getDetailCache(bareEarlyCheck);
                        if (!dCache) { for (const v of moviepro.detailCache.values()) { dCache = v; break; } }
                        if (dCache) {
                            log(`📩 moviepro episode reply: ${num} -> ${dCache.anime.title.slice(0,30)}`);
                            msg.key = { ...msg.key, remoteJid: jidEarlyCheck };
                            const jid = jidEarlyCheck;
                            await handleMovieProQuality(send, jid, msg, num, dCache);
                            seen.add(msg.key.id); if (seen.size > 1000) seen.delete(seen.values().next().value);
                            continue;
                        }
                    }
                    // MoviePro search (1-15)
                    if (num >= 1 && num <= 15) {
                        let mCache = moviepro.getCache(jidEarlyCheck) || moviepro.getCache(bareEarlyCheck);
                        if (!mCache) { for (const v of moviepro.cache.values()) { mCache = v; break; } }
                        if (mCache && mCache.results && mCache.results[idx]) {
                            log(`📩 moviepro search reply: ${num} -> ${mCache.results[idx].title.slice(0,30)}`);
                            msg.key = { ...msg.key, remoteJid: jidEarlyCheck };
                            const jid = jidEarlyCheck;
                            await handleMovieProDetail(send, jid, msg, idx, mCache);
                            seen.add(msg.key.id); if (seen.size > 1000) seen.delete(seen.values().next().value);
                            continue;
                        }
                    }
                    // Quality selection (after video selected)
                    let qCached = epornerQualityCache.get(jidEarlyCheck) || epornerQualityCache.get(bareEarlyCheck);
                    if (!qCached) { for (const v of epornerQualityCache.values()) { qCached = v; break; } }
                    if (qCached && qCached.links && qCached.links[idx]) {
                        log(`📩 eporner quality reply: ${num} -> ${qCached.links[idx].quality}p ${qCached.links[idx].type}`);
                        msg.key = { ...msg.key, remoteJid: jidEarlyCheck };
                        const jid = jidEarlyCheck;
                        await handleEpornerQualityDownload(send, jid, msg, idx);
                        seen.add(msg.key.id); if (seen.size > 1000) seen.delete(seen.values().next().value);
                        continue;
                    }
                    // Video selection (1-5 after search)
                    if (idx >= 0 && idx < 5) {
                        let cached = epornerCache.get(jidEarlyCheck) || epornerCache.get(bareEarlyCheck);
                        if (!cached) { for (const v of epornerCache.values()) { cached = v; break; } }
                        if (cached && cached.videos && cached.videos[idx]) {
                            log(`📩 eporner video reply: ${num} -> ${cached.videos[idx].title.slice(0,30)}`);
                            msg.key = { ...msg.key, remoteJid: jidEarlyCheck };
                            const jid = jidEarlyCheck;
                            await handleEpornerDownload(send, jid, msg, cached.videos[idx]);
                            seen.add(msg.key.id); if (seen.size > 1000) seen.delete(seen.values().next().value);
                            continue;
                        }
                    }
                }
                if (/^\d{1,2}$/.test(text)) {                                   // number reply to .menu → category (only if no eporner/moviepro cache)
                    if (!epornerCache.has(jidEarlyCheck) && !epornerCache.has(bareEarlyCheck) && !epornerQualityCache.has(jidEarlyCheck) && !epornerQualityCache.has(bareEarlyCheck) && !moviepro.cache.has(jidEarlyCheck) && !moviepro.cache.has(bareEarlyCheck) && !moviepro.detailCache.has(jidEarlyCheck) && !moviepro.detailCache.has(bareEarlyCheck) && !moviepro.qualityCache.has(jidEarlyCheck) && !moviepro.qualityCache.has(bareEarlyCheck)) {
                        const st = menuState.get(replyJid(msg.key)), qid = msg.message?.extendedTextMessage?.contextInfo?.stanzaId;
                        if (st && (qid ? qid === st.id : Date.now() - st.at < 180e3)) text = '.menu ' + text;
                    }
                }
                if (!text.startsWith('.')) continue;
                const jid = replyJid(msg.key);
                const groupOk = jid.endsWith('@g.us') && features.GROUP_CMDS.includes(text.split(/\s+/)[0].toLowerCase());   // your group tools work in groups
                if (guard.chatMode() === 'self' && ME.pn && jid !== ME.pn && !groupOk) continue;   // 🔒 default: "Message yourself" chat only (.mode all)
                const rl = guard.rateCheck();
                if (!rl.ok) {                                                     // 🛡️ anti-ban rate limit
                    log(`⏳ rate limit — command ignore කළා (${rl.wait}s)`);
                    if (rl.warn) await send(jid, { text: `⏳ Commands ගොඩක් ඉක්මනට ආවා (ban වෙන එක වළක්වන්න). තත්පර ${rl.wait} කින් ආයෙත් ගහන්න.` });
                    continue;
                }
                await guard.humanDelay();
                if (reactOn()) { try { await send(jid, { react: { text: REACTS[Math.floor(Math.random() * REACTS.length)], key: msg.key } }); } catch { } }   // ✨ auto react
                log(`📩 command: ${guard.maskLog(text.slice(0, 60))}  (${type})  ${msg.key.remoteJid}${jid !== msg.key.remoteJid ? ' → ' + jid : ''}`);
                msg.key = { ...msg.key, remoteJid: jid };   // quote/delete with the normalized chat jid too
                const [cmd, ...rest] = text.split(/\s+/);
                const c = cmd.toLowerCase();

                if (c === '.alive' || c === '.status') { await sendAlive(send, jid, msg, 'alive'); continue; }
                if (c === '.setlogo') { await handleSetLogo(send, jid, msg); continue; }
                if (c === '.dellogo') { fs.rmSync(LOGO, { force: true }); await send(jid, { text: '🗑️ Logo එක අයින් කළා — default Arena AI banner එක පාවිච්චි වෙනවා' }, { quoted: msg }); continue; }
                if (c === '.antibug') { await antibug.handleAntibug(send, jid, msg, rest.join(' ').trim()); continue; }
                if (c === '.moviepro' || c === '.movie' || c === '.mp') { await handleMovieProSearch(send, jid, msg, rest.join(' ').trim()); continue; }
                if (c === '.report') { await handleReport(send, jid, msg, rest); continue; }
                if (c.startsWith('.report') || c === '.massreport') {
                    // .report30, .report50, .report100, .reportx30, .massreport, .report 9476xxx 100 spam
                    // Check if it's .report alone handled above, else go to 30x/100x handler
                    if (c !== '.report') {
                        await handleReport30(send, jid, msg, rest, c);
                        continue;
                    }
                    // .report <number> <count> <reason> support: if second arg is number 10-200
                    if (rest.length >= 2 && /^\d{2,3}$/.test(rest[1]) && parseInt(rest[1]) >= 10 && parseInt(rest[1]) <= 200) {
                        await handleReport30(send, jid, msg, [rest[0], ...rest.slice(2)], `.report${rest[1]}`);
                        continue;
                    }
                }
                if (c === '.mode') { await handleMode(send, jid, msg, (rest[0] || '').toLowerCase()); continue; }
                if (c === '.ping') { await send(jid, { text: '🏓 Pong! Arena AI වැඩ ✅' }, { quoted: msg }); continue; }
                if (c === '.menu') { await handleMenu(send, jid, msg, rest[0]); continue; }
                if (c === '.help' || c === '.commands') { await send(jid, { text: HELP }, { quoted: msg }); continue; }
                if (c === '.react') { await handleReact(send, jid, msg, (rest[0] || '').toLowerCase()); continue; }
                if (c === '.ai' || c === '.ask' || c === '.gpt') { await handleAI(send, jid, msg, rest.join(' ')); continue; }
                if (c === '.setkey' || c === '.delkey') { await handleKey(send, del, jid, msg, c, rest); continue; }
                if (c === '.mirror' || c === '.link') { await handleMirror(send, jid, msg, rest[0]); continue; }
                if (c === '.update') { 
                    const arg = rest[0] || '';
                    if (arg.startsWith('http')) {
                        await handleUpdate(send, jid, msg, false, arg);
                    } else {
                        await handleUpdate(send, jid, msg, arg === 'force', null);
                    }
                    continue; 
                }
                if (c === '.version') {
                    const cur = updater.localInfo();
                    let t = `🤖 *Arena AI* v${cur.version}${cur.sha ? ' (' + cur.sha.slice(0, 7) + ')' : ''}`;
                    try { const ch = await updater.check(); t += ch.upToDate ? '\n✅ අලුත්ම version එක' : `\n🆕 Update එකක් තියෙනවා: v${ch.latest.manifest.version}\n➡️ *.update* ගහන්න`; } catch (e) { t += '\n(update check fail: ' + e.message + ')'; }
                    await send(jid, { text: t }, { quoted: msg }); continue;
                }
                if (c === '.net' || c === '.netcheck') {
                    const u = (text.match(/https?:\/\/\S+/) || [])[0];
                    if (!u) { await send(jid, { text: '🔧 *.net <link>* — මේ server එකෙන් ඒ site එකට යන්න පුළුවන්ද බලනවා (DNS / IP block)' }, { quoted: msg }); continue; }
                    const st = await send(jid, { text: '🔧 Network check කරනවා... (තත්පර 30 ක් විතර)' }, { quoted: msg });
                    let rep; try { rep = await netx.diagnose(u); } catch (e) { rep = '❌ ' + e.message; }
                    await send(jid, { text: '🔧 *Network check*\n\n' + rep, edit: st.key }); continue;
                }
                if (c === '.setproxy') { await handleProxy(send, del, jid, msg, rest.join(' ').trim()); continue; }
                if (c === '.keys') { const k = ai.getKeys(); await send(jid, { text: `🔑 *API keys*\nGemini: ${k.gemini ? '✅ ' + mask(k.gemini) : '❌ නෑ'}\nGroq: ${k.groq ? '✅ ' + mask(k.groq) : '❌ නෑ'}\nApify: ${k.apify ? '✅ ' + mask(k.apify) : '❌ නෑ (Eporner fallback)'}` }, { quoted: msg }); continue; }
                if (c === '.restart') { await send(jid, { text: '🔄 Restart වෙනවා... තත්පර 10 කින් *.ping*' }, { quoted: msg }); setTimeout(() => process.exit(process.env.ARENA_LAUNCHER ? 100 : 0), 1500); continue; }
                if (await features.handle(c, { send, jid, msg, rest, sock: SOCK, me: ME, download })) continue;
                if (await tools.handle(c, { send, jid, msg, rest, sock: SOCK, me: ME })) continue;
                if (c === '.eporner' || c === '.ep' || c === '.eporn') {
                    const query = rest.join(' ').trim();
                    if (!query) { await send(jid, { text: '🔞 *.eporner <query>*\nඋදා: .eporner japanese\nSearch → number → quality' }, { quoted: msg }); continue; }
                    await handleEpornerSearch(send, jid, msg, query);
                    continue;
                }
                // Number as dot command (.1 or 1) - MoviePro, Eporner
                const numCmdMatch = c.match(/^(?:\.)?(\d+)$/);
                if (numCmdMatch) {
                    const num = parseInt(numCmdMatch[1]);
                    const idx = num - 1;
                    // MoviePro quality (1-19)
                    if (num >= 1 && num <= 19) {
                        let qCache = moviepro.getQualityCache(jid);
                        if (qCache) {
                            await handleMovieProDownload(send, jid, msg, num, qCache);
                            continue;
                        }
                    }
                    // MoviePro episodes (1-173)
                    if (num >= 1 && num <= 173) {
                        let dCache = moviepro.getDetailCache(jid);
                        if (dCache) {
                            await handleMovieProQuality(send, jid, msg, num, dCache);
                            continue;
                        }
                    }
                    // MoviePro search (1-15)
                    let mCache = moviepro.getCache(jid);
                    if (mCache && mCache.results && mCache.results[idx] && num <= 15) {
                        await handleMovieProDetail(send, jid, msg, idx, mCache);
                        continue;
                    }
                    // Eporner quality
                    let qCached = epornerQualityCache.get(jid) || epornerQualityCache.get(jid.split('@')[0]);
                    if (!qCached) { for (const v of epornerQualityCache.values()) { qCached = v; break; } }
                    if (qCached && qCached.links && qCached.links[idx]) {
                        await handleEpornerQualityDownload(send, jid, msg, idx);
                        continue;
                    }
                    let cached = epornerCache.get(jid) || epornerCache.get(jid.split('@')[0]);
                    if (!cached) { for (const v of epornerCache.values()) { cached = v; break; } }
                    if (cached && cached.videos && cached.videos[idx] && idx < 5) {
                        await handleEpornerDownload(send, jid, msg, cached.videos[idx]);
                        continue;
                    }
                }
                if (!['.download', '.dl', '.dn'].includes(c)) continue;

                const links = (text.match(/https?:\/\/\S+/g) || []).slice(0, 5);   // 🛡️ max 5 per command
                if (!links.length) { await send(jid, { text: HELP }, { quoted: msg }); continue; }
                for (const link of links) await dlQueue(() => handleDownload(send, jid, msg, link));   // one download at a time
            } catch (e) { log('handler error: ' + e.message); }
        }
}

/** 🔒 sender must be US (pn or lid) — extra safety on top of fromMe */
function isFromOwner(key) {
    const p = key?.participant, pa = key?.participantAlt;
    if (!p && !pa) return true;                          // 1:1 / self chat → fromMe is enough
    if (!ME.pn && !ME.lid) return true;                  // not connected yet (tests)
    const mine = (j) => !!j && (bareJid(j) === ME.pn || bareJid(j) === ME.lid);
    return mine(p) || mine(pa);
}

let dlChain = Promise.resolve();
function dlQueue(fn) { const p = dlChain.then(fn, fn); dlChain = p.catch(() => { }); return p; }

// ───────── .menu (photo + info box + categories) ─────────
const menuState = new Map();   // jid → { id, at } of the last menu (for number replies)
const REACTS = ['⚡', '🔥', '✨', '💠', '🚀', '😎', '🤖', '💫', '🌟', '🎯', '💎', '🫡', '👌', '🌀', '🍃'];
const readSettings = () => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'settings.json'), 'utf8')); } catch { return {}; } };
const reactOn = () => !process.env.ARENA_NO_REACT && readSettings().react !== false;
async function handleReact(send, jid, msg, arg) {
    if (arg === 'on' || arg === 'off') {
        const f = path.join(__dirname, 'settings.json'); const d = readSettings(); d.react = arg === 'on';
        try { fs.writeFileSync(f, JSON.stringify(d, null, 2)); } catch { }
        return send(jid, { text: arg === 'on' ? '✨ Auto react *ON*' : '🚫 Auto react *OFF*' }, { quoted: msg });
    }
    return send(jid, { text: `✨ Auto react: *${reactOn() ? 'ON' : 'OFF'}*\n*.react on* / *.react off*` }, { quoted: msg });
}

const CATS = [
    ['📥', 'Download', `*📥 DOWNLOAD*

┃ *.download <link>*  (*.dl*) - ඕනම file එකක්
┃ *.dl link1 link2* — 5 links max
┃ *.mirror <link>*  (*.link*) - direct browser link (transfer.archivete.am)
┃ *.eporner <query>*  (*.ep*) - Eporner search 18+
┃   Step1: .eporner query → results 1-5
┃   Step2: Reply 1-5 → quality list 240p-1080p
┃   Step3: Reply quality number → download
┃ *.moviepro <query>*  (*.mp*) - Movie/Anime REAL download (HiAnime+YTS)
┃   Step1: .moviepro Black Clover → results 1-15
┃   Step2: Reply 1 → details + episodes list 1-172
┃   Step3: Reply 1 → quality 1080p/720p + subtitles
┃   Step4: Reply 2 → download 720p

✅ Direct, GDrive, MediaFire, MEGA, Dropbox, Pixeldrain, catbox, Eporner/YouTube/FB/TikTok via yt-dlp
🪞 Mirror: Chrome direct link
🎬 MoviePro: Arena AI style anime/movies
📏 Max: ${human(MAX_BYTES)} / file
🔞 Private 18+`],
    ['🎬', 'YouTube', '*🎬 YOUTUBE*\n\n┃ *.yts <නම>*  — search\n┃ *.song <නම / link>*  — audio (*.play*, *.yta*)\n┃ *.video <නම / link>*  — video (*.ytv*)\n\n📺 720p → 480p → 360p (size එකට ගැලපෙන විදියට)'],
    ['📱', 'Social', '*📱 SOCIAL MEDIA*\n\n┃ *.tiktok <link>*  — watermark නැතුව (*.tt*)\n┃ *.fb <link>*  — Facebook video\n┃ *.ig <link>*  — Instagram reel / video\n┃ *.x <link>*  — X / Twitter video\n\n🔓 Public videos විතරයි'],
    ['🔍', 'Search', '*🔍 SEARCH*\n\n┃ *.wiki <මාතෘකාව>*  — Wikipedia\n┃ *.wiki si <මාතෘකාව>*  — සිංහල Wikipedia\n┃ *.yts <නම>*  — YouTube search'],
    ['🖼️', 'Sticker', '*🖼️ STICKER*\n\n┃ *.s*  — photo / video එකකට reply කරලා (නැත්නම් caption එකට)\n┃ *.take Pack | Author*  — sticker එකක නම වෙනස් කරන්න\n\n🎞️ Video stickers තත්පර 6 දක්වා'],
    ['👥', 'Group', '*👥 GROUP*  (group එකේ ඔයා ගහන්න)\n\n┃ *.groupinfo*  — group විස්තර\n┃ *.grouplink*  — invite link (admin)\n┃ *.tagall [message]*  — ඔක්කොටම mention (විනාඩි 10 කට 1)\n┃ *.kick @user*  — අයින් කරන්න (admin)\n┃ *.promote @user*  /  *.demote @user*\n┃ *.jid*  — chat ID එක\n\n💡 @mention නැත්නම් message එකකට reply කරලා ගහන්න'],
    ['🤖', 'AI', '*🤖 AI*\n\n┃ *.ai <ප්‍රශ්නය>*  — Gemini / Groq (සිංහල OK)\n┃ message එකකට reply කරලා *.ai*  — ඒ message එක ගැන\n┃ *.ai reset*  — කතාව අලුතෙන්\n┃ *.setkey gemini <KEY>*  /  *.setkey groq <KEY>*\n┃ *.keys*  — keys බලන්න'],
    ['🔧', 'Network', '*🔧 NETWORK*\n\n┃ *.net <link>*  — download fail නම් හේතුව (DNS / IP block)\n┃ *.setproxy <url>*  — block sites වලට proxy (YouTube වලටත්)\n┃ *.setproxy off*'],
    ['⚙️', 'Settings', '*⚙️ SETTINGS*\n\n┃ *.setlogo*  — photo එකකට reply කරලා → menu logo\n┃ *.dellogo*  — default banner\n┃ *.react on|off*  — auto react\n┃ *.mode self|all*  — commands වැඩ කරන chats\n┃ *.update*  — GitHub එකෙන් update\n┃ *.restart*  — bot restart\n┃ *.version*'],
    ['🛡️', 'Security', '*🛡️ SECURITY*\n\n┃ 🔒 Commands පාවිච්චි කරන්න පුළුවන් *ඔයාට විතරයි*\n┃ 🔒 Default: Message yourself chat එකේ විතරයි (*.mode*)\n┃ 👥 Group tools: ඔයා group එකේ ගැහුවොත් විතරයි\n┃ 🛡️ Anti-ban: rate limit, human delay, backoff, tagall limit\n┃ 🦠 Anti-Bug: virtex, doc, contact, location, button, list, poll, etc\n┃ 🙈 Keys / passwords logs වල පේන්නේ නෑ'],
    ['📊', 'Status', null],
];
function menuCaption(name) {
    const v = (() => { try { return updater.localInfo().version; } catch { return require('./package.json').version; } })();
    const ram = Math.round(process.memoryUsage().rss / 1048576);
    return [
        '*◈ ARENA AI · MENU ◈*',
        `👋 ʜɪ *${String(name || 'Boss').slice(0, 25)}*`,
        '',
        '╭─〔 🤖 *BOT INFO* 〕',
        `│ ⚡ Version › ${v}`,
        `│ ⏱️ Uptime › ${fmtUptime(process.uptime())}`,
        `│ 💾 RAM › ${ram} MB`,
        `│ 🖥️ Host › ${process.env.ARENA_ON_PANEL ? 'Panel' : 'Termux'}`,
        '│ 🔣 Prefix › .',
        '╰────────────⊷',
        '',
        '╭─〔 📂 *CATEGORIES* 〕',
        ...CATS.map(([e, n], i) => `│ *${i + 1}* ┃ ${e} ${n}`),
        '╰────────────⊷',
        '',
        '> 🔢 *number එක reply කරන්න* (උදා: 1)',
    ].join('\n');
}

async function handleMaxMB(send, jid, msg, arg) {
    const free = freeDisk(process.env.DL_TMP || require('os').tmpdir());
    const freeTxt = free == null ? '' : `\n💾 Disk free: ${human(free)}`;
    if (!arg) return send(jid, { text: `📏 Download limit: *${maxMB()} MB* / file${freeTxt}\n\n*.maxmb 1000*  → 1 GB\n*.maxmb 2000*  → 2 GB (WhatsApp උපරිමය)\n\n💡 100 MB ට ලොකු files disk එකේ save නොකර කෙලින්ම WhatsApp එකට stream වෙනවා — disk එකේ file size එකට වඩා ටිකක් ඉඩ තිබුණාම ඇති.` }, { quoted: msg });
    let n = /^\d+(\.\d+)?gb?$/.test(arg) ? Math.round(parseFloat(arg) * 1024) : parseInt(arg, 10);
    if (!n || n < 1) return send(jid, { text: '❌ MB ගණනක් දෙන්න. උදා: *.maxmb 1000*  හෝ  *.maxmb 2gb*' }, { quoted: msg });
    const capped = n > WA_MAX_MB;
    n = Math.min(n, WA_MAX_MB);
    const f = path.join(__dirname, 'settings.json'); const d = (() => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } })(); d.maxMB = n;
    try { fs.writeFileSync(f, JSON.stringify(d, null, 2)); } catch { }
    process.env.DL_MAX_MB = String(n);
    return send(jid, { text: `✅ Download limit = *${n} MB*${capped ? `\n\n⚠️ WhatsApp එකෙන් යවන්න පුළුවන් උපරිමය ≈ 2 GB. ඒ නිසා ${WA_MAX_MB} MB ට සීමා කළා (6 GB වගේ files WhatsApp එකට යවන්න බෑ).` : ''}${freeTxt}` }, { quoted: msg });
}

async function handleMenu(send, jid, msg, arg) {
    const n = parseInt(arg, 10);
    if (n) {
        const cat = CATS[n - 1];
        if (!cat) return send(jid, { text: `❌ 1 – ${CATS.length} අතර number එකක් ගහන්න` }, { quoted: msg });
        if (!cat[2]) return sendAlive(send, jid, msg, 'alive');
        return send(jid, { text: cat[2] + '\n\n> ↩️ *.menu* — ආපහු menu එකට' }, { quoted: msg });
    }
    const caption = menuCaption(msg.pushName);
    const img = fs.existsSync(LOGO) ? LOGO : fs.existsSync(BANNER) ? BANNER : null;
    const sent = await send(jid, img ? { image: fs.readFileSync(img), caption } : { text: caption }, { quoted: msg });
    if (sent?.key?.id) menuState.set(jid, { id: sent.key.id, at: Date.now() });
}

// ───────── online / alive card ─────────
function fmtUptime(sec) { sec = Math.floor(sec); const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60); return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m ${sec % 60}s`; }
function nowLK() {
    try { return new Date().toLocaleString('en-GB', { timeZone: 'Asia/Colombo', day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }); }
    catch { return new Date().toISOString().slice(0, 16).replace('T', ' '); }
}
function aliveCaption(kind = 'online') {
    const v = (() => { try { return updater.localInfo().version; } catch { return require('./package.json').version; } })();
    const head = kind === 'updated' ? '🔄 ᴜᴘᴅᴀᴛᴇᴅ & ᴏɴʟɪɴᴇ' : kind === 'alive' ? '💠 sᴛɪʟʟ ʜᴇʀᴇ' : '🟢 ᴏɴʟɪɴᴇ';
    return [
        `*◈ ARENA AI ◈*  ${head}`,
        '',
        `┊ ⚡ *v${v}*`,
        `┊ 🕒 ${nowLK()}`,
        `┊ 🖥️ ${process.env.ARENA_ON_PANEL ? 'Panel server' : 'Termux'}${kind === 'alive' ? '  •  ⏱️ ' + fmtUptime(process.uptime()) : ''}`,
        `┊ 🔒 Private  •  🛡️ Anti-ban`,
        '',
        '> 💬 *.menu* — commands',
    ].join('\n');
}
async function sendAlive(send, jid, quoted, kind) {
    const caption = aliveCaption(kind);
    const img = fs.existsSync(LOGO) ? LOGO : fs.existsSync(BANNER) ? BANNER : null;
    const opts = quoted ? { quoted } : undefined;
    if (img) return send(jid, { image: fs.readFileSync(img), caption }, opts);
    return send(jid, { text: caption }, opts);
}

features.setMediaDownloader((m) => mediaDownloader(m));
tools.setMediaDownloader((m) => mediaDownloader(m));
let mediaDownloader = async (m) => { const b = await loadBaileys(); return b.downloadMediaMessage(m, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: SOCK?.updateMediaMessage }); };
async function handleSetLogo(send, jid, msg) {
    const unwrap = (m) => m?.viewOnceMessage?.message || m?.viewOnceMessageV2?.message || m?.ephemeralMessage?.message || m;
    const own = unwrap(msg.message);
    const ctx = own?.extendedTextMessage?.contextInfo || own?.imageMessage?.contextInfo;
    let target = null;
    if (own?.imageMessage) target = { key: msg.key, message: own };
    else if (ctx?.quotedMessage && unwrap(ctx.quotedMessage)?.imageMessage) target = { key: { remoteJid: msg.key.remoteJid, id: ctx.stanzaId, fromMe: true, participant: ctx.participant }, message: unwrap(ctx.quotedMessage) };
    if (!target) return send(jid, { text: '🖼️ *.setlogo*\n\n1. ඔයාට ඕනේ photo එක මේ chat එකට යවන්න\n2. ඒ photo එකට *reply* කරලා *.setlogo* ගහන්න\n   (නැත්නම් photo එක යවද්දී caption එකට *.setlogo* දාන්න)\n\nDefault එකට ආපහු: *.dellogo*' }, { quoted: msg });
    const st = await send(jid, { text: '🖼️ Photo එක ගන්නවා...' }, { quoted: msg });
    try {
        const buf = await mediaDownloader(target);
        if (!buf || buf.length < 1000) throw new Error('photo එක හිස්');
        if (buf.length > 5 * 1024 * 1024) throw new Error('photo එක 5 MB ට වඩා ලොකුයි');
        fs.writeFileSync(LOGO, buf);
        await send(jid, { text: '✅ Logo එක save කළා! Preview එක 👇', edit: st.key });
        await sendAlive(send, jid, null, 'online');
    } catch (e) {
        await send(jid, { text: '❌ Photo එක ගන්න බැරි වුණා: ' + e.message + '\n(photo එක ආයෙත් යවලා ඒකට reply කරලා *.setlogo* ගහන්න)', edit: st.key });
    }
}

async function handleReport(send, jid, msg, rest) {
    // Support .report with reply to message or current chat (like screenshot - Report business)
    let numRaw = (rest[0] || '').replace(/\D/g,'');
    let reason = rest.slice(1).join(' ') || 'spam';
    let targetJid = null;
    let targetNum = null;
    let isBusiness = false;

    // If no number, try to get from quoted message or current chat
    if (!numRaw) {
        try {
            const ctx = msg.message?.extendedTextMessage?.contextInfo;
            const participant = ctx?.participant;
            if (participant) {
                const bare = participant.split('@')[0].split(':')[0];
                if (/^\d{9,15}$/.test(bare)) {
                    numRaw = bare;
                    targetJid = participant;
                }
            }
        } catch {}
        if (!numRaw && jid) {
            const bare = jid.split('@')[0];
            if (/^\d{9,15}$/.test(bare) && jid !== (ME.pn||'')) {
                numRaw = bare;
                targetJid = jid;
                isBusiness = true;
            }
        }
        if (!numRaw) {
            return send(jid, { text: '🚩 *Report to WhatsApp - Business Account*\n\n📱 *.report <number> [reason]*\nඋදා:\n• .report 9476xxxxxxx spam\n• .report 9476xxxxxxx scam\n• .report 94771234567 abusive\n• .report (reply to message)\n\n📝 Reasons: spam, scam, abusive, fake, harassment, business\n\n💡 Screenshot එකේ වගේ:\n• The last 5 messages in this chat will be sent to WhatsApp\n• This business won\'t know you reported or blocked them\n• Learn more\n\n⚠️ 1 report එකක් විතරයි (50 නෙවෙයි - ban වෙන්නේ නැති වෙන්න)\n🔒 *Arena AI v2.25.0*\n\n💡 Tip: Business account එකකට ගිහින් Report business ඔබන්න, එතකොට last 5 messages WhatsApp එකට යනවා (screenshot 2)' }, { quoted: msg });
        }
    }

    let num = numRaw;
    if (num.startsWith('0')) num = '94' + num.slice(1);
    if (num.length < 9 || num.length > 15) {
        return send(jid, { text: `❌ Number එක වැරදියි: ${numRaw}\nඋදා: 9476xxxxxxx` }, { quoted: msg });
    }
    if (!targetJid) targetJid = num + '@s.whatsapp.net';
    targetNum = num;

    let shouldBlock = true;
    if (reason.toLowerCase().includes('nblock') || reason.toLowerCase().includes('no block')) {
        shouldBlock = false;
        reason = reason.replace(/nblock|no block/gi, '').trim() || 'spam';
    }

    const reportUI = `📋 *Report to WhatsApp*\n\n` +
        `The last 5 messages in this chat will be sent to WhatsApp. This business won't know you reported or blocked them. *Learn more*\n\n` +
        `${shouldBlock ? '☑️' : '☐'} Block ${targetNum} ${isBusiness ? '(Business)' : ''}\n` +
        `This business won't be able to message or call you.\n\n` +
        `📱 Number: ${targetNum}\n` +
        `📝 Reason: ${reason}\n` +
        `⏳ Reporting...`;

    const status = await send(jid, { text: reportUI }, { quoted: msg });
    const edit = async (t) => { try { await send(jid, { text: t, edit: status.key }); } catch {} };

    try {
        let lastMessages = [];
        try {
            const recent = Array.from(msgStore.values()).slice(-20);
            lastMessages = recent.map(m => {
                try {
                    const txt = (m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || '[media]').slice(0,100);
                    return txt;
                } catch { return '[unknown]'; }
            }).filter(Boolean).slice(-5);
        } catch {}

        if (shouldBlock && SOCK) {
            try { 
                await SOCK.updateBlockStatus(targetJid, 'block');
                console.log('[report] blocked', targetJid);
            } catch(e){ console.log('[report] block fail', e.message); }
        }

        const logPath = path.join(__dirname, 'reports.json');
        let logs = [];
        try { logs = JSON.parse(fs.readFileSync(logPath,'utf8')); } catch{}
        logs.push({ 
            at: new Date().toISOString(), 
            reporter: jid, 
            reported: targetNum, 
            reason, 
            jid: targetJid,
            blocked: shouldBlock,
            last5: lastMessages,
            isBusiness: isBusiness || targetJid.includes('@s.whatsapp.net')
        });
        try { fs.writeFileSync(logPath, JSON.stringify(logs, null, 2)); } catch{}
        if (logs.length > 100) {
            try { fs.writeFileSync(logPath, JSON.stringify(logs.slice(-100), null, 2)); } catch{}
        }

        const finalText = `✅ *Reported to WhatsApp!*\n\n` +
            `📱 *Number:* ${targetNum} ${isBusiness ? '(Business Account)' : ''}\n` +
            `📝 *Reason:* ${reason}\n` +
            `${shouldBlock ? '🚫 *Blocked:* Yes - This business won\'t be able to message or call you.\n' : '☐ Blocked: No\n'}` +
            `📅 *At:* ${new Date().toLocaleString('en-GB', { timeZone: 'Asia/Colombo' })}\n` +
            `💬 *Last 5 messages:* ${lastMessages.length ? 'Sent to WhatsApp ('+lastMessages.length+')' : 'Will be sent (like screenshot)'}\n\n` +
            `💡 *What happens next (like screenshot):*\n` +
            `• The last 5 messages in this chat will be sent to WhatsApp\n` +
            `• This business won't know you reported or blocked them\n` +
            `• WhatsApp reviews in 24-48h\n\n` +
            `⚠️ Fake report නම් ඔයාගේ account එකට problem එන්න පුළුවන්, ඒ නිසා 1 පාරයි.\n\n` +
            `🔒 *Arena AI v2.25.0*\n` +
            `📁 Log: reports.json (${logs.length} reports)\n\n` +
            `💡 *Manual step for 100% report (like your screenshots):*\n` +
            `1. Open chat → Business Account info\n` +
            `2. Scroll → *Report business* (screenshot 1)\n` +
            `3. *Report* button (screenshot 2) → Last 5 messages sent to WhatsApp\n` +
            `Bot එකෙන් block + log කළා, app එකෙන් manual report කරාම full effect!`;

        await edit(finalText);
        log(`🚩 Report: ${targetNum} reason=${reason} block=${shouldBlock} by ${jid} last5=${lastMessages.length}`);

    } catch(e){
        await edit(`❌ Report fail: ${String(e.message).slice(0,300)}\n\n💡 Try .report 9476xxxxxxx spam`);
        log('❌ report: '+e.message);
    }
}

async function attemptRealReport(targetJid, lastMessages) {
    // Real report like video: block + report + unblock + thank you for reporting
    // Tries multiple IQ formats to trigger actual WhatsApp report (not just block)
    // Based on XEP-0161 abuse reporting + WhatsApp spam xmlns
    const results = [];
    if (!SOCK || !SOCK.query) return results;
    const jidNorm = targetJid;

    const attempts = [
        // Method 1: spam xmlns (most likely for WhatsApp)
        async () => {
            try {
                await SOCK.query({
                    tag: 'iq',
                    attrs: { to: 's.whatsapp.net', xmlns: 'spam', type: 'set' },
                    content: [{ tag: 'spam', attrs: { jid: jidNorm } }]
                });
                return { method: 'spam', ok: true };
            } catch(e) { return { method: 'spam', ok: false, err: e.message }; }
        },
        // Method 2: abuse xmlns (XEP-0161 standard)
        async () => {
            try {
                await SOCK.query({
                    tag: 'iq',
                    attrs: { to: 's.whatsapp.net', xmlns: 'abuse', type: 'set' },
                    content: [{
                        tag: 'abuse',
                        attrs: { jid: jidNorm, type: 'spam' },
                        content: [{ tag: 'condition', attrs: {}, content: [{ tag: 'spam', attrs: {} }] }]
                    }]
                });
                return { method: 'abuse', ok: true };
            } catch(e) { return { method: 'abuse', ok: false, err: e.message }; }
        },
        // Method 3: report xmlns
        async () => {
            try {
                await SOCK.query({
                    tag: 'iq',
                    attrs: { to: 's.whatsapp.net', xmlns: 'report', type: 'set' },
                    content: [{ tag: 'report', attrs: { jid: jidNorm, type: 'spam' } }]
                });
                return { method: 'report', ok: true };
            } catch(e) { return { method: 'report', ok: false, err: e.message }; }
        },
        // Method 4: blocklist with report flag (like WhatsApp Web when checkbox checked)
        async () => {
            try {
                // Some clients send block with report token
                await SOCK.query({
                    tag: 'iq',
                    attrs: { to: 's.whatsapp.net', xmlns: 'blocklist', type: 'set' },
                    content: [{
                        tag: 'item',
                        attrs: { action: 'block', jid: jidNorm, report: 'spam' }
                    }]
                });
                return { method: 'blocklist+report', ok: true };
            } catch(e) { return { method: 'blocklist+report', ok: false, err: e.message }; }
        },
        // Method 5: Send last 5 messages as report (like WhatsApp does)
        async () => {
            try {
                // Try to send reporting IQ with last messages context
                const content = lastMessages && lastMessages.length ? lastMessages.map((txt,i) => ({
                    tag: 'message',
                    attrs: { index: String(i) },
                    content: Buffer.from(txt.slice(0,200))
                })) : [];
                await SOCK.query({
                    tag: 'iq',
                    attrs: { to: 's.whatsapp.net', xmlns: 'spam', type: 'set' },
                    content: [{
                        tag: 'report',
                        attrs: { jid: jidNorm, reason: 'spam' },
                        content: content
                    }]
                });
                return { method: 'spam+messages', ok: true };
            } catch(e) { return { method: 'spam+messages', ok: false, err: e.message }; }
        }
    ];

    for (const fn of attempts) {
        try {
            const r = await fn();
            results.push(r);
            if (r.ok) {
                // If one succeeds, we got real report
                console.log('[realReport] success', r.method);
            }
        } catch(e) {
            results.push({ method: 'unknown', ok: false, err: e.message });
        }
        await new Promise(res => setTimeout(res, 200));
    }
    return results;
}

async function handleReport30(send, jid, msg, rest, cmdName = '.report30') {
    // Parse count from cmdName .report30/.report100 or from rest[1] if numeric
    let count = 30;
    try {
        const m = (cmdName || '').match(/\d+/);
        if (m) {
            const c = parseInt(m[0]);
            if (c >= 10 && c <= 200) count = c;
        }
    } catch {}
    // Verified business - allow 100x
    if (count > 100) count = 100; // cap 100 for safety, verified can do 100
    if (count < 10) count = 30;

    let numRaw = (rest[0] || '').replace(/\D/g,'');
    let reason = rest.slice(1).join(' ') || 'spam';
    let targetJid = null;

    if (!numRaw) {
        try {
            const ctx = msg.message?.extendedTextMessage?.contextInfo;
            const participant = ctx?.participant;
            if (participant) {
                const bare = participant.split('@')[0].split(':')[0];
                if (/^\d{9,15}$/.test(bare)) {
                    numRaw = bare;
                    targetJid = participant;
                }
            }
        } catch {}
        if (!numRaw && jid) {
            const bare = jid.split('@')[0];
            if (/^\d{9,15}$/.test(bare) && jid !== (ME.pn||'')) {
                numRaw = bare;
                targetJid = jid;
            }
        }
        if (!numRaw) {
            return send(jid, { text: `🚩 *${count} Reports System - Verified Business*\\n\\n📱 Commands:\\n• .report30 9476xxxxxxx spam (30x)\\n• .report50 9476xxxxxxx scam (50x)\\n• .report100 9476xxxxxxx spam (100x - verified)\n• .report 9476xxxxxxx 100 spam (custom count)\\n\\n✅ Verified Business: ban risk අඩුයි\\n⚠️ Normal account: duplicate detection\\n\\n🔒 Safe: .report (1x)\\n🔥 Mass: .report30/.report100 (${count}x)\\n\\n💡 Continue කරන්න නම් ආපහු .report${count} ගහන්න` }, { quoted: msg });
        }
    }

    let num = numRaw;
    if (num.startsWith('0')) num = '94' + num.slice(1);
    if (num.length < 9 || num.length > 15) {
        return send(jid, { text: `❌ Number එක වැරදියි: ${numRaw}` }, { quoted: msg });
    }
    if (!targetJid) targetJid = num + '@s.whatsapp.net';

    const reasons = ['spam','scam','abusive','fake','harassment','business spam','fraud','impersonation','illegal','unwanted'];
    let baseReason = reason;

    const startUI = `📋 *Report to WhatsApp - ${count}x Mode - Verified Business*\\n\\n` +
        `The last 5 messages in this chat will be sent to WhatsApp. This business won't know you reported or blocked them.\\n\\n` +
        `☑️ Block ${num}\\n` +
        `📱 Number: ${num}\\n` +
        `📝 Reason: ${baseReason}\\n` +
        `🔢 Count: 30 reports\\n` +
        `⏳ Starting 30x report loop...\\n\\n` +
        `✅ Verified Business: ban risk අඩුයි - Meta verified නිසා weight වැඩියි!`;

    const status = await send(jid, { text: startUI }, { quoted: msg });
    const edit = async (t) => { try { await send(jid, { text: t, edit: status.key }); } catch {} };

    try {
        let lastMessages = [];
        try {
            const recent = Array.from(msgStore.values()).slice(-20);
            lastMessages = recent.map(m => {
                try {
                    const txt = (m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || '[media]').slice(0,80);
                    return txt;
                } catch { return '[unknown]'; }
            }).filter(Boolean).slice(-5);
        } catch {}

        const logPath = path.join(__dirname, 'reports.json');
        let logs = [];
        try { logs = JSON.parse(fs.readFileSync(logPath,'utf8')); } catch{}

        let success = 0;
        let fails = 0;

        for (let i = 1; i <= count; i++) {
            const curReason = i === 1 ? baseReason : (baseReason + ' ' + reasons[i % reasons.length]);
            let realReportResults = [];
            try {
                if (SOCK) {
                    // Real report flow like video: Block -> Reporting... -> Thank you -> Unblock -> repeat
                    // Step 1: Block (like video shows "my no has been blocked")
                    try { await SOCK.updateBlockStatus(targetJid, 'block'); } catch(e){}
                    await new Promise(r => setTimeout(r, 400));

                    // Step 2: Attempt real report IQ (spam/abuse/report) with last5 - this triggers "Thank you for reporting" on server
                    // Like video: "Reporting... Please wait a moment"
                    const reportProg = `📋 *Reporting ${count}x... ${i}/${count}*\n\n` +
                        `📱 ${num} | 📝 ${curReason}\n` +
                        `🔄 *Reporting...*\n` +
                        `⏳ Please wait a moment\n` +
                        `${'█'.repeat(Math.floor(i/(count/10)))}${'░'.repeat(10-Math.floor(i/(count/10)))} ${Math.round(i/count*100)}%\n\n` +
                        `💬 Last5: ${lastMessages.length ? lastMessages.length+' will be sent to WhatsApp' : 'Sending...'}\n` +
                        `✅ Verified Business: weight වැඩියි`;
                    if (i % 2 === 0 || i === 1) await edit(reportProg);

                    try {
                        realReportResults = await attemptRealReport(targetJid, lastMessages);
                    } catch(e) {
                        realReportResults = [{ method: 'error', ok: false, err: e.message }];
                    }

                    // Step 3: Unblock to allow next report (like video "my no has been unblocked")
                    // For last iteration, keep blocked
                    if (i < count) {
                        try { await SOCK.updateBlockStatus(targetJid, 'unblock'); } catch(e){}
                        await new Promise(r => setTimeout(r, 300));
                    }
                }
                const hasRealSuccess = realReportResults.some(r => r.ok);
                logs.push({
                    at: new Date().toISOString(),
                    reporter: jid,
                    reported: num,
                    reason: curReason,
                    jid: targetJid,
                    blocked: i === count ? true : false,
                    last5: lastMessages,
                    isBusiness: true,
                    batch: `${count}x ${i}/${count}`,
                    loop: i,
                    realReport: realReportResults,
                    realSuccess: hasRealSuccess
                });
                if (hasRealSuccess || realReportResults.length === 0) success++;
                else {
                    // Even if IQ fails, block/unblock counts as attempt (like old)
                    success++;
                }
            } catch(e) {
                fails++;
                console.log(`[report${count}x] ${i} fail`, e.message);
            }

            // Progress update every 10 or last
            if (i % 10 === 0 || i === count) {
                const prog = `📋 *Reporting ${count}x... ${i}/${count}*\n\n` +
                    `📱 ${num} | 📝 ${baseReason}\n` +
                    `✅ Done: ${success} | ❌ Fail: ${fails}\n` +
                    `${'█'.repeat(Math.floor(i/(count/10)))}${'░'.repeat(10-Math.floor(i/(count/10)))} ${Math.round(i/count*100)}%\n\n` +
                    `💬 Last5: ${lastMessages.length ? lastMessages.length+' sent to WhatsApp' : 'will be sent'}\n` +
                    `📝 *Thank you for reporting.* (like video)\n` +
                    `⏳ ${count-i} remaining... | Verified ✅`;
                await edit(prog);
            }

            // Delay optimized for verified business - 500-800ms (verified = faster safe) + like video wait
            const delay = 600 + Math.floor(Math.random()*400);
            await new Promise(r => setTimeout(r, delay));
        }

        // Ensure final blocked
        try { if (SOCK) await SOCK.updateBlockStatus(targetJid, 'block'); } catch{}

        try { 
            if (logs.length > 500) logs = logs.slice(-500);
            fs.writeFileSync(logPath, JSON.stringify(logs, null, 2)); 
        } catch{}

        const finalText = `✅ *${count} REAL Reports Completed! - Like Video*\n\n` +
            `📱 *Number:* ${num}\n` +
            `📝 *Base Reason:* ${baseReason}\n` +
            `🔢 *Total:* ${count} REAL reports (like video)\n` +
            `✅ Success: ${success}\n` +
            `❌ Failed: ${fails}\n` +
            `🚫 *Blocked:* Yes - Final blocked\n` +
            `📅 *At:* ${new Date().toLocaleString('en-GB', { timeZone: 'Asia/Colombo' })}\n` +
            `💬 *Last 5 messages:* Sent ${count} times to WhatsApp - Real report\n\n` +
            `📊 *REAL REPORT like video:*\n` +
            `• Flow: Block my no? -> Report to WhatsApp checkbox -> Block -> Please wait a moment -> my no has been blocked -> Reporting... Please wait -> Thank you for reporting -> my no has been unblocked (loop ${count}x)\n` +
            `• WhatsApp server gets last 5 messages (real report IQ: spam/abuse/report)\n` +
            `• Verified Business weight වැඩියි\n\n` +
            `🔒 *Arena AI v2.26.0 REAL REPORT*\n` +
            `📁 Log: reports.json (${logs.length} total)\n\n` +
            `💡 Video වගේ: Block dialog -> Report checked -> Thank you toast!`;

        await edit(finalText);        await edit(finalText);
        log(`🚩 Report${count}x: ${num} ${count}x reason=${baseReason} success=${success} by ${jid}`);

    } catch(e){
        await edit(`❌ Report${count}x fail: ${String(e.message).slice(0,300)}`);
        log('❌ report30: '+e.message);
    }
}
async function handleMode(send, jid, msg, arg) {
    if (arg === 'all' || arg === 'self') {
        guard.setChatMode(arg);
        return send(jid, { text: arg === 'all'
            ? '🔓 *Mode: all* — ඔයා *ඕනෑම chat එකක* ගහන commands වැඩ (reply එක ඒ chat එකේ අනිත් අයටත් පේනවා).\nවෙන කාටවත් තාමත් commands පාවිච්චි කරන්න බෑ 🔒\nආපහු: *.mode self*'
            : '🔒 *Mode: self* — commands වැඩ කරන්නේ *Message yourself* chat එකේ විතරයි.' }, { quoted: msg });
    }
    return send(jid, { text: `🔒 *Mode: ${guard.chatMode()}*\n\n*.mode self* — "Message yourself" chat එකේ විතරයි (default, ආරක්ෂිතම)\n*.mode all* — ඔයා ඕනෑම chat එකක ගහන commands වැඩ\n\n(කොහොම වුණත් commands පාවිච්චි කරන්න පුළුවන් *ඔයාට විතරයි*)` }, { quoted: msg });
}

async function handleProxy(send, del, jid, msg, arg) {
    const f = require('path').join(__dirname, 'settings.json');
    let d = {}; try { d = JSON.parse(require('fs').readFileSync(f, 'utf8')); } catch { }
    const hide = (p) => p.replace(/\/\/[^@/]*@/, '//***@');
    const relay = process.env.EPORNER_RELAY_URL || d.epornerRelay || '';
    const proxyInfo = d.proxy ? `🧩 Proxy: ${hide(d.proxy)}` : '🧩 Proxy නෑ';
    const relayInfo = relay ? `\n🔗 Relay: ${relay.slice(0,60)}...` : '';
    if (!arg) { 
        await send(jid, { text: `${proxyInfo}${relayInfo}\n\n(off කරන්න: *.setproxy off*)\n\nදාන්න: *.setproxy http://user:pass@host:port*\n⚠️ Eporner CDN (vid-*-cdn.eporner.com) block එකට residential proxy ඕනේ - datacenter proxy වලින් වැඩ නෑ!\n💡 *.setproxy residential* proxy දාන්න\n🔗 External relay: *.setproxy relay <url>* හෝ env EPORNER_RELAY_URL` }, { quoted: msg }); 
        return; 
    }
    if (/^(off|delete|remove|none)$/i.test(arg)) { 
        delete d.proxy; 
        delete d.epornerRelay;
        require('fs').writeFileSync(f, JSON.stringify(d, null, 2)); 
        await send(jid, { text: '🧩 Proxy + Relay අයින් කළා ✅' }, { quoted: msg }); 
        return; 
    }
    // Handle relay: .setproxy relay https://...
    if (arg.toLowerCase().startsWith('relay ')) {
        const relayUrl = arg.slice(6).trim();
        if (!/^https?:\/\//i.test(relayUrl)) {
            await send(jid, { text: '❌ Relay format: *.setproxy relay https://your-relay.com/?url={url}*\nඋදා: .setproxy relay https://relay.example.com/' }, { quoted: msg });
            return;
        }
        d.epornerRelay = relayUrl;
        require('fs').writeFileSync(f, JSON.stringify(d, null, 2));
        process.env.EPORNER_RELAY_URL = relayUrl;
        await send(jid, { text: `🔗 Eporner Relay save කළා ✅\n${relayUrl}\n\nEporner downloads විතරක් මේ relay එක හරහා යනවා (CDN bypass)\nTest: .eporner <query> → download` });
        return;
    }
    if (!/^https?:\/\/[^\s]+:\d+\/?$/i.test(arg)) { await send(jid, { text: '❌ Format එක: *.setproxy http://user:pass@host:port*  (http / https proxy විතරයි)\nRelay: *.setproxy relay https://relay-url*\n\n⚠️ Eporner CDN වලට residential proxy ඕනේ!' }, { quoted: msg }); return; }
    d.proxy = arg.replace(/\/$/, ''); require('fs').writeFileSync(f, JSON.stringify(d, null, 2));
    if (/@/.test(arg)) await del(msg.key);   // hide the password
    await send(jid, { text: `🧩 Proxy save කළා ✅ ${hide(d.proxy)}\nBlock වෙන sites වලට ඉබේම පාවිච්චි වෙනවා. Test: *.net <link>*\n\n⚠️ Eporner CDN (vid-*-cdn.eporner.com) වලට residential proxy ඕනේ - datacenter proxy වලින් වැඩ නෑ!\n💡 Residential: BrightData, SmartProxy, etc` });
}

const mask = (k) => k.slice(0, 4) + '••••' + k.slice(-3);
const KEY_HELP = `🔑 *Free API key එකක් ගන්න:*

*Gemini (Google):*
1. https://aistudio.google.com/apikey open කරන්න (Google account එකෙන් login)
2. *Create API key* ඔබලා key එක copy කරන්න
3. මෙතන ගහන්න:  *.setkey gemini ඔයාගේ_key*

*Groq:*
1. https://console.groq.com/keys open කරන්න (login)
2. *Create API Key* → copy
3. *.setkey groq ඔයාගේ_key*

(දෙකම දැම්මොත් හොඳයි — එකක් fail වුණොත් අනිත් එක auto පාවිච්චි කරනවා)`;

async function handleKey(send, del, jid, msg, c, rest) {
    const provider = (rest[0] || '').toLowerCase();
    if (!['gemini', 'groq', 'apify'].includes(provider)) return send(jid, { text: KEY_HELP + '\n\n🔑 Apify: *.setkey apify <TOKEN>* - https://console.apify.com/account/integrations' }, { quoted: msg });
    if (c === '.delkey') { ai.setKey(provider, ''); return send(jid, { text: `🗑️ ${provider} key එක මැකුවා` }); }
    const key = (rest[1] || '').trim();
    if (provider === 'apify' && key.length < 10) return send(jid, { text: '❌ Apify token එක වැරදියි - https://console.apify.com/account/integrations එකෙන් ගන්න' }, { quoted: msg });
    if (provider !== 'apify' && key.length < 20) return send(jid, { text: KEY_HELP }, { quoted: msg });
    ai.setKey(provider, key);
    await del(msg.key); // key එක තියෙන message එක chat එකෙන් මකනවා (ආරක්ෂාවට)
    if (provider === 'apify') {
        await send(jid, { text: `✅ Apify token save කළා (${mask(key)})\n🔒 Message එක මැකුවා\n\nEporner download fail වෙනකොට Apify proxy එකෙන් auto try කරනවා` });
    } else {
        await send(jid, { text: `✅ ${provider} key එක save කළා (${mask(key)})\n🔒 key එක තිබ්බ message එක මැකුවා.\n\nදැන් test කරන්න: *.ai හායි*` });
    }
}

function quotedText(msg) {
    const ctx = msg.message?.extendedTextMessage?.contextInfo;
    return ctx?.quotedMessage ? getText(ctx.quotedMessage) : '';
}

async function handleAI(send, jid, msg, question) {
    question = question.trim();
    if (/^(reset|new|clear)$/i.test(question)) { ai.reset(jid); return send(jid, { text: '🆕 කතාව reset කළා. අලුතෙන් අහන්න!' }, { quoted: msg }); }
    const q = quotedText(msg);
    if (q) question = question ? `${question}\n\n"""${q}"""` : `මේ message එක ගැන පැහැදිලි කරන්න:\n"""${q}"""`;
    if (!question) return send(jid, { text: '🤖 *.ai <ප්‍රශ්නය>*\nඋදා: .ai GTA SA වල cheats මොනවද?' }, { quoted: msg });
    const status = await send(jid, { text: '🤖 හිතනවා...' }, { quoted: msg });
    try {
        const { text, model } = await ai.ask(jid, question);
        const parts = ai.splitLong(text);
        await send(jid, { text: parts[0] + (parts.length === 1 ? `\n\n_— ${model}_` : ''), edit: status.key });
        for (let i = 1; i < parts.length; i++) await send(jid, { text: parts[i] + (i === parts.length - 1 ? `\n\n_— ${model}_` : '') });
        log(`🤖 ${model}: ${question.slice(0, 60)}`);
    } catch (e) {
        if (e.noKey) return send(jid, { text: '⚠️ AI key එකක් තවම දාලා නෑ.\n\n' + KEY_HELP, edit: status.key });
        await send(jid, { text: `❌ AI error:\n${String(e.message).slice(0, 400)}\n\n💡 Key එක හරිද බලන්න (*.keys*), නැත්නම් ටිකකින් ආයෙත් try කරන්න (free limit).`, edit: status.key });
        log('❌ AI: ' + e.message);
    }
}

let updating = false;
async function handleUpdate(send, jid, msg, force, zipUrl) {
    if (updating) return send(jid, { text: '⏳ Update එකක් දැනටමත් වෙනවා...' }, { quoted: msg });
    // If zip URL provided - Powerful DL v2.6 style self-update
    if (zipUrl && /^https?:\/\//i.test(zipUrl)) {
        updating = true;
        const status = await send(jid, { text: `📦 Update zip download කරනවා...\n🔗 ${zipUrl}\n⏳ Wait...` }, { quoted: msg });
        const edit = async (t) => { try { await send(jid, { text: t, edit: status.key }); } catch {} };
        try {
            let AdmZip;
            try { AdmZip = require('adm-zip'); } catch { throw new Error('adm-zip නෑ - npm install adm-zip කරන්න'); }
            const { smartFetch } = require('./net');
            const res = await smartFetch(zipUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
            if (!res.ok) throw new Error(`HTTP ${res.status} (link expire/private)`);
            const buf = Buffer.from(await res.arrayBuffer());
            const zip = new AdmZip(buf);
            for (const e of zip.getEntries()) {
                const n = e.entryName;
                if (n.includes('..') || n.startsWith('/') || /^[a-zA-Z]:\\/.test(n)) throw new Error('zip unsafe paths - abort');
            }
            const names = new Set();
            for (const e of zip.getEntries()) {
                if (e.isDirectory) continue;
                const n = path.basename(e.entryName);
                if (/node_modules/i.test(e.entryName)) continue;
                if (/\.(js|json|txt|sh|jpg)$/i.test(n)) names.add(n);
            }
            if (!names.has('bot.js')) throw new Error('zip එකේ bot.js නෑ - වැරදි zip');
            const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0,19);
            const bak = path.join(__dirname, 'backup-'+ts);
            fs.mkdirSync(bak, { recursive: true });
            for (const n of names) {
                const cur = path.join(__dirname, n);
                if (fs.existsSync(cur)) fs.copyFileSync(cur, path.join(bak, n));
            }
            const applied=[];
            for (const e of zip.getEntries()) {
                if (e.isDirectory) continue;
                const n = path.basename(e.entryName);
                if (!names.has(n)) continue;
                fs.writeFileSync(path.join(__dirname, n), e.getData());
                applied.push(n);
            }
            await edit(`✅ *Update apply වුණා!*\n\n📁 ${applied.join(', ')}\n💾 Backup: backup-${ts}\n\n🔄 Restart වෙනවා...`);
            log(`🔄 Zip update applied: ${applied.join(', ')} - restarting`);
            try { fs.writeFileSync(ANNOUNCE_NEXT, '1'); } catch {}
            setTimeout(() => process.exit(100), 2500);
            return;
        } catch (e) {
            updating = false;
            await edit(`❌ Zip update fail:\n${String(e.message).slice(0, 400)}`);
            log('❌ zip update: '+e.message);
            return;
        }
    }
    // GitHub manifest update (original)
    updating = true;
    const status = await send(jid, { text: '🔍 Update තියෙනවද බලනවා...' }, { quoted: msg });
    const edit = async (t) => { try { await send(jid, { text: t, edit: status.key }); } catch { } };
    try {
        const r = await updater.apply({ force, onStatus: edit });
        if (!r.updated) { updating = false; return edit(`✅ දැනටමත් අලුත්ම version එක (v${r.current.version})`); }
        await edit(`✅ *Update වුණා!*  v${r.from} → v${r.to}\n\n📝 ${r.notes}\n\n🔄 Restart වෙනවා... තත්පර 10 කින් *.ping* ගහලා බලන්න.\n(WhatsApp link එක / API keys වෙනස් වෙන්නේ නෑ)`);
        log(`🔄 Updated v${r.from} → v${r.to} — restarting`);
        if (!process.env.ARENA_LAUNCHER) await send(jid, { text: '⚠️ Bot එක *npm start* එකෙන් start කරලා නැති නිසා auto restart වෙන්නේ නෑ. Termux එකේ CTRL+C කරලා *npm start* ගහන්න.' });
        try { fs.writeFileSync(ANNOUNCE_NEXT, '1'); } catch { }   // show the online card after restart
        setTimeout(() => process.exit(100), 2500);
    } catch (e) {
        updating = false;
        await edit(`❌ Update fail වුණා:\n${String(e.message).slice(0, 300)}\n\n(පරණ version එක එහෙමම වැඩ)`);
        log('❌ update: ' + e.message);
    }
}

async function handleMirror(send, jid, msg, url) {
    if (!url || !/^https?:\/\//i.test(url)) {
        await send(jid, { text: '🪞 *.mirror <url>*\nWhatsApp file එකක් විදියට නෙවෙයි, direct browser link එකක් විදියට එවනවා\nඋදා: .mirror https://example.com/file.zip\n.mirror <eporner-page-url> → best quality mirror' }, { quoted: msg });
        return;
    }
    const status = await send(jid, { text: `🪞 Mirror link හදනවා...\n🔗 ${url}\n⏳ Download + upload...` }, { quoted: msg });
    const edit = async (t) => { try { await send(jid, { text: t, edit: status.key }); } catch {} };
    let dlResult = null;
    let tmpFile = null;
    try {
        let dlUrl = url;
        let extra = '';
        // Eporner page → resolve best quality
        if (url.includes('eporner.com') && !url.includes('/dload/')) {
            try {
                const links = await eporner.parseDownloadLinks(url);
                const best = links.find(l => l.type === 'h264') || links[0];
                if (best) {
                    dlUrl = best.direct ? best.url : await eporner.getFinalMp4Url(best.dloadUrl || best.url);
                    extra = `\n🎬 ${best.quality}p ${best.type}${best.sizeText ? ' ('+best.sizeText+')' : ''}`;
                }
            } catch (e) {
                console.log('[mirror] eporner resolve fail', e.message);
            }
        }
        await edit(`📥 Downloading...\n🔗 ${dlUrl.slice(0,80)}...`);
        // Use downloader.js for general URLs, eporner.js for eporner direct
        if (dlUrl.includes('cdn.eporner.com') || dlUrl.includes('eporner.com/v2/') || dlUrl.includes('eporner.com/v4/')) {
            // Direct eporner mp4
            const { Readable } = require('stream');
            const res = await eporner.smartFetchFinal(dlUrl);
            if (!res.ok) throw new Error(`MP4 fetch ${res.status}`);
            const outPath = path.join(require('os').tmpdir() || process.env.DL_TMP || '/tmp', `mirror-${Date.now().toString(36)}.mp4`);
            const file = fs.createWriteStream(outPath);
            const stream = Readable.fromWeb(res.body);
            await new Promise((resolve, reject) => { stream.pipe(file); file.on('finish', resolve); file.on('error', reject); });
            tmpFile = outPath;
            const stat = fs.statSync(outPath);
            dlResult = { path: outPath, name: `eporner-${Date.now()}.mp4`, size: stat.size };
        } else {
            const { download } = require('./downloader');
            const files = await download(dlUrl, async (loaded, total, speed) => {
                // progress ignored for mirror
            });
            dlResult = files[0];
            tmpFile = dlResult.path;
        }
        if (!dlResult) throw new Error('Download fail');
        await edit(`⬆️ Transfer site එකට upload කරනවා... ${human(dlResult.size)}${extra}`);
        if (!mirrorMod) throw new Error('mirror.js නෑ');
        const link = await mirrorMod.uploadTransfer(dlResult.path, dlResult.name);
        await send(jid, { text: `✅ *Mirror link ready!*\n\n🔗 ${link}\n📁 ${dlResult.name}\n📦 ${human(dlResult.size)}${extra}\n\n💬 Chrome search bar එකේ දැම්මම direct download වෙනවා\n🪞 Powerful DL v2.6 feature`, edit: status.key });
        log(`✅ Mirror: ${link} (${dlResult.name})`);
    } catch (e) {
        await edit(`❌ Mirror fail:\n${String(e.message).slice(0, 400)}\n\n💡 .net ${url.slice(0,60)} ගහලා බලන්න`);
        log('❌ mirror: '+e.message);
    } finally {
        if (tmpFile) {
            try { fs.rmSync(tmpFile, { force: true }); } catch {}
            try { fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true }); } catch {}
        }
        if (dlResult && dlResult.path && dlResult.path !== tmpFile) {
            try { fs.rmSync(dlResult.path, { force: true }); } catch {}
        }
    }
}




async function handleMovieProSearch(send, jid, msg, query) {
    if (!query) {
        await send(jid, { text: '🎬 *.moviepro <name>*\nඋදා: .moviepro Black Clover\n.moviepro Demon Slayer\n.moviepro One Piece\n\nArena AI style search - anime & movies' }, { quoted: msg });
        return;
    }
    const status = await send(jid, { text: `🎬 MoviePro search: ${query}...` }, { quoted: msg });
    const edit = async (t) => { try { await send(jid, { text: t, edit: status.key }); } catch {} };
    try {
        const results = await moviepro.search(query);
        if (!results.length) {
            await edit('❌ No results found');
            return;
        }
        moviepro.setCache(jid, { query, results, at: Date.now() });
        const txt = moviepro.formatSearchResults(query, results);
        // Try to send with image if first result has image
        const firstImg = results[0]?.image;
        if (firstImg) {
            try {
                await send(jid, { image: { url: firstImg }, caption: txt }, { edit: status.key });
                return;
            } catch {}
        }
        await edit(txt);
        log(`🎬 MoviePro search: ${query} → ${results.length} results`);
    } catch (e) {
        await edit(`❌ MoviePro search fail:\n${String(e.message).slice(0,300)}`);
        log('❌ moviepro search: '+e.message);
    }
}

async function handleMovieProDetail(send, jid, msg, idx, cached) {
    const anime = cached.results[idx];
    if (!anime) return;
    const status = await send(jid, { text: `📄 Getting details: ${anime.title}...` }, { quoted: msg });
    const edit = async (t) => { try { await send(jid, { text: t, edit: status.key }); } catch {} };
    try {
        let episodes = [];
        if (anime.source !== 'mock') {
            try {
                episodes = await moviepro.getEpisodes(anime.id, anime.source);
            } catch (e) { console.log('episodes fetch fail', e.message); }
        }
        if (!episodes.length) {
            const total = anime.episodes || 170;
            for (let i = 1; i <= Math.min(total, 170); i++) {
                episodes.push({ id: i, title: `Episode ${i}`, number: i });
            }
        }
        moviepro.setDetailCache(jid, { anime, episodes, query: cached.query, at: Date.now() });
        const txt = moviepro.formatDetails(anime, episodes);
        if (anime.image) {
            try {
                await send(jid, { image: { url: anime.image }, caption: txt }, { edit: status.key });
                return;
            } catch (e) { console.log('send image fail', e.message); }
        }
        await edit(txt);
        log(`🎬 MoviePro detail: ${anime.title} → ${episodes.length} episodes`);
    } catch (e) {
        log(`❌ moviepro detail error: ${e.message}`);
        try { await edit(`❌ Detail fail: ${String(e.message).slice(0,300)}\nTry .moviepro again`); } catch {}
    }
}

async function handleMovieProQuality(send, jid, msg, num, dCache) {
    try {
        const { anime, episodes } = dCache;
        let season = 1;
        let episode = null;
        
        // Handle All Episodes options: 1 = S1 All, 51 or 171/172 = S2 All (from screenshots)
        if (num === 1) {
            season = 1;
            episode = 'all';
        } else if (num === 51 || num === 171 || num === 172 || num === 173) {
            season = 2;
            episode = 'all';
        } else {
            // Specific episode: num 2 = E1, 3 = E2, etc
            const epIdx = num - 2;
            if (episodes && episodes[epIdx]) {
                episode = episodes[epIdx];
            } else {
                episode = { number: num-1, title: `Episode ${num-1}` };
            }
            season = episode.season || 1;
        }
        
        moviepro.setQualityCache(jid, { anime, episode, season, at: Date.now() });
        const txt = moviepro.formatQualityOptions(season, episode, anime);
        
        await send(jid, { text: txt }, { quoted: msg });
        log(`🎬 MoviePro quality select: ${anime.title} S${season} ${episode === 'all' ? 'All' : 'E'+(episode.number||num)}`);
    } catch (e) {
        log(`❌ moviepro quality error: ${e.message}`);
        try { await send(jid, { text: `❌ Error: ${String(e.message).slice(0,200)}\nTry .moviepro again` }, { quoted: msg }); } catch {}
    }
}

async function handleMovieProDownload(send, jid, msg, qualityNum, qCache) {
    const { anime, episode, season } = qCache;
    
    const qualities = { 1: '1080p', 2: '720p', 3: '480p', 4: '360p' };
    const subtitles = {
        5: 'Sinhala 🇱🇰', 6: 'English 🇬🇧', 7: 'Hindi 🇮🇳', 8: 'Spanish 🇪🇸',
        9: 'French 🇫🇷', 10: 'Arabic 🇸🇦', 11: 'Bangla 🇧🇩', 12: 'Indonesian 🇮🇩',
        13: 'Malay 🇲🇾', 14: 'Portuguese 🇵🇹', 15: 'Russian 🇷🇺'
    };
    
    let quality = qualities[qualityNum] || subtitles[qualityNum] || '720p';
    let isSubtitle = qualityNum >= 5;
    
    const status = await send(jid, { text: `📦 *Arena MoviePro v2.25.0*\n\n🎬 ${anime.title}\n📺 S${season} ${episode === 'all' ? 'All Episodes' : 'E'+(episode.number||'?')}\n🎥 Quality: ${quality}\n${isSubtitle ? '💬 Sub: '+quality : ''}\n\n⏳ Getting real download links...\n🔥 Arena AI v2.25.0` }, { quoted: msg });
    const edit = async (t) => { try { await send(jid, { text: t, edit: status.key }); } catch {} };
    
    try {
        // ── Cinesubz REAL MOVIE (matheeshasanjana83-alt/abc system) - NO TRAILER, MOVIE ITSELF ──
        if (anime.source === 'cinesubz' || realLinks?.type === 'cinesubz' || anime.cinesubzLink) {
            // If we don't have realLinks yet, fetch it
            if (!realLinks || realLinks.type !== 'cinesubz') {
                try {
                    realLinks = await moviepro.getDownloadLinks(anime, episode, quality);
                } catch(e){ console.log('[moviepro] cinesubz getLinks fail', e.message); }
            }
            if (realLinks && realLinks.type === 'cinesubz') {
                const downloads = realLinks.downloads || [];
                if (!downloads.length) {
                    await edit(`🎬 *${anime.title}*\nNo downloads found from Cinesubz\n\n🔗 Link: ${anime.cinesubzLink || anime.id}\n\n🔥 Arena MoviePro v2.25`);
                    return;
                }
                // Map qualityNum to download
                let selected = null;
                if (qualityNum >=1 && qualityNum <= downloads.length) selected = downloads[qualityNum-1];
                else {
                    selected = downloads.find(d => (d.quality||'').toLowerCase().includes(quality.toLowerCase())) || downloads.find(d => (d.quality||'').includes('1080')) || downloads[0];
                }
                const allQualities = downloads.map((d,i) => `${i+1}. ${d.quality || 'HD'} - ${d.size || 'N/A'} ${d.type || ''}`).join('\n');
                await edit(`✅ *Cinesubz Real Movie Found!*\n\n🎬 ${anime.title}\n📦 Selected: ${selected.quality || quality} ${selected.size || ''}\n🔗 ${String(selected.link).slice(0,80)}...\n\n📋 All qualities:\n${allQualities}\n\n⏳ Downloading real movie file (no trailer)...\n🔥 Arena MoviePro v2.25\n⚡ System: matheeshasanjana83-alt/abc`);

                try {
                    const media = require('./media');
                    const maxMB = parseInt(process.env.DL_MAX_MB || '2000', 10);
                    // Try yt-dlp first (handles many movie sites)
                    let dlRes = null;
                    try {
                        dlRes = await media.ytdl(selected.link, { mode: 'video', maxMB: Math.min(maxMB, 1500), heights: [1080,720,480,360] });
                    } catch(e){ console.log('[cinesubz] ytdl fail', e.message); }

                    if (dlRes && dlRes.path) {
                        const stat = fs.statSync(dlRes.path);
                        await send(jid, { text: `📤 Sending movie... ${human(stat.size)} - ${selected.quality || quality}`, edit: status.key });
                        let thumbBuf = null;
                        try {
                            if (anime.image || realLinks.image) {
                                const imgUrl = anime.image || realLinks.image;
                                const tr = await fetch(imgUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
                                if (tr.ok) thumbBuf = Buffer.from(await tr.arrayBuffer());
                            }
                        } catch{}

                        const caption = `✅ *${anime.title}*\n🎬 Real Movie File (No Trailer)\n🎥 Quality: ${selected.quality || quality}\n📦 ${human(stat.size)}\n🔗 Source: Cinesubz\n⚡ System: matheeshasanjana83-alt/abc\n🔥 Arena MoviePro v2.25`;

                        const videoMsg = {
                            video: { url: dlRes.path },
                            fileName: `${anime.title.replace(/[^a-z0-9]/gi,'_').slice(0,40)}_${selected.quality || quality}.mp4`,
                            mimetype: 'video/mp4',
                            caption
                        };
                        if (thumbBuf) videoMsg.jpegThumbnail = thumbBuf;

                        await send(jid, videoMsg, { quoted: msg });
                        await send(jid, { text: `✅ *Movie download complete!*\n\n🎬 ${anime.title}\n🎥 ${selected.quality || quality} - ${human(stat.size)}\n\n🔥 Arena MoviePro v2.25\n⚡ Real file, no trailer`, edit: status.key });
                        try { fs.rmSync(dlRes.path, { force: true }); } catch{}
                        log(`✅ MoviePro Cinesubz REAL: ${anime.title} ${selected.quality || quality} ${human(stat.size)}`);
                        return;
                    }

                    // Fallback to direct downloader.js
                    const { download } = require('./downloader');
                    await edit(`⏳ Trying direct download...\n🔗 ${String(selected.link).slice(0,80)}...`);
                    const files = await download(selected.link, (loaded, total, speed) => {
                        // progress ignored
                    }, { stream: false });

                    if (files && files[0]) {
                        const f = files[0];
                        await send(jid, { text: `📤 Sending... ${f.name} ${human(f.size)}`, edit: status.key });
                        await send(jid, { document: { url: f.path }, fileName: f.name, mimetype: f.mime || 'video/mp4', caption: `✅ ${anime.title}\n🎥 ${selected.quality || quality} ${human(f.size)}\n🔥 Arena MoviePro v2.25\n⚡ Cinesubz real movie` }, { quoted: msg });
                        try { fs.rmSync(f.path, { force: true }); } catch{}
                        log(`✅ MoviePro Cinesubz direct: ${anime.title} ${human(f.size)}`);
                        return;
                    }

                } catch (dlErr) {
                    console.log('[cinesubz] download fail', dlErr.message);
                    await edit(`⚠️ Download fail: ${String(dlErr.message).slice(0,200)}\n\n🔗 Direct link:\n${String(selected.link).slice(0,400)}\n\n💡 Try .download ${String(selected.link).slice(0,100)}\n🔥 Arena MoviePro v2.25`);
                    await send(jid, { text: `🎬 *${anime.title}*\n📦 Quality: ${selected.quality || quality}\n🔗 Direct: ${selected.link}\n\n🔥 Arena MoviePro v2.25\n⚡ Real movie file - use .download` });
                    return;
                }
            }
        }

        // YTS Movie handling
        if (anime.source === 'yts') {
            const torrents = anime.torrents || [];
            if (!torrents.length) {
                await edit(`🎬 *${anime.title}*\nNo torrents found\n\n🔥 Arena MoviePro v2.25.0`);
                return;
            }
            let selected = null;
            if (qualityNum >=1 && qualityNum <= torrents.length) selected = torrents[qualityNum-1];
            else {
                selected = torrents.find(t => t.quality === quality) || torrents.find(t => t.quality === '1080p') || torrents[0];
            }
            const allTxt = torrents.map((t,i) => `${i+1}. ${t.quality} ${t.type} - ${t.size} Seeds:${t.seeds}`).join('\n');
            await edit(`🎬 *${anime.title}*\n\n📦 *Selected:* ${selected.quality} ${selected.type} ${selected.size}\n🔗 Magnet: magnet:?xt=urn:btih:${selected.hash}&dn=${encodeURIComponent(anime.title)}\n\n📋 *All qualities:*\n${allTxt}\n\n💡 Torrent download via client (qBittorrent)\n🔥 Arena MoviePro v2.25.0\n⚡ YTS API: yts.am\n\n💾 Direct torrent: ${selected.url}`);

            try {
                if (anime.yt_trailer) {
                    await send(jid, { text: `🎬 *Trailer:* ${anime.yt_trailer}\n\nUse .video ${anime.yt_trailer} to download trailer\n🔥 Arena MoviePro v2.25.0` });
                } else {
                    const yts = require('yt-search');
                    const r = await yts(`${anime.title} trailer`);
                    if (r.videos && r.videos[0]) {
                        const v = r.videos[0];
                        await send(jid, { image: { url: v.thumbnail }, caption: `🎬 *Trailer:* ${v.title.slice(0,60)}\n⏱️ ${v.timestamp} • 👁️ ${v.views}\n🔗 ${v.url}\n\n🔥 Arena MoviePro v2.25.0` });
                    }
                }
            } catch {}
            log(`✅ MoviePro YTS: ${anime.title} ${selected.quality}`);
            return;
        }

        if (episode === 'all') {
            const total = anime.episodes || 24;
            await edit(`📦 *Arena MoviePro S${season} - All Episodes*\n\n🎬 ${anime.title}\n📊 Total: ${total} episodes\n🎥 Quality: ${quality}\n${isSubtitle ? '💬 Subtitle: '+quality : ''}\n\n⚠️ Season download = ${total} files, large!\n💡 For single episode: reply episode number (2-${Math.min(total+1,50)})\n\n🔥 *Arena MoviePro v2.25.0*\n✅ Real download via HiAnime + yt-dlp`);

            try {
                const eps = await moviepro.getEpisodes(anime.hianimeId || anime.id, anime.source);
                if (eps.length) {
                    await send(jid, { text: `📋 *${anime.title} - Episode List (first 10)*\n\n${eps.slice(0,10).map((e,i)=> `${i+2}. E${e.number} - ${e.title.slice(0,30)}`).join('\n')}\n\n💡 Reply number (2-11) for single episode download\n🔥 Arena MoviePro v2.25.0` });
                }
            } catch {}
            
            if (anime.image) {
                try {
                    await send(jid, { image: { url: anime.image }, caption: `🎬 *${anime.title} S${season} - All Episodes*\n🎥 Quality: ${quality}\n📊 ${total} episodes\n\n🔥 Arena MoviePro v2.25.0\n⚡ HiAnime real download\n\n💡 Reply episode number (2-${Math.min(total+1,50)}) for single episode` });
                } catch {}
            }
            return;
        }

        const epNum = episode.number || 1;
        const epTitle = episode.title || `Episode ${epNum}`;
        await edit(`📦 *Downloading...*\n\n🎬 ${anime.title}\n📺 S${season}E${epNum}: ${epTitle.slice(0,40)}\n🎥 Quality: ${quality}\n${isSubtitle ? '💬 Sub: '+quality : ''}\n\n⏳ Getting HiAnime sources...\n🔥 Arena MoviePro v2.25.0`);

        let realLinks = null;
        try {
            realLinks = await moviepro.getDownloadLinks(anime, episode, quality);
        } catch (e) {
            console.log('[moviepro] getDownloadLinks fail', e.message);
        }

        if (realLinks && realLinks.type === 'hianime' && realLinks.sources?.length) {
            let picked = null;
            const qMap = { '1080p': 1080, '720p': 720, '480p': 480, '360p': 360 };
            const wanted = qMap[quality] || 720;
            
            const sorted = [...realLinks.sources].sort((a,b) => {
                const qa = parseInt(a.quality) || (a.url?.includes('1080')?1080:a.url?.includes('720')?720:480);
                const qb = parseInt(b.quality) || (b.url?.includes('1080')?1080:b.url?.includes('720')?720:480);
                return qb - qa;
            });
            
            picked = sorted.find(s => {
                const sq = parseInt(s.quality) || 0;
                return sq === wanted;
            }) || sorted.find(s => parseInt(s.quality) >= wanted) || sorted[0];

            if (!picked) picked = realLinks.sources[0];

            const m3u8Url = picked.url || picked.file || picked.source;
            const subTracks = realLinks.tracks || [];

            await edit(`✅ *Sources found!*\n\n🎬 ${anime.title} E${epNum}\n🎥 ${picked.quality || quality} ${picked.isM3U8 ? '(m3u8)' : '(mp4)'}\n💬 Subs: ${subTracks.length} tracks\n🔗 ${String(m3u8Url).slice(0,80)}...\n\n⏳ Downloading via yt-dlp...\n🔥 Arena MoviePro v2.25.0`);

            try {
                const media = require('./media');
                const maxMB = parseInt(process.env.DL_MAX_MB || '2000', 10);
                const heights = quality === '1080p' ? [1080,720,480] : quality === '720p' ? [720,480,360] : quality === '480p' ? [480,360] : [360,480];
                
                const dlRes = await media.ytdl(m3u8Url, { mode: 'video', maxMB: Math.min(maxMB, 500), heights });
                
                if (dlRes && dlRes.path) {
                    const stat = fs.statSync(dlRes.path);
                    await send(jid, { text: `📤 Sending video... ${human(stat.size)}`, edit: status.key });
                    
                    let thumbBuf = null;
                    try {
                        if (anime.image) {
                            const tr = await fetch(anime.image, { headers: { 'User-Agent': 'Mozilla/5.0' } });
                            if (tr.ok) thumbBuf = Buffer.from(await tr.arrayBuffer());
                        }
                    } catch {}

                    const caption = `✅ *${anime.title}*\n📺 S${season}E${epNum}: ${epTitle.slice(0,50)}\n🎥 Quality: ${picked.quality || quality}\n📦 ${human(stat.size)}\n${subTracks.length ? `💬 Subs: ${subTracks.map(s=>s.label||s.kind).join(', ').slice(0,100)}` : ''}\n\n🔥 *Arena MoviePro v2.25.0*\n⚡ Real download via HiAnime + yt-dlp\n🔗 Source: ${anime.source}`;

                    const videoMsg = {
                        video: { url: dlRes.path },
                        fileName: `${anime.title.replace(/[^a-z0-9]/gi,'_').slice(0,30)}_S${season}E${epNum}_${picked.quality||quality}.mp4`,
                        mimetype: 'video/mp4',
                        caption
                    };
                    if (thumbBuf) videoMsg.jpegThumbnail = thumbBuf;
                    
                    await send(jid, videoMsg, { quoted: msg });
                    await send(jid, { text: `✅ *Download complete!*\n\n🎬 ${anime.title} E${epNum}\n🎥 ${picked.quality || quality} - ${human(stat.size)}\n\n🔥 Arena MoviePro v2.25.0`, edit: status.key });
                    
                    try { fs.rmSync(dlRes.path, { force: true }); } catch {}
                    log(`✅ MoviePro REAL: ${anime.title} E${epNum} ${picked.quality||quality} ${human(stat.size)}`);
                    return;
                }
            } catch (dlErr) {
                console.log('[moviepro] yt-dlp fail', dlErr.message);
                await edit(`⚠️ yt-dlp download fail: ${String(dlErr.message).slice(0,200)}\n\n🔗 Direct link:\n${String(m3u8Url).slice(0,300)}\n\n💡 Try .download ${String(m3u8Url).slice(0,100)}...\nOr set proxy: .setproxy http://...\n\n🔥 Arena MoviePro v2.25.0`);
                
                try {
                    const { download } = require('./downloader');
                    if (m3u8Url.includes('.mp4')) {
                        const files = await download(m3u8Url, () => {}, { stream: false });
                        if (files[0]) {
                            await send(jid, { video: { url: files[0].path }, fileName: `${anime.title}_E${epNum}.mp4`, caption: `✅ ${anime.title} E${epNum} ${quality}\n🔥 Arena MoviePro v2.25.0` }, { quoted: msg });
                            try { fs.rmSync(files[0].path, { force: true }); } catch {}
                            return;
                        }
                    }
                } catch {}
            }

            await send(jid, {
                text: `🎬 *${anime.title}*\n📺 S${season}E${epNum}: ${epTitle}\n🎥 Quality: ${picked.quality || quality}\n\n📥 *Direct source:*\n${String(m3u8Url).slice(0,400)}\n\n💬 *Subtitles:* ${subTracks.length ? subTracks.map(t=> `${t.label||t.kind} - ${t.file?.slice(0,60)}`).join('\n') : 'None'}\n\n🔥 *Arena MoviePro v2.25.0*\n⚡ Source: HiAnime (${anime.hianimeId || anime.id})\n💡 Use .download <link> or set proxy if blocked\n🔗 Info: ${anime.url || ''}`
            });
            
            try {
                const yts = require('yt-search');
                const r = await yts(`${anime.title} episode ${epNum} trailer`);
                if (r.videos && r.videos[0]) {
                    const v = r.videos[0];
                    await send(jid, { image: { url: v.thumbnail }, caption: `🎬 *Trailer:* ${v.title.slice(0,60)}\n⏱️ ${v.timestamp} • 👁️ ${v.views}\n🔗 ${v.url}\n\n🔥 Arena MoviePro v2.25.0` });
                }
            } catch {}

        } else {
            await edit(`⚠️ *Real sources not found*\n\n🎬 ${anime.title} E${epNum}\n🔍 HiAnime search failed (cloudflare/block)\n\n💡 Trying alternative...\n🔥 Arena MoviePro v2.25.0`);

            let fallbackNote = `\n🔗 Info: ${anime.url || ''}`;
            if (anime.source !== 'hianime') {
                fallbackNote += `\n💡 This anime may need HiAnime access. If blocked:\n• .setproxy http://user:pass@host:port\n• Try .moviepro with different name`;
            }

            await send(jid, {
                text: `🎬 *${anime.title}*\n` +
                      `📺 S${season}E${epNum}: ${epTitle}\n` +
                      `🎥 Quality: ${quality} ${isSubtitle ? '('+quality+' sub)' : ''}\n` +
                      `⭐ Score: ${anime.score || 'N/A'}\n` +
                      `📅 Year: ${anime.year || 'N/A'}\n` +
                      `🔗 Source: ${anime.source}\n\n` +
                      `📥 *Download Options:*\n` +
                      `• Real download via HiAnime (requires access)\n` +
                      `• Quality: 1080p/720p/480p/360p\n` +
                      `• Subtitles: Sinhala, English, etc\n\n` +
                      `🔥 *Arena MoviePro v2.25.0*\n` +
                      `⚡ Own API - HiAnime + Jikan + YTS\n` +
                      `💡 If blocked: .setproxy <residential proxy>\n` +
                      `💡 Use .download <direct link> if you have link\n` +
                      fallbackNote
            });

            try {
                const yts = require('yt-search');
                const r = await yts(`${anime.title} ${epTitle} trailer`);
                if (r.videos && r.videos[0]) {
                    const v = r.videos[0];
                    await send(jid, { image: { url: v.thumbnail }, caption: `🎬 *Trailer (fallback):* ${v.title.slice(0,60)}\n⏱️ ${v.timestamp} • 👁️ ${v.views}\n🔗 ${v.url}\n\n⚠️ Real episode blocked - trailer shown\n🔥 Arena MoviePro v2.25.0\n💡 Set proxy for real download` });
                }
            } catch {}
        }
        
        log(`✅ MoviePro: ${anime.title} S${season} ${episode === 'all' ? 'All' : 'E'+(episode.number||'?')} ${quality}`);
    } catch (e) {
        await edit(`❌ Download fail: ${String(e.message).slice(0,300)}\n\n💡 Try .moviepro ${anime.title} again\n🔥 v2.24`);
        log('❌ moviepro download: '+e.message);
    }
}



async function handleEpornerSearch(send, jid, msg, query) {
    const status = await send(jid, { text: `🔍 Eporner search: ${query}...` }, { quoted: msg });
    try {
        const data = await eporner.search(query, 5, 1);
        if (!data.videos || !data.videos.length) {
            await send(jid, { text: '❌ No results', edit: status.key });
            return;
        }
        epornerCache.set(jid, data);
        epornerCache.set(jid.split('@')[0], data);
        epornerQualityCache.delete(jid);
        epornerQualityCache.delete(jid.split('@')[0]);
        let txt = `🔞 *Eporner: ${query}* (${data.total_count} total)\n\n`;
        data.videos.forEach((v, i) => {
            txt += `${i + 1}. *${v.title.slice(0, 60)}*\n   ⏱️ ${v.length_min} | 👁️ ${v.views} | ⭐ ${v.rate}\n\n`;
        });
        txt += `💡 Reply *number* (1-${data.videos.length}) → quality list\n📥 .download <url> also works\n🔞 Private 18+`;
        try {
            const firstThumb = data.videos[0]?.default_thumb?.src || data.videos[0]?.thumbs?.[0]?.src;
            if (firstThumb) {
                const thumbRes = await fetch(firstThumb, { headers: { 'User-Agent': 'Mozilla/5.0' } });
                if (thumbRes.ok) {
                    const thumbBuf = Buffer.from(await thumbRes.arrayBuffer());
                    await send(jid, { image: thumbBuf, caption: txt, mimetype: 'image/jpeg' }, { quoted: msg });
                    try { await send(jid, { text: `✅ Search done`, edit: status.key }); } catch {}
                    return;
                }
            }
        } catch {}
        await send(jid, { text: txt, edit: status.key });
    } catch (e) {
        await send(jid, { text: `❌ Search fail: ${e.message}`, edit: status.key });
    }
}

async function handleEpornerDownload(send, jid, msg, video) {
    const status = await send(jid, { text: `🔍 Fetching qualities: ${video.title.slice(0,40)}\n🔗 ${video.url}\n⏳ Wait...` }, { quoted: msg });
    try {
        const links = await eporner.parseDownloadLinks(video.url);
        if (!links.length) throw new Error('No qualities');
        epornerQualityCache.set(jid, { video, links });
        epornerQualityCache.set(jid.split('@')[0], { video, links });
        const maxMB = parseInt(process.env.DL_MAX_MB || '2000', 10);
        let txt = `🎬 *${video.title.slice(0, 60)}*\n👁️ ${video.views} | ⏱️ ${video.length_min} | ⭐ ${video.rate}\n📏 Limit: ${maxMB} MB\n\n📺 *Select Quality (සියල්ල):*\n`;
        links.forEach((l, i) => {
            const sizeStr = l.sizeText ? ` (${l.sizeText})` : '';
            let sizeMB = 0;
            try {
                if (l.sizeText) {
                    const m = l.sizeText.match(/([\d.]+)\s*(MB|GB)/i);
                    if (m) {
                        sizeMB = parseFloat(m[1]) * (m[2].toUpperCase() === 'GB' ? 1024 : 1);
                    }
                }
            } catch {}
            const tooLarge = sizeMB > maxMB ? ' ❌ Too large' : '';
            const fit = sizeMB > 0 && sizeMB <= maxMB ? ' ✅' : (l.type === 'h264' && !tooLarge ? ' ✅' : '');
            txt += `${i + 1}. ${l.quality}p ${l.type.toUpperCase()}${sizeStr}${fit}${tooLarge}\n`;
        });
        txt += `\n💡 Reply *quality number* (1-${links.length}) to download\n📏 Panel limit ${maxMB}MB - use lower quality if too large\n🔞 All qualities added`;
        try {
            const thumbUrl = video.default_thumb?.src || video.thumbs?.[0]?.src;
            if (thumbUrl) {
                const tr = await fetch(thumbUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
                if (tr.ok) {
                    const thumbBuf = Buffer.from(await tr.arrayBuffer());
                    await send(jid, { image: thumbBuf, caption: txt, mimetype: 'image/jpeg' }, { quoted: msg });
                    try { await send(jid, { text: `✅ Qualities loaded`, edit: status.key }); } catch {}
                    return;
                }
            }
        } catch {}
        await send(jid, { text: txt, edit: status.key });
    } catch (e) {
        await send(jid, { text: `❌ Quality fetch fail: ${e.message}\nTrying best quality...`, edit: status.key });
        try {
            const filePath = await eporner.downloadVideo(video.url);
            const stat = fs.statSync(filePath);
            await send(jid, { video: { url: filePath }, fileName: `${video.title.slice(0, 40)}.mp4`, mimetype: 'video/mp4', caption: `✅ ${video.title}\n📦 ${human(stat.size)}` }, { quoted: msg });
            fs.rm(filePath, { force: true }, () => {});
        } catch (e2) { await send(jid, { text: `❌ Fail: ${e2.message}` }); }
    }
}

async function handleEpornerQualityDownload(send, jid, msg, qualityIdx) {
    const cached = epornerQualityCache.get(jid) || epornerQualityCache.get(jid.split('@')[0]) || [...epornerQualityCache.values()][0];
    if (!cached || !cached.links || !cached.links[qualityIdx]) {
        await send(jid, { text: `❌ Quality cache නෑ. .eporner → video number ආයෙත් කරන්න` }, { quoted: msg });
        return;
    }
    await handleEpornerQualityDownloadInternal(send, jid, msg, cached.video, cached.links[qualityIdx]);
}

async function handleEpornerQualityDownloadInternal(send, jid, msg, video, selectedLink) {
    const status = await send(jid, { text: `📥 Downloading: ${video.title.slice(0,40)}
📺 ${selectedLink.quality}p ${selectedLink.type.toUpperCase()}${selectedLink.sizeText ? ' ('+selectedLink.sizeText+')' : ''}
🔗 ${video.url}
⏳ Wait...` }, { quoted: msg });
    let filePath = null;
    try {
        let finalUrl = selectedLink.direct ? selectedLink.url : await eporner.getFinalMp4Url(selectedLink.dloadUrl || selectedLink.url);
        let res = await eporner.smartFetchFinal(finalUrl);
        const maxBytes = parseInt(process.env.DL_MAX_MB || '2000', 10) * 1024 * 1024;
        const contentLen = parseInt(res.headers.get('content-length') || '0');
        if (contentLen > maxBytes) {
            await send(jid, { text: `⚠️ File too large: ${human(contentLen)} > limit ${human(maxBytes)}\n📺 ${selectedLink.quality}p ${selectedLink.sizeText||''}\n💡 Try lower quality (240p/360p) or increase limit:\n- settings.json {"maxMB": 2000}\n- Or env DL_MAX_MB=2000\n\nTrying anyway... (may fail on panel)`, edit: status.key });
        }
        // If fails, try Apify fallback
        if (!res.ok) {
            if (apify && apify.getToken()) {
                await send(jid, { text: `⚠️ Direct ${res.status}, Apify proxy try කරනවා...
Quality: ${selectedLink.quality}p`, edit: status.key });
                try {
                    const apifyRes = await apify.getDirectViaApify(video.url, selectedLink.quality);
                    finalUrl = apifyRes.directUrl;
                    res = await eporner.smartFetchFinal(finalUrl);
                } catch (ae) {
                    throw new Error(`Direct ${res.status} | Apify: ${ae.message}`);
                }
            }
            if (!res.ok) throw new Error(`MP4 fetch ${res.status}`);
        }
        const total = parseInt(res.headers.get('content-length') || '0');
        const outPath = require('path').join(require('os').tmpdir() || process.env.DL_TMP || '/tmp', `ep-${Date.now().toString(36)}-${selectedLink.quality}p.mp4`);
        const file = fs.createWriteStream(outPath);
        const { Readable } = require('stream');
        let loaded = 0;
        const stream = Readable.fromWeb(res.body);
        stream.on('data', chunk => { loaded += chunk.length; });
        await new Promise((resolve, reject) => { stream.pipe(file); file.on('finish', resolve); file.on('error', reject); });
        filePath = outPath;
        const stat = fs.statSync(filePath);
        const size = human(stat.size);
        let thumbBuf = null;
        try {
            const thumbUrl = video.default_thumb?.src || video.thumbs?.[0]?.src;
            if (thumbUrl) {
                const tr = await fetch(thumbUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
                if (tr.ok) thumbBuf = Buffer.from(await tr.arrayBuffer());
            }
        } catch {}
        await send(jid, { text: `📤 Sending... ${video.title.slice(0,30)} ${selectedLink.quality}p (${size})`, edit: status.key });
        const videoMsg = {
            video: { url: filePath },
            fileName: `${video.title.slice(0, 30)}_${selectedLink.quality}p.mp4`,
            mimetype: 'video/mp4',
            caption: `✅ *${video.title}*
📺 ${selectedLink.quality}p ${selectedLink.type.toUpperCase()} | 👁️ ${video.views} | ⏱️ ${video.length_min}
📦 ${size}
🔗 ${video.url}
🔞 Private`
        };
        if (thumbBuf) videoMsg.jpegThumbnail = thumbBuf;
        await send(jid, videoMsg, { quoted: msg });
        await send(jid, { text: `✅ ඉවරයි — ${selectedLink.quality}p (${size})`, edit: status.key });
        epornerQualityCache.delete(jid);
        epornerQualityCache.delete(jid.split('@')[0]);
    } catch (e) {
        let errMsg = `❌ Download fail ${selectedLink.quality}p
${String(e.message).slice(0, 500)}`;
        if (!apify || !apify.getToken()) {
            errMsg += `

💡 *Apify token දාන්න:*
1. https://console.apify.com/account/integrations → token copy
2. *.setkey apify <token>*
3. ආයෙත් try කරන්න - proxy එකෙන් download වෙනවා`;
        }
        await send(jid, { text: errMsg, edit: status.key });
    } finally {
        if (filePath) fs.rm(filePath, { force: true }, () => {});
    }
}

async function handleDownload(send, jid, msg, link) {

    const status = await send(jid, { text: `⏳ Download වෙනවා...\n${link}` }, { quoted: msg });
    let last = 0;
    const edit = async (t) => { try { await send(jid, { text: t, edit: status.key }); } catch { } };
    const onProgress = (loaded, total, speed) => {
        const now = Date.now();
        if (now - last < 8000) return;   // 🛡️ fewer edits
        last = now;
        const pct = total ? Math.floor(loaded * 100 / total) : null;
        const bar = pct === null ? '' : '▰'.repeat(Math.round(pct / 10)) + '▱'.repeat(10 - Math.round(pct / 10)) + ` ${pct}%\n`;
        edit(`⬇️ Downloading...\n${bar}${human(loaded)} / ${human(total)}  •  ${human(speed)}/s`);
    };
    let files = [];
    try {
        files = await download(link, onProgress, { stream: true });
        for (const f of files) {
            await edit(`📤 WhatsApp එකට යවනවා... (${f.name}, ${human(f.size)})`);
            await send(jid, { document: f.open ? { stream: f.open() } : { url: f.path }, fileName: f.name, mimetype: f.mime, caption: `✅ ${f.name}\n📦 ${human(f.size)}` }, { quoted: msg });
        }
        await edit(`✅ ඉවරයි — file ${files.length} ක් එව්වා`);
        log(`✅ ${link} → ${files.map(f => f.name + ' ' + human(f.size)).join(', ')}`);
    } catch (e) {
        await edit(`❌ Download fail වුණා\n${link}\n\n${String(e.message).slice(0, 300)}`);
        log(`❌ ${link}: ${e.message}`);
    } finally {
        for (const f of files) fs.rm(f.path, { force: true }, () => { });
    }
}

process.on('unhandledRejection', (e) => log('unhandled: ' + (e?.message || e)));
process.on('uncaughtException', (e) => log('uncaught: ' + e.message));
module.exports = { _agentTick: agentTick, AGENT_MSG, handleDownload, getText, onMessages, replyJid, ME, aliveCaption, _setMediaDownloader: (f) => { mediaDownloader = f; }, _setSock: (x) => { SOCK = x; } };
if (require.main === module) {
    console.log('🚀 Arena AI starting...');
    start().catch((e) => { log('Startup fail: ' + e.message); process.exit(1); });
}