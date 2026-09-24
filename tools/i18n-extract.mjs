/**
 * 语言包键集抽取：扫描 src/ 下的字符串字面量与 index.html 里标注了 data-i18n /
 * data-i18n-attr 的静态骨架文案，把含中日韩文字（CJK）的界面文案汇总成
 * 「规范键集」写入 src/i18n/locales/zh-CN.js，并检查各译语言包是否漏译。
 * 用法：node tools/i18n-extract.mjs [--check]
 *
 * 键的取值规则：
 *   - 普通字符串取其运行时的真实值（会做转义还原，'\n' → 换行）；
 *   - 模板字面量把 ${表达式} 依次归一成 {0}、{1}……于是
 *     `第 ${tick} 步` 的键就是 `第 {0} 步`，占位符按位置命名，
 *     译者在目标语言里可自由调整语序（如英文写成 `Step {0}`）；
 *     表达式原文会作为行尾注释保留，供译者判断占位符是什么。
 *   - 语言包的键即「中文原文」，运行时 t() 用原文查表，无需给每处界面文案另起键名。
 *
 * --check：只比对不写文件，用于测试与 CI 中确认源码没有漏登记的新文案。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const SRC = path.join(root, 'src');
const LOCALES_DIR = path.join(SRC, 'i18n', 'locales');
const ZH_CN = path.join(LOCALES_DIR, 'zh-CN.js');
/** 语言包的规范语言代码，顺序与 languageList() 一致 */
const TARGETS = ['zh-TW', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'pt', 'ru'];
/**
 * 语言代码 → 语言包里导出的常量名。
 * 一律用具名导出（而非 export default）：tools/build-single-file.mjs 打包时
 * 只删除 `export` 关键字、再按 import 的名字从模块里取导出，
 * 默认导出既不会被识别也取不到，打成单文件后会报语法错误。
 */
const EXPORT_NAMES = {
  'zh-CN': 'zhCN', 'zh-TW': 'zhTW', en: 'en', ja: 'ja', ko: 'ko',
  fr: 'fr', de: 'de', es: 'es', pt: 'pt', ru: 'ru',
};
const CHECK_ONLY = process.argv.includes('--check');

const WORD_CHAR = /[A-Za-z0-9_$]/;
const REGEX_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'do', 'else', 'case', 'yield', 'await', 'throw',
]);
/** 判定「是否需要翻译」的字符：汉字、假名、韩文、中日韩标点与全角标点、中文引号省略号 */
const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff01-\uff60\u2018\u2019\u201c\u201d\u2026]/;
/**
 * 「纯占位符 + 全角标点」的骨架句式白名单（与 src/i18n/index.js 的 SKELETON_PATTERNS 保持一致）：
 * 这些键不含实义文字，只负责把运行期拼出来的片段用目标语言的标点重新连起来，
 * 按「无汉字即排版符号」的规则会被丢掉，故单独放行。
 */
const SKELETON_KEYS = new Set(['{0}（{1}）', '{0}：{1} → {2}', '{0}：{1}']);

function regexAllowedAt(code, i) {
  let k = i - 1;
  while (k >= 0 && /\s/.test(code[k])) k--;
  if (k < 0) return true;
  if (WORD_CHAR.test(code[k])) {
    let s = k;
    while (s >= 0 && WORD_CHAR.test(code[s])) s--;
    return REGEX_KEYWORDS.has(code.slice(s + 1, k + 1));
  }
  return '([{;,=:+-*/%<>!&|?~^'.includes(code[k]);
}

/** 还原单/双引号字符串里的转义序列，得到运行时真实值 */
function unescapeString(raw) {
  let s = raw;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '\\') { out += s[i]; continue; }
    const c = s[++i];
    if (c === undefined) break;
    if (c === 'n') out += '\n';
    else if (c === 'r') out += '\r';
    else if (c === 't') out += '\t';
    else if (c === 'b') out += '\b';
    else if (c === 'f') out += '\f';
    else if (c === 'v') out += '\v';
    else if (c === '0') out += '\0';
    else if (c === 'u') {
      if (s[i + 1] === '{') {
        const end = s.indexOf('}', i);
        out += String.fromCodePoint(Number.parseInt(s.slice(i + 2, end), 16));
        i = end;
      } else {
        out += String.fromCharCode(Number.parseInt(s.slice(i + 1, i + 5), 16));
        i += 4;
      }
    } else if (c === 'x') { out += String.fromCharCode(Number.parseInt(s.slice(i + 1, i + 3), 16)); i += 2; }
    else out += c; // \' \" \\ \` 等
  }
  return out;
}

/**
 * 扫描源码里的字符串与模板字面量。
 * 逐字符遍历并跳过注释与正则，保证不会把注释里的中文当成界面文案。
 * 返回 [{ key, raw }]：key 是归一后的键（模板里的 ${表达式} 依次替换为 {0}、{1}……），
 * raw 是模板原文（普通字符串为 null），仅用于在语言包里生成辅助注释。
 */
