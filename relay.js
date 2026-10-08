/**
 * relay.js - External relay for eporner CDN bypass
 * Deploy this on a server with residential IP (Termux, home VPS, etc)
 * Then set EPORNER_RELAY_URL on main panel bot to point to this relay
 * 
 * Usage:
 *   node relay.js
 *   Env: RELAY_PORT=3001, RELAY_TOKEN=secret (optional auth)
 * 
 * Endpoint:
 *   GET /?url=https://vid-s15-s50-fr-cdn.eporner.com/.../video-720p.mp4
 *   -> streams the video through relay (bypasses panel IP block)
 * 
 * Security: set RELAY_TOKEN and use EPORNER_RELAY_URL=https://relay.example.com/?token=secret
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

const PORT = parseInt(process.env.RELAY_PORT || '3001', 10);
const TOKEN = process.env.RELAY_TOKEN || '';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';

function checkAuth(req) {
    if (!TOKEN) return true;
    const url = new URL(req.url, `http://${req.headers.host}`);
    const t = url.searchParams.get('token') || req.headers['x-relay-token'] || '';
    return t === TOKEN;
}

const server = http.createServer(async (req, res) => {
    // CORS for testing
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-relay-token');
    
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
    }
    
    const parsed = new URL(req.url, `http://${req.headers.host}`);
    
    if (parsed.pathname === '/' && !parsed.searchParams.get('url')) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end(`
            <h1>🔗 Eporner CDN Relay v1.0</h1>
            <p>Status: ✅ Running</p>
            <p>Usage: GET /?url=ENCODED_CDN_URL</p>
            <p>Example: /?url=${encodeURIComponent('https://vid-s15-s50-fr-cdn.eporner.com/.../video-720p.mp4')}</p>
            <p>Env: RELAY_PORT, RELAY_TOKEN (optional)</p>
            <p>Set on main bot: EPORNER_RELAY_URL=https://your-relay.com/?token=${TOKEN||'secret'}&url={url}</p>
        `);
    }
    
    if (!checkAuth(req)) {
        res.writeHead(401, { 'Content-Type': 'text/plain' });
        return res.end('Unauthorized - invalid token');
    }
    
    const targetUrl = parsed.searchParams.get('url');
    if (!targetUrl) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        return res.end('Missing ?url= parameter');
    }
    
    // Only allow eporner CDN and eporner.com
    try {
        const u = new URL(targetUrl);
        if (!u.hostname.includes('eporner.com') && !u.hostname.includes('eporner')) {
            res.writeHead(403, { 'Content-Type': 'text/plain' });
            return res.end('Only eporner.com CDN allowed');
        }
    } catch {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        return res.end('Invalid URL');
    }
    
    console.log(`[relay] Fetching: ${targetUrl.slice(0,100)}...`);
    
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 120000); // 2min timeout
        
        const fetchRes = await fetch(targetUrl, {
            headers: {
                'User-Agent': UA,
                'Referer': 'https://www.eporner.com/',
                'Accept': 'video/mp4,*/*'
            },
            signal: controller.signal
        });
        
        clearTimeout(timeout);
        
        if (!fetchRes.ok) {
            res.writeHead(fetchRes.status, { 'Content-Type': 'text/plain' });
            return res.end(`Upstream ${fetchRes.status}`);
        }
        
        // Stream through
        res.writeHead(200, {
            'Content-Type': fetchRes.headers.get('content-type') || 'video/mp4',
            'Content-Length': fetchRes.headers.get('content-length') || undefined,
            'Content-Disposition': fetchRes.headers.get('content-disposition') || `attachment; filename="video.mp4"`,
            'Cache-Control': 'no-cache'
        });
        
        const { Readable } = require('stream');
        const stream = Readable.fromWeb(fetchRes.body);
        stream.pipe(res);
        
        stream.on('error', (e) => {
            console.error('[relay] Stream error', e.message);
            try { res.end(); } catch {}
        });
        
    } catch (e) {
        console.error('[relay] Fetch error', e.message);
        if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'text/plain' });
            res.end(`Relay fetch fail: ${e.message}`);
        }
    }
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🔗 Eporner CDN Relay running on http://0.0.0.0:${PORT}`);
    console.log(`   Token: ${TOKEN ? '✅ set' : '❌ none (open)'}`);
    console.log(`   Usage: ${TOKEN ? `http://localhost:${PORT}/?token=${TOKEN}&url={url}` : `http://localhost:${PORT}/?url={url}`}`);
    console.log(`   Set on main bot: EPORNER_RELAY_URL=http://your-ip:${PORT}/?token=${TOKEN}&url={url} or EPORNER_RELAY_URL=http://your-ip:${PORT}/`);
});
