/**
 * 把 src/ 下的 ES Module 打包进单个 HTML 文件（无需 HTTP 服务器，双击即可打开）。
 * 用法：node tools/build-single-file.mjs
 *
 * 打包方式：按依赖顺序把每个模块包成一个 IIFE，模块之间通过 __MODULES 表解构传递导出，
 * 从而避免不同模块顶层同名声明（如 COMPARATORS、lerpColor）互相冲突。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const ENTRY = path.join(root, 'src', 'ui', 'app.js');
const OUTPUT = path.join(root, 'GridSneaker.html');

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
  .replace(/<script[\s\S]*?<\/script>/g, '')
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
${css.trimEnd()}
  </style>
</head>
<body>
${body}
  <script>
(function () {
${bundle.join('\n').trimEnd()}
})();
  </script>
</body>
</html>
`;

fs.writeFileSync(OUTPUT, out, 'utf8');
console.log(`已生成：${path.relative(root, OUTPUT)}（${(out.length / 1024).toFixed(1)} KB，${modules.size} 个模块）`);
