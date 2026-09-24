/**
 * 轻量国际化（i18n）运行时。
 *
 * 设计取舍：本项目的界面文案直接以「中文原文」写在源码里，中文即源语言，
 * 因此不必再给上千处文案另起键名（如 config.grid.width）——那既费时又容易与界面脱节。
 * 语言包（locales/*.js）以中文原文为键，译文为值，等价于 gettext 的 msgid/msgstr 模型。
 *
 * 于是翻译在「渲染边界」统一发生：src/ui/forms.js 里所有写入 DOM 的文本与
 * title / placeholder / aria-label 属性都会先经过 t()，源码中的 900 余处调用点无需改动。
 *
 * t() 支持三种入参形态：
 *   1. t('尚未运行模拟')                      —— 整串精确查表；
 *   2. t('共 {0} 项', { 0: n })               —— 带占位符的文案，占位符按名替换（值也会被翻译）；
 *   3. t(`第 ${tick} / ${total} 步`)          —— 运行时拼接出的整句，
 *      第 1 种查不到时按「句式」匹配：语言包里 {0} 步 的键会编译成正则，
 *      捕获到的片段再递归翻译，因此「日志：在前方产生 3 个障碍物」这类层层嵌套的句子也能完整译出。
 *
 * 未命中任何条目时原样返回，用户数据（自定义命名等）不会被误翻。
 */

// 语言包用具名导出：单文件打包器只删 `export` 关键字、再按 import 的名字取导出，
// 默认导出（export default）不会被识别，打成单文件后会残留语法错误。
import { zhCN } from './locales/zh-CN.js';
import { zhTW } from './locales/zh-TW.js';
import { en } from './locales/en.js';
import { ja } from './locales/ja.js';
import { ko } from './locales/ko.js';
import { fr } from './locales/fr.js';
import { de } from './locales/de.js';
import { es } from './locales/es.js';
import { pt } from './locales/pt.js';
import { ru } from './locales/ru.js';

/** 源语言：界面文案的书写语言，其语言包即规范键集（键值相同） */
export const SOURCE_LOCALE = 'zh-CN';

/** 语言代码 → 语言包。键为 BCP 47 语言标签，与 <html lang> 一致 */
const MESSAGES = {
  'zh-CN': zhCN,
  'zh-TW': zhTW,
  en,
  ja,
  ko,
  fr,
  de,
  es,
  pt,
  ru,
};

/** 语言名称用各语言自身的写法（界面语言选择器里即如此显示，无需被翻译） */
const LOCALE_NAMES = {
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文',
  en: 'English',
  ja: '日本語',
  ko: '한국어',
  fr: 'Français',
  de: 'Deutsch',
  es: 'Español',
  pt: 'Português',
  ru: 'Русский',
};

/** 从上到下书写（RTL）的语言；本轮尚未收录阿拉伯语等，先把开关留在这里 */
const RTL_LOCALES = new Set(['ar', 'he', 'fa', 'ur']);

const STORAGE_KEY = 'gridsneaker:locale';

/** 判定「是否需要翻译」：汉字、假名、韩文、中日韩标点与全角标点、中文引号省略号 */
const HAS_CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff01-\uff60\u2018\u2019\u201c\u201d\u2026]/;
/** 句式匹配要求键里含实义文字（不能只有占位符），否则 {0} 之类会变成匹配一切的通配规则 */
const HAS_WORD = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/;
/**
 * 骨架句式白名单（与 tools/i18n-extract.mjs 的 SKELETON_KEYS 保持一致）：
 * 这几条不含实义文字，只负责把运行期拼出来的片段（各段已是译文）用目标语言的
 * 标点与语序重新连起来，例如「空格（empty）」在英文下应为 "Empty cell (empty)"。
 * 没有它们，这类拼接串会整体落在语言包之外、恒为源码语言。
 */
export const SKELETON_PATTERNS = new Set(['{0}（{1}）', '{0}：{1} → {2}', '{0}：{1}']);

/** 递归翻译的层数上限：句子 → 片段 → 更小片段，足够覆盖描述型文案，又避免病态递归 */
const MAX_DEPTH = 4;
/** 超过此长度的字符串不做句式匹配（多为导出内容等长文本，避免正则回溯开销） */
const MAX_PATTERN_LEN = 240;

let current = SOURCE_LOCALE;
const listeners = new Set();

/* ------------------------------------------------------------------ */
/* 语言注册与切换                                                      */
/* ------------------------------------------------------------------ */

/** 可选语言列表（供语言选择器渲染） */
export function localeList() {
  return Object.keys(MESSAGES).map((code) => ({ code, name: LOCALE_NAMES[code] }));
}

/** 当前语言代码 */
export function currentLocale() {
  return current;
}

