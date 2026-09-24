/**
 * 轻量 DOM 构建与表单控件辅助
 */

export function h(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else if (k === 'html') e.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  append(e, children);
  return e;
}

function append(parent, children) {
  for (const c of children.flat(4)) {
    if (c === null || c === undefined || c === false || c === '') continue;
    parent.appendChild(typeof c === 'object' && c.nodeType ? c : document.createTextNode(String(c)));
  }
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/**
 * 分组折叠状态记忆表。
 * 面板重建（rebuildAll / renderConfigPanel）时会重新创建 <details>，
 * 若不记忆状态，用户每次调整优先级、添加规则后选项卡都会被折叠。
 * 键默认取分组标题；动态列表项应显式传入稳定的 opts.key（如规则 id）。
 */
const groupOpenState = new Map();

/**
 * 多层级选项卡配色梯度。
 * 按嵌套深度沿色环推进色相（212° 蓝 → 紫 → 品红 → 红 → 橙 → 绿…），
 * 同时逐级抬高饱和度与亮度：父级沉稳压暗，子级越深越鲜明，
 * 于是每一层都能被一眼区分，又统一在同一套低饱和深色面板风格里。
 * 结果以 --grp-h / --grp-s / --grp-l 三个自定义属性写入元素，具体用色由 styles.css 决定。
 */
const GROUP_HUE_BASE = 212;
const GROUP_HUE_STEP = 47;
function groupPaletteOf(depth) {
  const d = Math.max(0, Math.round(depth) || 0);
  return {
    h: (GROUP_HUE_BASE + d * GROUP_HUE_STEP) % 360,
    s: Math.min(24 + d * 6, 60),
    l: Math.min(9 + d * 1.5, 18),
  };
}

/** 给分组及其内部所有嵌套分组的元素标注层级（0 为顶层）并写入配色变量 */
function markGroupDepth(root, base) {
  const apply = (el, depth) => {
    const p = groupPaletteOf(depth);
    el.dataset.depth = String(depth);
    el.style.setProperty('--grp-h', String(p.h));
    el.style.setProperty('--grp-s', `${p.s}%`);
    el.style.setProperty('--grp-l', `${p.l}%`);
  };
  apply(root, base);
  for (const el of root.querySelectorAll('.group')) {
    let depth = base + 1;
    for (let p = el.parentElement; p && p !== root; p = p.parentElement) {
      if (p.classList && p.classList.contains('group')) depth++;
    }
    apply(el, depth);
  }
}

export function group(title, children, opts = {}) {
  const key = opts.key === undefined ? String(title) : String(opts.key);
  const remembered = groupOpenState.get(key);
  // 默认全部收起：仅当显式传入 open: true 时才展开，保证面板初始状态只露出分组标题
  const open = remembered === undefined ? opts.open === true : remembered;
  const details = h('details', { class: 'group', open, 'data-group-key': key });
  details.appendChild(h('summary', {}, title, opts.badge ? h('span', { class: 'badge' }, opts.badge) : null));
  const body = h('div', { class: 'group-body' });
  append(body, [children]);
  details.appendChild(body);
  details.addEventListener('toggle', () => groupOpenState.set(key, details.open));
  markGroupDepth(details, Number.isFinite(opts.depth) ? opts.depth : 0);
  return details;
}

export function field(label, control, hint) {
  return h('div', { class: 'field' },
    h('span', { class: 'field-label' }, label),
    h('div', { class: 'field-control' }, control),
    hint ? h('span', { class: 'field-hint' }, hint) : null);
}

export function row(...children) {
  return h('div', { class: 'row' }, children);
}

export function button(label, onClick, cls = '') {
  return h('button', { class: `btn ${cls}`, type: 'button', onclick: onClick }, label);
}

export function numberInput(value, onChange, opts = {}) {
  // 注意：必须先设定 min/max/step，再写入 value。
  // 否则浏览器会先用默认 min/max/step 对 value 做一次合法化（range 会按 step 取整），
  // 之后再改 min/max/step 并不会把数值恢复原样，导致「滑动条显示回弹」。
  const input = h('input', {
    type: 'number',
    class: 'input',
    min: opts.min,
    max: opts.max,
    step: opts.step ?? 1,
  });
  input.value = value === undefined || value === null ? '' : String(value);
  const commit = () => {
    let v = Number(input.value);
    if (!Number.isFinite(v)) v = opts.default ?? 0;
    if (opts.min !== undefined) v = Math.max(opts.min, v);
    if (opts.max !== undefined) v = Math.min(opts.max, v);
    input.value = v;
    onChange(v);
  };
  input.addEventListener('change', commit);
  input.addEventListener('blur', commit);
  return input;
}

export function textInput(value, onChange, opts = {}) {
  const input = h('input', { type: 'text', class: 'input', value, placeholder: opts.placeholder || '' });
  input.addEventListener('change', () => onChange(input.value));
  return input;
}

export function textArea(value, onChange, opts = {}) {
  const el = h('textarea', { class: 'input textarea', rows: opts.rows || 4, placeholder: opts.placeholder || '' });
  el.value = value ?? '';
  el.addEventListener('change', () => onChange(el.value));
  return el;
}

export function select(value, options, onChange) {
  const s = h('select', { class: 'input' });
  for (const opt of options) {
    const value_ = typeof opt === 'object' ? opt.value : opt;
    const label = typeof opt === 'object' ? opt.label : opt;
    const o = h('option', { value: value_ }, label);
    if (String(value_) === String(value)) o.selected = true;
    s.appendChild(o);
  }
  s.addEventListener('change', () => onChange(s.value));
  return s;
}

export function checkbox(value, onChange, label) {
  const input = h('input', { type: 'checkbox', class: 'checkbox' });
  input.checked = !!value;
  input.addEventListener('change', () => onChange(input.checked));
  if (!label) return input;
  return h('label', { class: 'check-wrap' }, input, h('span', {}, label));
}

export function range(value, onChange, opts = {}) {
  const wrap = h('div', { class: opts.wrapClass ? `range-wrap ${opts.wrapClass}` : 'range-wrap' });
  const min = opts.min ?? 0;
  const max = opts.max ?? 1;
  const step = opts.step ?? 0.01;
  // 先设定 min/max/step，再写入 value（见 numberInput 中的说明）
  const input = h('input', { type: 'range', class: 'range', min, max, step });
  input.value = String(value);
  wrap.appendChild(input);

  if (opts.number) {
    // 滑动条 + 数值框双向同步，便于手动输入精确数值
    const num = h('input', { type: 'number', class: 'input range-num', min, max, step });
    num.value = String(value);
    const clampValue = (v) => Math.max(min, Math.min(max, v));
    input.addEventListener('input', () => {
      const v = Number(input.value);
      num.value = String(v);
      onChange(v);
    });
    const commit = () => {
      const raw = Number(num.value);
      const v = clampValue(Number.isFinite(raw) ? raw : Number(input.value));
      num.value = String(v);
      input.value = String(v);
      onChange(v);
    };
    num.addEventListener('change', commit);
    num.addEventListener('blur', commit);
    wrap.appendChild(num);
    return wrap;
  }

  const out = h('span', { class: 'range-out' }, formatNumber(value));
  input.addEventListener('input', () => {
    const v = Number(input.value);
    out.textContent = formatNumber(v);
    onChange(v);
  });
  wrap.appendChild(out);
  return wrap;
}

export function formatNumber(v) {
  if (typeof v !== 'number') return String(v);
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

export function colorInput(value, onChange) {
  const input = h('input', { type: 'color', class: 'color', value: value || '#ffffff' });
  input.addEventListener('input', () => onChange(input.value));
  return input;
}

/* ---------------- 绑定辅助：直接写入配置对象 ---------------- */

export function numBind(obj, key, onChange, opts = {}) {
  return numberInput(obj[key], (v) => { obj[key] = v; onChange(); }, { ...opts, default: obj[key] });
}

export function selBind(obj, key, onChange, options) {
  return select(obj[key], options, (v) => {
    obj[key] = coerceLike(obj[key], v);
    onChange();
  });
}

export function chkBind(obj, key, onChange, label) {
  return checkbox(obj[key], (v) => { obj[key] = v; onChange(); }, label);
}

export function textBind(obj, key, onChange, opts) {
  return textInput(obj[key], (v) => { obj[key] = v; onChange(); }, opts);
}

export function rangeBind(obj, key, onChange, opts = {}) {
  return range(obj[key], (v) => { obj[key] = v; onChange(); }, opts);
}

export function colorBind(obj, key, onChange) {
  return colorInput(obj[key], (v) => { obj[key] = v; onChange(); });
}

function coerceLike(prev, next) {
  if (typeof prev === 'number') return Number(next);
  if (typeof prev === 'boolean') return next === 'true' || next === true;
  return next;
}

export function toast(message, kind = 'info') {
  let box = document.getElementById('toast-box');
  if (!box) {
    box = h('div', { id: 'toast-box', class: 'toast-box' });
    document.body.appendChild(box);
  }
  const item = h('div', { class: `toast ${kind}` }, message);
  box.appendChild(item);
  setTimeout(() => item.classList.add('show'), 10);
  setTimeout(() => {
    item.classList.remove('show');
    setTimeout(() => item.remove(), 300);
  }, 2600);
}

/* ---------------- 模态对话框 ---------------- */

/** 当前是否有模态框打开：全局快捷键据此让位（如 Esc 不再触发暂停播放） */
export function dialogOpen() {
  return !!document.getElementById('modal-mask');
}

/**
 * 打开模态对话框。
 * 关闭方式：确认 / 取消按钮、遮罩点击、Esc。
 *
 * @param {object} opts
 * @param {string} opts.title       标题
 * @param {string} [opts.message]   正文说明
 * @param {Array<{title: string, items: string[]}>} [opts.sections] 分节明细列表
 * @param {string} [opts.footnote]  底部补充说明
 * @param {string} [opts.confirmText='确认']
 * @param {string} [opts.cancelText='取消']
 * @param {boolean} [opts.danger]   破坏性操作：默认焦点落在「取消」，避免误按回车覆盖
 * @param {boolean} [opts.alert]    仅提示：隐藏取消按钮
 * @returns {Promise<boolean>} 确认为 true，取消为 false
 */
export function openDialog(opts = {}) {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement;
    const mask = h('div', { id: 'modal-mask', class: 'modal-mask' });
    const dialog = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' });

    dialog.appendChild(h('div', { class: 'modal-title' }, opts.title || '提示'));
    if (opts.message) dialog.appendChild(h('div', { class: 'modal-msg' }, opts.message));
    if (opts.sections && opts.sections.length) {
      const body = h('div', { class: 'modal-body' });
      for (const sec of opts.sections) {
        body.appendChild(h('div', { class: 'modal-sec' },
          sec.title ? h('div', { class: 'modal-sec-title' }, sec.title) : null,
          ...(sec.items || []).map((item) => h('div', { class: 'modal-item' }, item))));
      }
      dialog.appendChild(body);
    }
    if (opts.footnote) dialog.appendChild(h('div', { class: 'modal-foot' }, opts.footnote));

    let settled = false;
    const close = (ok) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey, true);
      mask.remove();
      if (prevFocus && typeof prevFocus.focus === 'function' && prevFocus.isConnected) prevFocus.focus();
      resolve(ok);
    };
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation(); // 阻止全局快捷键（Esc = 暂停播放）同时触发
      close(false);
    };

    const actions = h('div', { class: 'modal-actions' });
    let primary = null;
    let cancel = null;
    if (!opts.alert) {
      cancel = button(opts.cancelText || '取消', () => close(false), 'ghost');
      actions.appendChild(cancel);
    }
    primary = button(opts.confirmText || (opts.alert ? '知道了' : '确认'), () => close(true), opts.danger ? 'primary danger' : 'primary');
    actions.appendChild(primary);
    dialog.appendChild(actions);

    mask.appendChild(dialog);
    mask.addEventListener('mousedown', (e) => { if (e.target === mask) close(false); });
    document.body.appendChild(mask);
    document.addEventListener('keydown', onKey, true);
    requestAnimationFrame(() => { if (mask.isConnected) mask.classList.add('show'); });
    // 破坏性操作默认聚焦「取消」：回车不会误触发覆盖
    (opts.danger && cancel ? cancel : primary).focus();
  });
}

/** 确认对话框（确认 / 取消两个操作） */
export function confirmDialog(opts) {
  return openDialog({ ...opts, alert: false });
}

/** 提示对话框（仅一个关闭按钮） */
export function alertDialog(opts) {
  return openDialog({ ...opts, alert: true });
}
