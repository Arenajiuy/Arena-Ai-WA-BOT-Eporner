/**
 * .ai — free AI chat (Google Gemini + Groq). Keys are stored in settings.json
 * (set them from WhatsApp:  .setkey gemini <KEY>   /   .setkey groq <KEY>)
 */
const fs = require('fs');
const path = require('path');

const SETTINGS = path.join(__dirname, 'settings.json');
const loadSettings = () => { try { return JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch { return {}; } };
const saveSettings = (s) => fs.writeFileSync(SETTINGS, JSON.stringify(s, null, 2));

const GEMINI_MODELS = ['gemini-flash-latest', 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-flash-lite-latest'];
const GROQ_MODELS = ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'llama-3.1-8b-instant'];

const SYSTEM = `You are "Arena AI", a helpful assistant inside the user's private WhatsApp.
- Reply in the same language the user writes in (Sinhala → Sinhala, English → English, Singlish → Sinhala/Singlish).
- Be clear and fairly short (WhatsApp). Use simple formatting: *bold*, _italic_, lists with • .
- If you don't know or are not sure, say so honestly. Never invent facts.
- You are powered by free models (Google Gemini / Groq). If asked, say so honestly.`;

const history = new Map(); // chat jid -> [{role:'user'|'assistant', text}]
const MAX_TURNS = 10;

function getKeys() {
    const s = loadSettings();
    return { gemini: process.env.GEMINI_API_KEY || s.gemini || '', groq: process.env.GROQ_API_KEY || s.groq || '', apify: process.env.APIFY_TOKEN || process.env.APIFY_API_TOKEN || s.apify || '' };
}

function setKey(provider, key) {
    const s = loadSettings();
    if (key) s[provider] = key; else delete s[provider];
    saveSettings(s);
}

function apiError(provider, status, body) {
    let msg = '';
    try { const j = JSON.parse(body); msg = j.error?.message || j.message || ''; } catch { msg = String(body).slice(0, 200); }
    const e = new Error(`${provider} ${status}: ${msg}`);
    e.status = status;
    e.modelMissing = status === 404 || /not found|does not exist|decommissioned|not supported/i.test(msg);
    return e;
}

async function askGemini(key, msgs) {
    let lastErr;
    for (const model of GEMINI_MODELS) {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
            body: JSON.stringify({
                systemInstruction: { parts: [{ text: SYSTEM }] },
                contents: msgs.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.text }] })),
                generationConfig: { maxOutputTokens: 2048, temperature: 0.7 }
            })
        });
        const body = await r.text();
        if (!r.ok) { lastErr = apiError('Gemini', r.status, body); if (lastErr.modelMissing) continue; throw lastErr; }
        const j = JSON.parse(body);
        const text = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
        if (!text) throw new Error('Gemini empty answer (' + (j.candidates?.[0]?.finishReason || j.promptFeedback?.blockReason || '?') + ')');
        return { text, model: 'Gemini ' + model };
    }
    throw lastErr;
}

async function askGroq(key, msgs) {
    let lastErr;
    for (const model of GROQ_MODELS) {
        const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
            body: JSON.stringify({
                model, temperature: 0.7, max_tokens: 2048,
                messages: [{ role: 'system', content: SYSTEM }, ...msgs.map(m => ({ role: m.role, content: m.text }))]
            })
        });
        const body = await r.text();
        if (!r.ok) { lastErr = apiError('Groq', r.status, body); if (lastErr.modelMissing) continue; throw lastErr; }
        const text = (JSON.parse(body).choices?.[0]?.message?.content || '').trim();
        if (!text) throw new Error('Groq empty answer');
        return { text, model: 'Groq ' + model };
    }
    throw lastErr;
}

/** Markdown → WhatsApp formatting */
function toWhatsApp(t) {
    return t
        .replace(/<think>[\s\S]*?<\/think>/g, '')
        .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
        .replace(/\*\*(.+?)\*\*/g, '*$1*')
        .replace(/__(.+?)__/g, '_$1_')
        .replace(/^\s*[-*]\s+/gm, '• ')
        .trim();
}

/** ask with memory; tries Gemini then Groq */
async function ask(chatId, question) {
    const keys = getKeys();
    if (!keys.gemini && !keys.groq) {
        const e = new Error('NO_KEY');
        e.noKey = true;
        throw e;
    }
    const h = history.get(chatId) || [];
    const msgs = [...h, { role: 'user', text: question }];
    const errors = [];
    for (const [name, fn] of [['gemini', askGemini], ['groq', askGroq]]) {
        if (!keys[name]) continue;
        try {
            const res = await fn(keys[name], msgs);
            const text = toWhatsApp(res.text);
            h.push({ role: 'user', text: question }, { role: 'assistant', text });
            while (h.length > MAX_TURNS * 2) h.shift();
            history.set(chatId, h);
            return { text, model: res.model };
        } catch (e) { errors.push(e.message); }
    }
    throw new Error(errors.join('\n'));
}

function reset(chatId) { history.delete(chatId); }

function splitLong(text, size = 3500) {
    const parts = [];
    while (text.length > size) {
        let cut = text.lastIndexOf('\n', size);
        if (cut < size * 0.5) cut = size;
        parts.push(text.slice(0, cut));
        text = text.slice(cut).trimStart();
    }
    if (text) parts.push(text);
    return parts;
}

module.exports = { ask, reset, setKey, getKeys, splitLong, toWhatsApp, _history: history };