function scanLiterals(code) {
  const found = [];
  let i = 0;
  const n = code.length;
  while (i < n) {
    const c = code[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && code[j] !== c && code[j] !== '\n') {
        if (code[j] === '\\') j++;
        j++;
      }
      found.push({ key: unescapeString(code.slice(i + 1, j)), raw: null });
      i = j + 1;
      continue;
    }
    if (c === '`') {
      let j = i + 1;
      let out = '';
      let slots = 0;
      while (j < n) {
        if (code[j] === '\\') { out += unescapeString(code.slice(j, j + 2)); j += 2; continue; }
        if (code[j] === '`') break;
        if (code[j] === '$' && code[j + 1] === '{') {
          let depth = 1;
          let k = j + 2;
          while (k < n && depth > 0) {
            if (code[k] === '{') depth++;
            else if (code[k] === '}') depth--;
            k++;
          }
          out += `{${slots++}}`;
          j = k;
          continue;
        }
        out += code[j];
        j++;
      }
      found.push({ key: out, raw: slots ? code.slice(i, j + 1) : null });
      i = j + 1;
      continue;
    }
    if (c === '/' && code[i + 1] === '/') {
      const j = code.indexOf('\n', i);
      i = j === -1 ? n : j;
      continue;
    }
    if (c === '/' && code[i + 1] === '*') {
      const j = code.indexOf('*/', i + 2);
      i = j === -1 ? n : j + 2;
      continue;
    }
    if (c === '/' && regexAllowedAt(code, i)) {
      let j = i + 1;
      let inClass = false;
      while (j < n) {
        if (code[j] === '\\') { j += 2; continue; }
        if (code[j] === '[') inClass = true;
        else if (code[j] === ']') inClass = false;
        else if (code[j] === '/' && !inClass) break;
        else if (code[j] === '\n') break;
        j++;
      }
      i = j + 1;
      continue;
    }
    i++;
  }
  return found;
}

const HTML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };

