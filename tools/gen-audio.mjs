#!/usr/bin/env node
/* Tạo file mp3 cho mọi thứ web đọc lên (từ vựng, mẫu câu, từng đoạn câu, từng từ của trò xếp câu,
   tên chữ cái, âm phonics /b/ /æ/…) bằng Azure Neural TTS, lưu vào audio/ cùng danh mục audio/index.js.

   Cách dùng (chạy ở thư mục gốc của repo, cần Node 18+):
     AZURE_SPEECH_KEY=xxxx AZURE_SPEECH_REGION=southeastasia node tools/gen-audio.mjs
   Tùy chọn:
     --voice en-US-AvaNeural   đổi giọng (mặc định en-US-AnaNeural — giọng bé gái Mỹ)
     --force                   tạo lại cả những file đã có (ví dụ sau khi đổi giọng)
     --only "/b/|bear"         chỉ tạo lại những mục khớp biểu thức này (dùng để nghe thử, chỉnh âm)
     --list                    chỉ in danh sách sẽ tạo, không gọi Azure
   Chạy lại bất cứ lúc nào sau khi thêm từ/câu vào index.html: file đã có sẽ được giữ nguyên. */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "audio");
const args = process.argv.slice(2);
const opt = k => { const i = args.indexOf(k); return i < 0 ? null : args[i + 1]; };
const VOICE = opt("--voice") || "en-US-AnaNeural";
const FORCE = args.includes("--force"), LIST = args.includes("--list");
const ONLY = opt("--only") ? new RegExp(opt("--only"), "i") : null;

/* Lấy dữ liệu bài học thẳng từ index.html (phần trước "Tiện ích") để không phải khai báo hai nơi */
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const dataJs = html.match(/<script>([\s\S]*?)\/\* -+ Tiện ích/)[1];
const { UNITS, SG_UNITS, SG_LETTERS } = vm.runInNewContext(dataJs + ";({ UNITS, SG_UNITS, SG_LETTERS })");

// Phải giống hệt akey() trong index.html
const akey = s => String(s).toLowerCase().replace(/\s+/g, " ").replace(/^[\s.,!?]+|[\s.,!?]+$/g, "");
const xml = s => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
// Ký hiệu âm trong sách → IPA cho Azure (sách viết /e/ cho âm e ngắn, chuẩn IPA là ɛ)
const IPA = { "/e/": "ɛ" };

const items = [], keys = new Set(), names = new Set();
function add(text, body, name) {
  const key = akey(text);
  if (!key || keys.has(key)) return;
  keys.add(key);
  let base = name || key.replace(/'/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "x";
  for (let n = 2; names.has(base); n++) base = base.replace(/-\d+$/, "") + "-" + n;
  names.add(base);
  items.push({ key, text, body: body || xml(text), file: base + ".mp3" });
}

// Tên chữ cái đứng trước để "a" (đứng một mình) được đọc là chữ A
for (const l of SG_LETTERS) add(l.L.toUpperCase(), `<say-as interpret-as="characters">${l.L.toUpperCase()}</say-as>`, "letter-" + l.L);
for (const t of ["Good try!", "Great job!", "Excellent!"]) add(t);
// Âm phonics: c và k cùng /k/ nên chỉ một file
for (const l of SG_LETTERS) {
  const ipa = IPA[l.snd] || l.snd.replace(/\//g, "");
  add(l.snd, `<prosody rate="-10%"><phoneme alphabet="ipa" ph="${xml(ipa)}">${l.L}</phoneme></prosody>`, "sound-" + l.L);
}
const sents = [...UNITS, ...SG_UNITS].flatMap(u => u.sents.map(s => s[0]));
for (const u of [...UNITS, ...SG_UNITS]) for (const w of u.words) add(w[0]);
for (const s of sents) add(s);
// Trò xếp câu đọc từng đoạn câu và từng từ khi bé chạm vào thẻ từ
const segs = sents.flatMap(s => s.split(/(?<=[.?!])\s+/));
for (const s of segs) add(s);
for (const s of segs) for (const w of s.split(" ")) add(w.replace(/[.,!?]+$/, ""));

const todo = items.filter(it => (FORCE || ONLY || !fs.existsSync(path.join(outDir, it.file))) && (!ONLY || ONLY.test(it.text)));
console.log(`${items.length} mục, cần tạo ${todo.length} (${todo.reduce((n, it) => n + it.text.length, 0)} ký tự), giọng ${VOICE}`);
if (LIST) { for (const it of todo) console.log(`  ${it.file.padEnd(40)} ${it.text}`); process.exit(0); }

const KEY = process.env.AZURE_SPEECH_KEY, REGION = process.env.AZURE_SPEECH_REGION;
if (todo.length && (!KEY || !REGION)) {
  console.error("Thiếu AZURE_SPEECH_KEY hoặc AZURE_SPEECH_REGION (lấy ở Azure Portal → Speech service → Keys and Endpoint).");
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function tts(it) {
  const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US"><voice name="${VOICE}">${it.body}</voice></speak>`;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`https://${REGION}.tts.speech.microsoft.com/cognitiveservices/v1`, {
      method: "POST",
      headers: { "Ocp-Apim-Subscription-Key": KEY, "Content-Type": "application/ssml+xml", "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3", "User-Agent": "be-on-english" },
      body: ssml,
    });
    if (res.ok) return Buffer.from(await res.arrayBuffer());
    // Gói miễn phí F0 giới hạn số lần gọi mỗi phút: chờ rồi thử lại
    if ((res.status === 429 || res.status >= 500) && attempt < 10) {
      const wait = (+res.headers.get("retry-after") || 0) * 1000 || 3000 * attempt;
      process.stdout.write(` (chờ ${Math.round(wait / 1000)}s)`);
      await sleep(wait); continue;
    }
    throw new Error(`Azure trả về ${res.status} cho "${it.text}": ${await res.text()}`);
  }
}
let done = 0;
for (const it of todo) {
  fs.writeFileSync(path.join(outDir, it.file), await tts(it));
  process.stdout.write(`\r${++done}/${todo.length} ${it.text.slice(0, 50).padEnd(50)}`);
}
if (todo.length) process.stdout.write("\n");

// Danh mục chỉ ghi những file thật sự có, để web biết khi nào phải dùng giọng trình duyệt
const map = Object.fromEntries(items.filter(it => fs.existsSync(path.join(outDir, it.file))).map(it => [it.key, it.file]));
fs.writeFileSync(path.join(outDir, "index.js"), `// Tự sinh bởi tools/gen-audio.mjs (${VOICE}) — đừng sửa tay\nwindow.AUDIO_FILES = ${JSON.stringify(map, null, 0).replace(/","/g, '",\n"')};\n`);
console.log(`Xong. audio/index.js có ${Object.keys(map).length} file.`);
