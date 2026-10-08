'use strict';
/**
 * mirror.js v2.19 - CDN block bypass with residential proxy + relay
 * File එකක් transfer.archivete.am එකට upload කරලා direct link එකක් ගන්නවා.
 * Uses net.js smartFetch for proxy support (residential proxy for eporner CDN)
 */

const fs = require('fs');
const { Readable } = require('stream');

let netMod = null;
try { netMod = require('./net'); } catch {}

const TRANSFER = process.env.MIRROR_HOST || 'https://transfer.archivete.am';

async function uploadTransfer(filePath, name) {
    const safe = encodeURIComponent(String(name || 'file.bin').replace(/[^\w.\-() ]+/g, '_').slice(0, 120));
    const body = Readable.toWeb(fs.createReadStream(filePath));
    
    // Use smartFetch if available for proxy support
    const fetchFn = netMod && netMod.smartFetch ? netMod.smartFetch : fetch;
    
    const res = await fetchFn(TRANSFER + '/' + safe, {
        method: 'PUT',
        body,
        duplex: 'half',
        headers: { 'Content-Type': 'application/octet-stream' },
    });
    if (!res.ok) throw new Error(`Transfer upload HTTP ${res.status} (site එක limit එකක් වෙන්න පුළුවන්)`);
    const link = (await res.text()).trim();
    if (!/^https?:\/\//.test(link)) throw new Error('Transfer upload: unexpected response');
    return link;
}

module.exports = { uploadTransfer, TRANSFER };
