/**
 * 股票名称 → 拼音首字母（用于搜索框打首字母直接命中，如 zcfw → 中船防务）。
 *
 * 不引入拼音词库：Node 自带完整 ICU，`Intl.Collator('zh-Hans-u-co-pinyin')`
 * 按拼音顺序比较汉字，于是拿 23 个声母各自的一个「代表字」当分界点，
 * 逐个比较就能定位任意汉字落在哪个声母区间。一个汉字最多 23 次比较，
 * 结果按字缓存，5000 多只票只算一次。
 *
 * 已知缺陷：多音字只会取 ICU 的默认读音。股票名里高频的几个用 POLYPHONE
 * 单独补一份备选串（长江 cjdl / 银行 yh），两串都入库参与匹配。
 */

const LETTERS = 'abcdefghjklmnopqrstwxyz'.split('');

/** 每个声母区间的下界：unihan 里该声母的首字，按拼音序升序 */
const BOUNDS: Record<string, string> = {
  a: '阿',
  b: '八',
  c: '擦',
  d: '搭',
  e: '蛾',
  f: '发',
  g: '噶',
  h: '哈',
  j: '击',
  k: '喀',
  l: '垃',
  m: '妈',
  n: '拿',
  o: '哦',
  p: '啪',
  q: '期',
  r: '然',
  s: '撒',
  t: '塌',
  w: '挖',
  x: '昔',
  y: '压',
  z: '匝',
};

let collator: Intl.Collator | null | undefined;

function getCollator(): Intl.Collator | null {
  if (collator !== undefined) return collator;
  try {
    collator = new Intl.Collator('zh-Hans-u-co-pinyin');
  } catch {
    // 极少数运行环境裁掉了 ICU 的中文排序数据
    collator = null;
  }
  return collator;
}

/** 汉字 → 声母，非汉字返回空串。结果缓存 */
const charCache = new Map<string, string>();

function initialOf(ch: string): string {
  const hit = charCache.get(ch);
  if (hit !== undefined) return hit;

  let out = '';
  const col = getCollator();
  if (col) {
    for (const L of LETTERS) {
      if (col.compare(ch, BOUNDS[L]) >= 0) out = L;
      else break;
    }
    if (!out) out = 'a';
  }
  charCache.set(ch, out);
  return out;
}

/**
 * 多音字的备选声母。只收股票名里真正高频的：
 * 长（长江/长城/长春 念 cháng，ICU 给 z）、行（银行 念 háng，ICU 给 x）、
 * 重（重庆 念 chóng）、厦（厦门 念 xià）、藏（西藏 念 zàng）等。
 */
const POLYPHONE: Record<string, string> = {
  行: 'h',
  长: 'c',
  重: 'c',
  厦: 'x',
  藏: 'z',
  曾: 'z',
  会: 'k',
  番: 'p',
  单: 's',
  查: 'z',
  解: 'x',
  区: 'o',
};

/** 名称里的汉字与字母都算一个音位；数字与符号跳过（*ST 之类的前后缀不影响） */
function charsOf(name: string): string[] {
  return [...name].filter((c) => /[\u4e00-\u9fff]/.test(c) || /[a-zA-Z]/.test(c));
}

/** 拼音首字母，全小写。如「中船防务」→ zcfw、「TCL科技」→ tclkj */
export function pinyinInitials(name: string): string {
  let out = '';
  for (const c of charsOf(name)) {
    if (c.charCodeAt(0) < 128) out += c.toLowerCase();
    else out += initialOf(c);
  }
  return out;
}

/** 多音字改用备选读音的整串；与主串相同则返回空串（省一列存储与一次 LIKE） */
export function pinyinInitialsAlt(name: string): string {
  let out = '';
  let changed = false;
  for (const c of charsOf(name)) {
    if (c.charCodeAt(0) < 128) {
      out += c.toLowerCase();
      continue;
    }
    const alt = POLYPHONE[c];
    if (alt) {
      out += alt;
      if (alt !== initialOf(c)) changed = true;
    } else {
      out += initialOf(c);
    }
  }
  return changed ? out : '';
}
