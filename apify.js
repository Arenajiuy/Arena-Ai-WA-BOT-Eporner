/**
 * Apify Eporner Bulk Downloader integration
 * Uses serpxxx~eporner-bulk-video-downloader actor
 */
const fs = require('fs');
const path = require('path');

const SETTINGS = path.join(__dirname, 'settings.json');
function loadSettings(){ try{ return JSON.parse(fs.readFileSync(SETTINGS,'utf8')); }catch{ return {}; } }

function getToken(){
    return process.env.APIFY_TOKEN || process.env.APIFY_API_TOKEN || loadSettings().apify || '';
}

async function getDirectViaApify(videoUrl, preferredQuality='best'){
    const token=getToken();
    if(!token) throw new Error('Apify token නෑ - .setkey apify <token> දාන්න හෝ APIFY_TOKEN env දාන්න https://console.apify.com/account/integrations');
    
    const input={
        urls: [videoUrl],
        preferredQuality: preferredQuality==='best' ? 'best' : `${preferredQuality}p`,
        downloadFiles: false,
        useApifyProxy: true,
        maxItems: 1
    };
    
    const endpoint=`https://api.apify.com/v2/acts/serpxxx~eporner-bulk-video-downloader/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`;
    
    const res=await fetch(endpoint,{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify(input)
    });
    
    if(!res.ok){
        const txt=await res.text().catch(()=> '');
        throw new Error(`Apify ${res.status}: ${txt.slice(0,300)}`);
    }
    
    const data=await res.json();
    if(!Array.isArray(data) || !data.length) throw new Error('Apify returned no items');
    
    const item=data[0];
    // Expected fields: directVideoUrl, selectedFormat, availableFormats, status, errorMessage
    if(item.errorMessage) throw new Error(`Apify error: ${item.errorMessage}`);
    if(!item.directVideoUrl) throw new Error('Apify directVideoUrl නෑ - '+JSON.stringify(item).slice(0,500));
    
    return {
        directUrl: item.directVideoUrl,
        title: item.title,
        duration: item.duration,
        thumbnail: item.thumbnailUrl,
        selectedFormat: item.selectedFormat,
        availableFormats: item.availableFormats,
        storedFileUrl: item.storedFileUrl,
        raw: item
    };
}

async function searchViaApify(query, maxItems=5, preferredQuality='best'){
    const token=getToken();
    if(!token) throw new Error('Apify token නෑ');
    
    const input={
        searchQuery: query,
        maxItems,
        preferredQuality,
        downloadFiles: false,
        useApifyProxy: true
    };
    
    const endpoint=`https://api.apify.com/v2/acts/serpxxx~eporner-bulk-video-downloader/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`;
    
    const res=await fetch(endpoint,{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify(input)
    });
    
    if(!res.ok){
        const txt=await res.text().catch(()=> '');
        throw new Error(`Apify search ${res.status}: ${txt.slice(0,300)}`);
    }
    
    const data=await res.json();
    return data;
}

module.exports={ getToken, getDirectViaApify, searchViaApify };
