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
    this.chars = new Map();   // 字 -> {strokes, weight, pinyin, initial, tone, plain, first}
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

// ---------------- 拼音解析 ----------------

const TONE_MARKS = {
  '\u0304': 1, '\u0301': 2, '\u030c': 3, '\u0300': 4, '\u0306': 0,
};
const INITIALS = ['zh', 'ch', 'sh',
  'b', 'p', 'm', 'f', 'd', 't', 'n', 'l', 'g', 'k', 'h',
  'j', 'q', 'x', 'r', 'z', 'c', 's', 'y', 'w'];

/** 把带声调的拼音拆成 {tone, plain, initial, final}。 */
export function parsePinyin(py) {
  if (!py) return null;
  const low = String(py).toLowerCase();
  const nfd = low.normalize('NFD');
  let tone = 0;
  for (const ch of nfd) {
    const t = TONE_MARKS[ch];
    if (t !== undefined && t > 0) { tone = t; break; }
  }
  const plain = nfd.replace(/[\u0300-\u036f]/g, '');
  let initial = '';
  for (const ini of INITIALS) {
    if (plain.startsWith(ini)) { initial = ini; break; }
  }
  return { tone, plain, initial, final: plain.slice(initial.length) };
}

// ---------------- 查询解析 ----------------

/**
 * 查询语法:
 *
 *   .            任一字符        [东西南北]  字符类      [^东]  排除类
 *   X* X+ X?     量词            {n} {n,m}  词长        ^ $    首/尾锚定
 *   (中|国)      分组或          \x         转义
 *
 *   #属性         把结果限定为「符合属性的单字」
 *     笔画数:   #9画  #9    |  #9-11画  #笔画9
 *     起笔:     #首笔点  #起笔横
 *     拼音:     #声母zh  #声调1  #拼音zhong  #韵母ong
 *     组合:     #9画,声母zh,声调1,首笔点
 *   [#属性]       在词模式里引用该字集, 如 [#9画]{4}
 *
 *   A+B           同时满足 A 与 B(交集), 如 ?风+金?
 *
 * 示例:
 *   .国                          二字词, 第二字为国
 *   #声调1,声母zh,首笔点           所有符合属性的单字
 *   [#9画]{4}                    四字词, 每字均 9 画
 *   ?风+金?                       既能成 X风 又能成 金X 的字
 */
export function parseQuery(raw) {
  let s = String(raw ?? '').trim();

  // 单字属性查询
  if (s.startsWith('#')) {
    const expr = s.slice(1);
    return {
      kind: 'chars',
      filterExpr: expr,
      filter: parseCharFilter(expr),
      minLen: 1,
      maxLen: 1,
      raw,
    };
  }

  // 交集: A&B —— 同时满足两个条件(如 ?风&金? 找既能成 X风 又能成 金X 的字)
  if (splitTop(s, '&').length > 1) {
    return { kind: 'and', parts: splitTop(s, '&'), raw };
  }

  let includeChars = false;
  if (s.startsWith('G')) { includeChars = true; s = s.slice(1); }

  // 显式「取字」标记: @?风 表示找出能组成 X风 的那个 X(而不是列出词本身)
  let wantChar = false;
  if (s.startsWith('@')) { wantChar = true; s = s.slice(1); }

  let minLen = includeChars ? 1 : 2;
  let maxLen = 10;

  // 先把 [#属性] 换成占位符, 这样后面的 {n} 才能区分
  // 「词长限定」与「字集重复」(如 [#9画]{4} 是 4 个 9 画字, 不是词长 4)。
  const setRefs = [];
  s = s.replace(/\[#([^\]]+)\]/g, (m, expr) => {
    setRefs.push(expr);
    return `\u0001${setRefs.length - 1}\u0001`;
  });

  // 展开字集重复量词 {n} / {n,}
  s = s.replace(/\u0001(\d+)\u0001\{(\d+),?\}/g, (m, idx, cnt) => {
    const k = Number(cnt);
    return Array(Math.max(1, Math.min(k, 12))).fill(`\u0001${idx}\u0001`).join('');
  });

  // 剩余的 {n} / {n,m} 才是词长限定
  s = s.replace(/\{(\d*)(,?)(\d*)\}/g, (m, a, comma, b) => {
    if (setRefs.length) return m; // 已无字集则可能是遗留, 交下方处理
    if (!comma) {
      const n = Number(a);
      if (!Number.isNaN(n)) { minLen = Math.max(1, n); maxLen = n; }
      return '';
    }
    if (a) minLen = Math.max(1, Number(a));
    if (b) maxLen = Number(b);
    return '';
  });

  // 纯单字模式(无锚定): 结果取「那个字」而非整个词, 例如 ?风 / 金?
  const isCharPattern = !includeChars && minLen === 2 && maxLen === 2
    && !s.includes('*') && !s.includes('(') && !s.includes('|') && s.length >= 1;

  let anchoredStart = false;
  let anchoredEnd = false;
  if (s.startsWith('^')) { anchoredStart = true; s = s.slice(1); }
  if (s.endsWith('$') && !s.endsWith('\\$')) { anchoredEnd = true; s = s.slice(0, -1); }

  if (!s) s = '.';

  // 取字: 仅在显式 @ 标记时启用, 结果交出「那个字」。
  // 例如 @?风 -> X风 的 X; @金? -> 金X 的 X; 二者用 & 交集即"两条件同时满足的字"。
  let extractAt = null;
  if (wantChar && !anchoredStart && !anchoredEnd) {
    const chars = [...s];
    const isWild = (ch) => ch === '.' || ch === '?';
    if (chars.length === 2) {
      if (isWild(chars[0]) && !isWild(chars[1])) extractAt = 0;
      else if (!isWild(chars[0]) && isWild(chars[1])) extractAt = 1;
      else extractAt = 0;
    }
  }

  // 取字模式下限定为两字词
  if (extractAt !== null) { minLen = 2; maxLen = 2; }

  return {
    kind: 'words',
    pattern: s,
    setRefs,
    extractAt,
    minLen,
    maxLen,
    anchoredStart,
    anchoredEnd,
    includeChars,
    raw,
  };
}