/**
 * 把任意语言标签（如 zh-Hant-HK、en-GB、ja-JP）归一到受支持的语言代码。
 * 匹配不到时返回 null，由调用方决定回退策略。
 */
export function matchLocale(tag) {
  const t = String(tag || '').trim().toLowerCase().replace(/_/g, '-');
  if (!t) return null;
  if (MESSAGES[t]) return t;
  const [lang, script, region] = t.split('-');
  if (lang === 'zh') {
    // 繁体：显式脚本（Hant）或港澳台地区；其余中文一律按简体处理
    if (script === 'hant' || ['tw', 'hk', 'mo'].includes(script)) return 'zh-TW';
    if (script === 'hans') return 'zh-CN';
    return ['tw', 'hk', 'mo'].includes(region) ? 'zh-TW' : 'zh-CN';
  }
  if (MESSAGES[lang]) return lang;
  return null;
}

/**
 * 推断初始语言：优先用户上次的手动选择，其次按浏览器语言依次匹配，
 * 都不支持时回退到英语（对非中文用户而言英文比中文更可读）。
 */
export function detectLocale() {
  const saved = readSaved();
  if (saved && MESSAGES[saved]) return saved;
  const tags = typeof navigator === 'object' && navigator
    ? (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language])
    : [];
  for (const tag of tags) {
    const hit = matchLocale(tag);
    if (hit) return hit;
  }
  return 'en';
}

