Arena AI v2.3 — ඔයාට විතරක් වැඩ කරන WhatsApp bot එක (AI + Downloader)
=====================================================================
Commands ("Message yourself" chat එකේ ගහන්න):
  .ai <ප්‍රශ්නය>             AI එකෙන් අහන්න (සිංහල OK). කලින් කතාව මතක තියාගන්නවා (පණිවිඩ 10ක්)
  (message එකකට reply කරලා) .ai   → ඒ message එක ගැන පැහැදිලි කරනවා / translate කරනවා
  .ai reset                  කතාව අලුතෙන් පටන් ගන්න
  .download <link>           file එක download කරලා document එකක් විදියට එවනවා (.dl / .dn)
  .setkey gemini <KEY>       Gemini free key දාන්න   (key message එක auto මැකෙනවා)
  .setkey groq <KEY>         Groq free key දාන්න
  .keys                      keys තියෙනවද බලන්න      .delkey gemini|groq  → key මකන්න
  .ping / .help

AI ගැන ඇත්ත: උත්තර දෙන්නේ Google Gemini / Groq free models (Arena.ai agent එක නෙවෙයි).
Gemini fail වුණොත් Groq එකට auto මාරු වෙනවා. Free limits ඉවර වුණොත් ටිකකින් ආයෙත් try කරන්න.

Free keys:
  Gemini → https://aistudio.google.com/apikey   (Google account → Create API key)
  Groq   → https://console.groq.com/keys        (login → Create API Key)

Download support: direct links, GitHub, Google Drive (public), MediaFire, MEGA, Dropbox, Pixeldrain,
litterbox/catbox, x0.at, transfer.archivete.am, filebin. (gofile / LimeWire / folders support නෑ). Max 2 GB.

🔒 Private: ඔයා යවන messages විතරයි. වෙන අය commands යැව්වත් ignore.

v2.12.2 — 🔒 ආරක්ෂාව + 📨 Agent messages
  • WhatsApp library එක (libsignal) encryption keys panel console එකට print කළා → දැන් ඒවා පේන්නේ නෑ
  • Arena agent ට panel එකේ agent-msg.txt file එකක් ලියලා ඔයාගේ "Message yourself" chat එකට message යවන්න පුළුවන්
    (bot එක තත්පර 5 කට සැරයක් බලනවා, යැව්වට පස්සේ file එක මකනවා)

v2.12.1 — 📦 ලොකු files (2 GB දක්වා)
  • Panel එකේ පරණ 350 MB limit එක අයින් කළා → දැන් 2000 MB (WhatsApp එකෙන් යවන්න පුළුවන් උපරිමය ≈ 2 GB)
  • 100 MB ට ලොකු files disk එකේ save නොකර කෙලින්ම WhatsApp එකට stream වෙනවා → disk එක 2× නෙවෙයි 1× විතරයි
  • .maxmb  → දැන් limit එක + disk free     .maxmb 1000 / .maxmb 2gb → වෙනස් කරන්න (max 2000)
  • Disk එකේ ඉඩ මදි නම් download එක පටන් ගන්න කලින්ම පැහැදිලි error එකක්
  ⚠️ 2 GB ට ලොකු (6 GB වගේ) files WhatsApp එකෙන් යවන්න බෑ — ඒක WhatsApp limit එකක්

v2.12 — 🛠️ TOOLS update (Knightbot-MD bot එකේ ideas, අපේම code එකෙන් ස්ථාවර free APIs වලින්)
  🌐 .tr <භාෂාව> <text>  → translate (message එකකට reply කරලා .tr si) — si en ta hi ja ko ...
  🗣️ .tts <text>  → voice note (සිංහල auto)      🌍 .weather <නගරය>  → කාලගුණය + දින 3
  🎤 .lyrics <සින්දුව>      🎨 .imagine <විස්තරය>  → AI image (සිංහලෙනුත් ලියන්න පුළුවන්)
  🖼️ .toimg (sticker reply) → photo      🔗 .tourl (media reply) → download link
  📸 .ss <website>  •  🔳 .qr <text>  •  ✂️ .short <link>  •  🧮 .calc (25+15)*3 / 15% of 2000
  🐙 .github <user>  •  🗑️ .del (reply → message එක මකනවා, ඕනෑම chat එකක)  •  .setpp (photo → profile)
  🎉 .joke  •  .fact (+සිංහල)  •  .quote  •  .8ball <ප්‍රශ්නය>
  👥 Group: .mute  .unmute  .tagadmins  .resetlink
  Menu: categories 13 (6 = Tools, 7 = Fun)
  Credit: command ideas — Knightbot-MD by mruniquehacker (MIT). Code එක අලුතෙන් ලිව්වේ.

