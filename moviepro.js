/**
 * moviepro.js — Arena MoviePro v2.0 (Own style, no Asitha)
 * 
 * Flow (our own):
 * 1. .moviepro <query> → search anime/movies (Jikan + TVMaze)
 * 2. Reply number → details + episodes/seasons list
 * 3. Reply episode number → quality options (1080p/720p/480p/360p) + subtitles
 * 4. Reply quality → download via Arena downloader
 * 
 * No Asitha.top, no YouTube channel, own API style
 * Uses Jikan API for anime, TVMaze for series, plus mock for movies
 */

const cache = new Map();
const detailCache = new Map();
const qualityCache = new Map();

function setCache(jid, data) {
    cache.set(jid, data);
    cache.set(jid.split('@')[0], data);
}
function getCache(jid) {
    return cache.get(jid) || cache.get(jid.split('@')[0]);
}
function setDetailCache(jid, data) {
    detailCache.set(jid, data);
    detailCache.set(jid.split('@')[0], data);
}
function getDetailCache(jid) {
    return detailCache.get(jid) || detailCache.get(jid.split('@')[0]);
}
function setQualityCache(jid, data) {
    qualityCache.set(jid, data);
    qualityCache.set(jid.split('@')[0], data);
}
function getQualityCache(jid) {
    return qualityCache.get(jid) || qualityCache.get(jid.split('@')[0]);
}

async function searchAnime(query) {
    try {
        const res = await fetch(`https://api.jikan.moe/v4/anime?q=${encodeURIComponent(query)}&limit=15&sfw=true&order_by=popularity&sort=desc`, {
            headers: { 'User-Agent': 'ArenaAI/2.22' }
        });
        if (!res.ok) throw new Error(`Jikan ${res.status}`);
        const json = await res.json();
        return (json.data || []).map(a => ({
            id: a.mal_id,
            title: a.title_english || a.title || 'Unknown',
            year: a.year || a.aired?.prop?.from?.year || 'N/A',
            episodes: a.episodes || 0,
            score: a.score || 'N/A',
            type: a.type || 'TV',
            status: a.status || 'Unknown',
            image: a.images?.jpg?.large_image_url || a.images?.jpg?.image_url || '',
            synopsis: a.synopsis || 'No synopsis available',
            genres: (a.genres || []).map(g => g.name).join(' • ') || 'Anime',
            source: 'jikan',
            url: a.url || ''
        }));
    } catch (e) {
        console.log('[moviepro] jikan fail', e.message);
        return [];
    }
}

async function searchTVMaze(query) {
    try {
        const res = await fetch(`https://api.tvmaze.com/search/shows?q=${encodeURIComponent(query)}`, {
            headers: { 'User-Agent': 'ArenaAI/2.22' }
        });
        if (!res.ok) throw new Error(`TVMaze ${res.status}`);
        const json = await res.json();
        return (json || []).slice(0,15).map(item => {
            const s = item.show;
            return {
                id: s.id,
                title: s.name || 'Unknown',
                year: s.premiered ? s.premiered.split('-')[0] : 'N/A',
                episodes: 0,
                score: s.rating?.average || 'N/A',
                type: s.type || 'Series',
                status: s.status || 'Unknown',
                image: s.image?.original || s.image?.medium || '',
                synopsis: (s.summary || '').replace(/<[^>]*>/g, '').slice(0,500) || 'No synopsis',
                genres: (s.genres || []).join(' • ') || 'Series',
                source: 'tvmaze',
                url: s.url || ''
            };
        });
    } catch (e) {
        console.log('[moviepro] tvmaze fail', e.message);
        return [];
    }
}

async function search(query) {
    const [anime, tv] = await Promise.all([
        searchAnime(query),
        searchTVMaze(query)
    ]);
    
    const isAnime = /black clover|naruto|one piece|bleach|demon slayer|jujutsu|anime|aot|attack on titan/i.test(query);
    let results = isAnime ? [...anime, ...tv] : [...tv, ...anime];
    
    // Deduplicate
    const seen = new Set();
    const deduped = [];
    for (const r of results) {
        const key = r.title.toLowerCase();
        if (!seen.has(key)) {
            seen.add(key);
            deduped.push(r);
        }
        if (deduped.length >= 15) break;
    }
    
    if (deduped.length === 0) {
        // Fallback mock
        return [
            { id: 1, title: `${query} - Season 1`, year: '2024', episodes: 24, score: '8.0', type: 'TV', status: 'Ongoing', image: '', synopsis: `Results for ${query}`, genres: 'Action • Adventure', source: 'mock' },
            { id: 2, title: `${query} - Movie`, year: '2023', episodes: 1, score: '7.5', type: 'Movie', status: 'Finished', image: '', synopsis: `Movie version of ${query}`, genres: 'Action', source: 'mock' }
        ];
    }
    
    return deduped.slice(0,15);
}

async function getEpisodes(animeId, source = 'jikan') {
    if (source === 'jikan') {
        try {
            const res = await fetch(`https://api.jikan.moe/v4/anime/${animeId}/episodes`, {
                headers: { 'User-Agent': 'ArenaAI/2.22' }
            });
            if (!res.ok) throw new Error(`Eps ${res.status}`);
            const json = await res.json();
            return (json.data || []).map(e => ({
                id: e.mal_id,
                title: e.title || `Episode ${e.mal_id}`,
                number: e.mal_id,
                aired: e.aired || 'N/A'
            }));
        } catch (e) {
            console.log('[moviepro] episodes fail', e.message);
            return [];
        }
    }
    if (source === 'tvmaze') {
        try {
            const res = await fetch(`https://api.tvmaze.com/shows/${animeId}/episodes`, {
                headers: { 'User-Agent': 'ArenaAI/2.22' }
            });
            if (!res.ok) throw new Error(`TVMaze eps ${res.status}`);
            const json = await res.json();
            return (json || []).map(e => ({
                id: e.id,
                title: e.name || `Episode ${e.number}`,
                number: e.number,
                season: e.season
            }));
        } catch (e) {
            return [];
        }
    }
    return [];
}

