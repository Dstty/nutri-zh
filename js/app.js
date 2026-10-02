/* 汉字正则查找 —— 交互层。
 *
 * 搜索是流式的: 按块推进, 每帧限时扫描, 边扫边出结果。
 * 结果按词表序(词长升序 / 同长频次降序)自然排列。
 */

import { Corpus, createSearch } from './corpus.js';

const LIMIT_DEFAULT = 400;
const FRAME_MS = 11;

const el = {
  q: document.getElementById('q'),
  go: document.getElementById('go'),
  clear: document.getElementById('clear'),
  withChars: document.getElementById('withChars'),
  anchored: document.getElementById('anchored'),
  stat: document.getElementById('stat'),
  err: document.getElementById('err'),
  results: document.getElementById('results'),
  more: document.getElementById('more'),
  moreBtn: document.getElementById('moreBtn'),
  empty: document.getElementById('empty'),
  dataset: document.getElementById('dataset'),
  quick: document.querySelector('.quick'),
};

let corpus = null;
let session = null;
let limit = LIMIT_DEFAULT;

// ---------------- 初始化 ----------------

(async function boot() {
  try {
    const t0 = performance.now();
    // 测试环境可注入语料实例; 正常浏览器走 Corpus.load
    corpus = globalThis.__CORPUS__ || await Corpus.load('asset/');
    const dt = ((performance.now() - t0) / 1000).toFixed(2);
    el.dataset.textContent =
      `${corpus.meta.words.toLocaleString()} 词 · ${corpus.meta.chars.toLocaleString()} 字 · 载入 ${dt}s`;
    el.q.value = '.国';
    runSearch();
  } catch (err) {
    el.dataset.textContent = '数据加载失败';
    showError(
      `无法加载数据（${err.message}）。\n` +
      `若以 file:// 直接打开，浏览器会拦截本地文件读取 —— 请在项目目录运行 ` +
      `python serve.py，再访问 http://localhost:8000/`);
  }
})();

// ---------------- 工具 ----------------

function setStat(html) { el.stat.innerHTML = html; }

function showError(msg) {
  el.err.hidden = false;
  el.err.textContent = msg;
}

function clearError() { el.err.hidden = true; el.err.textContent = ''; }

