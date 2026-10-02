"""验证三个候选查询在本机数据上是否可行。

1. 字 X: 既能与「风」组成 X风, 又能与「金」组成 金X
2. 四字词, 每字均 9 画
3. 字: 声调一声 + 声母 zh + 第一笔为点
"""
import io
import json
import re
import unicodedata
from collections import defaultdict

ROOT = r'D:\Dispher\工作区\2'

# ---------- 载入字属性 ----------
strokes_of = {}
pinyin_of = {}
stroke_seq_of = {}
print('载入 hz_full.jsonl ...')
with io.open(f'{ROOT}/hz_full.jsonl', encoding='utf-8') as f:
    for line in f:
        r = json.loads(line)
        ch = r['char']
        if r.get('strokes_total'):
            strokes_of[ch] = r['strokes_total']
        if r.get('pinyin'):
            pinyin_of[ch] = r['pinyin'][0]
        if r.get('stroke_seq'):
            stroke_seq_of[ch] = r['stroke_seq']
print(f'  笔画 {len(strokes_of)} 字, 拼音 {len(pinyin_of)} 字, 笔顺 {len(stroke_seq_of)} 字')

# ---------- 载入词表 ----------
words = set()
wl = f'{ROOT}/nutrimatic-zh/data/wordlist.tsv'
try:
    with io.open(wl, encoding='utf-8') as f:
        for line in f:
            w = line.split('\t')[0].strip()
            if w:
                words.add(w)
except FileNotFoundError:
    print(f'  [warn] 无 {wl}')
print(f'  词表 {len(words)} 条')

# ================= 查询 1 =================
print('\n=== 查询1: X 与风成 X风, 且与金成 金X ===')
has_feng = {w[0] for w in words if len(w) == 2 and w[1] == '风'}
has_jin = {w[1] for w in words if len(w) == 2 and w[0] == '金'}
both = has_feng & has_jin
print(f'  X风 首字候选: {len(has_feng)}')
print(f'  金X 末字候选: {len(has_jin)}')
print(f'  交集: {len(both)} -> {"".join(sorted(both)[:40])}')

# ================= 查询 2 =================
print('\n=== 查询2: 四字词, 每字 9 画 ===')
nine = {c for c, n in strokes_of.items() if n == 9}
print(f'  9 画字: {len(nine)}')
res4 = [w for w in words if len(w) == 4 and all(c in nine for c in w)]
print(f'  命中 {len(res4)} 条: {" ".join(sorted(res4)[:25])}')

# ================= 查询 3 =================
print('\n=== 查询3: 一声 + 声母 zh + 首笔为点 ===')


def tone_of(py):
    """返回 (声调数字, 无声调拼音)。轻声为 0。"""
    parts = py.split('/')
    out = []
    for p in parts:
        p = p.strip().lower()
        if not p:
            continue
        # 去掉非字母(如 ǖ 之类保留)
        if re.search(r'[\u0100-\u01ff\u1e00-\u1eff]', p):
            base = unicodedata.normalize('NFD', p)
            # 声调符号在 NFD 下成为独立组合字符
            marks = [ch for ch in base if unicodedata.combining(ch)]
            tone = 0
            for m in marks:
                if m == '\u0304':
                    tone = 1
                elif m == '\u0301':
                    tone = 2
                elif m == '\u030c':
                    tone = 3
                elif m == '\u0300':
                    tone = 4
            stripped = ''.join(ch for ch in base if not unicodedata.combining(ch))
            out.append((tone, stripped))
        else:
            out.append((0, p))
    return out


def initial_of(py):
    """提取声母(zh/ch/sh 优先)。"""
    for ini in ('zh', 'ch', 'sh'):
        if py.startswith(ini):
            return ini
    if py and py[0] in 'bpmfdtnlgkhjqxrzcsyw':
        return py[0]
    return ''


zh_first_tone_dot = []
for ch, py in pinyin_of.items():
    for tone, plain in tone_of(py):
        if tone == 1 and initial_of(plain) == 'zh':
            seq = stroke_seq_of.get(ch) or []
            if seq and seq[0] == '点':
                zh_first_tone_dot.append(ch)
            break
print(f'  一声+zh 的字: {len([c for c in pinyin_of if any(t == 1 and initial_of(p) == "zh" for t, p in tone_of(pinyin_of[c]))])}')
print(f'  再叠加首笔为点: {len(zh_first_tone_dot)} -> {"".join(sorted(zh_first_tone_dot))}')
for ch in sorted(zh_first_tone_dot)[:20]:
    print(f'    {ch}  拼音={pinyin_of[ch]}  首笔={stroke_seq_of[ch][0]}  笔画={strokes_of.get(ch)}')

# ================= 自定义: 两属性同时满足的字 =================
print('\n=== 附: 一声+zh 且 9 画 ===')
r = [c for c in zh_first_tone_dot if strokes_of.get(c) == 9]
print(f'  -> {"".join(sorted(r)) if r else "(空)"}')
