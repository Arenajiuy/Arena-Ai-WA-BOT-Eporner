'use strict';
/**
 * eporner.js v2.19.0 - CDN block bypass + residential proxy + external relay
 * 
 * Fixes panel network drops vid-*-cdn.eporner.com TCP timeout:
 * - Uses net.js smartFetch (direct → DoH → IPv6 → proxy) for ALL requests
 * - DL_PROXY / .setproxy residential proxy wired to eporner downloads
 * - External relay support via EPORNER_RELAY_URL for eporner-only
 * - Apify fallback still available
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { Readable } = require('stream');

let netMod = null;
try { netMod = require('./net'); } catch {}
let apifyMod = null;
try { apifyMod = require('./apify'); } catch {}

const API_BASE = 'https://www.eporner.com/api/v2/video';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';

function getRelayUrl() {
    let relay = process.env.EPORNER_RELAY_URL || process.env.EPORNER_RELAY || '';
    if (!relay) {
        try {
            const s = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'settings.json'), 'utf8'));
            relay = s.epornerRelay || '';
        } catch {}
    }
    return relay;
}
function getEpornerProxyMode() {
    return process.env.EPORNER_USE_PROXY === '1' || process.env.EPORNER_PROXY_ONLY === '1';
}

// Wrapper that uses net.js smartFetch if available, else plain fetch
async function smartFetchWrapper(url, opts = {}) {
    const headers = {
        'User-Agent': UA,
        'Accept': opts.accept || '*/*',
        ...(opts.headers || {})
    };
    if (opts.referer) headers.Referer = opts.referer;
    
    const fetchOpts = {
        method: opts.method || 'GET',
        headers,
        redirect: opts.redirect || 'follow'
    };
    
    // If relay is set and this is a CDN URL, use relay
    const relay = getRelayUrl();
    if (relay && (url.includes('cdn.eporner.com') || url.includes('eporner.com/v2/') || url.includes('eporner.com/v4/'))) {
        // Relay format: {RELAY_URL}?url={encoded_url}
        // Supports two modes:
        // 1. https://relay.example.com/fetch?url=ENCODED
        // 2. https://relay.example.com/ (POST with url in body) - we use GET mode
        let relayUrl;
        if (relay.includes('{url}') || relay.includes('%s')) {
            relayUrl = relay.replace('{url}', encodeURIComponent(url)).replace('%s', encodeURIComponent(url));
        } else if (relay.includes('?')) {
            relayUrl = `${relay}&url=${encodeURIComponent(url)}`;
        } else {
            relayUrl = `${relay.replace(/\/$/, '')}/?url=${encodeURIComponent(url)}`;
        }
        console.log(`[eporner] Using external relay for CDN: ${url.slice(0,60)}... via ${relayUrl.slice(0,60)}`);
        if (netMod && netMod.smartFetch) {
            return netMod.smartFetch(relayUrl, fetchOpts);
        }
        return fetch(relayUrl, fetchOpts);
    }
    
    if (netMod && netMod.smartFetch) {
        // Force proxy for eporner if EPORNER_USE_PROXY=1
        if (getEpornerProxyMode() && url.includes('eporner.com')) {
            console.log(`[eporner] Forcing proxy for ${url.slice(0,60)} (EPORNER_USE_PROXY=1)`);
        }
        return netMod.smartFetch(url, fetchOpts);
    }
    return fetch(url, fetchOpts);
}

function buildUrl(method, params) {
    const url = new URL(`${API_BASE}/${method}/`);
    Object.entries(params).forEach(([k,v]) => { if (v!==undefined && v!==null) url.searchParams.set(k, String(v)); });
    return url.toString();
}
async function apiFetch(url) {
    const res = await smartFetchWrapper(url, { accept: 'application/json' });
    if (!res.ok) throw new Error(`API ${res.status}`);
    return res.json();
}
async function search(query, perPage=5, page=1) {
    const url = buildUrl('search', { query, per_page: perPage, page, order: 'latest', thumbsize: 'big' });
    const data = await apiFetch(url);
    return { count: data.count||0, total_count: data.total_count||0, videos: data.videos||[], page };
}
async function getById(id) {
    const url = buildUrl('id', { id });
    const data = await apiFetch(url);
    return data.videos?.[0] || data;
}
function human(n){ if(!n) return '0'; if(n>=1e6) return (n/1e6).toFixed(1)+'M'; if(n>=1e3) return (n/1e3).toFixed(1)+'K'; return String(n); }

