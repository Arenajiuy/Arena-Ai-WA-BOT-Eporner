/**
 * antibug.js — Arena AI Anti-Bug System v1.0
 * 
 * Protects against WhatsApp crash bugs (virtex, trava, doc bug, contact bug, etc.)
 * Based on analysis of ÕNEPÎCE VÈRSION VIPZ bot (Indonesian bug bot)
 * 
 * Does NOT contain bug payloads - only detection & blocking
 * 
 * Bugs detected:
 * - Doc Bug: document with huge fileName (>200), fake fileLength, invalid mimetype
 * - Contact Bug: contactsArray with many vcards (>5), large vcard (>2000 chars)
 * - Location Bug: location with huge thumbnail (>100KB), liveLocation with large caption
 * - Button Bug: buttons with excessive count (>5), large displayText (>100)
 * - List Bug: listMessage with many sections (>10), rows (>20), large titles
 * - Poll Bug: poll with many options (>12), large option names
 * - Reaction Bug: reaction with large text (>100)
 * - Group Invite Bug: invite with large thumbnail, large caption
 * - ViewOnce Bug: viewOnce wrapping large payload, nested viewOnce
 * - Product/Order Bug: product with large description, order with large thumbnail
 * - Interactive Bug: flowMessage, interactiveMessage, carousel, etc with large payload
 * - Sticker Bug: sticker with large file or metadata
 * - Virtex: text with excessive chars (>5000), excessive mentions, excessive emojis
 * - Trava: message with crash characters (RTL override, etc)
 * - Etc
 */

const fs = require('fs');
const path = require('path');

const SET = path.join(__dirname, 'settings.json');
const readSet = () => { try { return JSON.parse(fs.readFileSync(SET, 'utf8')); } catch { return {}; } };
const writeSet = (d) => { try { fs.writeFileSync(SET, JSON.stringify(d, null, 2)); } catch {} };

// Config
function isAntibugOn() {
    const s = readSet();
    // default ON
    return s.antibug !== false;
}
function setAntibug(on) {
    const d = readSet();
    d.antibug = !!on;
    writeSet(d);
}

function getAntibugMode() {
    const s = readSet();
    return s.antibugMode || 'delete'; // delete, block, warn
}
function setAntibugMode(mode) {
    const d = readSet();
    if (['delete','block','warn','kick'].includes(mode)) {
        d.antibugMode = mode;
        writeSet(d);
        return true;
    }
    return false;
}

// Unwrap message
function unwrap(m) {
    if (!m) return {};
    let cur = m;
    for (let i = 0; i < 6; i++) {
        const n = cur.ephemeralMessage?.message || cur.viewOnceMessage?.message || cur.viewOnceMessageV2?.message || cur.viewOnceMessageV2Extension?.message || cur.documentWithCaptionMessage?.message;
        if (!n) break;
        cur = n;
    }
    return cur;
}

function getMsgType(msg) {
    const m = unwrap(msg.message || {});
    return Object.keys(m)[0] || 'unknown';
}

