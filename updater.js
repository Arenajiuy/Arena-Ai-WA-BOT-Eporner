/**
 * .update — pulls the latest bot files from GitHub and restarts (launcher.js).
 * Never touches: auth/ (WhatsApp link), settings.json (API keys), node_modules/.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawn } = require('child_process');

const REPO = process.env.UPDATE_REPO || 'Arenajiuy/Arena-Ai-WA-BOT-Eporner';
const DIR = (process.env.UPDATE_DIR ?? '').replace(/^\/+|\/+$/g, '');   // '' = repo root
const BRANCH = process.env.UPDATE_BRANCH || 'main';
const ROOT = __dirname;
const VERSION_FILE = path.join(ROOT, '.version.json');
const BACKUP = path.join(ROOT, '.backup');
const PROTECTED = /^(auth|node_modules|\.backup)(\/|$)|^settings\.json$|^\.version\.json$|^logo\.img$/;
const UA = { 'User-Agent': 'arena-ai-bot-updater', Accept: 'application/vnd.github+json' };

const localInfo = () => { try { return JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8')); } catch { return { version: require('./package.json').version, sha: null }; } };

async function latest() {
    const r = await fetch(`https://api.github.com/repos/${REPO}/commits?sha=${BRANCH}${DIR ? '&path=' + DIR : ''}&per_page=1`, { headers: UA });
    if (!r.ok) throw new Error(`GitHub ${r.status} (ටිකකින් ආයෙත් try කරන්න)`);
    const c = (await r.json())[0];
    if (!c) throw new Error('update repo එකේ files නෑ');
    const m = await fetchJson(c.sha, 'manifest.json');
    return { sha: c.sha, message: c.commit.message, date: c.commit.committer.date, manifest: m };
}

async function fetchRaw(sha, file) {
    const r = await fetch(`https://raw.githubusercontent.com/${REPO}/${sha}/${DIR ? DIR + '/' : ''}${file}`, { headers: { 'User-Agent': UA['User-Agent'] } });
    if (!r.ok) {
        // optional files 404 නම් skip කරන්න - update fail වෙන්න එපා
        const optional = ['termux-setup.sh', 'test.js', 'README-SI.txt', '.gitignore', 'banner.jpg', 'logo.img'];
        if (r.status === 404 && optional.includes(file)) {
            console.log(`⚠️ optional ${file} 404 - skip`);
            return null;
        }
        throw new Error(`${file} download fail (${r.status})`);
    }
    return Buffer.from(await r.arrayBuffer());
}
const fetchJson = async (sha, f) => JSON.parse((await fetchRaw(sha, f)).toString('utf8'));

async function check() {
    const cur = localInfo();
    const l = await latest();
    // sha only comparable within the same repo (after moving repos compare by version)
    const upToDate = (cur.sha && cur.repo === REPO) ? cur.sha === l.sha : cur.version === l.manifest.version;
    return { current: cur, latest: l, upToDate };
}

function runNpmInstall() {
    return new Promise((res, rej) => {
        const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
        const p = spawn(npm, ['install', '--legacy-peer-deps', '--no-audit', '--no-fund'], { cwd: ROOT, stdio: 'ignore' });
        p.on('exit', (code) => code === 0 ? res() : rej(new Error('npm install fail (' + code + ')')));
        p.on('error', rej);
    });
}

/** download → verify → backup → replace. Returns info; caller restarts the process. */
async function apply({ force = false, onStatus = () => { } } = {}) {
    const c = await check();
    if (c.upToDate && !force) return { updated: false, ...c };
    const { sha, manifest } = c.latest;
    const files = manifest.files || [];
    if (!files.length || !files.includes('bot.js')) throw new Error('manifest එක වැරදියි');
    for (const f of files) if (f.includes('..') || path.isAbsolute(f) || PROTECTED.test(f)) throw new Error('අනාරක්ෂිත file path: ' + f);

    onStatus(`⬇️ files ${files.length} ක් download කරනවා...`);
    const data = {};
    for (const f of files) {
        const buf = await fetchRaw(sha, f);
        if (buf === null) continue; // optional missing → skip
        data[f] = buf;
    }

    // syntax check every .js before touching anything (a broken update never gets installed)
    for (const f of Object.keys(data).filter(f => f.endsWith('.js'))) {
        try { new vm.Script(`(function(exports,require,module,__filename,__dirname){${data[f].toString('utf8')}\n})`, { filename: f }); }
        catch (e) { throw new Error(`${f} එකේ error එකක් — update එක install කළේ නෑ (${e.message})`); }
    }

    // backup current files (for automatic rollback by launcher.js)
    fs.rmSync(BACKUP, { recursive: true, force: true });
    fs.mkdirSync(BACKUP, { recursive: true });
    const backed = [];
    for (const f of Object.keys(data)) {
        const src = path.join(ROOT, f);
        if (fs.existsSync(src)) { fs.mkdirSync(path.dirname(path.join(BACKUP, f)), { recursive: true }); fs.copyFileSync(src, path.join(BACKUP, f)); backed.push(f); }
    }
    fs.writeFileSync(path.join(BACKUP, 'backup.json'), JSON.stringify({ files: backed, info: localInfo(), time: Date.now() }));

    const oldPkg = fs.existsSync(path.join(ROOT, 'package.json')) ? JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) : {};
    for (const f of Object.keys(data)) {
        const dst = path.join(ROOT, f);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.writeFileSync(dst + '.tmp', data[f]);
        fs.renameSync(dst + '.tmp', dst);
    }
    const newPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const depsChanged = JSON.stringify(oldPkg.dependencies || {}) !== JSON.stringify(newPkg.dependencies || {});
    if (depsChanged) { onStatus('📦 අලුත් packages install කරනවා (මිනිත්තුවක් විතර)...'); await runNpmInstall(); }

    fs.writeFileSync(VERSION_FILE, JSON.stringify({ version: manifest.version, sha, repo: REPO, date: c.latest.date }, null, 2));
    fs.writeFileSync(path.join(BACKUP, 'pending'), String(Date.now())); // launcher: rollback if the new version crash-loops
    return { updated: true, from: c.current.version, to: manifest.version, notes: manifest.notes || c.latest.message, depsChanged, files: Object.keys(data).length };
}

module.exports = { check, apply, localInfo, REPO, DIR };
