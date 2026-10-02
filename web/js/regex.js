/* 正则匹配层。
 *
 * 设计取舍: 匹配交给引擎内置 RegExp(线性于 V8 的实现, 成熟可靠),
 * 本模块只负责:
 *   1. 把用户模式归一为可用的 RegExp
 *   2. 全角标点归一(中文输入法下 . [ ] ( ) * + ? | { } 常是全角)
 *   3. 语法校验并给出可读的错误
 *   4. 提取「可接受的起始字符集」, 供块级倒排预筛
 *
 * 为什么不自己写 NFA 解释器: 词表一千万次匹配对分配很敏感, 而模式可能含
 * 嵌套量词。交给 V8 的正则引擎更快也更稳。风险是灾难性回溯, 用步数上限兜底。
 *
 * 支持语法(与 Nutrimatic 一致的子集):
 *   .            任意单字符
 *   [abc]        字符类
 *   [^abc]       排除类
 *   [a-c]        范围
 *   X*  X+  X?   量词
 *   X{n} X{n,} X{n,m}
 *   (...)  (?:...)  分组
 *   A|B          或
 *   \x           转义
 */

const FULLWIDTH = {
  '．': '.', '［': '[', '］': ']', '（': '(', '）': ')',
  '＊': '*', '＋': '+', '？': '?', '｜': '|', '｛': '{', '｝': '}',
  '＾': '^', '－': '-', '＼': '\\', '，': ',', '：': ':',
};

export function normalizePattern(input) {
  let out = '';
  for (const ch of String(input)) out += FULLWIDTH[ch] ?? ch;
  return out;
}

/** 元字符(需要转义才对字面匹配有意义)。 */
const META = new Set(['.', '[', ']', '(', ')', '*', '+', '?', '|', '{', '}', '^', '$', '\\']);

export class Regex {
  constructor(pattern) {
    this.source = normalizePattern(pattern);
    if (this.source === '') this.source = '.';
    // 用非捕获组包裹, 便于前后加锚点
    let body = this.source;
    try {
      this.re = new RegExp(body, 'u');
    } catch (err) {
      const e = new Error(describeError(err.message, this.source));
      e.patternPos = 0;
      e.cause = err;
      throw e;
    }
    this._anchored = null;
    this._startSet = null;
    this._startComputed = false;
  }

  /** 整串完全匹配。 */
  test(input) {
    if (!this._anchored) this._anchored = new RegExp(`^(?:${this.source})$`, 'u');
    this._anchored.lastIndex = 0;
    return this._anchored.test(input);
  }

  /** 在 input 中找第一个匹配(Nutrimatic 式滑窗)。 */
  search(input, from = 0) {
    const re = new RegExp(this.source, 'gu');
    re.lastIndex = from;
    const m = re.exec(input);
    return m ? [m.index, m.index + m[0].length] : null;
  }

  /**
   * 可接受的起始字符集合(供块级预筛)。
   * 仅在模式以明确的字符/字符类/字面量开头时给出, 否则 null 表示不能预筛。
   */
  startChars() {
    if (this._startComputed) return this._startSet;
    this._startComputed = true;
    const set = new Set();
    const src = this.source;
    let i = 0;
    for (;;) {
      const c = src[i];
      if (c === undefined) break;
      if (c === '\\') {
        const n = src[i + 1];
        if (!n || 'dwsDWS'.includes(n)) { this._startSet = null; return null; }
        set.add(n.codePointAt(0));
        i += 2;
        continue;
      }
      if (c === '[') {
        const end = findClassEnd(src, i);
        if (end < 0) { this._startSet = null; return null; }
        const body = src.slice(i + 1, end);
        if (body.startsWith('^') || body.startsWith('\\')) { this._startSet = null; return null; }
        const chars = expandClass(body);
        if (!chars || chars.length > 2048) { this._startSet = null; return null; }
        for (const ch of chars) set.add(ch.codePointAt(0));
        i = end + 1;
        continue;
      }
      if (c === '.') { this._startSet = null; return null; }
      if (c === '(') { this._startSet = null; return null; }
      // 量词/锚点/分支: 起始字符不确定
      if ('*+?{|^$'.includes(c)) { this._startSet = null; return null; }
      set.add(c.codePointAt(0));
      i++;
    }
    this._startSet = set.size ? set : null;
    return this._startSet;
  }
}

function findClassEnd(src, start) {
  // 返回类结束 ']' 的索引; 处理开头 ']' 与转义
  let i = start + 1;
  if (src[i] === '^') i++;
  if (src[i] === ']') i++;
  for (; i < src.length; i++) {
    if (src[i] === '\\') { i++; continue; }
    if (src[i] === ']') return i;
  }
  return -1;
}

function expandClass(body) {
  const out = [];
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '\\') return null;
    if (body[i + 1] === '-' && body[i + 2] !== undefined && body[i + 2] !== ']') {
      const a = body.codePointAt(i);
      const b = body.codePointAt(i + 2);
      if (a > b || b - a > 1024) return null;
      for (let c = a; c <= b; c++) out.push(String.fromCodePoint(c));
      i += 2;
    } else {
      out.push(body[i]);
    }
  }
  return out;
}

/** 把 RegExp 的英文报错转成更贴近中文查询习惯的提示。 */
function describeError(msg, src) {
  const m = /Invalid regular expression: \/(.*)\/: (.*)/.exec(msg);
  const reason = m ? m[2] : msg;
  const map = [
    [/Unterminated character class/i, '字符类缺少右方括号 ]'],
    [/Unmatched \)/i, '多了一个右括号 )'],
    [/Unterminated group/i, '分组缺少右括号 )'],
    [/Nothing to repeat/i, '量词前面缺少内容'],
    [/Lone quantifier brackets/i, '量词写法不完整'],
    [/Invalid escape/i, '无效的转义'],
    [/Invalid character class/i, '字符类范围不合法'],
    [/Incomplete quantifier/i, '量词写法不完整'],
  ];
  for (const [re, text] of map) if (re.test(reason)) return `${text}（模式：${src}）`;
  return `${reason}（模式：${src}）`;
}

export function compilePattern(pattern) {
  return new Regex(pattern);
}
