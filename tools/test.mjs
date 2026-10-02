/* 端到端测试: 引擎校准 + 数据加载 + 搜索正确性 + 性能。
 *
 * 关键原则: 期望值不手写, 一律以引擎原生 RegExp 为基准比对,
 * 避免把「我以为的语义」当成「正确的语义」。
 *
 * 用法: 先 python serve.py 8765 --no-open, 再 node tools/test.mjs
 */
const BASE = process.argv[2] || 'http://127.0.0.1:8765/';

const { compilePattern } = await import('../js/regex.js');
const { buildCorpus, createSearch } = await import('../js/corpus.js');
const { fetchJson, fetchGunzip } = await import('./http_fetch.mjs');

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}

// ---------------- 1. 与原生 RegExp 校准 ----------------
console.log('== 匹配层 vs 原生 RegExp ==');
const CAL = [
  ['(中|国)家', '中家'], ['(中|国)家', '国家'], ['(中|国)家', '中国家'],
  ['中*国', '国'], ['中*国', '中中国'], ['中+国', '国'], ['中+国', '中中国'],
  ['中?国', '中中国'], ['中{2}', '中中'], ['中{2,3}', '中中中中'],
  ['..*人', '人'], ['..*人', '中国人'], ['.*', '任何'],
  ['[东西南北]风', '东风'], ['[东西南北]风', '中风'],
  ['[^东]风', '东风'], ['[^东]风', '西风'],
  ['中.国', '中国'], ['中.国', '中x国'],
  ['中(国|华)人', '中国人'], ['中(国|华)人', '中华人'],
  ['(?:中|国)家', '国家'], ['[一-五]月', '三月'], ['[一-五]月', '七月'],
];
let diff = 0;
let skipped = 0;
for (const [pat, str] of CAL) {
  // `?` 在本工具里是 Nutrimatic 式通配符(等同 `.`), 与原生 RegExp 的量词语义
  // 有意不同, 不参与原生比对, 单独在下文断言。
  if (/(^|[^\\[])\?/.test(pat)) { skipped++; continue; }
  const native = new RegExp(`^(?:${pat})$`, 'u').test(str);
  const ours = compilePattern(pat).test(str);
  if (native !== ours) { diff++; console.log(`  DIFF ${pat} / ${str}: native=${native} ours=${ours}`); }
}
ok(`与原生一致(${CAL.length - skipped} 例, 跳过 ${skipped} 个含 ? 的)`, diff === 0, `差异 ${diff}`);

console.log('\n== ? 作通配符(有意区别于原生量词) ==');
ok('? = 任一字符', compilePattern('?').test('中') && !compilePattern('?').test('中国'));
ok('中?国 匹配 中x国', compilePattern('中?国').test('中x国'));
ok('中?国 匹配 中中国', compilePattern('中?国').test('中中国'));
ok('中?国 不匹配两字 中国', !compilePattern('中?国').test('中国'));
ok('量词仍可用 {0,1}',
  compilePattern('中{0,1}国').test('国') && compilePattern('中{0,1}国').test('中国'));

console.log('\n== 全角归一(有意为之的差异) ==');
ok('． 被归一为 .', compilePattern('．').test('中'));
ok('［］ 被归一', compilePattern('［东西南北］风').test('东风'));

console.log('\n== 数据加载 ==');
const t0 = performance.now();
const [meta, charsGz, wordsGz] = await Promise.all([
  fetchJson(BASE + 'asset/meta.json'),
  fetchGunzip(BASE + 'asset/chars.txt.gz'),
  fetchGunzip(BASE + 'asset/words.bin.gz'),
]);
const corpus = buildCorpus(meta, charsGz, wordsGz);
console.log(`  载入耗时 ${((performance.now() - t0) / 1000).toFixed(2)}s`);
ok('词表规模 > 90 万', corpus.wordCount > 900000, `实际 ${corpus.wordCount}`);
ok('单字表 > 9000', corpus.chars.size > 9000, `实际 ${corpus.chars.size}`);
ok('块数合理', corpus.blockCount > 500, `实际 ${corpus.blockCount}`);

// 取一个具体词校验读取正确
const probe = corpus.wordAt(0);
ok('首个词可读', typeof probe === 'string' && probe.length > 0, `得到 ${JSON.stringify(probe)}`);

// ---------------- 3. 搜索正确性(与原生全表比对) ----------------
console.log('\n== 搜索正确性 ==');
function ours(q, cap = 100000) {
  const engine = createSearch(corpus, q);
  if (engine.error) throw engine.error;
  const buf = [];
  for (let b = 0; b < engine.totalBlocks; b++) engine.scanBlock(b, buf);
  let items = buf;
  if (engine.kind === 'and' && engine.finish) items = engine.finish();
  if (typeof engine.finalize === 'function') items = engine.finalize(items);
  return items.map((h) => h.ch ?? (h.word ?? (h.i !== undefined ? corpus.wordAt(h.i) : h)));
}

console.log('\n== 新语法: 属性筛选 ==');
{
  const py = ours('#\u58f0\u8c03\u0031,\u58f0\u6bcdzh,\u9996\u7b14\u70b9');
  console.log(`  #声调1,声母zh,首笔点 -> ${py.length} 字: ${py.slice(0, 12).join('')}`);
  const allOk = py.every((ch) => {
    const info = corpus.chars.get(ch);
    return info.py?.tone === 1 && info.py?.initial === 'zh' && info.strokeNames[0] === '\u70b9';
  });
  ok('属性筛选结果全部符合', py.length > 0 && allOk, `n=${py.length}`);
  ok('含"之"', py.includes('\u4e4b'));

  const nine = ours('#9\u753b');
  console.log(`  #9画 -> ${nine.length} 字`);
  ok('#9画 全部 9 画', nine.every((c) => corpus.chars.get(c).strokeNames.length === 9), `n=${nine.length}`);
}

console.log('\n== 新语法: 字集引用 [#属性] ==');
{
  const r = ours('^[#9\u753b]{4}$');
  console.log(`  ^[#9画]{4}$ -> ${r.length} 条: ${r.slice(0, 12).join(' ')}`);
  const allOk = r.every((w) => w.length === 4 && [...w].every((c) => corpus.chars.get(c)?.strokeNames.length === 9));
  ok('四字词每字 9 画', r.length > 0 && allOk, `n=${r.length}`);
  ok('含 总统选举', r.includes('\u603b\u7edf\u9009\u4e3e'));
}

console.log('\n== 新语法: 取字与交集 @?风&@金? ==');
{
  const r = ours('@?\u98ce&@\u91d1?');
  console.log(`  @?风&@金? -> ${r.length} 字: ${r.slice(0, 30).join('')}`);
  ok('交集非空', r.length > 0, `n=${r.length}`);
  ok('含 军', r.includes('\u519b'), r.slice(0, 20).join(''));
  const set = new Set();
  for (let i = 0; i < corpus.wordCount; i++) set.add(corpus.wordAt(i));
  const verified = r.every((c) => set.has(c + '\u98ce') && set.has('\u91d1' + c));
  ok('逐个验证 X风 与 金X 均存在', verified, '');
}

console.log('\n== 回归: 普通两字查询不受取字影响 ==');
{
  const r = ours('.\u56fd');
  console.log(`  .国 -> ${r.length} 条, 例: ${r.slice(0, 6).join(' ')}`);
  ok('.国 返回词而非字', r.length > 1000 && r.includes('\u4e2d\u56fd'), `n=${r.length}`);
}

// 基准语义: 默认在「词内任意位置」找匹配(与扫描器一致), 不是整词匹配。
function nativeCount(pat, minLen, maxLen) {
  const re = new RegExp(pat, 'u');
  const seen = new Set();
  for (let i = 0; i < corpus.wordCount; i++) {
    const w = corpus.wordAt(i);
    const L = w.length;
    if (L < minLen || L > maxLen) continue;
    if (re.test(w) && !seen.has(w)) seen.add(w);
  }
  return seen.size;
}

for (const [q, pat, minLen, maxLen] of [
  ['[东西南北]风', '[东西南北]风', 2, 2],   // 只看 2 字词
  ['[东西南北]风', '[东西南北]风', 2, 10],  // 与查询默认范围一致
  ['.国', '.国', 2, 10],
  ['中.', '中.', 2, 10],
]) {
  const got = ours(q).filter((w) => w.length >= minLen && w.length <= maxLen);
  const expect = nativeCount(pat, minLen, maxLen);
  const uniq = new Set(got).size;
  console.log(`  ${q} [${minLen}-${maxLen}]: ours=${uniq} native=${expect}`);
  ok(`${q} 数量一致`, uniq === expect, `ours ${uniq} vs native ${expect}`);
}

// 抽样验证具体命中(子串语义: 命中词必然含匹配片段)
const rWind2 = ours('[东西南北]风').filter((w) => w.length === 2);
ok('2 字 [东西南北]风 含东风', rWind2.includes('东风'));
ok('2 字 [东西南北]风 不含中风', !rWind2.includes('中风'));
const rWind = ours('[东西南北]风');
ok('[东西南北]风 全部含该片段', rWind.every((w) => /[东西南北]风/u.test(w)));

// ---------------- 4. 性能 ----------------
console.log('\n== 性能(全量 100 万词) ==');
for (const q of ['.国', '中国', '..*人', '[东西南北]风']) {
  const t = performance.now();
  const r = ours(q);
  const ms = performance.now() - t;
  console.log(`  ${q.padEnd(12)} ${String(r.length).padStart(6)} 条  ${ms.toFixed(0)}ms`);
  ok(`${q} 在 3s 内`, ms < 3000, `${ms.toFixed(0)}ms`);
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
