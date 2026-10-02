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
for (const [pat, str] of CAL) {
  const native = new RegExp(`^(?:${pat})$`, 'u').test(str);
  const ours = compilePattern(pat).test(str);
  if (native !== ours) { diff++; console.log(`  DIFF ${pat} / ${str}: native=${native} ours=${ours}`); }
}
ok(`与原生一致(${CAL.length} 例)`, diff === 0, `差异 ${diff}`);

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
  for (let b = 0; b < corpus.blockCount; b++) engine.scanBlocks(b, b + 1, buf);
  return buf.map((h) => corpus.wordAt(h.i));
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