/** 还原 HTML 实体，得到浏览器里的真实文本（与运行时 textContent 对齐） */
function decodeEntities(s) {
  return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return HTML_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * 抽取 index.html 里的静态文案：
 *   <h2 data-i18n>页面未能启动</h2>            —— 元素文本
 *   <aside data-i18n-attr="aria-label" ...>    —— 指定属性的值
 * 顶栏副标题、无障碍标签这类骨架文案只写在 HTML 里，src/ 里扫不到；
 * 不登记的话 localizeStatic 查不到条目，切换语言时这几处仍是中文。
 * 文本不做 trim：运行时比对的是 textContent 原值（含首尾空格）。
 */
function scanHtml(code) {
  const found = [];
  const tagRe = /<([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  let m;
  while ((m = tagRe.exec(code))) {
    const attrs = m[2];
    const attr = (name) => {
      const hit = attrs.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`));
      return hit ? (hit[1] ?? hit[2] ?? hit[3] ?? '') : null;
    };
    const names = attr('data-i18n-attr');
    if (names) {
      for (const name of names.split(',')) {
        const key = name.trim();
        const value = key ? attr(key) : null;
        if (value) found.push({ key: decodeEntities(value), raw: null });
      }
    }
    if (/(?:^|\s)data-i18n(?:\s|$)/.test(attrs)) {
      const end = code.indexOf('<', tagRe.lastIndex);
      const text = code.slice(tagRe.lastIndex, end === -1 ? code.length : end);
      if (text.trim()) found.push({ key: decodeEntities(text), raw: null });
    }
  }
  return found;
}

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      if (p === path.join(SRC, 'i18n')) continue; // 语言包自身不参与抽取
      walk(p, out);
    } else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

/** 登记一条文案：只收「含中文且不止是纯标点」的（整串没有汉字/假名/韩文时，全角标点多半是排版符号） */
function register(keys, perFile, rel, key, raw) {
  if (!CJK.test(key)) return;
  if (!/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(key) && !SKELETON_KEYS.has(key)) return;
  if (key.length > 400) return; // 超长多行文本（如导出模板）不逐条翻译
  if (keys.has(key)) return;
  keys.set(key, { file: rel, raw });
  perFile.set(rel, (perFile.get(rel) || 0) + 1);
}

/** 抽取结果：键 → { file, raw }，raw 为该键首个出现的模板原文（用于注释） */
function collect() {
  const keys = new Map();
  const perFile = new Map();
  for (const file of walk(SRC).sort()) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    for (const { key, raw } of scanLiterals(fs.readFileSync(file, 'utf8'))) {
      register(keys, perFile, rel, key, raw);
    }
  }
  // 静态骨架文案（顶栏副标题、无障碍标签）只写在 index.html 里，同样要登记
  const html = path.join(root, 'index.html');
  if (fs.existsSync(html)) {
    for (const { key, raw } of scanHtml(fs.readFileSync(html, 'utf8'))) {
      register(keys, perFile, 'index.html', key, raw);
    }
  }
  return { keys, perFile };
}

/** 生成一行键值对，模板来源以行尾注释保留，方便译者判断占位符指代什么 */
function renderEntry(key, raw) {
  const entry = `  ${JSON.stringify(key)}: ${JSON.stringify(key)},`;
  if (!raw) return entry;
  const comment = ` // ${raw.replace(/\s*\n\s*/g, ' ').replace(/\*\//g, '*\\/')}`;
  return entry + (entry.length + comment.length > 200 ? '' : comment);
}

function renderZhCn(keys) {
  const groups = new Map();
  for (const [key, meta] of keys) {
    if (!groups.has(meta.file)) groups.set(meta.file, []);
    groups.get(meta.file).push([key, meta.raw]);
  }
  const lines = [
    '/**',
    ' * 简体中文语言包（规范键集）。',
    ' *',
    ' * 本文件由 tools/i18n-extract.mjs 自动生成，键即「中文原文」，值保持与键一致：',
    ' * 简体中文是源语言，运行时无需查表，这份文件的作用是集中登记全部界面文案，',
    ' * 供其它语言包对齐键集，并让「源码里新增了一句文案但漏了翻译」在测试中立刻暴露。',
    ' * 不要手改：新增/调整界面文案后运行 node tools/i18n-extract.mjs 重新生成。',
    ' */',
    'export const zhCN = {',
  ];
  for (const [file, list] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`  // ---------- ${file}（${list.length} 条） ----------`);
    for (const [key, raw] of list.sort((a, b) => a[0].localeCompare(b[0]))) lines.push(renderEntry(key, raw));
  }
  lines.push('};', '');
  return lines.join('\n');
}

const { keys, perFile } = collect();
console.log(`抽取到含中文的界面文案：${keys.size} 条`);
for (const [file, count] of [...perFile].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(4)}  ${file}`);
}

let failed = false;
if (!CHECK_ONLY) {
  fs.mkdirSync(LOCALES_DIR, { recursive: true });
  fs.writeFileSync(ZH_CN, renderZhCn(keys), 'utf8');
  console.log(`已写入 ${path.relative(root, ZH_CN)}`);
} else if (fs.existsSync(ZH_CN)) {
  const current = (await import(pathToFileURL(ZH_CN).href))[EXPORT_NAMES['zh-CN']];
  const missing = [...keys.keys()].filter((k) => !(k in current));
  const stale = Object.keys(current).filter((k) => !keys.has(k));
  if (missing.length) {
    failed = true;
    console.log(`\n✗ 有 ${missing.length} 条源码文案未登记到 zh-CN.js：`);
    for (const k of missing.slice(0, 20)) console.log(`    ${JSON.stringify(k)}`);
  }
  if (stale.length) {
    failed = true;
    console.log(`\n✗ zh-CN.js 有 ${stale.length} 条已失效的键：`);
    for (const k of stale.slice(0, 20)) console.log(`    ${JSON.stringify(k)}`);
  }
  if (!missing.length && !stale.length) console.log('✓ zh-CN.js 与源码文案一致');
}

// 各译语言包：键集必须与规范键集完全一致，缺译/多译都视为失败
for (const code of TARGETS) {
  const file = path.join(LOCALES_DIR, `${code}.js`);
  if (!fs.existsSync(file)) {
    failed = true;
    console.log(`\n✗ 缺少语言包 ${code}.js`);
    continue;
  }
  const dict = (await import(pathToFileURL(file).href))[EXPORT_NAMES[code]];
  if (!dict || typeof dict !== 'object') {
    failed = true;
    console.log(`\n✗ ${code}.js 未导出名为 ${EXPORT_NAMES[code]} 的对象`);
    continue;
  }
  const missing = [...keys.keys()].filter((k) => !(k in dict));
  const extra = Object.keys(dict).filter((k) => !keys.has(k));
  const empty = Object.keys(dict).filter((k) => !String(dict[k] || '').trim());
  if (missing.length || extra.length || empty.length) {
    failed = true;
    console.log(`\n✗ ${code}.js：缺 ${missing.length} / 多 ${extra.length} / 空值 ${empty.length}`);
    for (const k of missing.slice(0, 10)) console.log(`    缺 ${JSON.stringify(k)}`);
    for (const k of extra.slice(0, 10)) console.log(`    多 ${JSON.stringify(k)}`);
    for (const k of empty.slice(0, 10)) console.log(`    空 ${JSON.stringify(k)}`);
  } else {
    console.log(`✓ ${code}.js 键集完整（${Object.keys(dict).length} 条）`);
  }
}

if (failed) process.exitCode = 1;