function formatSearchResults(query, results) {
    let txt = `🎬 *Arena MoviePro Search*\n\n`;
    txt += `🔍 *Query:* ${query}\n`;
    txt += `📊 *Found:* ${results.length} results\n\n`;
    txt += `┌─ *SELECT* ─┐\n`;
    results.forEach((r, i) => {
        txt += `│ ${i+1}. *${r.title}* ${r.year !== 'N/A' ? `(${r.year})` : ''}\n`;
        txt += `│   ${r.type} • ${r.score} ⭐ • ${r.episodes ? r.episodes + ' eps' : r.status}\n`;
    });
    txt += `└───────────┘\n\n`;
    txt += `💡 Reply *number* (1-${results.length}) to view details\n`;
    txt += `🔥 *Arena AI v2.22 MoviePro*\n`;
    txt += `⚡ Powered by Jikan + TVMaze API`;
    return txt;
}

function formatDetails(anime, episodes) {
    let txt = `🎬 *${anime.title}*\n\n`;
    txt += `📅 *Year:* ${anime.year || 'N/A'}\n`;
    txt += `⏱️ *Episodes:* ${anime.episodes || episodes.length || 'N/A'}\n`;
    txt += `⭐ *Score:* ${anime.score || 'N/A'}\n`;
    txt += `🎭 *Genres:* ${anime.genres || 'N/A'}\n`;
    txt += `📺 *Type:* ${anime.type || 'TV'}\n`;
    txt += `📊 *Status:* ${anime.status || 'Unknown'}\n\n`;
    txt += `📝 *Synopsis:*\n${(anime.synopsis || '').slice(0,500)}\n\n`;
    txt += `┌─ *EPISODES* ─┐\n`;
    
    if (episodes.length > 0) {
        const display = episodes.slice(0, 50); // Show first 50 to avoid too long
        display.forEach((ep, i) => {
            if (i === 0) {
                txt += `│ ${i+1}. 📦 *All Episodes* (Season 1)\n`;
            } else {
                txt += `│ ${i+1}. E${ep.number || i} - ${(ep.title || '').slice(0,40)}\n`;
            }
        });
        if (episodes.length > 50) {
            txt += `│ ... +${episodes.length - 50} more episodes\n`;
            txt += `│ ${display.length+1}. 📦 *All Episodes* (Season 2)\n`;
        }
    } else {
        const total = anime.episodes || 24;
        for (let i = 1; i <= Math.min(total, 20); i++) {
            if (i === 1) txt += `│ ${i}. 📦 *All Episodes* (Season 1)\n`;
            else txt += `│ ${i}. Episode ${i-1}\n`;
        }
        if (total > 20) txt += `│ ... ${total} total episodes\n`;
    }
    
    txt += `└───────────┘\n\n`;
    txt += `💡 Reply *number* to select episode/season\n`;
    txt += `🔥 *Arena MoviePro v2.22*\n`;
    txt += `⚡ Use .moviepro for new search`;
    return txt;
}

function formatQualityOptions(season, episode, anime) {
    let txt = `📦 *Download Options - ${anime.title}*\n\n`;
    txt += `🎬 *Season:* ${season}\n`;
    txt += `🎞️ *Episode:* ${episode === 'all' ? 'All Episodes' : 'Episode ' + (episode.number || episode)}\n\n`;
    txt += `┌─ *QUALITY* ─┐\n`;
    txt += `│ 1. 🎥 1080p Full HD\n`;
    txt += `│ 2. 🎥 720p HD\n`;
    txt += `│ 3. 🎥 480p SD\n`;
    txt += `│ 4. 🎥 360p Mobile\n`;
    txt += `└───────────┘\n\n`;
    txt += `┌─ *SUBTITLES* ─┐\n`;
    txt += `│ 5. 🇱🇰 Sinhala\n`;
    txt += `│ 6. 🇬🇧 English\n`;
    txt += `│ 7. 🇮🇳 Hindi\n`;
    txt += `│ 8. 🇪🇸 Spanish\n`;
    txt += `│ 9. 🇫🇷 French\n`;
    txt += `│ 10. 🇸🇦 Arabic\n`;
    txt += `│ 11. 🇧🇩 Bangla\n`;
    txt += `│ 12. 🇮🇩 Indonesian\n`;
    txt += `│ 13. 🇲🇾 Malay\n`;
    txt += `│ 14. 🇵🇹 Portuguese\n`;
    txt += `│ 15. 🇷🇺 Russian\n`;
    txt += `└───────────┘\n\n`;
    txt += `💡 Reply *number* (1-15) to download\n`;
    txt += `🔥 *Arena MoviePro v2.22*\n`;
    txt += `⚡ Fast download via Arena AI`;
    return txt;
}

module.exports = {
    search,
    getEpisodes,
    formatSearchResults,
    formatDetails,
    formatQualityOptions,
    setCache,
    getCache,
    setDetailCache,
    getDetailCache,
    setQualityCache,
    getQualityCache,
    cache,
    detailCache,
    qualityCache
};
