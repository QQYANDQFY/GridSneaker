/**
 * 把 src/ 下的 ES Module 打包进单个 HTML 文件（无需 HTTP 服务器，双击即可打开）。
 * 用法：node tools/build-single-file.mjs
 *
 * 打包方式：按依赖顺序把每个模块包成一个 IIFE，模块之间通过 __MODULES 表解构传递导出，
 * 从而避免不同模块顶层同名声明（如 COMPARATORS、lerpColor）互相冲突。
 * 产物内联的 JS / CSS 会做轻量压缩（去注释、去缩进），源码本身保持完整可读。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const ENTRY = path.join(root, 'src', 'ui', 'app.js');
const OUTPUT = path.join(root, 'GridSneaker.html');
/** 传入 --no-minify 时输出未压缩产物（GridSneaker.raw.html），便于排查压缩引入的问题 */
const MINIFY = !process.argv.includes('--no-minify');
const TARGET = MINIFY ? OUTPUT : OUTPUT.replace(/\.html$/, '.raw.html');

/* ------------------------------------------------------------------ */
/* 轻量压缩                                                            */
/* ------------------------------------------------------------------ */

const WORD_CHAR = /[A-Za-z0-9_$]/;
/** 两侧同时是这些符号时中间的空格不能丢，否则可能粘连成 ++ / -- / // 等另一个记号 */
const OPERATOR_CHAR = new Set('+-*/%<>=!&|^~?');
/** 上一个记号是这些关键字时，紧跟的 `/` 是正则字面量而非除号 */
const REGEX_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'do', 'else', 'case', 'yield', 'await', 'throw',
]);

/**
 * 判断 code[i]（该处字符为 `/`）是否为正则字面量起点：
 * 向前跳过空白取上一个有效记号——关键字之后是正则，其它标识符 / 字面量之后是除号。
 */
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

/**
 * 字符串 / 模板 / 正则 / 注释感知的扫描器。
 * 逐字符遍历源码：字面量整体回调（kind='literal'），块注释回调（kind='comment'），
 * 行注释直接跳过，其余字符逐个以 kind='code' 回调。
 * 因此既不会误伤模板字符串里的换行与缩进，也不会把正则里的 `/` 当成注释。
 */
function scanJs(code, onCode) {
  let i = 0;
  const n = code.length;
  while (i < n) {
    const c = code[i];
    // 字符串字面量
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && code[j] !== c && code[j] !== '\n') {
        j += code[j] === '\\' ? 2 : 1;
      }
      onCode(code.slice(i, j + 1), 'literal');
      i = j + 1;
      continue;
    }
    // 模板字面量：整体原样保留（含换行与缩进），${} 中的表达式按普通代码继续扫描
    if (c === '`') {
      let j = i + 1;
      let buf = '`';
      while (j < n) {
        if (code[j] === '\\') { buf += code.slice(j, j + 2); j += 2; continue; }
        if (code[j] === '`') { buf += '`'; j++; break; }
        if (code[j] === '$' && code[j + 1] === '{') {
          let depth = 1;
          let k = j + 2;
          while (k < n && depth > 0) {
            if (code[k] === '{') depth++;
            else if (code[k] === '}') depth--;
            k++;
          }
          const inner = minifyJs(code.slice(j + 2, k - 1));
          buf += '${' + inner + '}';
          j = k;
          continue;
        }
        buf += code[j];
        j++;
      }
      onCode(buf, 'literal');
      i = j;
      continue;
    }
    // 行注释 / 块注释
    if (c === '/' && code[i + 1] === '/') {
      const j = code.indexOf('\n', i);
      i = j === -1 ? n : j;
      continue;
    }
    if (c === '/' && code[i + 1] === '*') {
      const j = code.indexOf('*/', i + 2);
      const end = j === -1 ? n : j + 2;
      onCode(code.slice(i, end), 'comment');
      i = end;
      continue;
    }
    // 正则字面量：仅在「上一个有效记号不构成表达式结尾」时成立
    if (c === '/' && regexAllowedAt(code, i)) {
      let j = i + 1;
      let inClass = false;
      while (j < n) {
        const d = code[j];
        if (d === '\\') { j += 2; continue; }
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) break;
        else if (d === '\n') break; // 非法正则，退回按除法处理
        j++;
      }
      if (j < n && code[j] === '/') {
        j++;
        while (j < n && /[a-z]/i.test(code[j])) j++; // 修饰符
        onCode(code.slice(i, j), 'literal');
        i = j;
        continue;
      }
    }
    onCode(c, 'code');
    i++;
  }
}

/**
 * JS 轻量压缩：删除注释与缩进，保留换行（避免 ASI 语义变化）。
 * 空白只在「两侧同为词字符」或「两侧同为运算符」时保留单个空格，其余位置一律丢弃；
 * 字符串 / 模板 / 正则字面量原样输出。
 */
function minifyJs(code) {
  const out = [];
  let prev = '';          // 上一个已输出字符
  let gap = false;        // 是否有待处理的空白
  let gapNewline = false; // 待处理的空白里是否含换行

  const push = (s) => {
    out.push(s);
    if (s) prev = s[s.length - 1];
  };
  const markGap = (text) => {
    gap = true;
    if (text.includes('\n')) gapNewline = true;
  };
  const flush = (next) => {
    if (!gap) return;
    if (gapNewline) {
      if (prev) push('\n'); // 行首缩进丢弃，只保留换行
    } else if (WORD_CHAR.test(prev) && WORD_CHAR.test(next)) {
      push(' '); // 两个「词」相邻必须分隔，否则会粘成一个标识符
    } else if (OPERATOR_CHAR.has(prev) && OPERATOR_CHAR.has(next)) {
      push(' '); // ++ -- // 等组合运算符不能被拼出来
    }
    gap = false;
    gapNewline = false;
  };

  scanJs(code, (text, kind) => {
    if (kind === 'comment') { markGap(' '); return; } // 块注释移除后留一个可丢弃的空隙
    if (kind === 'literal') { flush(text[0] || ''); push(text); return; }
    for (const ch of text) {
      if (/\s/.test(ch)) markGap(ch);
      else { flush(ch); push(ch); }
    }
  });
  return out.join('').replace(/^\n+/, '');
}