v2.11 — 🚀 SUPER update (abc repo එකේ SmokeBoy bot එකෙන් ගත්ත features)
  🎬 .yts <නම>  •  .song <නම/link> (audio)  •  .video <නම/link> (720p→360p)
  📱 .tiktok (watermark නෑ)  •  .fb  •  .ig  •  .x   <link>
  🔍 .wiki <මාතෘකාව>  (.wiki si ... = සිංහල)   🐙 .gitclone user/repo → zip
  🖼️ .s = photo/video → sticker (video තත්පර 6)  •  .take Pack | Author
  👥 Group (ඔයා group එකේ ගැහුවොත්): .groupinfo .grouplink .tagall .kick .promote .demote .jid
  🔄 .restart
  • Panel: පළමු .song/.video/.s එකේදී yt-dlp (40MB) + ffmpeg (80MB) auto download වෙනවා (විනාඩියක් විතර).
  • Termux: pkg install yt-dlp ffmpeg   (termux-setup.sh එක දැන් ඒකත් කරනවා)
  • YouTube සමහර server IPs වලට "bot check" දානවා — එහෙම වුණොත් bot එක පැහැදිලිව කියනවා.

v2.10 — 📋 ලස්සන .menu + ✨ auto react
  • .menu — photo + BOT INFO box (version, uptime, RAM, host) + categories 6.
    Number එක reply කරන්න (උදා 1 = Download) → ඒ category එකේ commands.  .help = full list.
  • Commands ගහද්දී random emoji react එකක් (⚡🔥✨🚀...).  .react off / .react on

v2.9 — 🖼️ ලස්සන online card එක (photo + කෙටි status)
  • Bot start වුණාම / .update එකෙන් පස්සේ photo එකක් එක්ක පොඩි card එකක් එනවා.  .alive = ඕනෑම වෙලාවක බලන්න.
  • .setlogo — ඔයාගේ photo එක Message yourself chat එකට යවලා ඒකට reply කරලා .setlogo ගහන්න (update වලින් මැකෙන්නේ නෑ).
  • .dellogo — default Arena AI banner එකට ආපහු.

v2.8 — 🔒 සම්පූර්ණ Safe mode + 🛡️ Anti-ban
  • Commands පාවිච්චි කරන්න පුළුවන් ඔයාට විතරයි (fromMe + sender double check). වෙන කෙනෙක් ගැහුවොත් reply එකක්වත් නෑ.
  • Default: "Message yourself" chat එකේ විතරයි වැඩ.  .mode all = ඔයා ඕනෑම chat එකක ගහන commands වැඩ.
  • Anti-ban: විනාඩියට commands 10 / පැයට 120 limit, reply කලින් පොඩි human delay, messages එකින් එක යවනවා,
    reconnect backoff (3s→5min), ban (403) වුණොත් / වෙන තැනක එකම bot එක run වුණොත් (440) නවතිනවා,
    "online" message පැය 6 කට එක පාරයි, download එකකට links 5 යි, එක පාරට download එකයි.
  • API keys / proxy password console log එකේ පේන්නේ නෑ. Panel status page එකේ number එක පේන්නේ නෑ.
  ⚠️ කිසිම bot එකක් 100% ban-proof නෑ — spam නොකර, එක instance එකක් විතරක් run කරන්න.

v2.7 — IPv6 route: CDN එකක් server එකේ IPv4 block කළොත් මුළු download chain එකම IPv6 එකෙන් ආයෙත් try කරනවා
  (server එකට IPv6 තියෙනවා නම්). .net එකේ Server IPv6 + hop එකට IPv6 TCP test පෙන්නනවා.