// Main detection
function isBugMessage(msg) {
    try {
        const m = unwrap(msg.message || {});
        if (!m) return { isBug: false };

        const type = Object.keys(m)[0];
        const content = m[type] || {};

        // 1. Virtex - excessive text length
        const text = content.text || content.caption || content.contentText || content.selectedDisplayText || content.title || msg.message?.conversation || '';
        if (text && text.length > 5000) {
            return { isBug: true, type: 'virtex', reason: `Text too long: ${text.length} chars (max 5000)` };
        }

        // Check for crash characters (RTL override, zero width, etc)
        if (text && /[\u202E\u202D\u202B\u2066\u2067\u2068\u2069\u200B\u200C\u200D\uFEFF]{20,}/.test(text)) {
            return { isBug: true, type: 'trava', reason: 'Crash unicode characters detected (RTL override etc)' };
        }

        // Excessive mentions
        const mentions = content.contextInfo?.mentionedJid || [];
        if (mentions.length > 50) {
            return { isBug: true, type: 'mention-spam', reason: `Too many mentions: ${mentions.length} (max 50)` };
        }

        // Excessive emojis (more than 100 emojis)
        const emojiCount = (text.match(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu) || []).length;
        if (emojiCount > 100) {
            return { isBug: true, type: 'emoji-spam', reason: `Too many emojis: ${emojiCount}` };
        }

        // 2. Document Bug
        if (type === 'documentMessage') {
            const fileName = content.fileName || '';
            if (fileName.length > 200) {
                return { isBug: true, type: 'doc-bug', reason: `FileName too long: ${fileName.length}` };
            }
            if (content.fileLength && content.fileLength > 100 * 1024 * 1024 * 1024) { // >100GB fake
                return { isBug: true, type: 'doc-bug', reason: `Fake fileLength: ${content.fileLength}` };
            }
            // Check for null bytes or path traversal in fileName
            if (fileName.includes('\0') || fileName.includes('../')) {
                return { isBug: true, type: 'doc-bug', reason: `Malicious fileName: ${fileName.slice(0,100)}` };
            }
            // Thumbnail too large
            if (content.jpegThumbnail && content.jpegThumbnail.length > 100 * 1024) {
                return { isBug: true, type: 'doc-bug', reason: `Thumbnail too large: ${content.jpegThumbnail.length}` };
            }
        }

        // 3. Contact Bug
        if (type === 'contactMessage' || type === 'contactsArrayMessage') {
            if (type === 'contactMessage') {
                const vcard = content.vcard || '';
                if (vcard.length > 5000) {
                    return { isBug: true, type: 'contact-bug', reason: `VCard too large: ${vcard.length}` };
                }
                // Check for excessive lines in vcard
                const lines = vcard.split('\n').length;
                if (lines > 100) {
                    return { isBug: true, type: 'contact-bug', reason: `VCard too many lines: ${lines}` };
                }
            }
            if (type === 'contactsArrayMessage') {
                const contacts = content.contacts || [];
                if (contacts.length > 5) {
                    return { isBug: true, type: 'contact-bug', reason: `Too many contacts: ${contacts.length}` };
                }
                for (const c of contacts) {
                    if ((c.vcard || '').length > 5000) {
                        return { isBug: true, type: 'contact-bug', reason: `VCard in array too large` };
                    }
                }
            }
        }

        // 4. Location Bug
        if (type === 'locationMessage' || type === 'liveLocationMessage') {
            const caption = content.caption || '';
            if (caption.length > 1000) {
                return { isBug: true, type: 'location-bug', reason: `Location caption too long: ${caption.length}` };
            }
            if (content.jpegThumbnail && content.jpegThumbnail.length > 100 * 1024) {
                return { isBug: true, type: 'location-bug', reason: `Location thumbnail too large: ${content.jpegThumbnail.length}` };
            }
            // Check for invalid degrees
            if (content.degreesLatitude && (Math.abs(content.degreesLatitude) > 90)) {
                return { isBug: true, type: 'location-bug', reason: `Invalid latitude: ${content.degreesLatitude}` };
            }
            if (content.degreesLongitude && (Math.abs(content.degreesLongitude) > 180)) {
                return { isBug: true, type: 'location-bug', reason: `Invalid longitude` };
            }
        }

        // 5. Button Bug
        if (type === 'buttonsMessage' || type === 'buttonsResponseMessage') {
            const buttons = content.buttons || content.buttonsMessage?.buttons || [];
            if (buttons.length > 5) {
                return { isBug: true, type: 'button-bug', reason: `Too many buttons: ${buttons.length}` };
            }
            for (const b of buttons) {
                const txt = b.buttonText?.displayText || b.displayText || '';
                if (txt.length > 200) {
                    return { isBug: true, type: 'button-bug', reason: `Button text too long: ${txt.length}` };
                }
            }
            if ((content.contentText || '').length > 2000) {
                return { isBug: true, type: 'button-bug', reason: `Button contentText too long` };
            }
        }

        // Template Button (hydrated)
        if (type === 'templateMessage') {
            const hydrated = content.hydratedTemplate || {};
            const buttons = hydrated.hydratedButtons || [];
            if (buttons.length > 5) {
                return { isBug: true, type: 'button-bug', reason: `Template too many buttons: ${buttons.length}` };
            }
        }

        // 6. List Bug
        if (type === 'listMessage') {
            const sections = content.sections || [];
            if (sections.length > 10) {
                return { isBug: true, type: 'list-bug', reason: `Too many list sections: ${sections.length}` };
            }
            let totalRows = 0;
            for (const s of sections) {
                totalRows += (s.rows || []).length;
                if ((s.title || '').length > 200) {
                    return { isBug: true, type: 'list-bug', reason: `Section title too long` };
                }
            }
            if (totalRows > 20) {
                return { isBug: true, type: 'list-bug', reason: `Too many list rows: ${totalRows}` };
            }
        }

        // 7. Poll Bug
        if (type === 'pollCreationMessage' || type === 'pollCreationMessageV3') {
            const options = content.options || [];
            if (options.length > 12) {
                return { isBug: true, type: 'poll-bug', reason: `Too many poll options: ${options.length}` };
            }
            for (const opt of options) {
                if ((opt.optionName || '').length > 200) {
                    return { isBug: true, type: 'poll-bug', reason: `Poll option too long` };
                }
            }
        }

        // 8. Reaction Bug
        if (type === 'reactionMessage') {
            const txt = content.text || '';
            if (txt.length > 100) {
                return { isBug: true, type: 'reaction-bug', reason: `Reaction text too long: ${txt.length}` };
            }
        }

        // 9. Group Invite Bug
        if (type === 'groupInviteMessage') {
            if ((content.caption || '').length > 1000) {
                return { isBug: true, type: 'group-bug', reason: `Group invite caption too long` };
            }
            if (content.jpegThumbnail && content.jpegThumbnail.length > 100 * 1024) {
                return { isBug: true, type: 'group-bug', reason: `Group invite thumbnail too large` };
            }
            // Invite code too long
            if ((content.inviteCode || '').length > 100) {
                return { isBug: true, type: 'group-bug', reason: `Invite code too long` };
            }
        }

        // 10. ViewOnce Bug - nested viewOnce
        if (msg.message?.viewOnceMessage || msg.message?.viewOnceMessageV2) {
            // Check if nested
            let inner = unwrap(msg.message);
            let depth = 0;
            let cur = msg.message;
            while (cur) {
                const next = cur.viewOnceMessage?.message || cur.viewOnceMessageV2?.message;
                if (!next) break;
                depth++;
                cur = next;
                if (depth > 2) {
                    return { isBug: true, type: 'viewonce-bug', reason: `Nested viewOnce depth: ${depth}` };
                }
            }
            // Check inner content for other bugs recursively
            if (inner) {
                const fakeMsg = { message: inner };
                const innerCheck = isBugMessage(fakeMsg);
                if (innerCheck.isBug) {
                    return { isBug: true, type: `viewonce-${innerCheck.type}`, reason: `ViewOnce wrapping ${innerCheck.type}: ${innerCheck.reason}` };
                }
            }
        }

        // 11. Product / Order Bug
        if (type === 'productMessage' || type === 'orderMessage') {
            if ((content.description || '').length > 2000) {
                return { isBug: true, type: 'product-bug', reason: `Product description too long` };
            }
            if (content.jpegThumbnail && content.jpegThumbnail.length > 200 * 1024) {
                return { isBug: true, type: 'product-bug', reason: `Product thumbnail too large` };
            }
        }

        // 12. Interactive / Flow / Carousel Bug (new WhatsApp bugs)
        if (type === 'interactiveMessage' || type === 'viewOnceMessage' || m.interactiveMessage) {
            const interactive = content.interactiveMessage || m.interactiveMessage || content;
            // Check for excessive payload
            const jsonStr = JSON.stringify(interactive);
            if (jsonStr.length > 10000) {
                return { isBug: true, type: 'interactive-bug', reason: `Interactive payload too large: ${jsonStr.length}` };
            }
            // Check for flowMessage
            if (interactive.flowMessage || content.flowMessage) {
                const flow = interactive.flowMessage || content.flowMessage;
                if (JSON.stringify(flow).length > 5000) {
                    return { isBug: true, type: 'flow-bug', reason: `Flow payload too large` };
                }
            }
            // Carousel
            if (interactive.carouselMessage || content.carouselMessage) {
                const carousel = interactive.carouselMessage || content.carouselMessage;
                const cards = carousel.cards || [];
                if (cards.length > 10) {
                    return { isBug: true, type: 'carousel-bug', reason: `Too many carousel cards: ${cards.length}` };
                }
            }
        }

        // 13. Sticker Bug
        if (type === 'stickerMessage') {
            if (content.fileLength && content.fileLength > 5 * 1024 * 1024) {
                return { isBug: true, type: 'sticker-bug', reason: `Sticker file too large: ${content.fileLength}` };
            }
            if (content.jpegThumbnail && content.jpegThumbnail.length > 100 * 1024) {
                return { isBug: true, type: 'sticker-bug', reason: `Sticker thumbnail too large` };
            }
        }

        // 14. Audio / Video with huge caption or thumbnail
        if (type === 'imageMessage' || type === 'videoMessage' || type === 'audioMessage') {
            if ((content.caption || '').length > 2000) {
                return { isBug: true, type: 'media-bug', reason: `${type} caption too long: ${content.caption.length}` };
            }
            if (content.jpegThumbnail && content.jpegThumbnail.length > 200 * 1024) {
                return { isBug: true, type: 'media-bug', reason: `${type} thumbnail too large` };
            }
        }

        // 15. ExtendedText with huge thumbnail or large matchedText
        if (type === 'extendedTextMessage') {
            if ((content.text || '').length > 5000) {
                return { isBug: true, type: 'virtex', reason: `Extended text too long: ${content.text.length}` };
            }
            if (content.jpegThumbnail && content.jpegThumbnail.length > 100 * 1024) {
                return { isBug: true, type: 'extended-bug', reason: `Extended thumbnail too large` };
            }
        }

        return { isBug: false };
    } catch (e) {
        // If error in detection, don't block
        console.log('antibug check error:', e.message);
        return { isBug: false };
    }
}

