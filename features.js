/**
 * features.js — extra commands for Arena AI (v2.11), ported from SmokeBoy v3.7 (abc repo)
 *   YouTube: .yts .play .song/.yta .video/.ytv     Social: .tiktok .fb .ig .x
 *   Search: .wiki    GitHub: .gitclone    Tools: .sticker .take    Group: .tagall .kick .promote .demote .grouplink .groupinfo .jid
 * Every command is owner-only (checked in bot.js before we get here).
 */
const fs = require('fs');
const media = require('./media');

const human = (b) => !b ? '?' : b >= 1073741824 ? (b / 1073741824).toFixed(2) + ' GB' : b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';
const fmtDur = (s) => { s = Math.round(s || 0); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };
const fmtNum = (n) => n == null ? '—' : n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n);
const URL_RE = /https?:\/\/\S+/i;
const MAXMB = () => Math.min(parseInt(process.env.DL_MAX_MB || '2000', 10), 2000);

function unwrap(m) {
    for (let i = 0; i < 5 && m; i++) {
        const n = m.ephemeralMessage?.message || m.viewOnceMessage?.message || m.viewOnceMessageV2?.message || m.viewOnceMessageV2Extension?.message || m.documentWithCaptionMessage?.message;
        if (!n) break; m = n;
    }
    return m || {};
}
const ctxInfo = (msg) => { const m = unwrap(msg.message); return m.extendedTextMessage?.contextInfo || m.imageMessage?.contextInfo || m.videoMessage?.contextInfo || null; };

let yts = null;
const ytsearch = async (q) => { yts ||= require('yt-search'); const r = await yts(q); return r.videos || []; };

// ───────── status helper (one message, edited) ─────────
async function status(send, jid, msg, text) {
    const st = await send(jid, { text }, { quoted: msg });
    return async (t) => { try { await send(jid, { text: t, edit: st.key }); } catch { } };
}

async function sendFile(send, jid, msg, kind, p, extra) {
    try {
        if (kind === 'audio') await send(jid, { audio: { url: p }, mimetype: /\.mp3$/.test(p) ? 'audio/mpeg' : 'audio/mp4', ptt: false }, { quoted: msg });
        else if (kind === 'video') await send(jid, { video: { url: p }, mimetype: 'video/mp4', caption: extra.caption }, { quoted: msg });
        else await send(jid, { document: { url: p }, fileName: extra.fileName, mimetype: extra.mime || 'application/octet-stream', caption: extra.caption }, { quoted: msg });
    } finally { fs.rm(p, { force: true }, () => { }); }
}

// ───────── YouTube / any yt-dlp site ─────────
async function ytCommand(send, jid, msg, query, mode, label = 'YouTube') {
    if (!query) return send(jid, { text: `${mode === 'audio' ? '🎧' : '🎬'} *${mode === 'audio' ? '.song' : '.video'} <link හෝ නම>*\nඋදා: ${mode === 'audio' ? '.song faded alan walker' : '.video https://youtu.be/xxxx'}` }, { quoted: msg });
    const edit = await status(send, jid, msg, '🔎 හොයනවා...');
    let url = (query.match(URL_RE) || [])[0], title = '', meta = '';
    try {
        if (!url) {
            const v = (await ytsearch(query)).find((x) => (x.seconds || 0) > 0 && (x.seconds || 0) <= (mode === 'audio' ? 900 : 1800));
            if (!v) return edit(`😢 "${query}" — හරියන result එකක් නෑ`);
            url = v.url; title = v.title; meta = `👤 ${v.author?.name || '—'}  •  ⏱️ ${v.timestamp || '—'}  •  👁️ ${fmtNum(v.views)}`;
        }
        await edit(`⬇️ ${mode === 'audio' ? 'Audio' : 'Video'} download වෙනවා...${title ? '\n🎵 ' + title : ''}`);
        const r = await media.ytdl(url, { mode, maxMB: mode === 'audio' ? Math.min(60, MAXMB()) : Math.min(150, MAXMB()) });
        if (!title) { try { const i = await media.info(url); title = i.title || ''; meta = `👤 ${i.uploader || i.channel || '—'}  •  ⏱️ ${fmtDur(i.duration)}`; } catch { } }
        await edit(`📤 යවනවා... (${human(r.size)})`);
        const cap = `${mode === 'audio' ? '🎧' : '🎬'} *${(title || label).slice(0, 150)}*\n${meta}${r.height && mode === 'video' ? '  •  📺 ' + r.height + 'p' : ''}\n📦 ${human(r.size)}`;
        await sendFile(send, jid, msg, mode, r.path, { caption: cap });
        if (mode === 'audio') await send(jid, { text: cap });
        await edit('✅ ඉවරයි');
    } catch (e) { await edit('❌ ' + String(e.message).slice(0, 350)); }
}

