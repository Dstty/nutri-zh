/* UI 冒烟测试: 按「先证明模块会执行, 再断言行为」的顺序组织,
 * 每一步都打印可观察状态, 便于失败时直接定位。 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEBROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---------- 极简 DOM ----------
class E {
  constructor() {
    this.children = []; this.dataset = {}; this.style = {}; this._t = '';
    this.hidden = false; this.checked = false; this.value = ''; this.title = '';
    this.listeners = new Map(); this._classes = new Set();
    const self = this;
    this.classList = {
      add: (...c) => c.forEach((x) => self._classes.add(x)),
      remove: (...c) => c.forEach((x) => self._classes.delete(x)),
      contains: (c) => self._classes.has(c),
    };
  }
  get className() { return [...this._classes].join(' '); }
  set className(v) { this._classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get textContent() { return this._t; }
  set textContent(v) { this._t = String(v); }
  get innerHTML() { return ''; }
  set innerHTML(v) { this.children = []; }
  appendChild(c) { this.children.push(c); return c; }
  addEventListener(t, f) {
    if (!this.listeners.has(t)) this.listeners.set(t, []);
    this.listeners.get(t).push(f);
  }
  dispatch(t, ev = {}) { for (const fn of this.listeners.get(t) || []) fn({ target: this, ...ev }); }
  focus() {}
  remove() {}
  closest() { return null; }
  find(pred, acc = []) {
    if (pred(this)) acc.push(this);
    for (const c of this.children) c.find(pred, acc);
    return acc;
  }
}

const IDS = ['q', 'go', 'clear', 'withChars', 'anchored', 'stat', 'err',
  'results', 'more', 'moreBtn', 'empty', 'dataset'];
const byId = new Map(IDS.map((i) => [i, new E()]));
const quick = new E();
const chip = new E();
chip.className = 'chip';
chip.dataset.q = '[东西南北]风';
quick.appendChild(chip);

globalThis.document = {
  getElementById: (id) => byId.get(id) || null,
  querySelector: (sel) => (sel === '.quick' ? quick : null),
  createElement: () => new E(),
  createDocumentFragment: () => new E(),
  body: new E(),
  execCommand: () => true,
};
Object.defineProperty(globalThis, 'navigator', {
  value: { clipboard: { writeText: async () => {} } }, configurable: true, writable: true,
});
let raf = [];
const fetchCalls = [];
globalThis.requestAnimationFrame = (fn) => { raf.push(fn); return raf.length; };
async function frames(max = 6000) {
  let n = 0;
  while (raf.length && n < max) {
    const q = raf; raf = [];
    for (const fn of q) fn();
    n++;
    if (n % 20 === 0) await new Promise((r) => setImmediate(r));
  }
  return n;
}

globalThis.fetch = async (url) => {
  fetchCalls.push(String(url));
  const rel = decodeURIComponent(new URL(String(url), 'http://x/').pathname).replace(/^\/+/, '');
  const buf = readFileSync(join(WEBROOT, rel));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return {
    ok: true, status: 200,
    json: async () => JSON.parse(buf.toString('utf8')),
    arrayBuffer: async () => ab,
    get body() {
      const RS = globalThis.ReadableStream;
      let off = 0;
      const chunk = 1 << 20;
      return new RS({
        pull(c) {
          if (off >= ab.byteLength) { c.close(); return; }
          const end = Math.min(off + chunk, ab.byteLength);
          c.enqueue(new Uint8Array(ab.slice(off, end)));
          off = end;
        },
      });
    },
  };
};

// ---------- 断言 ----------
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
};
const cards = () => byId.get('results').find((e) => e._classes.has('card'));
const words = () => cards().map((c) => c.children[0]?.textContent).filter(Boolean);

console.log('== UI 冒烟 ==');
// 直接装配语料并注入, 绕开 Node 下 fetch+DecompressionStream 的组合问题;
// 被测的 app.js 与浏览器完全同一份。
{
  const { buildCorpus } = await import('../js/corpus.js');
  const gz = (p) => new Uint8Array(gunzipSync(readFileSync(join(WEBROOT, p))));
  const meta = JSON.parse(readFileSync(join(WEBROOT, 'asset/meta.json'), 'utf8'));
  globalThis.__CORPUS__ = buildCorpus(meta, gz('asset/chars.txt.gz'), gz('asset/words.bin.gz'));
  console.log(`  注入语料: ${globalThis.__CORPUS__.wordCount} 词`);
}
await import('../js/app.js');

// 步骤 1: 确认模块确实执行(boot 至少写过 dataset 或 err)
let booted = false;
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setImmediate(r));
  await frames(200);
  const d = byId.get('dataset').textContent;
  if (d) { booted = true; console.log(`  boot 输出: ${d}`); break; }
}
console.log(`  fetch 调用记录: ${fetchCalls.length} 次 -> ${fetchCalls.slice(-3).join(', ')}`);
ok('模块已执行(boot 有输出)', booted, 'dataset 始终为空');
if (!booted) {
  console.log('  诊断: fetch 类型 =', typeof globalThis.fetch);
  console.log('  dataset 元素 =', byId.get('dataset') ? 'ok' : 'null');
  process.exit(1);
}

// 步骤 2: 数据载入成功
const dt = byId.get('dataset').textContent;
ok('数据集已载入成功', /载入/.test(dt), dt);

// 步骤 3: 等待首次搜索产出结果
for (let i = 0; i < 200 && cards().length === 0; i++) {
  await new Promise((r) => setImmediate(r));
  await frames(400);
}
console.log(`  stat: ${byId.get('stat').textContent}`);
ok('搜索已完成并渲染', cards().length > 0, `cards=${cards().length}`);

// 步骤 4: 结果渲染
console.log(`  卡片 ${cards().length} 张; 分组: ${byId.get('results').find((e) => e._classes.has('group-title')).map((t) => t.textContent).join(' / ')}`);
ok('结果已渲染', cards().length > 0, `cards=${cards().length}`);

const w1 = words();
console.log(`  样例: ${w1.slice(0, 10).join(' ')}`);
ok('默认查询 .国 命中 中国', w1.includes('中国'), w1.slice(0, 6).join(','));

// 步骤 5: 换模式搜索
byId.get('q').value = '[东西南北]风';
byId.get('q').dispatch('keydown', { key: 'Enter', preventDefault() {} });
await frames(6000);
const w2 = words();
console.log(`  [东西南北]风 -> ${w2.length} 张, 例: ${w2.slice(0, 8).join(' ')}`);
ok('第二次搜索生效', w2.includes('东风'), w2.slice(0, 6).join(','));
ok('二字词均已出现', ['东风', '西风', '南风', '北风'].every((x) => w2.includes(x)), '');

// 步骤 6: 非法模式
byId.get('q').value = '[abc';
byId.get('q').dispatch('input', {});
await new Promise((r) => setTimeout(r, 400));
await frames(300);
console.log(`  err: ${byId.get('err').textContent.slice(0, 50)}`);
ok('非法模式有提示', byId.get('err').textContent.length > 0, '');

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
