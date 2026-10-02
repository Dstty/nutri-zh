/* 从汉字全息数据集生成 Web 查询索引。
 *
 * 产出(asset/):
 *   chars.txt.gz  单字: 字\t笔画码串\t权重
 *   words.bin.gz  词流 + 块级首字倒排(见下)
 *   meta.json     元信息
 *
 * words.bin 布局(小端):
 *   uint32 wordCount
 *   uint32 streamLength        // 以 UTF-16 码元计, 与 JS 字符串索引一致
 *   uint32 blockCount
 *   uint32 blockSize           // 每块词数
 *   uint32 charCount           // 字符表大小
 *   uint32 charTableOffset     // 字符表在流中的起点(每个字符 1 码元)
 *   uint32 blockIndexOffset
 *   uint32 streamOffset
 *   ... blockIndex: 每块 1 字节 n + n*2 字节 charId ...
 *   ... stream: 所有词按序拼接的 UTF-16 码元
 *
 * 词序: 先按词长升序, 同长度内按频次降序。
 *   这样最高频的词集中在流前部, 短词优先, 且同长度词连续 ——
 *   与 Nutrimatic「先看常见解」的行为一致。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const SRC = process.env.HZ_SRC || join(REPO, '..');
const OUT = join(REPO, 'asset');

const BLOCK_SIZE = 1024;

// 笔画名 -> 单字符编码。'折' 为几何反推的泛化名。
const STROKE_NAMES = [
  '横', '竖', '撇', '点', '捺', '提',
  '横折', '竖钩', '竖弯', '竖弯钩', '竖提', '撇折', '撇点', '弯钩',
  '横折钩', '横斜钩', '横折提', '横撇', '横折折', '横折折撇',
  '横折折折', '竖折折钩', '横折折折钩', '斜钩', '竖折撇', '折',
];
const STROKE_CODE = new Map(STROKE_NAMES.map((n, i) => [n, String.fromCharCode(33 + i)]));

function loadJsonl(path) {
  const out = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim()) out.push(JSON.parse(line));
  }
  return out;
}

/**
 * 汇总词表: 优先用现成的 data/wordlist.tsv; 缺失时从 rime 词库源构建。
 *
 * rime dict.yaml 正文格式: 词 <TAB> 拼音 <TAB> 权重
 * essay.txt 格式:          词 <TAB> 权重
 */
function buildWordlist() {
  const tsv = join(REPO, 'data', 'wordlist.tsv');
  if (existsSync(tsv)) {
    console.log(`  词表 < ${tsv}`);
    return;
  }
  console.log('  未找到 data/wordlist.tsv, 尝试从 rime 词库构建 ...');
  const sources = [
    join(SRC, 'data', 'essay.txt'),
    join(SRC, 'data', 'rime_ice_base.dict.yaml'),
    join(SRC, 'data', 'rime_ice_ext.dict.yaml'),
  ];
  const best = new Map();
  for (const path of sources) {
    if (!existsSync(path)) { console.log(`    [skip] ${path}`); continue; }
    let n = 0;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line || line.startsWith('#')) continue;
      const parts = line.split('\t');
      const word = (parts[0] || '').trim();
      if (!word || word.length > 10 || /[\t\r\n]/.test(word)) continue;
      if (!/^[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+$/.test(word)) continue;
      let freq = 0;
      for (let i = parts.length - 1; i >= 1; i--) {
        const v = Number(parts[i]);
        if (Number.isFinite(v) && /^\d+$/.test(parts[i].trim())) { freq = v; break; }
      }
      const prev = best.get(word);
      if (prev === undefined || freq > prev) best.set(word, freq);
      n++;
    }
    console.log(`    ${path.split(/[\\/]/).pop()}: ${n} 行 -> 累计 ${best.size} 词`);
  }
  if (best.size === 0) {
    console.log('  [warn] 未能构建词表, 将退回到由单字记录反推');
    return;
  }
  const out = [...best.entries()]
    .sort((a, b) => (b[1] - a[1]) || (a[0].length - b[0].length) || a[0].localeCompare(b[0]));
  mkdirSync(join(REPO, 'data'), { recursive: true });
  writeFileSync(tsv, out.map(([w, f]) => `${w}\t${f}`).join('\n'), 'utf8');
  console.log(`  已写出 ${tsv} (${out.length} 词)`);
}

function buildWords(full) {
  buildWordlist();
  const wlPath = join(REPO, 'data', 'wordlist.tsv');
  const seen = new Set();
  let list = [];
  if (existsSync(wlPath)) {
    for (const line of readFileSync(wlPath, 'utf8').split('\n')) {
      if (!line) continue;
      const tab = line.indexOf('\t');
      const w = tab < 0 ? line : line.slice(0, tab);
      const freq = tab < 0 ? 0 : Number(line.slice(tab + 1)) || 0;
      if (!w || w.length > 10 || seen.has(w)) continue;
      seen.add(w);
      list.push([w, freq]);
    }
    console.log(`  载入 ${list.length} 词`);
  } else {
    for (const r of full) {
      for (const w of r.words || []) {
        if (w.length >= 2 && w.length <= 8 && !seen.has(w)) {
          seen.add(w);
          list.push([w, 1]);
        }
      }
    }
    console.log(`  [warn] 回退到字记录反推, ${list.length} 词`);
  }
  // 单字补齐(保证字模式可查)
  const have = new Set(list.map((x) => x[0]));
  for (const r of full) {
    if (!have.has(r.char)) {
      have.add(r.char);
      list.push([r.char, 0]);
    }
  }
  // 词长升序 -> 频次降序: 高频词集中在前部, 扫描可提前出结果
  list.sort((a, b) => (a[0].length - b[0].length) || (b[1] - a[1]) || a[0].localeCompare(b[0]));
  return list;
}