function encodeBaseN(num, base) {
    const chars='0123456789abcdefghijklmnopqrstuvwxyz';
    if (num===0) return '0';
    let res='';
    while(num>0){ res=chars[num%base]+res; num=Math.floor(num/base); }
    return res;
}
function calcHash(s){
    let out='';
    for(let lb=0; lb<32; lb+=8){
        const chunk=s.slice(lb,lb+8);
        const num=parseInt(chunk,16);
        out+=encodeBaseN(num,36);
    }
    return out;
}
function extractVideoId(pageUrl){
    const m=pageUrl.match(/(?:video-|hd-porn\/)([A-Za-z0-9]+)/);
    return m?m[1]:null;
}
function extractHash(html){
    const re=/hash\s*=\s*['"]([a-f0-9]{32})['"]/gi;
    let match;
    const hashes=[];
    while((match=re.exec(html))!==null){
        hashes.push(match[1]);
    }
    if(hashes.length) return hashes[hashes.length-1];
    const m2=html.match(/hash\s*[:=]\s*["']([a-f0-9]{32})["']/i);
    return m2?m2[1]:null;
}

async function getDirectSources(pageUrl){
    const res=await smartFetchWrapper(pageUrl,{
        accept: 'text/html',
        headers: { 'Accept-Language': 'en-US,en;q=0.9' },
        referer: 'https://www.eporner.com/'
    });
    if(!res.ok) throw new Error(`Page ${res.status}`);
    const html=await res.text();
    const videoId=extractVideoId(pageUrl);
    if(!videoId) throw new Error('Cannot extract video id');
    const rawHash=extractHash(html);
    if(!rawHash) throw new Error('Hash not found - page may have changed');
    const hash=calcHash(rawHash);
    const xhrUrl=`https://www.eporner.com/xhr/video/${videoId}?hash=${hash}&device=generic&domain=www.eporner.com&fallback=false`;
    const xhrRes=await smartFetchWrapper(xhrUrl,{
        accept: 'application/json',
        referer: pageUrl
    });
    if(!xhrRes.ok) throw new Error(`XHR ${xhrRes.status}`);
    const data=await xhrRes.json();
    if(data.available===false) throw new Error(data.message||'Video not available');
    const sources=data.sources||{};
    const mp4Sources=sources.mp4||sources.hls||{};
    const links=[];
    for(const [formatId, info] of Object.entries(mp4Sources)){
        if(!info||!info.src) continue;
        const src=info.src;
        const qMatch=formatId.match(/(\d+)p/) || info.labelShort?.match(/(\d+)p/) || src.match(/-(\d+)p\.mp4/);
        const quality=qMatch?parseInt(qMatch[1]):0;
        if(!quality) continue;
        const type=src.includes('-av1')||formatId.toLowerCase().includes('av1')?'av1':'h264';
        links.push({
            quality,
            type,
            url: src,
            dloadUrl: null,
            src,
            formatId,
            label: info.labelShort||formatId,
            direct: true
        });
    }
    try {
        const sizeMap={};
        const sizeRe=/href="\/dload\/[^"]+"[^>]*>\s*Download[^<]*\((\d+)p,\s*[^,]+,\s*([^)]+)\)/gi;
        let m;
        while((m=sizeRe.exec(html))!==null){
            const q=parseInt(m[1]);
            sizeMap[q]=m[2].trim();
        }
        links.forEach(l=>{ if(sizeMap[l.quality]) l.sizeText=sizeMap[l.quality]; });
    } catch {}
    links.sort((a,b)=>b.quality-a.quality || (a.type==='h264'?-1:1));
    return { links, html, videoId, rawHash, hash };
}

function parseDloadLinksFromHtml(html){
    const links=[];
    const re1=/href="(\/dload\/[^"]+)"[^>]*>\s*Download[^<]*\((\d+)p,\s*([^,\)]+)(?:,\s*([^)]+))?\)/gi;
    let m;
    while((m=re1.exec(html))!==null){
        let href=m[1];
        const quality=parseInt(m[2]);
        const codec=(m[3]||'h264').toLowerCase().includes('av1')?'av1':'h264';
        const sizeText=m[4]?m[4].trim():null;
        if(href.startsWith('/')) href='https://www.eporner.com'+href;
        links.push({ quality, type: codec, url: href, dloadUrl: href, src: href, formatId: `${quality}p`, label: `${quality}p`, sizeText, direct: false });
    }
    const re2=/<span class="download-(h264|av1)">\s*<a href="([^"]+)"[^>]*>[^<]*\((\d+)p/gi;
    while((m=re2.exec(html))!==null){
        const type=m[1].toLowerCase();
        let href=m[2];
        const quality=parseInt(m[3]);
        if(href.startsWith('/')) href='https://www.eporner.com'+href;
        if(!links.find(l=>l.quality===quality && l.type===type)){
            links.push({ quality, type, url: href, dloadUrl: href, src: href, formatId: `${quality}p`, label: `${quality}p`, direct: false });
        }
    }
    const re3=/href="(\/dload\/[^"]+)"[^>]*>(\d+)p/gi;
    while((m=re3.exec(html))!==null){
        let href=m[1];
        const quality=parseInt(m[2]);
        if(href.startsWith('/')) href='https://www.eporner.com'+href;
        if(!links.find(l=>l.quality===quality)){
            links.push({ quality, type: 'h264', url: href, dloadUrl: href, src: href, formatId: `${quality}p`, label: `${quality}p`, direct: false });
        }
    }
    links.sort((a,b)=>b.quality-a.quality);
    const seen=new Set();
    const uniq=[];
    for(const l of links){ const k=l.quality+'-'+l.type; if(!seen.has(k)){ seen.add(k); uniq.push(l);} }
    return uniq;
}