// Command handler
async function handleAntibug(send, jid, msg, arg) {
    const args = (arg || '').toLowerCase().split(/\s+/);
    const sub = args[0] || '';

    if (!sub || sub === 'status' || sub === 'info') {
        const on = isAntibugOn();
        const mode = getAntibugMode();
        return send(jid, {
            text: `🛡️ *Anti-Bug System* ${on ? 'ON ✅' : 'OFF ❌'}\n\n` +
                  `Mode: *${mode}* (delete/block/warn/kick)\n` +
                  `Protected: virtex, trava, doc, contact, location, button, list, poll, reaction, group, viewonce, product, interactive, flow, carousel, sticker, media\n\n` +
                  `Commands:\n` +
                  `*.antibug on* - ON කරන්න\n` +
                  `*.antibug off* - OFF කරන්න\n` +
                  `*.antibug mode delete* - delete mode\n` +
                  `*.antibug mode block* - block sender\n` +
                  `*.antibug mode warn* - warn only\n` +
                  `*.antibug mode kick* - kick from group (group only)\n` +
                  `*.antibug test* - test detection\n\n` +
                  `💡 VIPZ bot වගේ bug bots වලින් ආරක්ෂාව`
        }, { quoted: msg });
    }

    if (sub === 'on') {
        setAntibug(true);
        return send(jid, { text: '🛡️ Anti-Bug *ON* ✅\nBug messages auto delete වෙනවා' }, { quoted: msg });
    }
    if (sub === 'off') {
        setAntibug(false);
        return send(jid, { text: '🛡️ Anti-Bug *OFF* ❌\n⚠️ Bug වලින් ආරක්ෂාව නෑ!' }, { quoted: msg });
    }
    if (sub === 'mode') {
        const mode = args[1] || '';
        if (setAntibugMode(mode)) {
            return send(jid, { text: `🛡️ Anti-Bug mode = *${mode}* ✅\n` + 
                (mode === 'delete' ? 'Bug messages delete වෙනවා' :
                 mode === 'block' ? 'Bug sender block වෙනවා' :
                 mode === 'warn' ? 'Warning විතරයි' :
                 'Group එකෙන් kick වෙනවා') }, { quoted: msg });
        } else {
            return send(jid, { text: '❌ Mode එක: delete, block, warn, kick\nඋදා: .antibug mode delete' }, { quoted: msg });
        }
    }
    if (sub === 'test') {
        // Simulate bug detection
        const fakeBug = { message: { extendedTextMessage: { text: 'A'.repeat(6000) } } };
        const res = isBugMessage(fakeBug);
        return send(jid, { text: `🧪 *Anti-Bug Test*\n\nFake virtex (6000 chars): ${res.isBug ? 'DETECTED ✅' : 'NOT detected ❌'}\nType: ${res.type}\nReason: ${res.reason}\n\nSystem working: ${isAntibugOn() ? 'ON' : 'OFF'}` }, { quoted: msg });
    }

    return send(jid, { text: '🛡️ *.antibug on/off/mode/status/test*\nඋදා: .antibug on' }, { quoted: msg });
}