async function ytSearchCmd(send, jid, msg, q) {
    if (!q) return send(jid, { text: '🔎 *.yts <නම>*  — YouTube search\nඋදා: .yts alan walker faded' }, { quoted: msg });
    const v = (await ytsearch(q)).slice(0, 6);
    if (!v.length) return send(jid, { text: `😢 "${q}" — results නෑ` }, { quoted: msg });
    const list = v.map((x, i) => `*${i + 1}.* ${x.title.slice(0, 70)}\n   ⏱️ ${x.timestamp || '—'}  •  👁️ ${fmtNum(x.views)}\n   🔗 ${x.url}`).join('\n\n');
    return send(jid, { text: `🔎 *YouTube — ${q}*\n\n${list}\n\n> 🎧 *.song <link>*  •  🎬 *.video <link>*` }, { quoted: msg });
}

// ───────── TikTok (tikwm, no watermark) ─────────
async function tiktok(send, jid, msg, q) {
    const url = (q.match(URL_RE) || [])[0];
    if (!url || !/tiktok\.com/i.test(url)) return send(jid, { text: '🎵 *.tiktok <link>*  — watermark නැතුව download' }, { quoted: msg });
    const edit = await status(send, jid, msg, '⏳ TikTok video එක ගන්නවා...');
    try {
        const r = await fetch('https://tikwm.com/api/?hd=1&url=' + encodeURIComponent(url), { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const j = await r.json();
        if (j.code !== 0 || !j.data) throw new Error(j.msg || 'TikTok API error');
        const d = j.data, abs = (u) => !u ? null : u.startsWith('/') ? 'https://tikwm.com' + u : u;
        const cap = `🎵 *${(d.title || 'TikTok').slice(0, 150)}*\n👤 @${d.author?.unique_id || '?'}  •  ⏱️ ${d.duration || '?'}s\n❤️ ${fmtNum(d.digg_count)}  •  💬 ${fmtNum(d.comment_count)}  •  👁️ ${fmtNum(d.play_count)}\n✅ No watermark`;
        if (d.images?.length) {                            // photo slideshow
            for (const im of d.images.slice(0, 10)) await send(jid, { image: { url: im } }, { quoted: msg });
            await send(jid, { text: cap });
        } else {
            await send(jid, { video: { url: abs(d.hdplay || d.play) }, mimetype: 'video/mp4', caption: cap }, { quoted: msg });
        }
        await edit('✅ ඉවරයි');
    } catch (e) {
        await edit('⚠️ TikTok API fail (' + String(e.message).slice(0, 80) + ') — yt-dlp එකෙන් try කරනවා...');
        return ytCommand(send, jid, msg, url, 'video', 'TikTok');
    }
}

// ───────── Wikipedia ─────────
async function wiki(send, jid, msg, raw) {
    if (!raw) return send(jid, { text: '📚 *.wiki <මාතෘකාව>*\nඋදා: .wiki Sri Lanka  /  .wiki si සීගිරිය' }, { quoted: msg });
    let lang = 'en', q = raw;
    const m = raw.match(/^(si|en|ta|hi)\s+(.+)$/i);
    if (m) { lang = m[1].toLowerCase(); q = m[2]; } else if (/[\u0D80-\u0DFF]/.test(raw)) lang = 'si';
    const UA = { 'User-Agent': 'ArenaAI-WhatsApp-bot/2.11 (private)' };
    const sum = async (t) => fetch(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(t.replace(/ /g, '_'))}`, { headers: UA });
    let r = await sum(q), d = r.ok ? await r.json() : null;
    if (!d?.extract) {
        const s = await fetch(`https://${lang}.wikipedia.org/w/rest.php/v1/search/page?limit=3&q=${encodeURIComponent(q)}`, { headers: UA }).then((x) => x.ok ? x.json() : null).catch(() => null);
        const t = s?.pages?.[0]?.title;
        if (t) { r = await sum(t); d = r.ok ? await r.json() : null; }
    }
    if (!d?.extract) return send(jid, { text: `❓ Wikipedia (${lang}) එකේ "${q}" හම්බුණේ නෑ` }, { quoted: msg });
    const link = d.content_urls?.mobile?.page || d.content_urls?.desktop?.page || '';
    const text = `📚 *${d.title}*${d.description ? '\n_' + d.description + '_' : ''}\n\n${d.extract.slice(0, 1500)}\n\n🔗 ${link}`;
    const img = d.thumbnail?.source || d.originalimage?.source;
    if (img) { try { return await send(jid, { image: { url: img }, caption: text }, { quoted: msg }); } catch { } }
    return send(jid, { text }, { quoted: msg });
}

// ───────── GitHub repo → zip ─────────
async function gitclone(send, jid, msg, q, download) {
    const mm = q.match(/github\.com\/([\w.-]+)\/([\w.-]+)/i) || q.trim().match(/^([\w.-]+)\/([\w.-]+)$/);
    if (!mm) return send(jid, { text: '🐙 *.gitclone user/repo*  හෝ  *.gitclone https://github.com/user/repo*\n→ repo එක .zip එකක් විදියට' }, { quoted: msg });
    const owner = mm[1], repo = mm[2].replace(/\.git$/, '');
    const r = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers: { 'User-Agent': 'arena-ai-bot', Accept: 'application/vnd.github+json' } });
    if (r.status === 404) return send(jid, { text: `❌ ${owner}/${repo} — repo එක නෑ / private` }, { quoted: msg });
    if (!r.ok) return send(jid, { text: `❌ GitHub ${r.status}` }, { quoted: msg });
    const d = await r.json();
    const edit = await status(send, jid, msg, `⏳ ${owner}/${repo} zip එක ගන්නවා...`);
    let files = [];
    try {
        files = await download(`https://codeload.github.com/${owner}/${repo}/zip/refs/heads/${d.default_branch}`);
        const f = files[0];
        await send(jid, { document: { url: f.path }, fileName: `${repo}-${d.default_branch}.zip`, mimetype: 'application/zip', caption: `🐙 *${owner}/${repo}*\n🌿 ${d.default_branch}  •  ⭐ ${fmtNum(d.stargazers_count)}  •  💻 ${d.language || '—'}\n📝 ${(d.description || '—').slice(0, 150)}\n📦 ${human(f.size)}` }, { quoted: msg });
        await edit('✅ ඉවරයි');
    } catch (e) { await edit('❌ ' + String(e.message).slice(0, 250)); }
    finally { for (const f of files) fs.rm(f.path, { force: true }, () => { }); }
}