/** 按顶层分隔符切分(忽略字符类与括号内部)。 */
function splitTop(s, sep) {
  const out = [];
  let depth = 0;
  let inClass = false;
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') { cur += c + (s[i + 1] ?? ''); i++; continue; }
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (!inClass && c === '(') depth++;
    else if (!inClass && c === ')') depth--;
    if (c === sep && !inClass && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

/** 由属性表达式构造字集: 返回 {set: Set<string>, classText: string}。 */
export function buildCharSet(corpus, filterExpr) {
  const conds = parseCharFilter(filterExpr);
  const set = new Set();
  for (const [ch, info] of corpus.chars) {
    if (charMatches(info, conds)) set.add(ch);
  }
  if (!set.size) return { set, classText: '(?!)' };
  const chars = [...set].map((c) => (c === '\\' || c === ']' || c === '^' || c === '-'
    ? '\\' + c : c)).join('');
  return { set, classText: `[${chars}]` };
}

const STROKE_GROUPS = {
  '\u6a2a': ['\u6a2a', '\u6a2a\u6298', '\u6a2a\u94a9', '\u6a2a\u659c\u94a9',
    '\u6a2a\u6298\u94a9', '\u6a2a\u6298\u6298', '\u6a2a\u6298\u6298\u6487',
    '\u6a2a\u6487', '\u6a2a\u6298\u63d0', '\u6a2a\u6298\u6298\u94a9',
    '\u6a2a\u6298\u6298\u6298', '\u6a2a\u6298\u6298\u6298\u94a9',
    '\u6a2a\u6298\u5f2f\u94a9'],
  '\u7ad6': ['\u7ad6', '\u7ad6\u94a9', '\u7ad6\u5f2f', '\u7ad6\u5f2f\u94a9',
    '\u7ad6\u63d0', '\u7ad6\u6298\u6487', '\u7ad6\u6298\u6298\u94a9'],
  '\u6487': ['\u6487', '\u6487\u6298', '\u6487\u70b9'],
  '\u70b9': ['\u70b9'],
  '\u637a': ['\u637a'],
  '\u6298': ['\u6298', '\u6a2a\u6298', '\u7ad6\u94a9', '\u7ad6\u5f2f',
    '\u7ad6\u5f2f\u94a9', '\u7ad6\u63d0', '\u6487\u6298',
    '\u6a2a\u6298\u94a9', '\u6a2a\u659c\u94a9', '\u6a2a\u6298\u63d0',
    '\u6a2a\u6487', '\u6a2a\u6298\u6298', '\u6a2a\u6298\u6298\u6487',
    '\u6a2a\u6298\u6298\u6298', '\u6a2a\u6298\u6298\u94a9',
    '\u6a2a\u6298\u6298\u6298\u94a9', '\u659c\u94a9', '\u7ad6\u6298\u6487',
    '\u6487\u70b9', '\u5f2f\u94a9'],
};

/**
 * 解析 `#` 后的筛选表达式, 返回校验函数。
 * 条件之间是「与」关系, 用逗号分隔。
 */
export function parseCharFilter(expr) {
  const conds = [];
  for (const rawPart of String(expr).split(/[,，]/)) {
    const part = rawPart.trim();
    if (!part) continue;
    const c = parseOneCond(part);
    if (c) conds.push(c);
  }
  return conds;
}

function parseOneCond(part) {
  let m;

  // 笔画数: 9 / 9画 / 笔画9 / 9-11画 / 9~11
  if ((m = /^(?:\u7b14\u753b)?(\d+)\s*(?:[-~\u2013\u2014]\s*(\d+))?\s*\u753b?$/.exec(part))) {
    const lo = Number(m[1]);
    const hi = m[2] ? Number(m[2]) : lo;
    return { type: 'strokes', lo, hi, text: part };
  }

  // 起笔 / 首笔
  if ((m = /^(?:\u8d77\u7b14|\u9996\u7b14|\u7b2c\u4e00\u7b14)\s*(.+)$/.exec(part))) {
    const name = m[1].trim();
    const group = STROKE_GROUPS[name] || [name];
    return { type: 'first', set: group, text: part };
  }

  // 声母
  if ((m = /^\u58f0\u6bcd\s*([a-zA-Z]+)$/.exec(part))) {
    return { type: 'initial', value: m[1].toLowerCase(), text: part };
  }
  // 声调
  if ((m = /^\u58f0\u8c03\s*([1-4\u4e00\u4e8c\u4e09\u56db]|\u8f7b\u58f0)$/.exec(part))) {
    const map = { '\u4e00': '1', '\u4e8c': '2', '\u4e09': '3', '\u56db': '4' };
    const v = map[m[1]] ?? (/[1-4]/.test(m[1]) ? m[1] : '0');
    return { type: 'tone', value: Number(v), text: part };
  }
  // 韵母
  if ((m = /^\u97f5\u6bcd\s*([a-z]+)$/.exec(part))) {
    return { type: 'final', value: m[1].toLowerCase(), text: part };
  }
  // 拼音音节
  if ((m = /^\u62fc\u97f3\s*([a-zA-Z\u00c0-\u024f]+)$/.exec(part))) {
    const p = parsePinyin(m[1]);
    return { type: 'pinyin', value: p ? p.plain : m[1].toLowerCase(), text: part };
  }
  // 简写: 纯字母按声母处理
  if (/^[a-zA-Z]+$/.test(part)) {
    return { type: 'initial', value: part.toLowerCase(), text: part };
  }
  return { type: 'unknown', text: part };
}

/** 单个字是否满足全部条件。 */
export function charMatches(info, conds) {
  for (const c of conds) {
    switch (c.type) {
      case 'strokes':
        if (!info.strokes || info.strokes.length < c.lo || info.strokes.length > c.hi) return false;
        break;
      case 'first': {
        const names = info.strokeNames;
        if (!names || !names.length) return false;
        if (!c.set.includes(names[0])) return false;
        break;
      }
      case 'initial':
        if (info.py?.initial !== c.value) return false;
        break;
      case 'tone':
        if (info.py?.tone !== c.value) return false;
        break;
      case 'final':
        if (info.py?.final !== c.value) return false;
        break;
      case 'pinyin':
        if (info.py?.plain !== c.value) return false;
        break;
      default:
        return false;
    }
  }
  return true;
}

/**
 * 流式搜索。返回一个可迭代的分片执行器。
 * onBatch(items) 每片回调; 返回 {done} 或继续。
 */
/**
 * 统一的搜索会话接口。
 *
 * 返回 { query, totalBlocks, scanBlock(b, out), kind }:
 *   - totalBlocks: 需要扫描的块数(单字属性查询恒为 1)
 *   - scanBlock(b, out): 扫描第 b 块, 向 out 追加 { ch } 或 { i, len }
 * 由调用方按帧推进、限时、去重与排序; 这样不同查询类型对 UI 是同一件事。
 */
export function createSearch(corpus, query) {
  const q = parseQuery(query);

  // ---- 单字属性查询 ----
  if (q.kind === 'chars') {
    const items = searchByFilter(corpus, q.filter);
    let done = false;
    return {
      query: q,
      kind: 'chars',
      totalBlocks: 1,
      scanBlock(b, out) {
        if (done || b !== 0) return;
        for (const it of items) out.push({ ch: it.ch, info: it.info });
        done = true;
      },
    };
  }

  // ---- 交集: 各子查询分别扫完后求交 ----
  if (q.kind === 'and') {
    const subs = [];
    for (const part of q.parts) {
      const sub = createSearch(corpus, part);
      if (sub.error) return sub;
      subs.push(sub);
    }
    const totalBlocks = Math.max(...subs.map((s) => s.totalBlocks));
    const acc = subs.map(() => new Map());
    const keyOf = (item) => item.ch ?? corpus.wordAt(item.i);
    return {
      query: q,
      kind: 'and',
      totalBlocks,
      subs,
      /** 每个子查询都扫完后才产出: 取交集。 */
      finish() {
        const [first, ...rest] = acc;
        const out = [];
        for (const [k, item] of first) {
          if (rest.every((s) => s.has(k))) {
            out.push({ word: k, isChar: !!item.ch, info: item.info });
          }
        }
        return out;
      },
      scanBlock(b, out) {
        for (let k = 0; k < subs.length; k++) {
          const buf = [];
          subs[k].scanBlock(b, buf);
          for (const item of buf) acc[k].set(keyOf(item), item);
        }
        // 交集需要全部扫完才有结果, 此处不产出
      },
    };
  }

  // ---- 词模式: 展开 [#属性] 占位符 ----
  //
  // 属性字集可能有近千字, 塞进正则字符类既慢又易踩引擎边界,
  // 因此对含字集引用的模式改走「按段逐字匹配」的路径。
  if (q.setRefs && q.setRefs.length) {
    return makeSegmentedScanner(corpus, q);
  }

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

  // 词长 -> 块范围
  const ranges = blocksForLength(corpus, q.minLen, q.maxLen);
  const skip = new Uint8Array(corpus.blockCount);
  for (const [from, to] of ranges) {
    for (let b = from; b < to; b++) skip[b] = 1;
  }

  // 单字模式: 命中的是两字词, 但结果为「那一个字」(如 ?风 交出 X)
  const extractAt = q.extractAt;

  return {
    query: q,
    kind: 'words',
    regex,
    extractAt,
    totalBlocks: corpus.blockCount,
    /** 搜索完成后按字权重重排(仅在取字模式下需要)。 */
    finalize(items) {
      if (extractAt === null) return items;
      const uniq = new Map();
      for (const it of items) {
        if (!uniq.has(it.ch)) uniq.set(it.ch, it);
      }
      const arr = [...uniq.values()];
      arr.sort((a, b) =>
        ((corpus.chars.get(b.ch)?.weight) || 0) - ((corpus.chars.get(a.ch)?.weight) || 0));
      return arr;
    },
    scanBlock(b, out) {
      if (!skip[b]) return;
      if (startIds && !corpus.blockMayContain(b, startIds)) return;
      const from = b * corpus.blockSize;
      const to = Math.min(from + corpus.blockSize, corpus.wordCount);
      for (let i = from; i < to; i++) {
        const len = corpus.bounds[i + 1] - corpus.bounds[i];
        if (len < q.minLen || len > q.maxLen) continue;
        const word = corpus.wordAt(i);
        const hit = matchWord(regex, word, wantStart, wantEnd);
        if (!hit) continue;
        if (extractAt !== null) out.push({ ch: word[extractAt] });
        else out.push({ i, len, pos: hit });
      }
    },
  };
}

/**
 * 含 [#属性] 字集引用的模式: 按段逐字匹配。
 *
 * 把模式按占位符切成若干段, 每段要么是字集(用 Set 判定), 要么是普通正则片段;
 * 再用 `(seg1|seg2|...)` 一次性定位, 逐个校验。属性集合可达近千字,
 * 这样避免构造巨型正则字符类。
 */
function makeSegmentedScanner(corpus, q) {
  const segs = [];
  const tokens = String(q.pattern).split(/\u0001(\d+)\u0001/);
  for (let i = 0; i < tokens.length; i++) {
    if (i % 2 === 0) {
      const txt = tokens[i];
      if (txt) segs.push({ type: 're', re: compilePattern(txt) });
    } else {
      const { set, classText } = buildCharSet(corpus, q.setRefs[Number(tokens[i])]);
      segs.push({ type: 'set', set, classText });
    }
  }
  if (!segs.length) return { error: new Error('空模式'), query: q };

  // 空字集 => 永不匹配
  if (segs.some((s) => s.type === 'set' && s.set.size === 0)) {
    return { query: q, kind: 'words', totalBlocks: 0, scanBlock() {} };
  }

  const whole = new RegExp(
    `(${segs.map((s) => (s.type === 'set' ? s.classText : `(?:${s.source})`)).join('|')})`, 'u');

  function matchWord(word) {
    // 纯字集段: 退化为「逐字属于对应集合」的直接判断
    if (segs.every((s) => s.type === 'set') && segs.length === q.minLen && q.minLen === q.maxLen) {
      if (word.length !== segs.length) return null;
      for (let i = 0; i < segs.length; i++) {
        if (!segs[i].set.has(word[i])) return null;
      }
      return [0, word.length];
    }

    const found = [];
    let start = 0;
    while (start <= word.length) {
      whole.lastIndex = 0;
      const m = whole.exec(word.slice(start));
      if (!m) break;
      found.push({ seg: segs[found.length % segs.length], text: m[0], at: start + m.index });
      start += m.index + Math.max(1, m[0].length);
      if (found.length > segs.length * 2) break;
    }
    if (found.length !== segs.length) return null;
    // 段与段必须首尾相接, 覆盖整词
    let pos = 0;
    for (const f of found) {
      if (f.at !== pos) return null;
      if (f.seg.type === 'set' && !(f.text.length === 1 && f.seg.set.has(f.text))) return null;
      pos += f.text.length;
    }
    if (pos !== word.length) return null;
    return [0, word.length];
  }

  const ranges = blocksForLength(corpus, q.minLen, q.maxLen);
  const want = new Set();
  for (const [from, to] of ranges) for (let b = from; b < to; b++) want.add(b);

  return {
    query: q,
    kind: 'words',
    totalBlocks: corpus.blockCount,
    scanBlock(b, out) {
      if (!want.has(b)) return;
      const from = b * corpus.blockSize;
      const to = Math.min(from + corpus.blockSize, corpus.wordCount);
      for (let i = from; i < to; i++) {
        const len = corpus.bounds[i + 1] - corpus.bounds[i];
        if (len < q.minLen || len > q.maxLen) continue;
        const word = corpus.wordAt(i);
        if (matchWord(word)) out.push({ i, len });
      }
    },
  };
}

function blocksForLength(corpus, minLen, maxLen) {
  const map = new Map();
  const n = corpus.wordCount;
  let i = 0;
  while (i < n) {
    const len = corpus.bounds[i + 1] - corpus.bounds[i];
    let j = i;
    while (j < n && corpus.bounds[j + 1] - corpus.bounds[j] === len) j++;
    map.set(len, [Math.floor(i / corpus.blockSize), Math.ceil(j / corpus.blockSize)]);
    i = j;
  }
  const ranges = [];
  for (const [len, r] of map) {
    if (len >= minLen && len <= maxLen) ranges.push(r);
  }
  if (!ranges.length) return [];
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [ranges[0].slice()];
  for (let k = 1; k < ranges.length; k++) {
    const last = merged[merged.length - 1];
    if (ranges[k][0] <= last[1]) last[1] = Math.max(last[1], ranges[k][1]);
    else merged.push(ranges[k].slice());
  }
  return merged;
}

/** 单字属性搜索: 遍历字表, 返回符合全部条件的字。 */
export function searchByFilter(corpus, filter, limit = 4000) {
  const out = [];
  for (const [ch, info] of corpus.chars) {
    if (charMatches(info, filter)) out.push({ ch, info });
  }
  out.sort((a, b) => (b.info.weight || 0) - (a.info.weight || 0));
  return out.slice(0, limit);
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

  // ---- 单字表: 字 \t 笔画码串 \t 权重 \t 拼音 ----
  for (const line of decoder.decode(charsBuf).split('\n')) {
    if (!line) continue;
    const [ch, code, w, py] = line.split('\t');
    if (!ch) continue;
    const strokeNames = [];
    for (const ch2 of code || '') {
      const idx = ch2.charCodeAt(0) - 33;
      strokeNames.push(meta.strokeNames?.[idx] || '');
    }
    c.chars.set(ch, {
      strokes: code || '',
      strokeNames,
      weight: Number(w) || 0,
      pinyin: py || '',
      py: parsePinyin(py),
    });
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