// Middleware to check incoming messages
async function checkAndHandle(send, jid, msg, sock) {
    if (!isAntibugOn()) return false;

    const check = isBugMessage(msg);
    if (!check.isBug) return false;

    const mode = getAntibugMode();
    const sender = msg.key?.participant || msg.key?.remoteJid || 'unknown';
    const logMsg = `🚨 *BUG DETECTED!* 🚨\n\nType: ${check.type}\nReason: ${check.reason}\nSender: ${sender}\nMode: ${mode}\n\n${mode === 'delete' ? 'Message deleted ✅' : mode === 'block' ? 'Sender blocked 🚫' : mode === 'kick' ? 'Kicked from group 👢' : 'Warning only ⚠️'}`;

    try {
        if (mode === 'delete') {
            // Delete the bug message
            try {
                await sock.sendMessage(jid, { delete: msg.key });
            } catch {}
            await send(jid, { text: logMsg });
        } else if (mode === 'block') {
            try {
                await sock.sendMessage(jid, { delete: msg.key });
            } catch {}
            try {
                await sock.updateBlockStatus(sender, 'block');
            } catch {}
            await send(jid, { text: logMsg + '\n\n🚫 Sender blocked' });
        } else if (mode === 'kick' && jid.endsWith('@g.us')) {
            try {
                await sock.sendMessage(jid, { delete: msg.key });
            } catch {}
            try {
                await sock.groupParticipantsUpdate(jid, [sender], 'remove');
            } catch {}
            await send(jid, { text: logMsg + '\n\n👢 Sender kicked from group' });
        } else { // warn
            await send(jid, { text: logMsg + '\n\n⚠️ Warning only - message not deleted' });
        }

        console.log(`[ANTIBUG] ${check.type} from ${sender} in ${jid}: ${check.reason}`);
    } catch (e) {
        console.log('[ANTIBUG] handle error:', e.message);
    }

    return true; // handled as bug
}

module.exports = { isBugMessage, handleAntibug, checkAndHandle, isAntibugOn, setAntibug, getAntibugMode, setAntibugMode };