/** CSS 轻量压缩：去注释、折叠空白；引号内的内容原样保留 */
const CSS_TIGHT = '{};:,>+~';
function minifyCss(css) {
  let out = '';
  let i = 0;
  const n = css.length;
  let prev = '';
  while (i < n) {
    const c = css[i];
    if (c === '/' && css[i + 1] === '*') {
      const j = css.indexOf('*/', i + 2);
      i = j === -1 ? n : j + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && css[j] !== c) j += css[j] === '\\' ? 2 : 1;
      const lit = css.slice(i, Math.min(j + 1, n));
      out += lit;
      prev = c;
      i = Math.min(j + 1, n);
      continue;
    }
    if (/\s/.test(c)) {
      let j = i;
      while (j < n && /\s/.test(css[j])) j++;
      const next = css[j] || '';
      // 该留的空格必须留（如 calc(100% - 10px)、后代选择器 a b），其余折叠掉
      if (prev && next && !CSS_TIGHT.includes(prev) && !CSS_TIGHT.includes(next)) out += ' ';
      i = j;
      continue;
    }
    out += c;
    prev = c;
    i++;
  }
  return out.replace(/;}/g, '}').trim();
}

/** 项目内相对路径，统一用 / 分隔 */
const idOf = (abs) => path.relative(root, abs).split(path.sep).join('/');

/** 解析 import 子句里的绑定，支持 `a as b`，返回 [{ imported, local }] */
function namesFromClause(clause) {
  return clause
    .trim()
    .replace(/^\{|\}$/g, '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [imported, local] = s.split(/\s+as\s+/);
      return { imported, local: local || imported };
    });
}

const modules = new Map(); // id -> { file, code, deps: [{ id, names }] }
const building = new Set();

function collectImports(file) {
  const id = idOf(file);
  if (modules.has(id)) return id;

  if (building.has(id)) throw new Error(`检测到循环依赖：${id}`);
  building.add(id);

  let code = fs.readFileSync(file, 'utf8');
  const deps = [];

  code = code.replace(
    /^import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"];?/gm,
    (_all, clause, spec) => {
      const depFile = path.resolve(path.dirname(file), spec);
      const depId = collectImports(depFile); // 深度优先，依赖先入表
      const names = namesFromClause(clause);
      deps.push({ id: depId, names });
      const bindings = names
        .map((n) => (n.imported === n.local ? n.imported : `${n.imported}: ${n.local}`))
        .join(', ');
      return `const { ${bindings} } = __MODULES[${JSON.stringify(depId)}];`;
    },
  );

  // 去掉 export 关键字，函数/类/常量声明本身留在模块作用域内
  code = code.replace(/^export\s+(?=(?:async\s+)?(?:function|class|const|let|var))/gm, '');

  building.delete(id);
  modules.set(id, { file, code, deps });
  return id;
}

collectImports(ENTRY);

// 每个模块需要 return 的导出名 = 其它模块从它这里 import 的全部名字
const exported = new Map();
for (const { deps } of modules.values()) {
  for (const d of deps) {
    if (!exported.has(d.id)) exported.set(d.id, new Set());
    for (const n of d.names) exported.get(d.id).add(n.imported);
  }
}

// modules 的插入顺序即依赖顺序（被依赖者先插入）
const bundle = ["'use strict';", 'const __MODULES = Object.create(null);', ''];
for (const [id, mod] of modules) {
  const names = [...(exported.get(id) || [])];
  bundle.push(`/* ===== ${id} ===== */`);
  bundle.push(`__MODULES[${JSON.stringify(id)}] = (function () {`);
  bundle.push(mod.code.trimEnd());
  bundle.push(`return { ${names.join(', ')} };`);
  bundle.push('})();');
  bundle.push('');
}

const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const title = (html.match(/<title>([\s\S]*?)<\/title>/) || [, 'GridSneaker'])[1].trim();
const body = html
  .match(/<body>([\s\S]*)<\/body>/)[1]
  // 只移除模块入口（其内容由下面的打包结果替代）；不依赖模块的内联经典脚本要保留，
  // 例如 #legacy-hint 的兜底文案改写脚本——脚本跑不起来时正需要它工作
  .replace(/<script\b[^>]*type="module"[^>]*>[\s\S]*?<\/script>/g, '')
  // 版本号以 package.json 为唯一来源，避免更新后各处版本不一致
  .replace(/(<span id="app-version">)[\s\S]*?(<\/span>)/, `$1${pkg.version}$2`)
  .trim();

const out = `<!doctype html>
<html lang="zh-CN">
<head>
  <!-- 让 360 / QQ 等双内核浏览器对本地文件也走极速（Blink）内核，避免兼容模式白屏 -->
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
${(MINIFY ? minifyCss(css) : css.trimEnd())}
  </style>
</head>
<body>
${body}
  <script>
(function () {
${(MINIFY ? minifyJs(bundle.join('\n')) : bundle.join('\n')).trimEnd()}
})();
  </script>
</body>
</html>
`;

fs.writeFileSync(TARGET, out, 'utf8');
console.log(`已生成：${path.relative(root, TARGET)}（${(out.length / 1024).toFixed(1)} KB，${modules.size} 个模块${MINIFY ? '，已压缩' : '，未压缩'}）`);
