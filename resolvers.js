/**
 * Link resolvers: turn a share link into something we can download.
 * Supported: any direct link, GitHub (blob/raw/releases), Google Drive,
 * MediaFire, Dropbox, Pixeldrain, MEGA (megajs), catbox/litterbox, x0.at,
 * transfer.archivete.am, filebin, OneDrive-style direct links...
 */
const UA_BROWSER = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';
const UA_CURL = 'curl/8.5.0';

async function fetchText(url, ua = UA_BROWSER) {
    const r = await require('./net').smartFetch(url, { headers: { 'User-Agent': ua }, redirect: 'follow' });
    return { status: r.status, url: r.url, text: await r.text() };
}

function driveId(u) {
    const m = u.pathname.match(/\/file\/d\/([\w-]{10,})/) || u.pathname.match(/\/d\/([\w-]{10,})/);
    return (m && m[1]) || u.searchParams.get('id');
}

async function resolve(raw) {
    let u;
    try { u = new URL(raw); } catch { throw new Error('link එක වැරදියි'); }
    const host = u.hostname.replace(/^www\./, '').toLowerCase();

    // ── MEGA ──
    if (host === 'mega.nz' || host === 'mega.co.nz') return { kind: 'mega', url: raw };

    // ── gofile / limewire: protected, can't download outside the browser ──
    if (host === 'gofile.io') throw new Error('gofile links bot එකකට download කරන්න බෑ (site එක bots block කරනවා). Browser එකෙන් download කරන්න.');
    if (host === 'limewire.com') throw new Error('LimeWire files encrypt කරලා — browser එකෙන් විතරයි download වෙන්නේ.');

    // ── GitHub ──
    if (host === 'github.com') {
        const m = u.pathname.match(/^\/([^/]+)\/([^/]+)\/blob\/(.+)$/);
        if (m) return { kind: 'http', url: `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}` };
        return { kind: 'http', url: raw }; // /raw/..., /releases/download/... redirect fine
    }

    // ── Google Drive ──
    if (host === 'drive.google.com' || host === 'docs.google.com' || host === 'drive.usercontent.google.com') {
        const id = driveId(u);
        if (!id) throw new Error('Google Drive file ID එක හොයාගන්න බෑ (folder links support නෑ)');
        return { kind: 'http', url: `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`, drive: true };
    }

    // ── Dropbox ──
    if (host.endsWith('dropbox.com')) { u.searchParams.set('dl', '1'); return { kind: 'http', url: u.toString() }; }

    // ── Pixeldrain ──
    if (host === 'pixeldrain.com' || host === 'pixeldra.in') {
        const m = u.pathname.match(/\/(?:u|api\/file)\/([\w-]+)/);
        if (m) return { kind: 'http', url: `https://pixeldrain.com/api/file/${m[1]}?download` };
    }

    // ── MediaFire ──
    if (host.endsWith('mediafire.com') && !/^download\d*\./.test(host)) {
        if (/\/folder\//.test(u.pathname)) throw new Error('MediaFire folder links support නෑ — file link එකක් එවන්න');
        const page = await fetchText(raw, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36');
        if (page.status === 404) throw new Error('MediaFire file එක delete වෙලා / private');
        let m = page.text.match(/href="(https?:\/\/download\d*\.mediafire\.com[^"]+)"/);
        let link = m && m[1].replace(/&amp;/g, '&');
        if (!link) {
            const s = page.text.match(/data-scrambled-url="([^"]+)"/);
            if (s) { try { link = Buffer.from(s[1], 'base64').toString('utf8'); } catch { } }
        }
        if (!link) throw new Error('MediaFire download link එක හොයාගන්න බෑ (file එක delete වෙලා හෝ private)');
        return { kind: 'http', url: link, referer: raw };
    }

    // ── everything else: treat as direct link ──
    return { kind: 'http', url: raw };
}

/** Google Drive "can't scan for viruses" page → follow its form */
function driveConfirmUrl(html) {
    const form = html.match(/<form[^>]+id="download-form"[^>]+action="([^"]+)"[\s\S]*?<\/form>/);
    if (!form) return null;
    const action = form[1].replace(/&amp;/g, '&');
    const params = new URLSearchParams();
    for (const m of form[0].matchAll(/<input[^>]+type="hidden"[^>]+name="([^"]+)"[^>]+value="([^"]*)"/g)) params.set(m[1], m[2]);
    return action + (action.includes('?') ? '&' : '?') + params.toString();
}

module.exports = { resolve, driveConfirmUrl, UA_BROWSER, UA_CURL };