// ───────── Sticker ─────────
let mediaDownloader = null;   // set by bot.js (Baileys downloadMediaMessage)
async function sticker(send, jid, msg, args, take) {
    const own = unwrap(msg.message), ci = ctxInfo(msg);
    let src = null, kind = null;
    const pick = (m) => m?.imageMessage ? 'image' : m?.videoMessage ? 'video' : m?.stickerMessage ? 'sticker' : null;
    if (pick(own)) { kind = pick(own); src = { key: msg.key, message: own }; }
    else if (ci?.quotedMessage && pick(unwrap(ci.quotedMessage))) { const q = unwrap(ci.quotedMessage); kind = pick(q); src = { key: { remoteJid: msg.key.remoteJid, id: ci.stanzaId, participant: ci.participant, fromMe: false }, message: q }; }
    if (!src) return send(jid, { text: '🖼️ *.sticker*  (*.s*)\n• Photo / video එකක් යවලා caption එකට *.s*\n• නැත්නම් photo / video / sticker එකකට reply කරලා *.s*\n\n🎁 *.take Pack | Author*  — sticker එකේ නම වෙනස් කරන්න\n🎞️ Video = තත්පර 6 දක්වා' }, { quoted: msg });
    const [pack, author] = take ? (args.join(' ') || 'Arena AI').split('|').map((s) => s.trim()) : ['Arena AI', 'Arena AI'];
    try {
        const buf = await mediaDownloader(src);
        const m = src.message;
        if (kind === 'video' && (m.videoMessage?.seconds || 0) > 15) return send(jid, { text: '🎞️ Video එක තත්පර 15 ට අඩු වෙන්න ඕනේ' }, { quoted: msg });
        const out = kind === 'sticker' ? await media.addExif(buf, pack || 'Arena AI', author || 'Arena AI')
            : await media.makeSticker(buf, { animated: kind === 'video' || !!m.imageMessage?.mimetype?.includes('gif'), pack: pack || 'Arena AI', author: author || 'Arena AI' });
        return send(jid, { sticker: out }, { quoted: msg });
    } catch (e) {
        return send(jid, { text: '❌ Sticker එක හදන්න බැරි වුණා: ' + String(e.message).slice(0, 200) }, { quoted: msg });
    }
}

