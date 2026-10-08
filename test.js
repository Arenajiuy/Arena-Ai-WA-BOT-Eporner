// npm test  → simulated WhatsApp messages (no real account needed)
process.env.ARENA_NO_DELAY = '1'; process.env.ARENA_NO_REACT = '1'; process.env.ARENA_RATE_MIN = '1000'; process.env.ARENA_RATE_HOUR = '10000';
const fs = require('fs');
const { onMessages, getText } = require('./bot');
let n = 0, ok = 0, bad = 0;
const t = (name, cond) => { cond ? ok++ : bad++; console.log(`  ${cond ? '✅' : '❌'} ${name}`); };
const ME = '94771234567@s.whatsapp.net';
const mk = (text, fromMe = true, jid = ME) => ({ key: { id: 'IN' + (++n), remoteJid: jid, fromMe }, message: { conversation: text } });
(async () => {
    const out = [];
    const send = async (jid, c) => { const e = { jid, ...c }; if (c.document?.stream) { let n = 0; for await (const ch of c.document.stream) n += ch.length; e.size = n; e.streamed = true; } else if (c.document) { e.size = fs.statSync(c.document.url).size; e.exists = true; } out.push(e); return { key: { id: 'OUT' + (++n) } }; };
    const run = async (msg) => { out.length = 0; await onMessages({ type: 'notify', messages: [msg] }, send); return out; };

    let r = await run(mk('.ping')); t('.ping → Pong', r.length === 1 && /Pong/.test(r[0].text));
    r = await run(mk('.ping', false, '94770000000@s.whatsapp.net')); t('🔒 වෙන කෙනෙක් .ping → ignore', r.length === 0);
    r = await run(mk('.download https://x0.at/D07z.zip', false, '120363@g.us')); t('🔒 group එකේ වෙන කෙනෙක් .download → ignore', r.length === 0);
    r = await run(mk('hello')); t('සාමාන්‍ය message → ignore', r.length === 0);
    r = await run(mk('.download')); t('.download link නැතුව → help', r.length === 1 && /Arena AI/.test(r[0].text));
    r = await run(mk('.download https://raw.githubusercontent.com/matheeshasanjana83-alt/abc/main/downloads/Joystick-Layout-NoCLEO-v1.zip'));
    const doc = r.find(x => x.document);
    t('.download GitHub → document එවනවා', !!doc && doc.fileName === 'Joystick-Layout-NoCLEO-v1.zip' && doc.size === 3127);
    t('progress/status edit message', r.some(x => x.edit && /ඉවරයි/.test(x.text)));
    t('temp file එක delete වෙනවා', await new Promise(res => setTimeout(() => res(!fs.existsSync(doc.document.url)), 300)));
    r = await run(mk('.dl https://raw.githubusercontent.com/matheeshasanjana83-alt/abc/main/downloads/Joystick-Layout-NoCLEO-v1.zip https://github.com/matheeshasanjana83-alt/abc/blob/main/downloads/SmokeBoy.zip'));
    t('.dl links 2ක් → documents 2ක්', r.filter(x => x.document).length === 2);
    r = await run(mk('.download https://www.google.com/')); t('web page link → පැහැදිලි error', r.some(x => x.edit && /web page/.test(x.text)) && !r.some(x => x.document));
    t('getText: extendedTextMessage', getText({ extendedTextMessage: { text: ' .ping ' } }) === '.ping');
    t('getText: ephemeral wrapper', getText({ ephemeralMessage: { message: { conversation: '.dl x' } } }) === '.dl x');

    // ───────── v2.1 fixes ─────────
    const ap = mk('.ping'); r = await (async () => { out.length = 0; await onMessages({ type: 'append', messages: [ap] }, send); return out; })();
    t("type 'append' (phone එකෙන් එන) .ping → වැඩ", r.some(x => /Pong/.test(x.text || '')));
    r = await (async () => { out.length = 0; await onMessages({ type: 'notify', messages: [ap] }, send); return out; })();
    t('එකම message එක දෙපාරක් ආවොත් → එක පාරයි', r.length === 0);
    const old = mk('.ping'); old.messageTimestamp = Math.floor(Date.now() / 1000) - 3600;
    r = await (async () => { out.length = 0; await onMessages({ type: 'append', messages: [old] }, send); return out; })();
    t('පැයකට කලින් history .ping (append) → run කරන්නේ නෑ', r.length === 0);
    const ds = mk(''); ds.message = { deviceSentMessage: { destinationJid: ME, message: { conversation: '.ping' } } };
    r = await run(ds); t('deviceSentMessage wrapper → .ping වැඩ', r.some(x => /Pong/.test(x.text || '')));

    // ───────── v2.3: self-chat reply JID ("Waiting for this message" fix) ─────────
    const { replyJid, ME: me } = require('./bot');
    me.pn = '94760552994@s.whatsapp.net'; me.lid = '35189220741167@lid';
    t('self chat device LID → phone JID', replyJid({ remoteJid: '35189220741167:0@lid' }) === me.pn);
    t('self chat device PN → bare phone JID', replyJid({ remoteJid: '94760552994:0@s.whatsapp.net' }) === me.pn);
    t('self chat LID + alt → phone JID', replyJid({ remoteJid: '35189220741167@lid', remoteJidAlt: '94760552994@s.whatsapp.net' }) === me.pn);
    t('other @lid chat with PN alt → PN', replyJid({ remoteJid: '1234567890123@lid', remoteJidAlt: '94771112222@s.whatsapp.net' }) === '94771112222@s.whatsapp.net');
    t('group jid unchanged', replyJid({ remoteJid: '120363000@g.us' }) === '120363000@g.us');
    out.length = 0;
    await onMessages({ type: 'notify', messages: [{ key: { id: 'LID1', remoteJid: '35189220741167:0@lid', fromMe: true }, message: { conversation: '.ping' } }] }, send);
    t('.ping from device-LID self chat → reply sent to phone JID', out.length > 0 && out.every(x => x.jid === me.pn));
    me.pn = null; me.lid = null;

    // ───────── v2.6: .setproxy / .net ─────────
    {
        const fs = require('fs'), sp = require('path').join(__dirname, 'settings.json');
        const had = fs.existsSync(sp) ? fs.readFileSync(sp) : null;
        const run = async (txt) => { out.length = 0; await onMessages({ type: 'notify', messages: [{ key: { id: 'P' + Math.random(), remoteJid: '94771234567@s.whatsapp.net', fromMe: true }, message: { conversation: txt } }] }, send, async () => { }); return out.map(x => x.text || '').join('\n'); };
        t('.setproxy bad format → error', /Format/.test(await run('.setproxy socks5://1.2.3.4')));
        await run('.setproxy http://u:p@10.0.0.1:8080');
        t('.setproxy saves proxy', JSON.parse(fs.readFileSync(sp, 'utf8')).proxy === 'http://u:p@10.0.0.1:8080');
        t('.setproxy hides password', /\*\*\*@/.test(await run('.setproxy')));
        await run('.setproxy off');
        t('.setproxy off removes', !JSON.parse(fs.readFileSync(sp, 'utf8')).proxy);
        t('.net without link → help', /\.net <link>/.test(await run('.net')));
        if (had) fs.writeFileSync(sp, had); else fs.rmSync(sp, { force: true });
    }

    // ───────── AI tests (fake Gemini/Groq servers) ─────────
    const ai = require('./ai');
    const realFetch = global.fetch; const calls = [];
    let geminiMode = 'ok';
    global.fetch = async (url, opt) => {
        url = String(url);
        if (url.includes('generativelanguage') || url.includes('api.groq.com')) {
            const body = JSON.parse(opt.body); calls.push({ url, body });
            const J = (st, o) => new Response(JSON.stringify(o), { status: st, headers: { 'content-type': 'application/json' } });
            if (url.includes('generativelanguage')) {
                if (geminiMode === 'down') return J(503, { error: { message: 'overloaded' } });
                if (geminiMode === 'oldmodel' && url.includes('gemini-flash-latest')) return J(404, { error: { message: 'models/gemini-flash-latest is not found' } });
                const last = body.contents.at(-1).parts[0].text;
                return J(200, { candidates: [{ content: { parts: [{ text: `## උත්තරය\n**හායි!** ඔයා ඇහුවේ: ${last} (turns=${body.contents.length})` }] } }] });
            }
            return J(200, { choices: [{ message: { content: 'Groq answer ✅' } }] });
        }
        return realFetch(url, opt);
    };
    const fs2 = require('fs'); const SET = require('path').join(__dirname, 'settings.json');
    const backup = fs2.existsSync(SET) ? fs2.readFileSync(SET) : null; try { fs2.unlinkSync(SET); } catch { }
    delete process.env.GEMINI_API_KEY; delete process.env.GROQ_API_KEY;
    const deleted = [];
    const run2 = async (msg) => { out.length = 0; await onMessages({ type: 'notify', messages: [msg] }, send, async (k) => deleted.push(k.id)); return out; };

    r = await run2(mk('.ai hello')); t('.ai key නැතුව → key ගන්න විදිය කියනවා', r.some(x => /aistudio\.google\.com/.test(x.text || '')));
    const km = mk('.setkey gemini AIzaSyTESTKEY1234567890abcdef'); r = await run2(km);
    t('.setkey gemini → save + message එක මකනවා', ai.getKeys().gemini === 'AIzaSyTESTKEY1234567890abcdef' && deleted.includes(km.key.id) && r.some(x => /save/.test(x.text)));
    r = await run2(mk('.keys')); t('.keys → key එක mask කරලා පෙන්නනවා', r.some(x => /AIza••••def/.test(x.text || '')) && !r.some(x => /TESTKEY/.test(x.text || '')));
    r = await run2(mk('.ai GTA cheats මොනවද?'));
    const ans = r.find(x => x.edit && /උත්තරය/.test(x.text || ''));
    t('.ai → Gemini උත්තරය (edit)', !!ans && /GTA cheats/.test(ans.text));
    t('markdown → WhatsApp (*bold*, heading)', !!ans && /\*හායි!\*/.test(ans.text) && /^\*උත්තරය\*/.test(ans.text) && !/\*\*/.test(ans.text));
    t('system prompt = Arena AI', calls.at(-1).body.systemInstruction.parts[0].text.includes('Arena AI'));
    r = await run2(mk('.ai තව කියන්න')); t('memory: 2nd question එකට කලින් කතාව යවනවා (turns=3)', r.some(x => /turns=3/.test(x.text || '')));
    r = await run2(mk('.ai reset')); r = await run2(mk('.ai අලුත් එකක්')); t('.ai reset → memory clear (turns=1)', r.some(x => /turns=1/.test(x.text || '')));
    const qm = mk('.ai'); qm.message = { extendedTextMessage: { text: '.ai', contextInfo: { quotedMessage: { conversation: 'Hello world message' } } } };
    r = await run2(qm); t('message එකකට reply කරලා .ai → ඒ message එක ගැන අහනවා', r.some(x => /Hello world message/.test(x.text || '')));
    geminiMode = 'oldmodel'; calls.length = 0; r = await run2(mk('.ai test'));
    t('Gemini model එක නැත්නම් ඊළඟ model එකට යනවා', calls.length === 2 && calls[1].url.includes('gemini-2.5-flash') && r.some(x => /gemini-2\.5-flash/.test(x.text || '')));
    geminiMode = 'down'; r = await run2(mk('.ai test')); t('Gemini down + Groq key නෑ → error message', r.some(x => /AI error/.test(x.text || '')));
    await run2(mk('.setkey groq gsk_TESTKEY1234567890abcdefgh')); r = await run2(mk('.ai test'));
    t('Gemini down → Groq එකෙන් උත්තරය (fallback)', r.some(x => /Groq answer/.test(x.text || '')));
    r = await run2(mk('.ai hi', false, '94770000000@s.whatsapp.net')); t('🔒 වෙන කෙනෙක් .ai → ignore', r.length === 0);
    t('long answer split', ai.splitLong('a'.repeat(8000)).length === 3);
    try { fs2.unlinkSync(SET); } catch { } if (backup) fs2.writeFileSync(SET, backup);
    global.fetch = realFetch;

    // ───────── v2.8: owner-only + anti-ban ─────────
    {
        const guard = require('./guard');
        const { ME: me2 } = require('./bot');
        me2.pn = ME; me2.lid = '35189220741167@lid';
        delete process.env.ARENA_CHATS;
        const sp = require('path').join(__dirname, 'settings.json');
        const had = fs.existsSync(sp) ? fs.readFileSync(sp) : null;
        try { const d = had ? JSON.parse(had) : {}; delete d.chats; fs.writeFileSync(sp, JSON.stringify(d)); } catch { }
        r = await run(mk('.ping')); t('🔒 mode self: Message yourself .ping → Pong', r.some(x => /Pong/.test(x.text || '')));
        r = await run(mk('.ping', true, '94770000000@s.whatsapp.net')); t('🔒 mode self: මම යාලුවෙක්ගේ chat එකේ .ping → ignore (එතන reply නෑ)', r.length === 0);
        r = await run(mk('.ping', true, '120363@g.us')); t('🔒 mode self: group එකේ මගේ .ping → ignore', r.length === 0);
        r = await run(mk('.mode all')); t('.mode all → confirm', r.some(x => /Mode: all/.test(x.text || '')));
        r = await run(mk('.ping', true, '94770000000@s.whatsapp.net')); t('🔓 mode all: මගේ command වෙන chat එකක → වැඩ', r.some(x => /Pong/.test(x.text || '')));
        r = await run(mk('.ping', false, '94770000000@s.whatsapp.net')); t('🔒 mode all: යාලුවා .ping → තාමත් ignore', r.length === 0);
        const spoof = mk('.ping', true, '120363@g.us'); spoof.key.participant = '94779999999@s.whatsapp.net';
        r = await run(spoof); t('🔒 group: fromMe කියලා ආවත් participant වෙන කෙනෙක් → ignore', r.length === 0);
        const mineG = mk('.ping', true, '120363@g.us'); mineG.key.participant = '35189220741167:3@lid';
        r = await run(mineG); t('mode all: group එකේ මගේ LID participant → වැඩ', r.some(x => /Pong/.test(x.text || '')));
        r = await run(mk('.ping', true, 'status@broadcast')); t('status@broadcast → ignore', r.length === 0);
        r = await run(mk('.mode self')); t('.mode self → confirm', r.some(x => /Mode: self/.test(x.text || '')));
        r = await run(mk('.ping', true, '94770000000@s.whatsapp.net')); t('.mode self ආපහු → වෙන chat ignore', r.length === 0);
        // rate limit
        process.env.ARENA_RATE_MIN = '3'; guard._hits.length = 0;
        const res = []; for (let i = 0; i < 5; i++) { out.length = 0; await onMessages({ type: 'notify', messages: [mk('.ping')] }, send); res.push(out.map(x => x.text).join('|')); }
        t('🛡️ rate limit: විනාඩියට 3 → 4 වෙනි එකට warning, 5 වෙනි එකට කිසිම reply එකක් නෑ', /Pong/.test(res[2]) && /ඉක්මනට/.test(res[3]) && res[4] === '');
        process.env.ARENA_RATE_MIN = '1000'; guard._hits.length = 0;
        t('🙈 maskLog: setkey', guard.maskLog('.setkey gemini AIzaSyABCDEFGHIJKLMNOP') === '.setkey gemini ••••');
        t('🙈 maskLog: proxy password', guard.maskLog('.setproxy http://user:pw@1.2.3.4:80') === '.setproxy http://***@1.2.3.4:80');
        t('🛡️ backoff grows + capped', guard.backoff(0) < 6000 && guard.backoff(3) >= 24000 && guard.backoff(20) <= 302000);
        let ran = 0; const pc = guard.pacer(150); const t0 = Date.now(); await Promise.all([1, 2, 3].map(() => pc(async () => ran++)));
        t('🛡️ pacer: messages එකින් එක gap එකක් එක්ක', ran === 3 && Date.now() - t0 >= 280);
        const d0 = guard.shouldAnnounce(), d1 = guard.shouldAnnounce(); t('🛡️ online message පැය 6 කට එක පාරයි', d1 === false);
        if (had) fs.writeFileSync(sp, had); else try { fs.unlinkSync(sp); } catch { }
        me2.pn = null; me2.lid = null;
    }

    // ───────── v2.9: online card + .setlogo ─────────
    {
        const bot = require('./bot'); const path = require('path');
        const LOGO = path.join(__dirname, 'logo.img'); const hadLogo = fs.existsSync(LOGO) ? fs.readFileSync(LOGO) : null;
        fs.rmSync(LOGO, { force: true });
        r = await run(mk('.alive')); const card = r.find(x => x.image);
        t('.alive → banner photo + card', !!card && card.image.length === fs.statSync(path.join(__dirname, 'banner.jpg')).size && /ARENA AI/.test(card.caption) && /v\d+\.\d+/.test(card.caption));
        t('card එක කෙටියි (පේළි 9 ට අඩුයි)', card && card.caption.split('\n').length <= 9);
        r = await run(mk('.setlogo')); t('.setlogo photo නැතුව → උදව් message', r.some(x => /reply/.test(x.text || '')) && !fs.existsSync(LOGO));
        const fake = Buffer.alloc(4000, 7); let got = null;
        bot._setMediaDownloader(async (m) => { got = m; return fake; });
        const q = mk('.setlogo'); q.message = { extendedTextMessage: { text: '.setlogo', contextInfo: { stanzaId: 'IMG1', quotedMessage: { imageMessage: { mimetype: 'image/jpeg' } } } } };
        r = await run(q);
        t('photo එකට reply කරලා .setlogo → logo save වෙනවා', fs.existsSync(LOGO) && fs.readFileSync(LOGO).equals(fake) && got.key.id === 'IMG1');
        t('.setlogo → අලුත් logo එකෙන් preview card', r.some(x => x.image && x.image.equals(fake)));
        const cap = mk('.setlogo'); cap.message = { imageMessage: { caption: '.setlogo', mimetype: 'image/jpeg' } };
        r = await run(cap); t('photo + caption .setlogo → වැඩ', r.some(x => x.image && x.image.equals(fake)));
        r = await run(mk('.alive')); t('.alive → දැන් ඔයාගේ logo එක', r.some(x => x.image && x.image.equals(fake)));
        r = await run(mk('.dellogo')); t('.dellogo → logo අයින්', !fs.existsSync(LOGO));
        t('updater: logo.img protected', /logo\\.img/.test(fs.readFileSync(path.join(__dirname, 'updater.js'), 'utf8')));
        if (hadLogo) fs.writeFileSync(LOGO, hadLogo);
    }

    // ───────── v2.10: photo menu + categories + auto react ─────────
    {
        r = await run(mk('.menu')); const mm = r.find(x => x.image);
        t('.menu → photo + info box + categories', !!mm && /BOT INFO/.test(mm.caption) && /CATEGORIES/.test(mm.caption) && /RAM/.test(mm.caption) && /\*1\* ┃ 📥 Download/.test(mm.caption));
        const menuId = 'OUT' + n;   // fake send ids
        const q1 = mk('1'); q1.message = { extendedTextMessage: { text: '1', contextInfo: { stanzaId: menuId } } };
        r = await run(q1); t('menu එකට reply කරලා 1 → Download category', r.some(x => /DOWNLOAD/.test(x.text || '')));
        r = await run(mk('2')); t('menu එකෙන් පස්සේ 2 විතරක් → YouTube category', r.some(x => /\*🎬 YOUTUBE\*/.test(x.text || '')));
        r = await run(mk('9')); t('9 → AI category', r.some(x => /\*🤖 AI\*/.test(x.text || '')));
        r = await run(mk('13')); t('13 → status card (photo)', r.some(x => x.image && /ARENA AI/.test(x.caption)));
        r = await run(mk('99')); t('වැරදි number → error', r.some(x => /අතර number/.test(x.text || '')));
        const other = mk('1'); other.message = { extendedTextMessage: { text: '1', contextInfo: { stanzaId: 'SOMETHING_ELSE' } } };
        r = await run(other); t('වෙන message එකකට reply කරපු "1" → ignore', r.length === 0);
        r = await run(mk('3', false, '94770000000@s.whatsapp.net')); t('🔒 යාලුවා "3" → ignore', r.length === 0);
        r = await run(mk('.help')); t('.help → full command list', r.some(x => /setkey/.test(x.text || '')));
        delete process.env.ARENA_NO_REACT;
        r = await run(mk('.ping')); const re = r.find(x => x.react);
        t('✨ auto react → command message එකට emoji react', !!re && re.react.key.id && re.react.text.length > 0 && r.some(x => /Pong/.test(x.text || '')));
        r = await run(mk('.react off')); r = await run(mk('.ping')); t('.react off → react නෑ', !r.some(x => x.react));
        r = await run(mk('.react on')); r = await run(mk('.ping')); t('.react on → react ආපහු', r.some(x => x.react));
        r = await run(mk('hello')); t('සාමාන්‍ය message එකට react නෑ', r.length === 0);
        process.env.ARENA_NO_REACT = '1';
        try { const sp = require('path').join(__dirname, 'settings.json'); const d = JSON.parse(fs.readFileSync(sp, 'utf8')); delete d.react; fs.writeFileSync(sp, JSON.stringify(d)); } catch { }
    }

    // ───────── v2.11: SmokeBoy features (YouTube, TikTok, wiki, gitclone, sticker, group) ─────────
    {
        const path = require('path'), features = require('./features'), bot = require('./bot');
        if (fs.existsSync('/tmp/ytt/yt-dlp')) process.env.YTDLP_PATH = '/tmp/ytt/yt-dlp';
        if (fs.existsSync('/tmp/ytt/ffmpeg')) process.env.FFMPEG_PATH = '/tmp/ytt/ffmpeg';
        const txt = () => out.map(x => x.text || x.caption || '').join('\n');
        r = await run(mk('.yts alan walker faded')); t('.yts → YouTube results', /youtube\.com\/watch|youtu/.test(txt()) && /\*1\.\*/.test(txt()));
        r = await run(mk('.wiki Sri Lanka')); t('.wiki Sri Lanka → summary (+photo)', /Sri Lanka/.test(txt()) && /wikipedia\.org/.test(txt()));
        r = await run(mk('.wiki si ශ්‍රී ලංකාව')); t('.wiki si → සිංහල', /[\u0D80-\u0DFF]/.test(txt()) && /si\.(m\.)?wikipedia/.test(txt()));
        r = await run(mk('.gitclone matheeshasanjana83-alt/Arena-Ai-WA-BOT')); const gz = r.find(x => x.document);
        t('.gitclone → repo zip document', !!gz && /Arena-Ai-WA-BOT-main\.zip/.test(gz.fileName) && gz.size > 10000);
        r = await run(mk('.song https://www.youtube.com/watch?v=jNQXAC9IVRw')); const au = r.find(x => x.audio);
        t('.song <link> → audio (yt-dlp)', !!au && /Me at the zoo/.test(txt()));
        r = await run(mk('.video https://www.youtube.com/watch?v=jNQXAC9IVRw')); const vi = r.find(x => x.video);
        t('.video <link> → mp4 video + caption', !!vi && /Me at the zoo/.test(vi.caption || '') && /\d+p/.test(vi.caption || ''));
        t('yt temp files delete වෙනවා', await new Promise(res => setTimeout(() => res(![au, vi].some(x => x && fs.existsSync(x.audio?.url || x.video?.url))), 400)));
        r = await run(mk('.tiktok https://www.tiktok.com/@scout2015/video/6718335390845095173')); t('.tiktok → video (no watermark)', r.some(x => x.video && /No watermark/.test(x.caption || '')));
        r = await run(mk('.fb')); t('.fb link නැතුව → usage', /\.fb <link>/.test(txt()));
        // stickers (mock WhatsApp media download)
        const jpg = fs.readFileSync(path.join(__dirname, 'banner.jpg'));
        bot._setMediaDownloader(async (m) => m.message.videoMessage ? fs.readFileSync('/tmp/ytt/v.mp4') : m.message.stickerMessage ? globalThis.__lastSticker : jpg);
        const sm = mk('.s'); sm.message = { imageMessage: { caption: '.s', mimetype: 'image/jpeg' } };
        r = await run(sm); const st = r.find(x => x.sticker);
        t('.s photo → webp sticker (512, Exif)', !!st && st.sticker.slice(0, 4).toString() === 'RIFF' && st.sticker.includes(Buffer.from('Arena AI')));
        if (fs.existsSync('/tmp/ytt/v.mp4')) {
            const vm = mk('.s'); vm.message = { extendedTextMessage: { text: '.s', contextInfo: { stanzaId: 'V1', quotedMessage: { videoMessage: { seconds: 5, mimetype: 'video/mp4' } } } } };
            r = await run(vm); const vs = r.find(x => x.sticker);
            t('.s video → animated sticker ≤ 500 KB', !!vs && vs.sticker.length <= 500 * 1024 && vs.sticker.includes(Buffer.from('ANIM')));
        }
        globalThis.__lastSticker = st && st.sticker;
        const tk = mk('.take Matheesha Pack | Me'); tk.message = { extendedTextMessage: { text: '.take Matheesha Pack | Me', contextInfo: { stanzaId: 'S1', quotedMessage: { stickerMessage: { mimetype: 'image/webp' } } } } };
        r = await run(tk); const tks = r.find(x => x.sticker); t('.take → sticker pack නම වෙනස්', !!tks && tks.sticker.includes(Buffer.from('Matheesha Pack')) && tks.sticker.includes(Buffer.from('"Me"')));
        r = await run(mk('.s')); t('.s photo නැතුව → උදව්', /reply/.test(txt()));
        // group tools (mock socket)
        const me3 = bot.ME; me3.pn = ME; me3.lid = '35189220741167@lid';
        const G = '120363111@g.us', calls = [];
        const fakeSock = { groupMetadata: async () => ({ subject: 'Test Group', participants: [{ id: '35189220741167@lid', admin: 'admin' }, { id: '94771111111@s.whatsapp.net' }, { id: '94772222222@s.whatsapp.net', admin: null }], desc: 'hello', creation: 1700000000 }),
            groupInviteCode: async () => 'ABCDEF', groupParticipantsUpdate: async (j, ids, a) => { calls.push([a, ids]); return ids.map(() => ({ status: '200' })); } };
        bot._setSock(fakeSock);
        r = await run(mk('.groupinfo', true, G)); t('👥 mode self වුණත් group එකේ මගේ .groupinfo → වැඩ', /Test Group/.test(txt()) && /Members: 3/.test(txt()));
        r = await run(mk('.ping', true, G)); t('mode self: group එකේ .ping → ignore (group tools විතරයි)', r.length === 0);
        r = await run(mk('.grouplink', true, G)); t('.grouplink → invite link', /chat\.whatsapp\.com\/ABCDEF/.test(txt()));
        const kk = mk('.kick', true, G); kk.message = { extendedTextMessage: { text: '.kick', contextInfo: { mentionedJid: ['94771111111@s.whatsapp.net'] } } };
        r = await run(kk); t('.kick @user → remove', calls.some(c => c[0] === 'remove' && c[1][0] === '94771111111@s.whatsapp.net') && /1\/1/.test(txt()));
        const pr = mk('.promote', true, G); pr.message = { extendedTextMessage: { text: '.promote', contextInfo: { participant: '94772222222@s.whatsapp.net', stanzaId: 'Q' } } };
        r = await run(pr); t('.promote (reply) → admin', calls.some(c => c[0] === 'promote'));
        r = await run(mk('.tagall hi all', true, G)); const ta = r.find(x => x.mentions); t('.tagall → mentions ඔක්කොම', !!ta && ta.mentions.length === 3);
        r = await run(mk('.tagall again', true, G)); t('🛡️ .tagall විනාඩි 10 limit', /විනාඩි 10/.test(txt()));
        r = await run(mk('.kick', false, G)); t('🔒 group එකේ වෙන කෙනෙක් .kick → ignore', r.length === 0);
        bot._setSock(null); me3.pn = null; me3.lid = null;
    }

    // ───────── v2.12: tools + fun (Knightbot-MD ideas) ─────────
    {
        const bot = require('./bot'), path = require('path');
        const txt = () => out.map(x => x.text || x.caption || '').join('\n');
        r = await run(mk('.tr si good morning my friend')); t('.tr si → සිංහල', /[\u0D80-\u0DFF]/.test(txt()));
        r = await run(mk('.tr සුභ උදෑසනක්')); t('.tr (සිංහල text) → English auto', /good|morning/i.test(txt()));
        const rq = mk('.tr si'); rq.message = { extendedTextMessage: { text: '.tr si', contextInfo: { stanzaId: 'Q', quotedMessage: { conversation: 'How are you?' } } } };
        r = await run(rq); t('reply කරලා .tr si → translate', /[\u0D80-\u0DFF]/.test(txt()));
        r = await run(mk('.tts ආයුබෝවන් ඔබට')); const vo = r.find(x => x.audio); t('.tts සිංහල → voice note (mp3)', !!vo && vo.ptt === true && vo.audio.length > 2000);
        r = await run(mk('.weather Kandy')); t('.weather Kandy → කාලගුණය + දින 3', /Kandy/.test(txt()) && /°C/.test(txt()) && /දින 3/.test(txt()));
        r = await run(mk('.lyrics faded alan walker')); t('.lyrics → lyrics', /Faded/i.test(txt()) && txt().length > 300);
        r = await run(mk('.calc (25+15)*3')); t('.calc (25+15)*3 = 120', /\*120\*/.test(txt()));
        r = await run(mk('.calc 15% of 2000')); t('.calc 15% of 2000 = 300', /\*300\*/.test(txt()));
        r = await run(mk('.calc sqrt(144)+2^3')); t('.calc sqrt(144)+2^3 = 20', /\*20\*/.test(txt()));
        r = await run(mk('.calc process.exit()')); t('🔒 .calc code run කරන්න බෑ', /විතරයි/.test(txt()));
        r = await run(mk('.qr hello arena')); t('.qr → QR image', r.some(x => x.image && x.image.length > 300));
        r = await run(mk('.short https://example.com')); t('.short → is.gd link', /https:\/\/is\.gd\//.test(txt()));
        r = await run(mk('.github torvalds')); t('.github torvalds → profile', /Linus/.test(txt()));
        r = await run(mk('.joke')); t('.joke', /😂/.test(txt()) && txt().length > 10);
        r = await run(mk('.fact')); t('.fact (+සිංහල)', /Fact/.test(txt()));
        r = await run(mk('.quote')); t('.quote', /—/.test(txt()));
        r = await run(mk('.8ball will it rain')); t('.8ball', /🎱/.test(txt()));
        r = await run(mk('.ss example.com')); t('.ss example.com → screenshot', r.some(x => x.image && x.image.length > 5000));
        r = await run(mk('.imagine a cute robot drinking tea')); t('.imagine → AI image (හෝ busy නම් පැහැදිලි message)', r.some(x => x.image && x.image.length > 5000) || /busy/.test(txt()));
        // media tools (mock download)
        globalThis.__st = null;
        bot._setMediaDownloader(async (m) => m.message.stickerMessage ? globalThis.__st : fs.readFileSync(path.join(__dirname, 'banner.jpg')));
        const sm = mk('.s'); sm.message = { imageMessage: { caption: '.s', mimetype: 'image/jpeg' } }; r = await run(sm); globalThis.__st = (r.find(x => x.sticker) || {}).sticker;
        const ti = mk('.toimg'); ti.message = { extendedTextMessage: { text: '.toimg', contextInfo: { stanzaId: 'S', quotedMessage: { stickerMessage: { mimetype: 'image/webp' } } } } };
        r = await run(ti); t('.toimg sticker → PNG photo', r.some(x => x.image && x.image.slice(1, 4).toString() === 'PNG'));
        const tu = mk('.tourl'); tu.message = { extendedTextMessage: { text: '.tourl', contextInfo: { stanzaId: 'I', quotedMessage: { imageMessage: { mimetype: 'image/jpeg' } } } } };
        r = await run(tu); t('.tourl photo → link (catbox / litterbox)', /https:\/\/(files\.catbox\.moe|litter\.catbox\.moe)\//.test(txt()));
        // .del + .setpp + group extras (mock socket)
        const me4 = bot.ME; me4.pn = ME; me4.lid = '35189220741167@lid';
        const sc = [];
        bot._setSock({ sendMessage: async (j, c) => { sc.push([j, c]); return {}; }, updateProfilePicture: async (j, b) => { sc.push(['pp', j, b.length]); },
            groupMetadata: async () => ({ subject: 'G', participants: [{ id: '35189220741167@lid', admin: 'admin' }, { id: '94771111111@s.whatsapp.net', admin: 'admin' }, { id: '94772222222@s.whatsapp.net' }] }),
            groupSettingUpdate: async (j, s) => { sc.push(['set', s]); }, groupRevokeInvite: async () => 'NEWCODE' });
        const dl = mk('.del', true, '94770000000@s.whatsapp.net'); dl.message = { extendedTextMessage: { text: '.del', contextInfo: { stanzaId: 'MSG9' } } };
        r = await run(dl); t('.del (mode self වුණත් ඕනෑම chat එකක) → message delete', sc.some(x => x[1]?.delete?.id === 'MSG9' && x[1].delete.fromMe === true));
        const pp = mk('.setpp'); pp.message = { extendedTextMessage: { text: '.setpp', contextInfo: { stanzaId: 'I2', quotedMessage: { imageMessage: { mimetype: 'image/jpeg' } } } } };
        r = await run(pp); t('.setpp photo → profile photo', sc.some(x => x[0] === 'pp' && x[1] === ME));
        const G2 = '120363222@g.us';
        r = await run(mk('.mute', true, G2)); t('.mute → announcement', sc.some(x => x[0] === 'set' && x[1] === 'announcement'));
        r = await run(mk('.unmute', true, G2)); t('.unmute → open', sc.some(x => x[0] === 'set' && x[1] === 'not_announcement'));
        r = await run(mk('.resetlink', true, G2)); t('.resetlink → අලුත් link', /NEWCODE/.test(txt()));
        r = await run(mk('.tagadmins', true, G2)); t('.tagadmins → admins 2', (r.find(x => x.mentions) || {}).mentions?.length === 2);
        r = await run(mk('.joke', true, G2)); t('mode self: group එකේ .joke → ignore', r.length === 0);
        r = await run(mk('.del', false, '94770000000@s.whatsapp.net')); t('🔒 වෙන කෙනෙක් .del → ignore', r.length === 0);
        bot._setSock(null); me4.pn = null; me4.lid = null;
    }

    // ───────── v2.12.1: big files → stream (1× disk), .maxmb ─────────
    {
        const http = require('http'), os2 = require('os');
        const BIG = 420 * 1048576;
        const srv = http.createServer((req, res) => {
            res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': BIG, 'Content-Disposition': 'attachment; filename="big-480p.mp4"' });
            const chunk = Buffer.alloc(1048576, 7); let sent = 0;
            const pump = () => { while (sent < BIG) { sent += chunk.length; if (!res.write(chunk)) return res.once('drain', pump); } res.end(); };
            pump();
        });
        await new Promise(r => srv.listen(0, '127.0.0.1', r));
        const url = `http://127.0.0.1:${srv.address().port}/big-480p.mp4`;
        const tmpBefore = fs.readdirSync(process.env.DL_TMP || os2.tmpdir()).filter(f => f.startsWith('dl-')).length;
        const txt = () => out.map(x => x.text || x.caption || '').join('\n');
        r = await run(mk('.download ' + url)); const bd = r.find(x => x.document);
        t('🌊 420 MB file (පරණ limit 350) → stream එකෙන් සම්පූර්ණයෙන්ම යනවා', !!bd && bd.streamed === true && bd.size === BIG && bd.fileName === 'big-480p.mp4');
        t('🌊 stream mode: disk එකේ copy එකක් හැදෙන්නේ නෑ', fs.readdirSync(process.env.DL_TMP || os2.tmpdir()).filter(f => f.startsWith('dl-')).length === tmpBefore);
        r = await run(mk('.maxmb 300')); t('.maxmb 300 → set', /300 MB/.test(txt()));
        r = await run(mk('.download ' + url)); t('limit 300 → 420 MB file එකට පැහැදිලි error', /limit එක 300\.0 MB/.test(txt()) && !r.some(x => x.document));
        r = await run(mk('.maxmb 6gb')); t('.maxmb 6gb → 2000 ට සීමා (WhatsApp 2 GB)', /2000 MB/.test(txt()) && /2 GB/.test(txt()));
        r = await run(mk('.maxmb')); t('.maxmb → දැන් limit එක පෙන්නනවා', /2000 MB/.test(txt()));
        r = await run(mk('.maxmb', false, '94770000000@s.whatsapp.net')); t('🔒 වෙන කෙනෙක් .maxmb → ignore', r.length === 0);
        const sf = require('path').join(__dirname, 'settings.json'); try { const d = JSON.parse(fs.readFileSync(sf, 'utf8')); delete d.maxMB; fs.writeFileSync(sf, JSON.stringify(d, null, 2)); } catch { }
        delete process.env.DL_MAX_MB;
        srv.close();
    }

    // ───────── v2.12.2: hide libsignal session keys + agent → WhatsApp ─────────
    {
        const bot = require('./bot');
        let printed = '';
        const ow = process.stdout.write.bind(process.stdout), ew = process.stderr.write.bind(process.stderr);
        process.stdout.write = (s, ...a) => { printed += s; return true; }; process.stderr.write = (s, ...a) => { printed += s; return true; };
        console.info('Closing session:', { privKey: 'SECRET123' }); console.info('Opening session:', { privKey: 'SECRET123' });
        console.info('Removing old closed session:', { privKey: 'SECRET123' }); console.warn('Closing open session in favor of incoming prekey bundle');
        console.log('normal line OK');
        process.stdout.write = ow; process.stderr.write = ew;
        t('🔒 session keys console එකේ පේන්නේ නෑ', !printed.includes('SECRET123') && !/Closing open session/.test(printed));
        t('සාමාන්‍ය logs තාම පේනවා', printed.includes('normal line OK'));
        const sent = []; const fsend = async (j, c) => { sent.push([j, c]); return { key: { id: 'A' + sent.length } }; };
        bot.ME.pn = ME;
        fs.writeFileSync(bot.AGENT_MSG, 'Hello from the agent 👋\nදෙවෙනි line එක');
        const ok = await bot._agentTick(fsend);
        t('📨 agent-msg.txt → Message yourself එකට යනවා', ok && sent.length === 1 && sent[0][0] === ME && /Arena Agent/.test(sent[0][1].text) && /දෙවෙනි line/.test(sent[0][1].text));
        t('📨 යැව්වට පස්සේ file එක මැකෙනවා (ආයෙත් යන්නේ නෑ)', !fs.existsSync(bot.AGENT_MSG) && (await bot._agentTick(fsend)) === false && sent.length === 1);
        fs.writeFileSync(bot.AGENT_MSG, '   ');
        t('📨 හිස් file → මුකුත් යවන්නේ නෑ', (await bot._agentTick(fsend)) === false && sent.length === 1);
        bot.ME.pn = null;
        fs.writeFileSync(bot.AGENT_MSG, 'x'); t('📨 connect වෙලා නැත්නම් යවන්නේ නෑ', (await bot._agentTick(fsend)) === false); fs.rmSync(bot.AGENT_MSG, { force: true });
    }

    console.log(bad ? `\n⚠️ ${ok} passed, ${bad} failed` : `\n🎉 ALL ${ok} TESTS PASSED`);
    process.exit(bad ? 1 : 0);
})();
