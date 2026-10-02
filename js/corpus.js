/* 数据加载与搜索引擎。
 *
 * 数据格式见 tools/build_index.mjs。
 * 搜索策略:
 *   1. 从模式解析出可接受的「首字符集合」, 用块级倒排跳过无关块
 *   2. 命中的块内逐词用 NFA 位并行匹配
 *   3. 分片推进(每片限时), 边扫边出结果, 不阻塞 UI
 *   4. 结果流式按权重降序插入, 只保留前 N 条
 */

import { compilePattern } from './regex.js';

async function gunzip(url, doFetch = (u) => fetch(u)) {
  const res = await doFetch(url);
  if (!res.ok) throw new Error(`加载失败 ${url}: HTTP ${res.status}`);
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const stream = res.body.pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const decoder = new TextDecoder('utf-8');

export class Corpus {
  constructor() {
    this.meta = null;
    this.chars = new Map();   // 字 -> {strokes, weight}
    this.words = [];          // 词流: 按词长升序, 同长按频次降序
    this.bounds = null;       // Uint32Array, 词边界
    this.charIds = new Map(); // 字符 -> id
    this.blockChars = null;   // 每块字符 id 集合
    this.blockCount = 0;
    this.blockSize = 0;
  }

  /**
   * 浏览器默认加载路径: fetch + DecompressionStream。
   *
   * opts.gunzip 可注入自定义解压(测试环境用), 默认走浏览器流式解压。
   * opts.fetch 可注入取数实现。
   */
  static async load(base = 'asset/', opts = {}) {
    const doFetch = opts.fetch || ((u) => fetch(u));
    const unzip = opts.gunzip || ((u) => gunzip(u, doFetch));
    const [meta, charsGz, wordsGz] = await Promise.all([
      doFetch(base + 'meta.json').then((r) => r.json()),
      unzip(base + 'chars.txt.gz'),
      unzip(base + 'words.bin.gz'),
    ]);
    return buildCorpus(meta, charsGz, wordsGz);
  }

  get wordCount() { return this.bounds.length - 1; }

  wordAt(i) {
    return String.fromCharCode.apply(
      null, this.words.subarray(this.bounds[i], this.bounds[i + 1]));
  }

  /** 块 b 是否可能包含以 charSet 中任一字符开头的词。 */
  blockMayContain(b, charIds) {
    if (!charIds) return true;
    const base = b * 256;
    const n = this.blockChars[base];
    for (let i = 0; i < n; i++) {
      const id = this.blockChars[base + 1 + i * 2] | (this.blockChars[base + 2 + i * 2] << 8);
      if (charIds.has(id)) return true;
    }
    return false;
  }
}

// ---------------- 查询解析 ----------------

/* 查询语法:
 *   模式        默认搜词(2 字及以上)
 *   .           任意单字符
 *   [中猫狗]     字符类
 *   {n} {n,m}   限定词长
 *   G模式       加 G 前缀则同时搜单字
 *
 * 示例: .国 | [东西南北]风 | .{2} | G. | ^中 | ^..$
 */
export function parseQuery(raw) {
  let s = String(raw ?? '').trim();
  let includeChars = false;
  if (s.startsWith('G')) { includeChars = true; s = s.slice(1); }

  let minLen = includeChars ? 1 : 2;
  let maxLen = 10;

  // 剥离词长限定 {n} / {n,m} / {n,} / {,m}
  s = s.replace(/\{(\d*)(,?)(\d*)\}/g, (m, a, comma, b) => {
    if (!comma) {
      const n = Number(a);
      if (!Number.isNaN(n)) { minLen = Math.max(1, n); maxLen = n; }
      return '';
    }
    if (a) minLen = Math.max(1, Number(a));
    if (b) maxLen = Number(b);
    return '';
  });

  let anchoredStart = false;
  let anchoredEnd = false;
  if (s.startsWith('^')) { anchoredStart = true; s = s.slice(1); }
  if (s.endsWith('$') && !s.endsWith('\\$')) { anchoredEnd = true; s = s.slice(0, -1); }

  if (!s) s = '.';
  return { pattern: s, minLen, maxLen, anchoredStart, anchoredEnd, includeChars, raw };
}

/**
 * 流式搜索。返回一个可迭代的分片执行器。
 * onBatch(items) 每片回调; 返回 {done} 或继续。
 */
export function createSearch(corpus, query) {
  const q = parseQuery(query);
  let regex;
  try {
    regex = compilePattern(q.pattern);
  } catch (err) {
    return { error: err, query: q };
  }

  const wantStart = q.anchoredStart;
  const wantEnd = q.anchoredEnd;
  const charSet = wantStart ? regex.startChars() : null;
  const startIds = charSet
    ? new Set([...charSet].filter((c) => corpus.charIds.has(c)).map((c) => corpus.charIds.get(c)))
    : null;

  const scanner = {
    query: q,
    regex,
    /** 扫描第 [fromBlock, toBlock) 块, 结果追加到 collector。 */
    scanBlocks(fromBlock, toBlock, collector) {
      for (let b = fromBlock; b < toBlock; b++) {
        if (startIds && !corpus.blockMayContain(b, startIds)) continue;
        const from = b * corpus.blockSize;
        const to = Math.min(from + corpus.blockSize, corpus.wordCount);
        for (let i = from; i < to; i++) {
          const len = corpus.bounds[i + 1] - corpus.bounds[i];
          if (len < q.minLen || len > q.maxLen) continue;
          const word = corpus.wordAt(i);
          const hit = matchWord(regex, word, wantStart, wantEnd);
          if (hit) collector.push({ i, len, pos: hit });
        }
      }
    },
  };
  return scanner;
}

function matchWord(regex, word, wantStart, wantEnd) {
  if (!word) return null;
  if (wantStart && wantEnd) return regex.test(word) ? [0, word.length] : null;
  // 允许前缀/后缀: 用 search 找一个区间, 再按锚点约束
  const found = wantStart
    ? (regex.test(word) || prefixMatch(regex, word) ? [0, word.length] : null)
    : regex.search(word);
  if (!found) return null;
  if (wantEnd && found[1] !== word.length) {
    const alt = regex.search(word, 1);
    if (!alt || alt[1] !== word.length) return null;
    return alt;
  }
  return found;
}

/** 从词首开始的可匹配前缀长度(用于 ^ 锚定但未 $ 的情形)。 */
function prefixMatch(regex, word) {
  const m = regex.search(word);
  return m && m[0] === 0;
}

/** 单字专用搜索(笔画模式等)。 */
export function searchChars(corpus, query) {
  const q = parseQuery(query);
  let regex;
  try {
    regex = compilePattern(q.pattern);
  } catch (err) {
    return { error: err };
  }
  const out = [];
  for (const [ch, info] of corpus.chars) {
    if (regex.test(ch)) out.push({ ch, ...info });
  }
  out.sort((a, b) => b.weight - a.weight);
  return { items: out, query: q };
}

export { compilePattern };

/**
 * 从已解压的缓冲区装配语料。
 * 浏览器走 Corpus.load; 测试环境可自行取数后调用本函数。
 */
export function buildCorpus(meta, charsBuf, wordsBuf) {
  const c = new Corpus();
  c.meta = meta;

  // ---- 单字表: 字 \t 笔画码串 \t 权重 ----
  for (const line of decoder.decode(charsBuf).split('\n')) {
    if (!line) continue;
    const [ch, code, w] = line.split('\t');
    if (!ch) continue;
    c.chars.set(ch, { strokes: code || '', weight: Number(w) || 0 });
  }

  // ---- 词流 ----
  const bytes = new Uint8Array(wordsBuf.buffer, wordsBuf.byteOffset, wordsBuf.byteLength);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const wordCount = view.getUint32(0, true);
  const streamLength = view.getUint32(4, true);
  c.blockCount = view.getUint32(8, true);
  c.blockSize = view.getUint32(12, true);
  const charCount = view.getUint32(16, true);
  const charTableOffset = view.getUint32(20, true);
  const blockIndexOffset = view.getUint32(24, true);
  const streamOffset = view.getUint32(28, true);

  c.bounds = new Uint32Array(bytes.buffer, bytes.byteOffset + 32, wordCount + 1);

  const codeUnits = new Uint16Array(streamLength);
  for (let i = 0; i < streamLength; i++) {
    codeUnits[i] = view.getUint16(streamOffset + i * 2, true);
  }
  c.words = codeUnits;

  const table = new Uint16Array(charCount);
  for (let i = 0; i < charCount; i++) {
    table[i] = view.getUint16(charTableOffset + i * 2, true);
    c.charIds.set(table[i], i);
  }

  // 块级首字字符集
  c.blockChars = new Uint8Array(
    bytes.buffer, bytes.byteOffset + blockIndexOffset, c.blockCount * 256);

  return c;
}