function main() {
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

  console.log('读取数据集 ...');
  const full = loadJsonl(join(SRC, 'hz_full.jsonl'));
  const commonSet = new Set(loadJsonl(join(SRC, 'hz_common.jsonl')).map((r) => r.char));
  console.log(`  全量 ${full.length} 字, 常用 ${commonSet.size} 字`);

  // ---- 1. 单字表: 字 \t 笔画码串 \t 权重 \t 拼音 ----
  const charLines = [];
  let strokeMiss = 0;
  let pyMissing = 0;
  for (const r of full) {
    let code = '';
    for (const name of r.stroke_seq || []) {
      const c = STROKE_CODE.get(name);
      if (c) code += c; else { code += '?'; strokeMiss++; }
    }
    let w = (commonSet.has(r.char) ? 100000 : 0) + (r.words || []).length * 10;
    const py = (r.pinyin && r.pinyin[0]) || '';
    if (!py) pyMissing++;
    charLines.push(`${r.char}\t${code}\t${w}\t${py}`);
  }
  writeFileSync(join(OUT, 'chars.txt.gz'),
    gzipSync(Buffer.from(charLines.join('\n'), 'utf8'), { level: 9 }));
  console.log(`  chars.txt.gz  ${charLines.length} 字 (缺拼音 ${pyMissing})`);

  // ---- 2. 词流 + 块级倒排 ----
  const words = buildWords(full);
  const stream = [];            // 词流(码元)
  const bounds = new Uint32Array(words.length + 1);
  const charToId = new Map();
  const charTable = [];

  for (let i = 0; i < words.length; i++) {
    bounds[i] = stream.length;
    const w = words[i][0];
    for (const ch of w) {
      stream.push(ch.charCodeAt(0));
      if (!charToId.has(ch)) {
        charToId.set(ch, charTable.length);
        charTable.push(ch.charCodeAt(0));
      }
    }
  }
  bounds[words.length] = stream.length;

  // 每块记录首字字符集(用于用正则首字符快速跳过无关块)
  const blockCount = Math.ceil(words.length / BLOCK_SIZE);
  const blockChars = new Uint8Array(blockCount * 256);
  for (let b = 0; b < blockCount; b++) {
    const from = b * BLOCK_SIZE;
    const to = Math.min(from + BLOCK_SIZE, words.length);
    const ids = new Set();
    for (let i = from; i < to; i++) {
      const id = charToId.get(words[i][0]);
      if (id !== undefined) ids.add(id);
    }
    const base = b * 256;
    let n = 0;
    for (const id of ids) {
      if (n >= 255) break;
      blockChars[base + 1 + n * 2] = id & 0xff;
      blockChars[base + 2 + n * 2] = (id >> 8) & 0xff;
      n++;
    }
    blockChars[base] = n;
  }

  // 序列化
  const streamLen = stream.length;
  const streamBytes = Buffer.alloc(streamLen * 2);
  for (let i = 0; i < streamLen; i++) streamBytes.writeUInt16LE(stream[i], i * 2);
  const charTableBytes = Buffer.alloc(charTable.length * 2);
  for (let i = 0; i < charTable.length; i++) charTableBytes.writeUInt16LE(charTable[i], i * 2);
  const boundsBytes = Buffer.from(bounds.buffer, bounds.byteOffset, bounds.byteLength);
  const blockBytes = Buffer.from(blockChars.buffer, blockChars.byteOffset, blockChars.byteLength);

  const HEAD = 32;
  const charTableOffset = HEAD + boundsBytes.length;
  const blockIndexOffset = charTableOffset + charTableBytes.length;
  const streamOffset = blockIndexOffset + blockBytes.length;

  const head = Buffer.alloc(HEAD);
  head.writeUInt32LE(words.length, 0);
  head.writeUInt32LE(streamLen, 4);
  head.writeUInt32LE(blockCount, 8);
  head.writeUInt32LE(BLOCK_SIZE, 12);
  head.writeUInt32LE(charTable.length, 16);
  head.writeUInt32LE(charTableOffset, 20);
  head.writeUInt32LE(blockIndexOffset, 24);
  head.writeUInt32LE(streamOffset, 28);

  const bin = Buffer.concat([head, boundsBytes, charTableBytes, blockBytes, streamBytes]);
  writeFileSync(join(OUT, 'words.bin.gz'), gzipSync(bin, { level: 9 }));
  console.log(`  words.bin.gz  ${words.length} 词, ${blockCount} 块, 字符表 ${charTable.length}`);
  console.log(`    未压缩 ${(bin.length / 1048576).toFixed(2)}MB`);

  // ---- 3. 元信息 ----
  const meta = {
    chars: charLines.length,
    words: words.length,
    streamLength: streamLen,
    blockCount,
    blockSize: BLOCK_SIZE,
    charCount: charTable.length,
    strokeNames: STROKE_NAMES,
    builtAt: new Date().toISOString(),
  };
  writeFileSync(join(OUT, 'meta.json'), JSON.stringify(meta, null, 2));
  if (strokeMiss) console.log(`  [warn] 未识别笔画名 ${strokeMiss} 处`);
  console.log('完成');
}

main();