// ───────── Group tools ─────────
const bare = (j) => { if (!j) return j; const [u, s] = String(j).split('@'); return u.split(':')[0] + '@' + s; };
const lastTagall = new Map();
function targets(msg, args) {
    const ci = ctxInfo(msg);
    const t = [...(ci?.mentionedJid || [])];
    if (ci?.participant && !t.length) t.push(ci.participant);
    for (const a of args) { const n = a.replace(/\D/g, ''); if (n.length >= 9 && n.length <= 15) t.push(n + '@s.whatsapp.net'); }
    return [...new Set(t.map(bare))];
}
async function group(sock, send, jid, msg, c, args, me) {
    if (c === '.jid') return send(jid, { text: `🆔 ${jid}` }, { quoted: msg });
    if (!jid.endsWith('@g.us')) return send(jid, { text: '👥 මේ command එක group එකක විතරයි වැඩ' }, { quoted: msg });
    const meta = await sock.groupMetadata(jid);
    const mine = new Set([me.pn, me.lid].filter(Boolean));
    const meP = meta.participants.find((p) => mine.has(bare(p.id)) || mine.has(bare(p.phoneNumber)) || mine.has(bare(p.lid)));
    const iAmAdmin = !!meP?.admin;
    if (c === '.groupinfo') {
        const admins = meta.participants.filter((p) => p.admin).length;
        return send(jid, { text: `👥 *${meta.subject}*\n\n🆔 ${jid}\n👤 Members: ${meta.participants.length}  •  🛡️ Admins: ${admins}\n📅 ${meta.creation ? new Date(meta.creation * 1000).toLocaleDateString('en-GB') : '—'}\n🔒 ${meta.announce ? 'Admins only messages' : 'Everyone can message'}\n\n📝 ${(meta.desc || '—').toString().slice(0, 500)}` }, { quoted: msg });
    }
    if (c === '.grouplink') {
        if (!iAmAdmin) return send(jid, { text: '⛔ Link එක ගන්න ඔයා admin වෙන්න ඕනේ' }, { quoted: msg });
        return send(jid, { text: `🔗 *${meta.subject}*\nhttps://chat.whatsapp.com/${await sock.groupInviteCode(jid)}` }, { quoted: msg });
    }
    if (c === '.tagall') {
        const last = lastTagall.get(jid) || 0;
        if (Date.now() - last < 10 * 60e3) return send(jid, { text: `⏳ Anti-ban: *.tagall* group එකකට විනාඩි 10 කට එක පාරයි (තව ${Math.ceil((10 * 60e3 - (Date.now() - last)) / 60e3)} min)` }, { quoted: msg });
        if (meta.participants.length > 300) return send(jid, { text: '⛔ Members 300 ට වැඩි groups වල tagall කරන්නේ නෑ (ban risk)' }, { quoted: msg });
        lastTagall.set(jid, Date.now());
        const ids = meta.participants.map((p) => p.id);
        const list = meta.participants.map((p) => `${p.admin ? '👑' : '▫️'} @${p.id.split('@')[0]}`).join('\n');
        return send(jid, { text: `📢 ${args.join(' ') ? '*' + args.join(' ') + '*\n\n' : ''}${list}`, mentions: ids });
    }
    // kick / promote / demote
    if (!iAmAdmin) return send(jid, { text: '⛔ මේක කරන්න ඔයා group එකේ admin වෙන්න ඕනේ' }, { quoted: msg });
    const t = targets(msg, args).filter((x) => !mine.has(x));
    if (!t.length) return send(jid, { text: `❓ කෙනෙක්ව @mention කරන්න, නැත්නම් එයාගේ message එකකට reply කරලා *${c}* ගහන්න` }, { quoted: msg });
    const action = { '.kick': 'remove', '.promote': 'promote', '.demote': 'demote' }[c];
    const res = await sock.groupParticipantsUpdate(jid, t, action);
    const ok = (res || []).filter((x) => String(x.status) === '200').length;
    const word = { remove: '👢 Remove කළා', promote: '⬆️ Admin කළා', demote: '⬇️ Admin අයින් කළා' }[action];
    return send(jid, { text: `${word}: ${ok}/${t.length}\n${t.map((x) => '@' + x.split('@')[0]).join(' ')}`, mentions: t }, { quoted: msg });
}

