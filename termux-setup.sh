#!/data/data/com.termux/files/usr/bin/bash
# Arena AI - Termux setup (එක පාරක් run කරන්න):  bash termux-setup.sh
echo "=== 1/2  Termux update + Node.js ==="
yes | pkg update
yes | pkg upgrade
pkg install -y nodejs-lts || { echo "❌ fail - 'termux-change-repo' run කරලා වෙන mirror එකක් තෝරලා ආයෙත් try කරන්න"; exit 1; }
pkg install -y yt-dlp ffmpeg || echo "⚠️ yt-dlp / ffmpeg install වුණේ නෑ — .song .video .s වැඩ කරන්නේ නෑ (පස්සේ: pkg install yt-dlp ffmpeg)"
echo "=== 2/2  bot packages ==="
cd "$(dirname "$0")"
npm install --legacy-peer-deps --no-audit --no-fund || { echo "❌ npm install fail - screenshot එකක් ගන්න"; exit 1; }
echo ""
echo "✅ Setup DONE!   දැන් bot එක start කරන්න:   npm start"