async function parseDownloadLinks(pageUrl){
    try {
        const { links } = await getDirectSources(pageUrl);
        if(links.length) return links;
    } catch(e){
        console.log(`[eporner] xhr failed: ${e.message}, trying dload parse`);
    }
    const res=await smartFetchWrapper(pageUrl,{
        accept: 'text/html',
        referer: 'https://www.eporner.com/'
    });
    if(!res.ok) throw new Error(`Page ${res.status}`);
    const html=await res.text();
    const links=parseDloadLinksFromHtml(html);
    if(!links.length){
        const cu=html.match(/"contentUrl"\s*:\s*"([^"]+)"/);
        if(cu){
            let url=cu[1].replace(/\\\//g,'/');
            if(url.startsWith('/')) url='https://www.eporner.com'+url;
            return [{ quality: 720, type: 'h264', url, dloadUrl: url, src: url, formatId: '720p', label: '720p', direct: true }];
        }
        throw new Error('No download links found');
    }
    return links;
}

async function getFinalMp4Url(dloadUrl){
    if(dloadUrl.includes('eporner.com/v2/') || dloadUrl.includes('eporner.com/v4/') || (dloadUrl.includes('.mp4') && dloadUrl.includes('cdn.eporner.com'))){
        return dloadUrl;
    }
    const res=await smartFetchWrapper(dloadUrl,{
        method: 'GET',
        referer: 'https://www.eporner.com/',
        redirect: 'manual'
    });
    const loc=res.headers.get('location');
    if(loc) return loc;
    const text=await res.text().catch(()=> '');
    const mp4Match=text.match(/https?:\/\/[^\s"'<>]+\.mp4[^\s"'<>]*/i);
    if(mp4Match) return mp4Match[0];
    const hrefMatch=text.match(/href="(https?:\/\/[^"]+\.mp4[^"]*)"/i);
    if(hrefMatch) return hrefMatch[1];
    throw new Error('No mp4 redirect found - dload may have expired, try xhr method or set residential proxy');
}

async function smartFetchFinal(finalUrl){
    // Use smartFetchWrapper which handles proxy + relay
    const res=await smartFetchWrapper(finalUrl,{
        accept: 'video/mp4,*/*',
        referer: 'https://www.eporner.com/'
    });
    return res;
}

async function downloadVideo(pageUrl, qualityOrTmp, tmpDir){
    let wantedQuality=null;
    if(typeof qualityOrTmp==='number') wantedQuality=qualityOrTmp;
    else if(typeof qualityOrTmp==='string' && /^\d+$/.test(qualityOrTmp)) wantedQuality=parseInt(qualityOrTmp);

    const actualTmpDir=typeof qualityOrTmp==='string' && !/^\d+$/.test(qualityOrTmp) ? qualityOrTmp : tmpDir;

    let links=[];
    try{
        links=await parseDownloadLinks(pageUrl);
    }catch(e){
        console.log(`[eporner] parseDownloadLinks fail: ${e.message}`);
    }
    if(!links.length){
        if(apifyMod && apifyMod.getToken()){
            try{
                console.log('[eporner] Trying Apify fallback for',pageUrl);
                const apifyRes=await apifyMod.getDirectViaApify(pageUrl, wantedQuality||'best');
                if(apifyRes.directUrl){
                    const res=await smartFetchFinal(apifyRes.directUrl);
                    if(!res.ok) throw new Error(`Apify MP4 ${res.status}`);
                    const outDir=actualTmpDir||os.tmpdir();
                    const outPath=path.join(outDir,`ep-${Date.now().toString(36)}-${wantedQuality||'best'}p-apify.mp4`);
                    const file=fs.createWriteStream(outPath);
                    const stream=Readable.fromWeb(res.body);
                    await new Promise((resolve,reject)=>{ stream.pipe(file); file.on('finish',resolve); file.on('error',reject); });
                    return outPath;
                }
            }catch(e){ console.log('[eporner] Apify fallback fail:',e.message); }
        }
        throw new Error('No links and Apify not available - CDN may be blocked, set residential proxy via .setproxy or DL_PROXY');
    }

    let selected=null;
    if(wantedQuality){
        selected=links.find(l=>l.quality===wantedQuality) || links.find(l=>l.quality===wantedQuality && l.type==='h264');
    }
    if(!selected) selected=links.find(l=>l.type==='h264') || links[0];

    let finalUrl=selected.url;
    if(!selected.direct){
        finalUrl=await getFinalMp4Url(selected.dloadUrl||selected.url);
    }
    try{
        const res=await smartFetchFinal(finalUrl);
        if(!res.ok) throw new Error(`MP4 ${res.status} - CDN block? ${finalUrl.includes('cdn.eporner.com') ? 'vid-*-cdn.eporner.com TCP timeout, need residential proxy' : ''}`);
        const outDir=actualTmpDir||os.tmpdir();
        const outPath=path.join(outDir,`ep-${Date.now().toString(36)}-${selected.quality}p.mp4`);
        const file=fs.createWriteStream(outPath);
        const stream=Readable.fromWeb(res.body);
        await new Promise((resolve,reject)=>{ stream.pipe(file); file.on('finish',resolve); file.on('error',reject); });
        return outPath;
    }catch(e){
        if(apifyMod && apifyMod.getToken()){
            try{
                console.log('[eporner] Direct download fail, trying Apify:',e.message);
                const apifyRes=await apifyMod.getDirectViaApify(pageUrl, selected.quality||'best');
                const res=await smartFetchFinal(apifyRes.directUrl);
                if(!res.ok) throw new Error(`Apify MP4 ${res.status}`);
                const outDir=actualTmpDir||os.tmpdir();
                const outPath=path.join(outDir,`ep-${Date.now().toString(36)}-${selected.quality}p-apify.mp4`);
                const file=fs.createWriteStream(outPath);
                const stream=Readable.fromWeb(res.body);
                await new Promise((resolve,reject)=>{ stream.pipe(file); file.on('finish',resolve); file.on('error',reject); });
                return outPath;
            }catch(e2){
                console.log('[eporner] Apify fallback also fail:',e2.message);
                throw new Error(`Direct fail: ${e.message} | Apify fail: ${e2.message} | Fix: set residential proxy via .setproxy http://user:pass@host:port or EPORNER_RELAY_URL`);
            }
        }
        throw new Error(`${e.message} | Fix: residential proxy needed - .setproxy http://user:pass@residential:port (datacenter proxy won't work) or set EPORNER_RELAY_URL to external relay`);
    }
}

module.exports={ search, getById, parseDownloadLinks, getDirectSources, getFinalMp4Url, smartFetchFinal, downloadVideo, human, calcHash, extractHash, smartFetchWrapper, getRelayUrl };
