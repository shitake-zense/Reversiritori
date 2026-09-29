// Rebuild from MeCab IPAdic's Noun.csv only. Run: npm run dictionary:build
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const revision = "61b90ba6e669dc2d7d533d4a80d206f3b31d52b1";
const base = `https://raw.githubusercontent.com/taku910/mecab/${revision}/mecab-ipadic/`;
const source = process.argv[2];
const csv = source ? await readFile(source, "utf8") :
  new TextDecoder("euc-jp").decode(await (await fetch(base + "Noun.csv")).arrayBuffer());

function fields(line) {
  const out = []; let current = "", quote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quote && line[i + 1] === '"') { current += '"'; i++; }
      else quote = !quote;
    } else if (ch === "," && !quote) { out.push(current); current = ""; }
    else current += ch;
  }
  out.push(current);
  return out;
}
function hiragana(s) {
  return [...s.normalize("NFC")].map(ch => {
    const n = ch.codePointAt(0);
    return n >= 0x30a1 && n <= 0x30f6 ? String.fromCodePoint(n - 0x60) : ch;
  }).join("");
}
const disallowed = /[ぁぃぅぇぉゃゅょっゎーん]$/u;
const words = new Set();
for (const line of csv.split(/\r?\n/)) {
  if (!line) continue;
  const c = fields(line);
  // IPAdic: surface, ids/cost, part of speech, POS subtype, ..., reading.
  if (c[4] !== "名詞" || c[5] !== "一般") continue;
  const word = hiragana(c[11] || "");
  if (!/^[ぁ-んゔー]{2,4}$/u.test(word) || disallowed.test(word) || /^[ぁぃぅぇぉゃゅょっゎー]/u.test(word)) continue;
  // The reading is the playable spelling. Reject readings with isolated long marks.
  if (word.includes("ーー")) continue;
  words.add(word);
}
const list = [...words].sort();
await mkdir(join(root, "src", "data"), { recursive: true });
await writeFile(join(root, "src", "data", "words.json"), JSON.stringify(list));
const counts = Object.fromEntries([...new Set(list.map(w => w[0]))].sort().map(ch => [ch, list.filter(w => w[0] === ch).length]));
await writeFile(join(root, "src", "data", "dictionary-stats.json"), JSON.stringify({ source: "MeCab IPAdic Noun.csv, 名詞/一般", revision, count: list.length, byFirst: counts }, null, 2) + "\n");
if (!source) {
  const license = await (await fetch(base + "COPYING")).text();
  await mkdir(join(root, "public"), { recursive: true });
  await writeFile(join(root, "public", "IPADIC-COPYING.txt"), license);
}
console.log(`Noun.csv common noun readings: ${list.length}`);
console.log(counts);