const GROUP_CMDS = ['.tagall', '.kick', '.promote', '.demote', '.grouplink', '.groupinfo', '.jid'];
const CMDS = ['.yts', '.play', '.song', '.yta', '.video', '.ytv', '.yt', '.tiktok', '.tt', '.fb', '.ig', '.insta', '.x', '.twitter', '.wiki', '.gitclone', '.sticker', '.s', '.take', ...GROUP_CMDS];

/** returns true if handled */
async function handle(c, { send, jid, msg, rest, sock, me, download }) {
    if (!CMDS.includes(c)) return false;
    const q = rest.join(' ').trim();
    switch (c) {
        case '.yts': await ytSearchCmd(send, jid, msg, q); break;
        case '.play': case '.song': case '.yta': await ytCommand(send, jid, msg, q, 'audio'); break;
        case '.video': case '.ytv': case '.yt': await ytCommand(send, jid, msg, q, 'video'); break;
        case '.fb': case '.ig': case '.insta': case '.x': case '.twitter':
            if (!URL_RE.test(q)) { await send(jid, { text: `🎬 *${c} <link>*  — public video එකක link එක දාන්න` }, { quoted: msg }); break; }
            await ytCommand(send, jid, msg, q, 'video', { '.fb': 'Facebook', '.ig': 'Instagram', '.insta': 'Instagram' }[c] || 'X / Twitter'); break;
        case '.tiktok': case '.tt': await tiktok(send, jid, msg, q); break;
        case '.wiki': await wiki(send, jid, msg, q); break;
        case '.gitclone': await gitclone(send, jid, msg, q, download); break;
        case '.sticker': case '.s': await sticker(send, jid, msg, rest, false); break;
        case '.take': await sticker(send, jid, msg, rest, true); break;
        default:
            if (!sock) { await send(jid, { text: '⚠️ WhatsApp connect වෙලා නෑ' }, { quoted: msg }); break; }
            try { await group(sock, send, jid, msg, c, rest, me); } catch (e) { await send(jid, { text: '❌ ' + String(e.message).slice(0, 200) }, { quoted: msg }); }
    }
    return true;
}

module.exports = { handle, CMDS, GROUP_CMDS, setMediaDownloader: (f) => { mediaDownloader = f; }, _ytsearch: (f) => { yts = f; } };