v2.6 — Block වෙන sites fix:
  • Download එකක් network error එකකින් fail වුණොත් bot එක ඉබේම DNS-over-HTTPS (1.1.1.1/8.8.8.8) එකෙන් ආයෙත් try කරනවා
    (server එකේ ISP/රට DNS block කරනවා නම් ඒක පනිනවා). වැඩ කරපු route එක මතක තියාගන්නවා.
  • .net <link> — server එකෙන් ඒ site එකට යන්න පුළුවන්ද, DNS block ද IP block ද කියලා report එකක්.
  • .setproxy http://user:pass@host:port — IP block වෙන sites වලට proxy (off: .setproxy off).

v2.5 — Updates දැන් එන්නේ අලුත් repo එකෙන්: https://github.com/matheeshasanjana83-alt/Arena-Ai-WA-BOT
  (.update / .version ඒ විදියටම. Panel එකේත් වැඩ — launcher එක bot එක auto restart කරනවා.)

v2.4 — Server/panel (HeavenCloud) support:
  index.js = panel entry (npm start එකමයි). Panel එකේ temp files server disk එකේ (.tmp), file limit 350MB.
  Phone number එක settings.json එකේ "phone" විදියටත් දාන්න පුළුවන්. Panel zip: Arena-AI-panel.zip (files root එකේ).

v2.3 fix: bot එකේ replies phone එකේ "Waiting for this message" කියලා පෙන්නපු එක.
  Baileys v7 self-chat messages වලට device/LID jid එකක් (35189...:0@lid) දෙනවා; ඒකට reply කළාම phone එකට decrypt
  කරන්න බෑ. දැන් self-chat replies හැම වෙලාවෙම ඔයාගේ phone-number JID (94...@s.whatsapp.net) එකට යනවා.

v2.2 — .update command:
  .update          GitHub (matheeshasanjana83-alt/abc → arena-ai-bot/) එකෙන් අලුත් files අරන් auto restart.
                   auth/ (WhatsApp link) + settings.json (API keys) කවදාවත් වෙනස් කරන්නේ නෑ → pair කරන්න ඕනේ නෑ.
  .update force    එකම version එක ආයෙත් install කරන්න
  .version         දැන් version එක + update තියෙනවද
  • අලුත් files වල error එකක් තිබ්බොත් install කරන්නේම නෑ. Install වුණාට පස්සේ crash වුණොත් පරණ version එකට auto rollback.
  • Auto restart වෙන්න bot එක *npm start* එකෙන් start කරන්න ඕනේ (launcher.js).

v2.1 fix (commands වැඩ නොකළ ප්‍රශ්නය):
  • Baileys 6.7 (legacy) → 7.0.0-rc14. WhatsApp LID ක්‍රමයට මාරු වුණු නිසා 6.7 ට ඔයාගේ phone එකෙන් එන
    messages decrypt කරන්න බැරි වුණා ("Bad MAC") → commands bot එකට පේන්නේ නෑ. v7 එකේ LID support තියෙනවා.
    (6.7 delivery ACKs යවනවා — WhatsApp ban කරනවා කියලා Baileys docs කියනවා; v7 යවන්නේ නෑ)
  • 'append' type messages ද process කරනවා, getMessage retry fix ("Waiting for this message"), online msg එක එක පාරයි.
  • 6.7 session එක v7 එකට පාවිච්චි කරන්න එපා → auth folder එක මකලා අලුතෙන් pair කරන්න.

Update (පරණ version එකෙන්):
  WhatsApp → Linked devices → පරණ bot device එක Log out කරන්න
  cd ~ && curl -L -o Arena-AI.zip https://raw.githubusercontent.com/matheeshasanjana83-alt/abc/main/downloads/Arena-AI.zip && unzip -o Arena-AI.zip
  cd ~/Arena-AI && rm -rf auth node_modules package-lock.json && npm install --legacy-peer-deps && npm start

Termux setup:
  pkg install -y curl unzip
  cd ~ && curl -L -o Arena-AI.zip https://raw.githubusercontent.com/matheeshasanjana83-alt/abc/main/downloads/Arena-AI.zip && unzip -o Arena-AI.zip
  cd ~/Arena-AI && bash termux-setup.sh
  termux-wake-lock
  npm start
ආයෙත් start:  cd ~/Arena-AI && termux-wake-lock && npm start
Re-pair:       cd ~/Arena-AI && rm -rf auth && npm start
Test:          npm test