function debounce(fn, ms) {
  let t = 0;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ---------------- 词长 -> 块区间 ----------------

function lengthBlockMap() {
  if (corpus._lenBlocks) return corpus._lenBlocks;
  const map = new Map();
  const n = corpus.wordCount;
  let i = 0;
  while (i < n) {
    const len = corpus.bounds[i + 1] - corpus.bounds[i];
    let j = i;
    while (j < n && corpus.bounds[j + 1] - corpus.bounds[j] === len) j++;
    map.set(len, [
      Math.floor(i / corpus.blockSize),
      Math.ceil(j / corpus.blockSize),
    ]);
    i = j;
  }
  corpus._lenBlocks = map;
  return map;
}

function blocksForLength(minLen, maxLen) {
  const ranges = [];
  for (const [len, r] of lengthBlockMap()) {
    if (len >= minLen && len <= maxLen) ranges.push(r);
  }
  if (!ranges.length) return [];
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [ranges[0].slice()];
  for (let i = 1; i < ranges.length; i++) {
    const last = merged[merged.length - 1];
    if (ranges[i][0] <= last[1]) last[1] = Math.max(last[1], ranges[i][1]);
    else merged.push(ranges[i].slice());
  }
  return merged;
}

// ---------------- 搜索 ----------------

function runSearch() {
  if (!corpus) return;
  if (session) session.cancelled = true;
  session = null;

  clearError();
  el.results.innerHTML = '';
  el.empty.hidden = true;
  el.more.hidden = true;
  limit = LIMIT_DEFAULT;

  const raw = el.q.value.trim();
  if (!raw) { setStat('待输入'); return; }

  let text = raw;
  if (el.withChars.checked && !/^G/i.test(text)) text = 'G' + text;
  if (el.anchored.checked) text = '^' + text.replace(/^\^/, '').replace(/\$$/, '') + '$';

  const engine = createSearch(corpus, text);
  if (engine.error) {
    showError(`模式错误：${engine.error.message}`);
    setStat('模式错误');
    return;
  }

  const q = engine.query;
  const ranges = blocksForLength(q.minLen, q.maxLen);
  if (!ranges.length) {
    setStat('<b>0</b> 个结果');
    el.empty.hidden = false;
    return;
  }

  session = {
    engine, q, ranges,
    rangePos: 0,
    blockCursor: ranges[0][0],
    cancelled: false,
    matches: [],
    seen: new Set(),
    scanned: 0,
    t0: performance.now(),
    finished: false,
  };

  setStat('<span class="loading">搜索中…</span>');
  requestAnimationFrame(() => pump());
}

function pump() {
  if (!session || session.cancelled) return;
  const s = session;
  const deadline = performance.now() + FRAME_MS;
  const buf = [];

  while (performance.now() < deadline) {
    if (s.rangePos >= s.ranges.length) { s.finished = true; break; }
    const [, end] = s.ranges[s.rangePos];
    if (s.blockCursor >= end) {
      s.rangePos++;
      if (s.rangePos < s.ranges.length) s.blockCursor = s.ranges[s.rangePos][0];
      continue;
    }
    // 逐块扫描
    const from = s.blockCursor;
    s.engine.scanBlocks(from, from + 1, buf);
    s.blockCursor++;
    s.scanned += corpus.blockSize;
  }

  if (buf.length) {
    for (const hit of buf) {
      const word = corpus.wordAt(hit.i);
      if (s.seen.has(word)) continue;
      s.seen.add(word);
      s.matches.push({ word, len: hit.len, i: hit.i });
    }
    render();
  }
  updateStat();

  if (!s.finished) requestAnimationFrame(pump);
  else {
    updateStat(true);
    el.more.hidden = s.matches.length <= limit;
    if (!s.matches.length) el.empty.hidden = false;
  }
}

// ---------------- 渲染 ----------------

function render() {
  const total = session.matches.length;
  const shown = session.matches.slice(0, limit);
  const byLen = new Map();
  for (const m of shown) {
    if (!byLen.has(m.len)) byLen.set(m.len, []);
    byLen.get(m.len).push(m);
  }
  el.results.innerHTML = '';
  for (const len of [...byLen.keys()].sort((a, b) => a - b)) {
    const group = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'group-title';
    const n = byLen.get(len).length;
    title.textContent = len === 1 ? `单字 · ${n}` : `${len} 字词 · ${n}`;
    group.appendChild(title);

    const cards = document.createElement('div');
    cards.className = 'cards';
    const frag = document.createDocumentFragment();
    for (const m of byLen.get(len)) frag.appendChild(makeCard(m, len === 1));
    cards.appendChild(frag);
    group.appendChild(cards);
    el.results.appendChild(group);
  }
  el.empty.hidden = shown.length > 0;
  // 仅在已扫描完成且确实有多余结果时才提示
  const more = session.finished && total > limit;
  el.more.hidden = !more;
  if (more) el.moreBtn.textContent = `继续加载更多（还有 ${total - limit} 条）`;
}

function makeCard(m, isChar) {
  const card = document.createElement('div');
  card.className = 'card' + (isChar ? ' char' : '');

  const w = document.createElement('div');
  w.className = 'w';
  w.textContent = m.word;
  card.appendChild(w);

  const info = isChar ? corpus.chars.get(m.word) : null;
  if (isChar && info && info.strokes) {
    const st = document.createElement('div');
    st.className = 'strokes';
    for (const code of info.strokes) {
      const span = document.createElement('span');
      span.textContent = strokeName(code);
      st.appendChild(span);
    }
    card.appendChild(st);
  } else {
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${m.len} 字`;
    card.appendChild(meta);
  }

  card.title = '点击复制';
  card.addEventListener('click', () => copy(card, m.word));
  return card;
}

let strokeTable = null;
function strokeName(code) {
  if (!strokeTable) {
    strokeTable = new Map(
      (corpus.meta.strokeNames || []).map((n, i) => [String.fromCharCode(33 + i), n]));
  }
  return strokeTable.get(code) || code;
}

async function copy(card, text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch { /* 忽略 */ }
    ta.remove();
  }
  card.classList.add('copied');
  setTimeout(() => card.classList.remove('copied'), 900);
}

function updateStat(done = false) {
  if (!session) return;
  const n = session.matches.length;
  const ms = performance.now() - session.t0;
  const pct = Math.min(100, (session.blockCursor / corpus.blockCount) * 100).toFixed(0);
  const tail = done
    ? ''
    : ` <span class="dim">· 已扫 ${pct}%</span>`;
  setStat(`<b>${n.toLocaleString()}</b> 个结果 · ${ms.toFixed(0)}ms${tail}`);
}

// ---------------- 事件 ----------------

const debounced = debounce(runSearch, 160);
el.q.addEventListener('input', debounced);
el.q.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); runSearch(); }
  if (e.key === 'Escape') { el.q.value = ''; runSearch(); }
});
el.go.addEventListener('click', runSearch);
el.clear.addEventListener('click', () => { el.q.value = ''; el.q.focus(); runSearch(); });
el.withChars.addEventListener('change', runSearch);
el.anchored.addEventListener('change', runSearch);

el.moreBtn.addEventListener('click', () => {
  limit += LIMIT_DEFAULT;
  if (session) render();
});

el.quick.addEventListener('click', (e) => {
  const btn = e.target.closest('.chip');
  if (!btn) return;
  el.q.value = btn.dataset.q;
  runSearch();
  el.q.focus();
});
