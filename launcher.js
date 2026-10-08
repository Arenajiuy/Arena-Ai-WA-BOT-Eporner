/**
 * launcher.js — keeps the bot running.
 *  exit 100 → restart (after .update)   exit 0 → stop   crash → restart (3s)
 *  if a fresh update crash-loops (3 quick crashes) → automatic rollback to .backup
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const BACKUP = path.join(__dirname, '.backup');
let quickFails = 0;

function rollback() {
    try {
        const b = JSON.parse(fs.readFileSync(path.join(BACKUP, 'backup.json'), 'utf8'));
        for (const f of b.files) fs.copyFileSync(path.join(BACKUP, f), path.join(__dirname, f));
        fs.writeFileSync(path.join(__dirname, '.version.json'), JSON.stringify(b.info || {}, null, 2));
        fs.rmSync(path.join(BACKUP, 'pending'), { force: true });
        console.log('↩️  අලුත් update එක crash වුණා — පරණ version එකට ආපහු ගියා (rollback).');
        return true;
    } catch (e) { console.log('rollback fail: ' + e.message); return false; }
}

function run() {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(__dirname, 'bot.js')], { stdio: 'inherit', env: { ...process.env, ARENA_LAUNCHER: '1' } });
    // a version that stays up for 60s is "good" → clear the rollback flag
    const okTimer = setTimeout(() => fs.rmSync(path.join(BACKUP, 'pending'), { force: true }), 60000);
    child.on('exit', (code, signal) => {
        clearTimeout(okTimer);
        if (signal === 'SIGINT' || signal === 'SIGTERM') process.exit(0);
        if (code === 0) process.exit(0);
        if (code === 100) { quickFails = 0; console.log('🔄 Update එකෙන් පස්සේ restart වෙනවා...'); return setTimeout(run, 1000); }
        quickFails = Date.now() - started < 20000 ? quickFails + 1 : 0;
        if (quickFails >= 3 && fs.existsSync(path.join(BACKUP, 'pending')) && rollback()) quickFails = 0;
        if (quickFails >= 8) { console.log('❌ Bot එක නැවත නැවත crash වෙනවා — නවත්තනවා. Screenshot එකක් ගන්න.'); process.exit(1); }
        console.log(`⚠️ Bot නතර වුණා (code ${code}) — තත්පර 3 කින් ආයෙත් start වෙනවා...`);
        setTimeout(run, 3000);
    });
}
process.on('SIGINT', () => { }); // child gets Ctrl+C too; we exit when it does
run();