function readSaved() {
  try {
    return localStorage.getItem(STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

/**
 * 切换语言。
 * @param {string} code 语言代码；不支持时忽略
 * @param {object} [opts]
 * @param {boolean} [opts.persist=true] 是否记住该选择（自动匹配时不写存储）
 * @returns {boolean} 是否发生了变化
 */
export function setLocale(code, opts = {}) {
  const next = MESSAGES[code] ? code : null;
  if (!next) return false;
  if (opts.persist !== false) {
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* file:// 或隐私模式下可能不可写，忽略即可 */
    }
  }
  if (next === current) return false;
  current = next;
  applyDocumentLang();
  for (const fn of [...listeners]) fn(next);
  return true;
}

/** 按系统设置初始化语言（不写入存储，用户的显式选择优先） */
export function initLocale() {
  current = detectLocale();
  applyDocumentLang();
  return current;
}

/** 订阅语言变化（用于切换后重建界面） */
export function onLocaleChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 同步 <html lang> 与书写方向；配合 CSS 逻辑属性即可支持 RTL 布局 */
export function applyDocumentLang() {
  if (typeof document === 'undefined' || !document.documentElement) return;
  const root = document.documentElement;
  root.setAttribute('lang', current);
  root.setAttribute('dir', RTL_LOCALES.has(current.split('-')[0]) ? 'rtl' : 'ltr');
}

/* ------------------------------------------------------------------ */
/* 翻译                                                                */
/* ------------------------------------------------------------------ */

/**
 * 翻译任意字符串（精确查表 → 句式匹配 → 原样返回）。
 * 不含中日韩文字的字符串直接放行，既是性能快路径，也保证数字、代码、用户输入不被误翻。
 */
export function t(key, params) {
  if (key === null || key === undefined || key === false) return key;
  const text = String(key);
  const translated = translate(text, 0);
  return params ? fillNamed(translated, params) : translated;
}

/** 供 DOM 渲染边界使用：单参数版本，可安全用于 Text 节点内容 */
export function translateText(text) {
  return t(text);
}

function translate(text, depth) {
  if (!text || !HAS_CJK.test(text)) return text;
  if (current === SOURCE_LOCALE) return text; // 源语言即原文，无需查表
  const dict = MESSAGES[current];
  const hit = dict[text];
  if (hit !== undefined) return hit;
  // 多行文本（如画布悬浮提示的多行说明）整串查不到，逐行翻译后再拼回。
  // 句式规则用的是 ^...$ 单行匹配，拆行后每行才可能命中。
  if (text.includes('\n')) return text.split('\n').map((line) => translate(line, depth)).join('\n');
  const pack = packOf(current);
  const cached = pack.memo.get(text);
  if (cached !== undefined) return cached;
  const out = depth < MAX_DEPTH ? byPattern(text, pack, depth) : text;
  if (pack.memo.size > 4000) pack.memo.clear();
  pack.memo.set(text, out);
  return out;
}

/** 逐条尝试句式规则；规则按「实义文字越多越靠前」排序，先命中先返回 */
function byPattern(text, pack, depth) {
  if (text.length > MAX_PATTERN_LEN) return text;
  for (const rule of pack.rules) {
    const m = rule.re.exec(text);
    if (!m) continue;
    let out = '';
    for (const piece of rule.out) {
      if (piece.text !== undefined) {
        out += piece.text;
        continue;
      }
      // 捕获片段本身可能还是中文（如「日志：在前方产生 3 个障碍物」里的后半句），递归再翻一层
      const cap = m[piece.slot + 1];
      out += cap === undefined ? '' : translate(cap, depth + 1);
    }
    return out;
  }
  return text;
}

/* ---- 语言包 → 句式规则（惰性编译） ---- */

const PACKS = new Map();

function packOf(code) {
  let pack = PACKS.get(code);
  if (!pack) {
    pack = { rules: [], memo: new Map() };
    for (const key of Object.keys(MESSAGES[code])) {
      const rule = compileRule(key, MESSAGES[code][key]);
      if (rule) pack.rules.push(rule);
    }
    // 实义文字多的规则更具体，优先匹配，避免「清空全部 {0}」抢走「清空全部 {0}（{1} 格）」
    pack.rules.sort((a, b) => b.wordCount - a.wordCount || b.key.length - a.key.length);
    PACKS.set(code, pack);
  }
  return pack;
}

/**
 * 把一条语言包条目编译成句式规则：
 *   「在{0}产生 {1} 个{2}」→ /^在(.*?)产生 (.*?) 个(.*?)$/，译文里的 {n} 依次回填捕获片段。
 * 不含 {n} 占位符、或占位符之外没有实义文字的条目返回 null（这类条目只走精确查表）；
 * SKELETON_PATTERNS 里的纯标点骨架句式是例外，它们专门用来拼接运行期片段。
 */
function compileRule(key, value) {
  if (!key.includes('{')) return null;
  const skeleton = SKELETON_PATTERNS.has(key);
  if (!HAS_WORD.test(key) && !skeleton) return null;
  const source = [];
  const re = /\{(\d+)\}/g;
  let last = 0;
  let slots = 0;
  let m;
  while ((m = re.exec(key))) {
    source.push(escapeRegExp(key.slice(last, m.index)), '(.*?)');
    last = m.index + m[0].length;
    slots++;
  }
  if (!slots) return null;
  source.push(escapeRegExp(key.slice(last)));
  const wordCount = (key.replace(/\{\d+\}/g, '').match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  if (!wordCount && !skeleton) return null;
  return {
    key,
    re: new RegExp(`^${source.join('')}$`),
    out: splitTemplate(value),
    wordCount,
  };
}

/** 把译文模板拆成 [{ text } | { slot: n }] 片段序列 */
function splitTemplate(value) {
  const out = [];
  const text = String(value);
  const re = /\{(\d+)\}/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    out.push({ text: text.slice(last, m.index) });
    out.push({ slot: Number(m[1]) });
    last = m.index + m[0].length;
  }
  out.push({ text: text.slice(last) });
  return out;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 按名替换占位符；替换值同样会被翻译（如 t('长度 {n}', { n: stateLabel(x) })） */
function fillNamed(template, params) {
  return String(template).replace(/\{([^{}]+)\}/g, (whole, name) => {
    if (!(name in params)) return whole;
    return translate(String(params[name]), 0);
  });
}

/**
 * 为静态 HTML（index.html）提供本地化：
 *   <h2 data-i18n>页面未能启动</h2>            —— 元素文本按原文查表
 *   <aside data-i18n-attr="aria-label" ...>    —— 指定属性按原值查表
 * 原文会记录在元素上，切换语言时可反复应用而不累积。
 */
export function localizeElement(el) {
  if (el.dataset && el.hasAttribute('data-i18n')) {
    // 首次调用时把原文记进 dataset，之后反复应用不会累积；
    // 静态兜底脚本改写过的节点会自行写好 data-i18n-src（简体原文），这里直接沿用它作查表依据
    if (el.dataset.i18nSrc === undefined) el.dataset.i18nSrc = el.textContent;
    el.textContent = t(el.dataset.i18nSrc);
  }
  const attrs = el.getAttribute && el.getAttribute('data-i18n-attr');
  if (attrs) {
    for (const name of attrs.split(',').map((s) => s.trim()).filter(Boolean)) {
      const store = `i18nSrc${name.replace(/[^a-zA-Z0-9]/g, '')}`;
      if (el.dataset[store] === undefined) el.dataset[store] = el.getAttribute(name) || '';
      el.setAttribute(name, t(el.dataset[store]));
    }
  }
}

/** 本地化整个文档中的静态文案（由 app 初始化与语言切换时调用） */
export function localizeStatic(root = typeof document === 'undefined' ? null : document) {
  if (!root) return;
  for (const el of root.querySelectorAll('[data-i18n],[data-i18n-attr]')) localizeElement(el);
}
