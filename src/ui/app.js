/**
 * 应用主体：配置面板、规则编辑器、播放控制、统计与日志、导入导出
 */
import {
  defaultConfig, normalizeConfig, defaultRule, defaultClause, defaultAction,
  validateConfig, diagnoseConfig, buildShareUrl, readConfigFromLocation, END_LABELS, MAX_STEPS_LIMIT,
} from '../core/config.js';
import { PRESETS, buildPresetConfig } from '../core/presets.js';
import { Simulation, DEFAULT_FRAME_CAP, MAX_FRAME_CAP, MAX_STORED_FRAMES } from '../core/simulation.js';
import { Renderer } from './canvas.js';
import { dirNames } from '../core/grid.js';
import { ACTION_LABELS, TURN_LABELS } from '../core/actions.js';
import { SUBJECT_LABELS, TRIGGER_LABELS } from '../core/rules.js';
import { CA_UPDATE_LABELS, CA_BOUNDARY_LABELS } from '../core/ca.js';
import { OBJECT_LABELS, STAT_LABELS } from '../core/conditions.js';
import {
  configToJSON, trailToCSV, trailToJSON, logsToCSV, logsToJSON,
  frameToSVG, downloadText, downloadCanvasPNG, downloadSVG,
} from '../core/exporters.js';
import {
  h, clear, group, field, row, button, numberInput, textInput, textArea, select,
  checkbox, range, colorInput, numBind, selBind, chkBind, textBind, rangeBind,
  colorBind, toast, formatNumber,
} from './forms.js';

/* ------------------------------------------------------------------ */
/* 常量                                                                */
/* ------------------------------------------------------------------ */

const DIR_LABELS = {
  up: '上', right: '右', down: '下', left: '左',
  east: '东', southEast: '东南', southWest: '西南', west: '西', northWest: '西北', northEast: '东北',
};

const CLAUSE_TYPES = [
  { value: 'count', label: '数量' },
  { value: 'proportion', label: '比例' },
  { value: 'exists', label: '存在' },
  { value: 'direction', label: '方向关系' },
  { value: 'pattern', label: '图案匹配' },
  { value: 'distance', label: '最近距离' },
  { value: 'stat', label: '运行统计' },
  { value: 'selfLength', label: '自身长度' },
  { value: 'cellState', label: '格子状态' },
  { value: 'random', label: '概率' },
  { value: 'group', label: '组合子句' },
];

const NEIGHBORHOODS = [
  { value: 'vonNeumann', label: '4 邻域（Von Neumann）' },
  { value: 'moore', label: '8 邻域（Moore）' },
  { value: 'hex', label: '6 邻域（六边形）' },
  { value: 'radius', label: '半径 r 邻域' },
];

const COMPARATORS = [
  { value: '>=', label: '≥' }, { value: '<=', label: '≤' },
  { value: '==', label: '=' }, { value: '>', label: '>' },
  { value: '<', label: '<' }, { value: '!=', label: '≠' },
];

const REL_OPTIONS_SQUARE = [
  { value: 'front', label: '前方' }, { value: 'right', label: '右侧' },
  { value: 'back', label: '后方' }, { value: 'left', label: '左侧' },
];
const REL_OPTIONS_HEX = [
  { value: 'front', label: '前方' }, { value: 'frontRight', label: '右前' },
  { value: 'backRight', label: '右后' }, { value: 'back', label: '后方' },
  { value: 'backLeft', label: '左后' }, { value: 'frontLeft', label: '左前' },
];
const POSITIONS = [
  { value: 'current', label: '当前格' }, { value: 'front', label: '前方' },
  { value: 'left', label: '左侧' }, { value: 'right', label: '右侧' },
  { value: 'back', label: '后方' }, { value: 'randomNeighbor', label: '随机邻格' },
  { value: 'randomEmpty', label: '随机空格' }, { value: 'random', label: '随机格' },
];
const BASE_OBJECTS = ['empty', 'obstacle', 'marker', 'head', 'body', 'boundary', 'visited', 'other', 'any'];

/* ------------------------------------------------------------------ */
/* 状态                                                                */
/* ------------------------------------------------------------------ */

const state = {
  cfg: null,
  result: null,
  frameIndex: 0,
  playing: false,
  loop: true,
  autoRun: true,
  dirty: true,
  logFilter: 'all',
  logLimit: 400,
  frameCap: DEFAULT_FRAME_CAP,
};

const els = {};
let renderer = null;
let rafId = null;
let acc = 0;
let lastTs = 0;
let runTimer = null;
let activeLogEls = [];

/** 结束规则中数值型条件的“上次取值”记忆：取消勾选后仍保留数值，便于再次启用 */
const endParamMemory = { maxSteps: defaultConfig().endConditions.maxSteps };

/**
 * 结束规则勾选状态的跨面板联动。
 * 「碰撞与自撞处理 → 连续自撞上限」是否生效取决于「结束规则 → 撞到自身」，
 * 这里让后者在勾选变化时实时更新前者的可编辑状态。
 */
const endConditionSyncers = new Map();

function bindEndConditionSync(code, fn) {
  if (!endConditionSyncers.has(code)) endConditionSyncers.set(code, []);
  endConditionSyncers.get(code).push(fn);
}

function notifyEndConditionSync(code, on) {
  for (const fn of endConditionSyncers.get(code) || []) fn(on);
}

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

function init() {
  state.cfg = initialConfig();
  els.canvas = document.getElementById('canvas');
  els.canvasWrap = document.getElementById('canvas-wrap');
  els.tooltip = document.getElementById('tooltip');
  els.controls = document.getElementById('controls');
  els.stageStats = document.getElementById('stage-stats');
  els.side = document.getElementById('side-panel');
  els.config = document.getElementById('config-panel');

  renderer = new Renderer(els.canvas);
  buildControls();
  bindCanvasEvents();
  bindKeyboard();
  renderConfigPanel();
  renderSidePanel();
  notifyStartupDiagnostics();
  recompute({ immediate: true });
  // 启动成功后再撤掉兜底提示（init 全同步，不会出现闪烁）
  const legacyHint = document.getElementById('legacy-hint');
  if (legacyHint) legacyHint.className = 'hidden';
}

/** 键盘快捷键：空格播放/暂停，← → 单步，Home / End 跳转首末帧 */
function bindKeyboard() {
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    switch (e.key) {
      case ' ':
        e.preventDefault();
        if (state.playing) pause();
        else play();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        pause();
        gotoFrame(state.frameIndex - 1);
        break;
      case 'ArrowRight':
        e.preventDefault();
        pause();
        if (advance()) frameChanged();
        break;
      case 'Home':
        e.preventDefault();
        pause();
        gotoFrame(0);
        break;
      case 'End':
        e.preventDefault();
        pause();
        gotoFrame(state.result ? state.result.frames.length - 1 : 0);
        break;
      default:
        break;
    }
  });
}

function initialConfig() {
  const shared = readConfigFromLocation();
  if (shared) {
    const v = validateConfig(shared);
    if (!v.ok) toast(`分享配置存在问题：${v.errors[0]}`, 'warn');
    return normalizeConfig(shared);
  }
  const local = loadLocalConfig();
  if (local) {
    toast('已恢复上次编辑的配置，可用「恢复默认模板」重置', 'info');
    return local;
  }
  return normalizeConfig(buildPresetConfig('random-walk'));
}

/* ---------------- 本地自动保存（避免刷新 / 更新后丢失配置） ---------------- */

const STORAGE_KEY = 'gridsneaker:last-config';

function saveLocalConfig(cfg) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
  } catch (e) {
    /* 隐私模式或超配额时静默忽略 */
  }
}

function loadLocalConfig() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!validateConfig(obj).ok) return null;
    return normalizeConfig(obj);
  } catch (e) {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 运行 / 播放                                                         */
/* ------------------------------------------------------------------ */

function scheduleRun(delay = 160) {
  if (runTimer) clearTimeout(runTimer);
  runTimer = setTimeout(() => recompute(), delay);
}

function onSimChange(delay = 160) {
  state.dirty = true;
  refreshDiagnostics(); // 静态诊断只依赖配置，改动后立即反馈，无需等待重算
  if (state.autoRun) scheduleRun(delay);
}

function onStyleChange() {
  if (!state.result) return;
  // 同时传入移动体外观配置，使形状 / 尺寸 / 配色模式的修改即时生效（无需重新计算）
  renderer.setStyle(state.cfg.style, state.cfg.body);
  draw();
}

function recompute(opts = {}) {
  let normalized;
  try {
    normalized = normalizeConfig(state.cfg);
  } catch (e) {
    toast(`配置解析失败：${e.message}`, 'error');
    return;
  }
  syncDerived(normalized);
  const cfg = normalized;
  // 未启用「达到步数上限」时使用的安全帧上限；可通过「继续运行」逐级提升
  const frameCap = Number.isFinite(opts.frameCap)
    ? Math.min(MAX_FRAME_CAP, Math.max(1, Math.round(opts.frameCap)))
    : DEFAULT_FRAME_CAP;
  state.frameCap = frameCap;
  const effCap = cfg.endConditions.maxSteps === false
    ? frameCap
    : Math.max(1, Math.round(cfg.endConditions.maxSteps));
  // 画面帧超限时按步长抽样缓存，内存占用取决于缓存的帧数而非总步数
  const est = cfg.grid.width * cfg.grid.height * Math.min(effCap, MAX_STORED_FRAMES);
  if (est > 4e8) {
    toast('当前网格与步数组合数据量较大，可能占用较多内存与时间', 'warn');
  }
  const t0 = performance.now();
  let result;
  try {
    result = new Simulation(cfg, { frameCap }).run();
  } catch (e) {
    toast(`运行失败：${e.message}`, 'error');
    console.error(e);
    return;
  }
  state.result = result;
  state.dirty = false;
  state.frameIndex = Math.min(state.frameIndex, result.frames.length - 1);
  saveLocalConfig(cfg);
  renderer.setResult(result);
  renderer.setStyle(cfg.style, cfg.body);
  renderStageStats();
  renderLog();
  updateControls();
  draw();
  refreshDiagnostics(); // 用本次运行的真实结果替换上一轮的运行期诊断
  if (opts.immediate !== true && performance.now() - t0 > 400) {
    toast(`已重新计算 ${result.frames.length} 帧`, 'info');
  }
}

/**
 * 把规范化过程中被修正/补齐的派生数据写回工作配置。
 * 不整体替换 state.cfg，避免配置面板中已持有的对象引用失效。
 */
function syncDerived(normalized) {
  const cfg = state.cfg;
  cfg.version = normalized.version;
  // 就地补齐被规范化补出的基础状态（保持已有状态对象引用不变）
  for (const need of normalized.caMode.states) {
    if (!cfg.caMode.states.some((s) => s.name === need.name)) cfg.caMode.states.push(need);
  }
  if (!cfg.caMode.states.some((s) => s.name === 'empty')) cfg.caMode.states.unshift(normalized.caMode.states[0]);
  if (!Array.isArray(cfg.endConditions.priority) || !cfg.endConditions.priority.length) {
    cfg.endConditions.priority = normalized.endConditions.priority;
  }
  if (typeof normalized.endConditions.maxSteps === 'number') {
    endParamMemory.maxSteps = normalized.endConditions.maxSteps;
  }
}

function draw() {
  if (!state.result) return;
  renderer.draw(state.frameIndex);
  updateFrameStats();
}

function advance() {
  const last = state.result ? state.result.frames.length - 1 : 0;
  if (state.frameIndex >= last) {
    if (state.loop) {
      state.frameIndex = 0;
      return true;
    }
    pause();
    return false;
  }
  state.frameIndex++;
  return true;
}

function play() {
  if (!state.result) return;
  if (state.dirty && state.autoRun) recompute();
  if (state.frameIndex >= state.result.frames.length - 1) state.frameIndex = 0;
  state.playing = true;
  lastTs = 0;
  acc = 0;
  if (rafId) cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(loopTick);
  updateControls();
}

function pause() {
  state.playing = false;
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
  updateControls();
}

function loopTick(ts) {
  if (!state.playing) return;
  if (!lastTs) lastTs = ts;
  const dt = Math.min(250, ts - lastTs);
  lastTs = ts;
  acc += dt;
  const stepMs = 1000 / Math.max(0.5, state.cfg.speed);
  let guard = 0;
  while (acc >= stepMs && guard++ < 400) {
    acc -= stepMs;
    if (!advance()) break;
    frameChanged();
  }
  rafId = requestAnimationFrame(loopTick);
}

/** 帧变化后的轻量更新（播放中高频调用） */
function frameChanged() {
  draw();
  updateControls();
  highlightLogs();
}

function gotoFrame(i) {
  if (!state.result) return;
  const last = state.result.frames.length - 1;
  state.frameIndex = Math.max(0, Math.min(last, Math.round(i)));
  frameChanged();
}

/** 步数 → 帧下标：步数上限很大时帧按步长抽样，二者不再一一对应，取不大于该步数的最后一帧 */
function frameIndexForTick(tick) {
  const frames = state.result ? state.result.frames : null;
  if (!frames || !frames.length) return 0;
  let lo = 0;
  let hi = frames.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (frames[mid].tick <= tick) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/* ------------------------------------------------------------------ */
/* 播放控制条                                                          */
/* ------------------------------------------------------------------ */

function buildControls() {
  const c = els.controls;
  clear(c);

  els.playBtn = button('▶ 播放', () => (state.playing ? pause() : play()), 'primary');
  els.prevBtn = button('◀ 上一帧', () => { pause(); gotoFrame(state.frameIndex - 1); });
  els.stepBtn = button('单步 ▶', () => { pause(); if (advance()) frameChanged(); });
  els.resetBtn = button('⟲ 重置', () => { pause(); gotoFrame(0); });
  els.endBtn = button('⏭ 跳到末尾', () => { pause(); gotoFrame(state.result ? state.result.frames.length - 1 : 0); });
  els.runBtn = button('重新计算', () => recompute(), 'ghost');

  els.loopChk = checkbox(state.loop, (v) => { state.loop = v; }, '循环');
  els.autoChk = checkbox(state.autoRun, (v) => { state.autoRun = v; }, '自动运行');

  els.speedRange = range(state.cfg.speed, (v) => {
    state.cfg.speed = v;
    updateSpeedLabel();
  }, { min: 0.5, max: 120, step: 0.5, number: true, wrapClass: 'speed-wrap' });
  els.speedLabel = h('span', { class: 'mini-label' }, '步/秒');

  els.seedInput = numberInput(state.cfg.seed, (v) => {
    state.cfg.seed = v;
    onSimChange(0);
  }, { min: 1, step: 1 });
  els.seedDice = button('🎲', () => {
    state.cfg.seed = Math.floor(Math.random() * 1e9) + 1;
    els.seedInput.value = state.cfg.seed;
    onSimChange(0);
  }, 'icon');

  els.timeline = slider(0, (v) => { pause(); gotoFrame(Number(v)); }, { min: 0, max: 1, step: 1, cls: 'range timeline' });
  els.frameLabel = h('span', { class: 'frame-label' }, '');
  els.endLabel = h('span', { class: 'end-label' }, '');
  els.endJumpBtn = button('查看结束规则', () => focusEndReason(), 'ghost small');
  els.continueBtn = button('继续运行 +' + DEFAULT_FRAME_CAP, () => continueRun(), 'primary small');

  c.appendChild(h('div', { class: 'controls-line' },
    els.playBtn, els.prevBtn, els.stepBtn, els.resetBtn, els.endBtn, els.runBtn));
  c.appendChild(h('div', { class: 'controls-line' },
    els.loopChk, els.autoChk,
    h('span', { class: 'mini-label' }, '速度'), els.speedRange, els.speedLabel));
  c.appendChild(h('div', { class: 'controls-line' },
    h('span', { class: 'mini-label' }, '种子'), els.seedInput, els.seedDice));
  c.appendChild(h('div', { class: 'controls-line' }, els.timeline, els.frameLabel));
  c.appendChild(h('div', { class: 'controls-line' }, els.endLabel, els.endJumpBtn, els.continueBtn));
  c.appendChild(h('div', { class: 'controls-line' },
    h('span', { class: 'hint' }, '快捷键：空格 播放/暂停 · ← / → 单步 · Home / End 首帧/末帧')));
  updateSpeedLabel();
}

function updateSpeedLabel() {
  els.speedLabel.textContent = `步/秒`;
}

/** 未启用「达到步数上限」时，逐级提升安全帧上限并重新运行 */
function continueRun() {
  if (!state.result) return;
  if (state.result.endReason?.code !== 'frameLimit') {
    toast('本次运行并非因安全步数上限而停止', 'warn');
    return;
  }
  const next = Math.min(MAX_FRAME_CAP, state.frameCap + DEFAULT_FRAME_CAP);
  if (next <= state.frameCap) {
    toast(`已达到最大安全步数上限（${MAX_FRAME_CAP} 步）`, 'warn');
    return;
  }
  recompute({ frameCap: next });
  toast(`步数上限已提升至 ${next} 步并继续运行`, 'success');
}

/** 打开「结束规则」选项卡并高亮本次命中的结束条件 */
function focusEndReason() {
  const reason = state.result?.endReason;
  const details = document.querySelector('#config-panel details[data-group-key="结束规则（按优先级）"]');
  if (!details) { toast('未找到结束规则面板', 'warn'); return; }
  details.open = true;
  details.scrollIntoView({ block: 'start', behavior: 'smooth' });
  if (!reason) return;
  const row = details.querySelector(`[data-end-code="${reason.code}"]`);
  if (!row) {
    toast(`「${reason.label}」不属于结束规则列表项`, 'info');
    return;
  }
  details.querySelectorAll('.end-row.target').forEach((el) => el.classList.remove('target'));
  row.classList.add('target');
  setTimeout(() => row.classList.remove('target'), 2600);
}

function updateControls() {
  const frames = state.result ? state.result.frames.length : 1;
  const last = frames - 1;
  state.frameIndex = Math.max(0, Math.min(last, state.frameIndex));
  els.playBtn.textContent = state.playing ? '⏸ 暂停' : '▶ 播放';
  els.timeline.max = last;
  els.timeline.value = state.frameIndex;
  // 步数上限很大时帧按步长抽样，滑条走的是「帧下标」，标签显示真实步数
  const frame = state.result ? state.result.frames[state.frameIndex] : null;
  const lastTick = state.result ? state.result.frames[last].tick : 0;
  const strideNote = state.result && state.result.frameStride > 1 ? ` · 抽样 1/${state.result.frameStride}` : '';
  els.frameLabel.textContent = `第 ${frame ? frame.tick : 0} / ${lastTick} 步${strideNote}`;
  els.endBtn.disabled = !state.result;
  const reason = state.result?.endReason;
  els.endLabel.textContent = reason
    ? `结束原因：${reason.label}${reason.tick !== undefined ? `（第 ${reason.tick} 步）` : ''}`
    : '结束原因：未结束';
  els.endLabel.className = reason ? 'end-label ended' : 'end-label';
  els.endJumpBtn.disabled = !state.result;
  els.continueBtn.hidden = reason?.code !== 'frameLimit';
}

function bindCanvasEvents() {
  els.canvas.addEventListener('mousemove', (e) => {
    if (!state.result) return;
    const c = renderer.hitTest(e.clientX, e.clientY);
    renderer.hover = c;
    draw();
    if (!c) {
      els.tooltip.classList.remove('show');
      return;
    }
    els.tooltip.textContent = renderer.describe(state.frameIndex, c);
    els.tooltip.classList.add('show');
    const rect = els.canvasWrap.getBoundingClientRect();
    els.tooltip.style.left = `${e.clientX - rect.left + 14}px`;
    els.tooltip.style.top = `${e.clientY - rect.top + 14}px`;
  });
  els.canvas.addEventListener('mouseleave', () => {
    renderer.hover = null;
    els.tooltip.classList.remove('show');
    draw();
  });
  els.canvas.addEventListener('click', (e) => {
    if (!state.result) return;
    const c = renderer.hitTest(e.clientX, e.clientY);
    if (!c) return;
    const info = renderer.trailInfo.get(state.result.grid.idx(c.col, c.row));
    if (!info) return;
    pause();
    gotoFrame(frameIndexForTick(info.first));
    toast(`已跳转到该格首次经过的步数：第 ${info.first} 步`, 'info');
  });
}

/* ------------------------------------------------------------------ */
/* 统计面板                                                            */
/* ------------------------------------------------------------------ */

const STAT_KEYS = [
  ['steps', '步数'], ['frames', '缓存帧数'], ['endReason', '结束原因 / 本步事件'], ['collisions', '碰撞次数'], ['selfCollisions', '自撞次数'], ['length', '当前长度'],
  ['finalLength', '最终长度'], ['maxLength', '最大长度'], ['coverage', '覆盖率'], ['ruleTriggers', '规则触发'],
  ['caSteps', 'CA 演进次数'], ['obstacleCount', '障碍物'], ['markerCount', '标记物'], ['seed', '随机种子'],
  ['rngCalls', '随机调用次数'],
];

function renderStageStats() {
  const host = els.stageStats;
  clear(host);
  els.statSpans = {};
  const r = state.result;
  if (!r) return;
  const s = r.summary;
  const values = {
    steps: s.steps,
    frames: r.frameStride > 1 ? `${r.frames.length}（抽样 1/${r.frameStride}）` : r.frames.length,
    endReason: s.endReason,
    collisions: s.collisions,
    selfCollisions: s.selfCollisions,
    length: '-',
    finalLength: s.finalLength,
    maxLength: s.maxLength,
    coverage: `${formatNumber(s.coverage)}%`,
    ruleTriggers: s.ruleTriggers,
    caSteps: s.caSteps,
    obstacleCount: s.obstacleCount,
    markerCount: s.markerCount,
    seed: r.seed,
    rngCalls: r.rngCalls,
  };
  for (const [key, label] of STAT_KEYS) {
    const span = h('span', { class: 'stat-value' }, String(values[key] ?? '-'));
    els.statSpans[key] = span;
    host.appendChild(h('div', { class: `stat ${key === 'endReason' ? 'wide' : ''}` },
      h('span', { class: 'stat-label' }, label), span));
  }
  host.appendChild(h('div', { class: 'stat wide' },
    h('span', { class: 'stat-label' }, '长度曲线'), buildSparkline(r.stats.lengthHistory)));
  host.appendChild(h('div', { class: 'stat wide' },
    h('span', { class: 'stat-label' }, '转向分布'), buildTurnBars(r.stats)));
}

function updateFrameStats() {
  if (!state.result || !els.statSpans) return;
  const f = state.result.frames[state.frameIndex];
  if (!f) return;
  const set = (key, value) => {
    const span = els.statSpans[key];
    if (span) span.textContent = String(value);
  };
  set('length', f.stats.length);
  set('steps', f.stats.steps);
  set('collisions', f.stats.collisions);
  set('selfCollisions', f.stats.selfCollisions);
  set('coverage', `${formatNumber(f.stats.coverage)}%`);
  set('ruleTriggers', f.stats.ruleTriggers);
  set('caSteps', f.stats.caSteps);
  if (f.events && f.events.length) {
    set('endReason', f.events.map(eventLabel).join('、'));
  }
}

function eventLabel(e) {
  const map = {
    wall: '撞墙', obstacle: '撞障碍物', obstacleDestroyed: '撞毁障碍物', obstaclePass: '穿过障碍物',
    selfCollision: '撞到自身', grow: '增长', shrink: '缩短', eat: '吃到标记物', spawn: '生成移动体',
  };
  const pos = e.coord ? `(${e.coord.col},${e.coord.row})` : '';
  return `${map[e.type] || e.type}${pos}`;
}

function buildSparkline(history) {
  const w = 220;
  const hh = 44;
  const canvas = h('canvas', { class: 'spark', width: w, height: hh });
  const ctx = canvas.getContext('2d');
  // 步数上限可放宽到数十万，按像素宽度抽样，避免逐点绘制拖慢界面
  const maxPoints = Math.max(2, w);
  let data = history;
  if (history.length > maxPoints) {
    const stride = history.length / maxPoints;
    data = [];
    for (let i = 0; i < maxPoints; i++) data.push(history[Math.floor(i * stride)]);
    data[data.length - 1] = history[history.length - 1];
  }
  const max = Math.max(2, ...data);
  ctx.clearRect(0, 0, w, hh);
  ctx.strokeStyle = 'rgba(120,140,170,0.3)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, hh - 1);
  ctx.lineTo(w, hh - 1);
  ctx.stroke();
  ctx.beginPath();
  const n = Math.max(1, data.length - 1);
  data.forEach((v, i) => {
    const x = (i / n) * w;
    const y = hh - (v / max) * (hh - 4) - 2;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = '#4dabf7';
  ctx.lineWidth = 1.6;
  ctx.stroke();
  return canvas;
}

function buildTurnBars(stats) {
  const total = Math.max(1, stats.turnsLeft + stats.turnsStraight + stats.turnsRight + stats.turnsReverse);
  const items = [
    ['左转', stats.turnsLeft, '#ff922b'],
    ['直行', stats.turnsStraight, '#4dabf7'],
    ['右转', stats.turnsRight, '#51cf66'],
    ['掉头', stats.turnsReverse, '#c084fc'],
  ];
  const wrap = h('div', { class: 'bars' });
  for (const [label, v, color] of items) {
    const pct = (v / total) * 100;
    wrap.appendChild(h('div', { class: 'bar-row' },
      h('span', { class: 'bar-label' }, label),
      h('div', { class: 'bar-track' }, h('div', { class: 'bar-fill', style: { width: `${pct}%`, background: color } })),
      h('span', { class: 'bar-val' }, `${v} · ${pct.toFixed(1)}%`)));
  }
  return wrap;
}

/* ------------------------------------------------------------------ */
/* 日志面板                                                            */
/* ------------------------------------------------------------------ */

function renderLog() {
  const host = els.logHost;
  if (!host) return;
  clear(host);
  activeLogEls = [];
  const r = state.result;
  if (!r) return;
  const all = r.logs;
  let list = all;
  if (state.logFilter === 'frame') {
    const f = r.frames[state.frameIndex];
    list = all.slice(f ? f.logFrom : 0, f ? f.logTo : 0);
  } else if (state.logFilter !== 'all') {
    list = all.filter((l) => l.ruleId === state.logFilter);
  }
  const dropped = r.stats.logsDropped || 0;
  els.logCount.textContent = `${list.length} 条 / 共 ${all.length} 条${dropped ? `（另有 ${dropped} 条超出日志缓存上限未记录）` : ''}`;
  const shown = list.slice(0, state.logLimit);
  els.logItems = shown.map((l) => {
    const item = h('div', { class: 'log-item', onclick: () => { pause(); gotoFrame(frameIndexForTick(l.tick)); } },
      h('span', { class: 'log-tick' }, `#${l.tick}`),
      h('span', { class: 'log-rule' }, l.ruleName),
      h('span', { class: 'log-sub' }, `${l.subject}${l.coord ? ` (${l.coord.col},${l.coord.row})` : ''}`),
      h('span', { class: 'log-text' }, l.text || `${l.condition} → ${l.actions}`));
    if (l.skipped) item.classList.add('skipped');
    host.appendChild(item);
    return { el: item, tick: l.tick, log: l };
  });
  if (list.length > shown.length) {
    host.appendChild(h('div', { class: 'hint' },
      `共 ${list.length} 条记录，已显示前 ${shown.length} 条。`,
      button('加载更多', () => { state.logLimit += 400; renderLog(); highlightLogs(); }, 'ghost small')));
  }
  highlightLogs();
}

function highlightLogs() {
  if (!els.logItems) return;
  for (const el of activeLogEls) el.classList.remove('active');
  activeLogEls = [];
  if (!state.result) return;
  const f = state.result.frames[state.frameIndex];
  if (!f) return;
  for (const item of els.logItems) {
    if (item.tick === f.tick) {
      item.el.classList.add('active');
      activeLogEls.push(item.el);
    }
  }
  if (activeLogEls.length && !state.playing) activeLogEls[0].scrollIntoView({ block: 'nearest' });
}

/* ------------------------------------------------------------------ */
/* 侧边面板                                                            */
/* ------------------------------------------------------------------ */

function renderSidePanel() {
  const side = els.side;
  clear(side);

  side.appendChild(diagnosticsGroup());

  const currentPreset = PRESETS.find((p) => p.name === state.cfg.meta.name) || PRESETS[0];
  const presetSel = select(currentPreset.id, PRESETS.map((p) => ({ value: p.id, label: p.name })), () => {});
  const presetDesc = h('div', { class: 'hint' }, currentPreset.description);
  presetSel.addEventListener('change', () => {
    const p = PRESETS.find((x) => x.id === presetSel.value);
    if (p) presetDesc.textContent = p.description;
  });
  side.appendChild(group('预设模板', [
    field('模板', presetSel),
    presetDesc,
    row(button('载入模板', () => {
      state.cfg = normalizeConfig(buildPresetConfig(presetSel.value));
      state.frameIndex = 0;
      state.dirty = true;
      rebuildAll();
      toast('已载入模板', 'success');
    }, 'primary'), button('空白配置', () => {
      state.cfg = normalizeConfig(defaultConfig());
      state.frameIndex = 0;
      rebuildAll();
    }, 'ghost'), button('恢复上次配置', () => {
      const last = loadLocalConfig();
      if (!last) { toast('本地没有可恢复的配置', 'warn'); return; }
      state.cfg = last;
      state.frameIndex = 0;
      rebuildAll();
      toast('已恢复上次配置', 'success');
    }, 'ghost')),
  ], { open: true }));

  side.appendChild(group('配置导入导出', [
    row(
      button('复制 JSON', () => copyText(configToJSON(state.cfg), '配置 JSON 已复制')),
      button('下载 JSON', () => downloadText(`${safeName(state.cfg.meta.name)}.json`, configToJSON(state.cfg), 'application/json')),
    ),
    row(
      button('复制分享链接', () => copyText(buildShareUrl(state.cfg), '分享链接已复制')),
      button('载入链接配置', () => {
        const shared = readConfigFromLocation();
        if (!shared) { toast('当前链接中没有配置参数', 'warn'); return; }
        state.cfg = normalizeConfig(shared);
        rebuildAll();
        toast('已从链接载入配置', 'success');
      }),
    ),
    field('粘贴 JSON 导入', (() => {
      const ta = textArea('', () => {}, { rows: 4, placeholder: '在此粘贴配置 JSON…' });
      return h('div', {}, ta, row(button('导入配置', () => {
        try {
          const obj = JSON.parse(ta.value);
          const v = validateConfig(obj);
          if (!v.ok) { toast(`配置无效：${v.errors[0]}`, 'error'); return; }
          if (v.warnings.length) toast(v.warnings[0], 'warn');
          state.cfg = normalizeConfig(obj);
          rebuildAll();
          toast('配置导入成功', 'success');
        } catch (e) {
          toast(`JSON 解析失败：${e.message}`, 'error');
        }
      }, 'primary small'), button('清空', () => { ta.value = ''; }, 'ghost small')));
    })()),
  ], { open: false }));

  side.appendChild(group('导出结果', [
    row(
      button('轨迹 CSV', () => withResult((r) => downloadText(`trail-${r.seed}.csv`, trailToCSV(r), 'text/csv;charset=utf-8'))),
      button('轨迹 JSON', () => withResult((r) => downloadText(`trail-${r.seed}.json`, trailToJSON(r), 'application/json'))),
    ),
    row(
      button('日志 CSV', () => withResult((r) => downloadText(`logs-${r.seed}.csv`, logsToCSV(r), 'text/csv;charset=utf-8'))),
      button('日志 JSON', () => withResult((r) => downloadText(`logs-${r.seed}.json`, logsToJSON(r), 'application/json'))),
    ),
    row(
      button('当前帧 PNG', () => withResult(() => downloadCanvasPNG(renderer.canvas, `frame-${state.frameIndex}.png`))),
      button('当前帧 SVG', () => withResult((r) => downloadSVG(frameToSVG(r, state.frameIndex, state.cfg.style), `frame-${state.frameIndex}.svg`))),
    ),
  ], { open: false }));

  els.logHost = h('div', { class: 'log-list' });
  els.logCount = h('span', { class: 'mini-label' }, '');
  const filterSel = select(state.logFilter, [
    { value: 'all', label: '全部规则' },
    { value: 'frame', label: '仅当前步' },
    ...state.cfg.environmentRules.map((r) => ({ value: r.id, label: r.name })),
  ], (v) => { state.logFilter = v; renderLog(); });

  side.appendChild(group('规则触发日志', [
    row(filterSel, els.logCount),
    els.logHost,
  ], { open: true }));
}

function withResult(fn) {
  if (!state.result) { toast('尚未运行模拟', 'warn'); return; }
  fn(state.result);
}

/* ------------------------------------------------------------------ */
/* 配置诊断                                                            */
/* ------------------------------------------------------------------ */

const DIAG_LEVEL_TEXT = { error: '严重', warning: '警告', info: '提示' };
const DIAG_GROUP_KEY = 'diagnostics';

/**
 * 合并两类诊断：
 *  - 静态：当前配置与地图尺寸的匹配情况（规范化前的原始配置）
 *  - 运行期：上一次运行中真实发生的情况（如身体被截断、起点被阻塞）
 * 同一 code 以运行期结果为准，避免同一条问题重复出现。
 */
function collectDiagnostics() {
  const staticList = diagnoseConfig(state.cfg);
  // 配置改动后（dirty）上一次运行的运行期诊断已不适用，只展示静态诊断
  const runtime = state.dirty ? [] : (state.result?.diagnostics || []);
  const runtimeCodes = new Set(runtime.map((d) => d.code));
  return [...runtime, ...staticList.filter((d) => !runtimeCodes.has(d.code))];
}

function diagnosticsGroup() {
  const list = collectDiagnostics();
  const errors = list.filter((d) => d.level === 'error').length;
  const warnings = list.filter((d) => d.level === 'warning').length;
  const badge = errors ? `${errors} 项严重` : warnings ? `${warnings} 项警告` : '正常';
  const body = [];
  if (!list.length) {
    body.push(h('div', { class: 'diag-ok' }, '未检测到异常：起点、初始身体与地图尺寸相互匹配。'));
  } else {
    body.push(h('div', { class: 'hint' }, '以下情况会被静默修正或导致结果不符合预期，可直接套用其中一种解决方案。'));
    for (const d of list) body.push(diagItem(d));
    body.push(row(button('复制诊断报告', () => copyText(diagnosticsReport(list), '诊断报告已复制'), 'ghost small')));
  }
  return group('配置诊断', body, { open: true, key: DIAG_GROUP_KEY, badge });
}

/** 只重建「配置诊断」分组，避免整块侧边面板重绘 */
function refreshDiagnostics() {
  const old = els.side && els.side.querySelector(`[data-group-key="${DIAG_GROUP_KEY}"]`);
  if (old && old.parentNode) old.parentNode.replaceChild(diagnosticsGroup(), old);
}

function diagItem(d) {
  const item = h('div', { class: `diag-item ${d.level}` },
    h('div', { class: 'diag-head' },
      h('span', { class: `diag-level ${d.level}` }, DIAG_LEVEL_TEXT[d.level] || d.level),
      h('span', { class: 'diag-title' }, d.title)),
    h('div', { class: 'diag-msg' }, d.message));
  const fixes = (d.suggestions || []).filter((s) => s.patch);
  if (fixes.length) {
    const host = h('div', { class: 'diag-fixes' }, h('span', { class: 'diag-fix-label' }, '可能的解决方案：'));
    for (const s of fixes) host.appendChild(button(s.label, () => applyDiagFix(s), 'ghost small'));
    item.appendChild(host);
  }
  return item;
}

/** 套用诊断建议：把补丁深合并进当前配置后重算 */
function applyDiagFix(suggestion) {
  deepAssign(state.cfg, suggestion.patch);
  state.frameIndex = 0;
  rebuildAll();
  toast(`已应用：${suggestion.label}`, 'success');
}

/** 深合并补丁（对象递归合并，数组与标量直接覆盖），保持原有对象引用有效 */
function deepAssign(target, patch) {
  for (const [k, v] of Object.entries(patch || {})) {
    const cur = target[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' && !Array.isArray(cur)) {
      deepAssign(cur, v);
    } else {
      target[k] = Array.isArray(v) ? [...v] : v;
    }
  }
  return target;
}

function diagnosticsReport(list) {
  const lines = [`# GridSneaker 配置诊断 · ${state.cfg.meta.name}`];
  for (const d of list) {
    lines.push('', `[${DIAG_LEVEL_TEXT[d.level] || d.level}] ${d.title}`, `  ${d.message}`);
    for (const s of d.suggestions || []) lines.push(`  · ${s.label}`);
  }
  return lines.join('\n');
}

/** 启动时若存在严重问题，提示用户查看诊断面板（不打断操作） */
function notifyStartupDiagnostics() {
  const errors = diagnoseConfig(state.cfg).filter((d) => d.level === 'error');
  if (errors.length) toast(`检测到 ${errors.length} 项配置异常：${errors[0].title}（见右侧「配置诊断」）`, 'warn');
}

function copyText(text, okMsg) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(() => toast(okMsg, 'success')).catch(() => fallbackCopy(text, okMsg));
  } else {
    fallbackCopy(text, okMsg);
  }
}

function fallbackCopy(text, okMsg) {
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); toast(okMsg, 'success'); } catch (e) { toast('复制失败', 'error'); }
  ta.remove();
}

function safeName(name) {
  return String(name || 'simulation').replace(/[\\/:*?"<>|]/g, '_');
}

/* ------------------------------------------------------------------ */
/* 配置面板                                                            */
/* ------------------------------------------------------------------ */

function rebuildAll() {
  state.dirty = true; // 配置即将变化：隐藏上一轮的运行期诊断，避免渲染顺序造成残留
  renderConfigPanel();
  renderSidePanel();
  recompute({ immediate: true });
}

function renderConfigPanel() {
  const root = els.config;
  clear(root);
  endConditionSyncers.clear(); // 重建面板前清空旧的联动回调，避免重复累积
  const cfg = state.cfg;
  root.appendChild(sceneGroup(cfg));
  root.appendChild(gridGroup(cfg));
  root.appendChild(bodyGroup(cfg));
  root.appendChild(moveGroup(cfg));
  root.appendChild(advancedGroup(cfg));
  root.appendChild(collisionGroup(cfg));
  root.appendChild(lengthGroup(cfg));
  root.appendChild(envRulesGroup(cfg));
  root.appendChild(caGroup(cfg));
  root.appendChild(endGroup(cfg));
  root.appendChild(styleGroup(cfg));
}

function sceneGroup(cfg) {
  return group('场景与随机', [
    field('名称', textBind(cfg.meta, 'name', () => {})),
    field('描述', textBind(cfg.meta, 'description', () => {})),
    field('随机种子', row(
      numBind(cfg, 'seed', () => onSimChange(0), { min: 1, step: 1 }),
      button('🎲 随机', () => { cfg.seed = Math.floor(Math.random() * 1e9) + 1; rebuildAll(); }, 'ghost small'),
    ), '相同种子 + 相同配置 = 完全相同的结果'),
    field('规则执行方式', selBind(cfg, 'ruleExecution', () => onSimChange(), [
      { value: 'async', label: '异步（逐条即时生效）' },
      { value: 'sync', label: '同步（基于阶段快照）' },
    ])),
  ], { open: true });
}

function gridGroup(cfg) {
  const g = cfg.grid;
  return group('网格与坐标', [
    field('网格类型', selBind(g, 'type', () => {
      g.width = Math.min(g.width, 200);
      g.height = Math.min(g.height, 200);
      // 「任意」方向与网格类型无关，切换时保留
      if (cfg.start.direction !== 'random') cfg.start.direction = dirNames(g.type)[0];
      cfg.body.shape = g.type === 'hex' ? 'hexagon' : 'round';
      cfg.start.col = Math.min(cfg.start.col, g.width - 1);
      cfg.start.row = Math.min(cfg.start.row, g.height - 1);
      rebuildAll();
    }, [
      { value: 'square', label: '方格图（4 方向）' },
      { value: 'hex', label: '六边形图（6 方向，轴向坐标）' },
    ]), g.type === 'hex' ? '六边形使用尖顶轴向坐标，邻居为 6 方向' : '方格使用偏移坐标，4 方向移动 + 4/8 邻域感知'),
    row(
      field('宽', numBind(g, 'width', () => onSimChange(), { min: 2, max: 400 })),
      field('高', numBind(g, 'height', () => onSimChange(), { min: 2, max: 400 })),
    ),
    field('边界行为', selBind(g, 'boundary', () => onSimChange(), [
      { value: 'stop', label: '停止（撞墙即停）' },
      { value: 'bounce', label: '反弹' },
      { value: 'wrap', label: '穿越到另一侧' },
      { value: 'randomTurn', label: '随机转向' },
      { value: 'custom', label: '自定义（由环境规则决定）' },
    ])),
    h('div', { class: 'hint' }, `网格共 ${g.width * g.height} 格`),
  ]);
}

function bodyGroup(cfg) {
  const b = cfg.body;
  const defaultSegmentSize = defaultConfig().body.segmentSize;
  const sizeInput = numBind(b, 'segmentSize', () => onStyleChange(), { min: 0.1, max: 1.6, step: 0.02 });
  return group('起点与移动体', [
    row(
      field('起点 col/x', numBind(cfg.start, 'col', () => onSimChange(), { min: 0, max: cfg.grid.width - 1 })),
      field('起点 row/y', numBind(cfg.start, 'row', () => onSimChange(), { min: 0, max: cfg.grid.height - 1 })),
    ),
    field('起始方向', selBind(cfg.start, 'direction', () => onSimChange(), [
      ...dirNames(cfg.grid.type).map((n) => ({ value: n, label: DIR_LABELS[n] || n })),
      { value: 'random', label: '任意（每次运行随机）' },
    ]), '选择「任意」时，起始方向由随机种子决定，同一种子结果可复现'),
    row(
      field('初始长度', numBind(b, 'initialLength', () => onSimChange(), { min: 1, max: 100000 })),
      field('体节尺寸', row(
        sizeInput,
        button('重置', () => {
          b.segmentSize = defaultSegmentSize;
          sizeInput.value = defaultSegmentSize;
          onStyleChange();
        }, 'ghost small'),
      ), '相对格子的比例，与长度无关'),
    ),
    row(
      field('体节形状', selBind(b, 'shape', () => onStyleChange(), [
        { value: 'round', label: '圆形' }, { value: 'square', label: '方形' }, { value: 'hexagon', label: '六边形' },
      ])),
      // 配色模式会决定「自定义色带」字段是否出现，因此需要重建面板；canvas 样式同时即时刷新
      field('配色模式', selBind(b, 'colorMode', () => { onStyleChange(); renderConfigPanel(); }, [
        { value: 'gradient', label: '头尾渐变' }, { value: 'solid', label: '单色' }, { value: 'custom', label: '自定义多色' },
      ])),
    ),
    row(
      field('头色', colorBind(b.colors, 'head', () => onStyleChange())),
      field('尾色', colorBind(b.colors, 'tail', () => onStyleChange())),
      field('单色', colorBind(b.colors, 'solid', () => onStyleChange())),
    ),
    b.colorMode === 'custom'
      ? field('自定义色带', textInput((b.colors.custom || []).join(', '), (v) => {
        const list = parseColorList(v);
        if (list.length) {
          b.colors.custom = list;
          onStyleChange();
        } else {
          toast('请至少填写一个合法的十六进制颜色，如 #ff5d5d', 'warn');
        }
      }, { placeholder: '#ff5d5d, #ffd166, #51cf66' }),
        '逗号分隔的十六进制颜色序列，从头到尾沿体节渐变')
      : null,
  ]);
}

/** 解析逗号/空格分隔的颜色列表，仅保留合法的十六进制颜色 */
function parseColorList(text) {
  return String(text || '')
    .split(/[\s,，;；]+/)
    .map((s) => s.trim())
    .filter((s) => /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(s));
}

/** 左/直/右权重占比说明（引擎按占比归一化，权重绝对值不影响比例） */
function weightSummary(m) {
  const sum = m.left + m.straight + m.right;
  if (sum <= 0) return '权重全为 0，运行时按均匀分布处理';
  return `概率：左 ${(m.left / sum * 100).toFixed(1)}% · 直 ${(m.straight / sum * 100).toFixed(1)}% · 右 ${(m.right / sum * 100).toFixed(1)}%`;
}

function moveGroup(cfg) {
  const m = cfg.moveRules;
  const hint = h('div', { class: 'hint' }, weightSummary(m));
  const upd = () => { onSimChange(); hint.textContent = weightSummary(m); };
  return group('基础移动规则', [
    field('左转权重', rangeBind(m, 'left', upd, { min: 0, max: 1, step: 0.01, number: true })),
    field('直行权重', rangeBind(m, 'straight', upd, { min: 0, max: 1, step: 0.01, number: true })),
    field('右转权重', rangeBind(m, 'right', upd, { min: 0, max: 1, step: 0.01, number: true })),
    hint,
  ], { open: true });
}

/* ---------------- 高级规则（条件概率） ---------------- */

function advancedGroup(cfg) {
  const list = h('div', { class: 'rule-list' });
  cfg.advancedRules.forEach((r, index) => {
    const hint = h('div', { class: 'hint' }, weightSummary(r.moves));
    const updWeights = () => { onSimChange(); hint.textContent = weightSummary(r.moves); };
    const body = [
      row(
        textBind(r, 'name', () => {}),
        chkBind(r, 'enabled', () => onSimChange(), '启用'),
        button('↑', () => { swap(cfg.advancedRules, index, index - 1); rebuildAll(); }, 'icon small'),
        button('↓', () => { swap(cfg.advancedRules, index, index + 1); rebuildAll(); }, 'icon small'),
        button('✕', () => { cfg.advancedRules.splice(index, 1); rebuildAll(); }, 'icon small danger'),
      ),
      field('条件', conditionEditor(r.condition, () => onSimChange(), () => rebuildAll()), '条件满足时使用下面的权重'),
      field('左转权重', rangeBind(r.moves, 'left', updWeights, { min: 0, max: 1, step: 0.01, number: true })),
      field('直行权重', rangeBind(r.moves, 'straight', updWeights, { min: 0, max: 1, step: 0.01, number: true })),
      field('右转权重', rangeBind(r.moves, 'right', updWeights, { min: 0, max: 1, step: 0.01, number: true })),
      hint,
      field('优先级', numBind(r, 'priority', () => onSimChange(), { step: 1 }), '数值越大越优先匹配'),
    ];
    list.appendChild(group(r.name || '条件概率规则', body, { open: index === 0, badge: r.enabled ? '' : '停用', key: `adv:${r.id}` }));
  });
  return group('高级移动规则（条件概率）', [
    h('div', { class: 'hint' }, '按优先级匹配，命中后使用该规则的左/直/右权重；未命中则使用基础权重。'),
    list,
    button('+ 添加条件概率规则', () => {
      cfg.advancedRules.push({
        id: `adv_${Math.random().toString(36).slice(2, 8)}`,
        enabled: true,
        name: `条件概率 ${cfg.advancedRules.length + 1}`,
        condition: { logic: 'and', clauses: [defaultClause('count')] },
        moves: { left: 0.2, straight: 0.6, right: 0.2 },
        priority: 1,
      });
      rebuildAll();
    }, 'ghost'),
  ], { open: false });
}

/* ---------------- 碰撞与边界 ---------------- */

function collisionGroup(cfg) {
  const c = cfg.collision;
  const sp = cfg.selfCollisionPolicy;
  // 「连续自撞上限」只在「结束规则 → 撞到自身」勾选时才参与结束判定，
  // 因此这里跟随该结束规则的可编辑状态联动置灰。
  const maxConsecutiveInput = numBind(sp, 'maxConsecutive', () => onSimChange(), { min: 1, max: 100000 });
  const syncMaxConsecutive = (on) => {
    maxConsecutiveInput.disabled = !on;
    maxConsecutiveInput.title = on ? '' : '需先勾选「结束规则 → 撞到自身」，该项才会生效';
  };
  bindEndConditionSync('selfCollision', syncMaxConsecutive);
  syncMaxConsecutive(!!cfg.endConditions.selfCollision);
  return group('碰撞与自撞处理', [
    field('视为碰撞', h('div', { class: 'chips-line' },
      chkBind(c, 'headIntoBody', () => onSimChange(), '头撞身体'),
      chkBind(c, 'headIntoTail', () => onSimChange(), '头撞尾部'),
      chkBind(c, 'wall', () => onSimChange(), '撞墙'),
      chkBind(c, 'outOfBounds', () => onSimChange(), '越界')),
      '勾选项会累加碰撞次数并如实记录'),
    field('撞到障碍物', selBind(c, 'obstacle', () => onSimChange(), [
      { value: 'stop', label: '停止并结束' },
      { value: 'destroy', label: '撞毁障碍物后继续' },
      { value: 'pass', label: '直接穿过' },
      { value: 'turn', label: '随机转向绕开' },
    ])),
    field('自撞处理', selBind(sp, 'action', () => onSimChange(), [
      { value: 'stop', label: '立即停止' },
      { value: 'ignore', label: '忽略并继续' },
      { value: 'forceStraight', label: '强制直行 1 次' },
      { value: 'forceStraightN', label: '强制直行 n 次' },
      { value: 'randomTurn', label: '随机转向' },
      { value: 'custom', label: '自定义（立即停止）' },
    ]), '是否结束运行由「结束规则 → 撞到自身」统一控制；未勾选时「立即停止/自定义」退化为「忽略并继续」'),
    field('强制直行次数 n', numBind(sp, 'n', () => onSimChange(), { min: 1, max: 1000 }),
      '连续强制直行带防死循环保护'),
    field('连续自撞上限', maxConsecutiveInput,
      '连续撞到自身达到该次数后结束（需勾选「结束规则 → 撞到自身」）'),
  ], { open: false });
}

/* ---------------- 长度策略 ---------------- */

function lengthGroup(cfg) {
  const lp = cfg.body.lengthPolicy;
  const subEditor = (sub, title) => [
    h('div', { class: 'sub-title' }, title),
    field('启用', chkBind(sub, 'enabled', () => onSimChange(), '启用'), '仅在长度策略为「可变」时生效'),
    row(
      field('触发时机', selBind(sub, 'trigger', () => onSimChange(), [
        { value: 'step', label: '每步' }, { value: 'eat', label: '吃到标记物' },
        { value: 'collision', label: '发生碰撞' }, { value: 'timer', label: '每 N 步' },
      ])),
      field('间隔', numBind(sub, 'interval', () => onSimChange(), { min: 1, max: 100000 })),
    ),
    row(
      field('每步变化量', numBind(sub, 'amount', () => onSimChange(), { min: -100, max: 100 })),
      field('概率', rangeBind(sub, 'probability', () => onSimChange(), { min: 0, max: 1, step: 0.01 })),
    ),
    row(
      field('最大长度', numBind(sub, 'maxLength', () => onSimChange(), { min: 1, max: 100000 })),
      field('最小长度', numBind(sub, 'minLength', () => onSimChange(), { min: 1, max: 100000 })),
    ),
  ];
  return group('长度策略', [
    field('模式', selBind(lp, 'mode', () => onSimChange(), [
      { value: 'fixed', label: '固定长度（头进尾出）' },
      { value: 'variable', label: '可变长度（增长 / 缩短）' },
      { value: 'custom', label: '自定义（由环境规则决定）' },
    ]), '自定义模式建议配合「改变长度 / 设定长度」后果动作使用'),
    ...subEditor(lp.growth, '增长'),
    ...subEditor(lp.shrink, '缩短'),
  ], { open: false });
}

/* ---------------- 环境规则 ---------------- */

function envRulesGroup(cfg) {
  const list = h('div', { class: 'rule-list' });
  cfg.environmentRules.forEach((rule, index) => {
    const body = [
      row(
        textBind(rule, 'name', () => { renderSidePanel(); }),
        chkBind(rule, 'enabled', () => onSimChange(), '启用'),
        button('测试', () => testRule(rule), 'ghost small'),
        button('↑', () => { swap(cfg.environmentRules, index, index - 1); rebuildAll(); }, 'icon small'),
        button('↓', () => { swap(cfg.environmentRules, index, index + 1); rebuildAll(); }, 'icon small'),
        button('✕', () => { cfg.environmentRules.splice(index, 1); rebuildAll(); }, 'icon small danger'),
      ),
      row(
        field('规则主体', selBind(rule, 'subject', () => { onSimChange(); rebuildAll(); }, Object.entries(SUBJECT_LABELS).map(([value, label]) => ({ value, label })))),
        field('触发时机', selBind(rule, 'trigger', () => { onSimChange(); rebuildAll(); }, Object.entries(TRIGGER_LABELS).map(([value, label]) => ({ value, label })))),
      ),
      rule.subject === 'segment'
        ? field('体节编号', numBind(rule, 'segmentIndex', () => onSimChange(), { min: 0, step: 1 }), '0 为蛇头，支持负索引（-1 为尾）')
        : null,
      rule.trigger === 'timer'
        ? field('触发间隔', numBind(rule, 'interval', () => onSimChange(), { min: 1 }))
        : null,
      row(
        field('优先级', numBind(rule, 'priority', () => onSimChange(), { step: 1 })),
        field('触发概率', rangeBind(rule, 'probability', () => onSimChange(), { min: 0, max: 1, step: 0.01 })),
      ),
      row(
        field('冷却步数', numBind(rule, 'cooldown', () => onSimChange(), { min: 0 })),
        field('触发次数上限', numBind(rule, 'maxTriggers', () => onSimChange(), { min: 0 }), '0 为不限'),
        field('仅一次', chkBind(rule, 'once', () => onSimChange(), '仅触发一次')),
      ),
      field('周围环境条件', conditionEditor(rule.condition, () => onSimChange(), () => rebuildAll())),
      field('后果动作', h('div', { class: 'action-list' },
        ...rule.actions.map((a, ai) => actionEditor(rule, a, ai)),
        button('+ 添加后果动作', () => { rule.actions.push(defaultAction('createObstacle')); rebuildAll(); }, 'ghost small'))),
    ];
    list.appendChild(group(rule.name || '环境规则', body, { open: false, badge: rule.enabled ? '' : '停用', key: `env:${rule.id}` }));
  });

  return group('环境感知—条件—后果规则', [
    h('div', { class: 'hint' }, '当蛇头 / 蛇身 / 二者在满足周围环境条件时，触发对应后果（产生障碍物、标记物、强制转向等）。'),
    list,
    row(
      button('+ 添加环境规则', () => {
        cfg.environmentRules.push(defaultRule({ name: `规则 ${cfg.environmentRules.length + 1}` }));
        rebuildAll();
      }, 'primary'),
      button('+ 障碍物感知示例', () => {
        cfg.environmentRules.push(defaultRule({
          name: '前方障碍则右转',
          subject: 'head',
          trigger: 'afterStep',
          priority: 5,
          condition: { logic: 'and', clauses: [defaultClause('direction')] },
          actions: [defaultAction('forceTurn'), defaultAction('createMarker')],
        }));
        rebuildAll();
      }, 'ghost'),
    ),
  ], { open: true });
}

function actionEditor(rule, action, index) {
  const controls = [];
  const rebuild = () => rebuildAll();
  controls.push(row(
    select(action.type, Object.entries(ACTION_LABELS).map(([value, label]) => ({ value, label })), (v) => {
      Object.assign(action, defaultAction(v));
      rebuild();
    }),
    button('↑', () => { swap(rule.actions, index, index - 1); rebuild(); }, 'icon small'),
    button('↓', () => { swap(rule.actions, index, index + 1); rebuild(); }, 'icon small'),
    button('✕', () => { rule.actions.splice(index, 1); rebuild(); }, 'icon small danger'),
  ));

  switch (action.type) {
    case 'createObstacle':
    case 'createMarker':
      controls.push(row(
        field('位置', selBind(action, 'position', () => onSimChange(), POSITIONS)),
        field('数量', numBind(action, 'count', () => onSimChange(), { min: 1, max: 64 })),
      ));
      break;
    case 'removeObstacle':
    case 'removeMarker':
    case 'paintTrail':
      controls.push(field('位置', selBind(action, 'position', () => onSimChange(), POSITIONS)));
      break;
    case 'setCellState':
      controls.push(row(
        field('位置', selBind(action, 'position', () => onSimChange(), POSITIONS)),
        field('目标状态', select(action.state, stateOptions(), (v) => { action.state = v; onSimChange(); })),
      ));
      break;
    case 'clearState':
      controls.push(field('状态', select(action.state, stateOptions(), (v) => { action.state = v; onSimChange(); })));
      break;
    case 'forceTurn':
      controls.push(row(
        field('转向', selBind(action, 'turn', () => onSimChange(), Object.entries(TURN_LABELS).map(([value, label]) => ({ value, label })))),
        field('概率', rangeBind(action, 'probability', () => onSimChange(), { min: 0, max: 1, step: 0.01 })),
      ));
      break;
    case 'randomTurn':
      controls.push(row(
        field('左', numBind(action.weights, 'left', () => onSimChange(), { min: 0, step: 0.1 })),
        field('直', numBind(action.weights, 'straight', () => onSimChange(), { min: 0, step: 0.1 })),
        field('右', numBind(action.weights, 'right', () => onSimChange(), { min: 0, step: 0.1 })),
      ));
      break;
    case 'changeLength':
      controls.push(field('变化量', numBind(action, 'amount', () => onSimChange(), { min: -1000, max: 1000 }), '负数表示缩短'));
      break;
    case 'setLength':
      controls.push(field('目标长度', numBind(action, 'value', () => onSimChange(), { min: 1, max: 100000 })));
      break;
    case 'changeSpeed':
      controls.push(row(
        field('倍率', numBind(action, 'factor', () => onSimChange(), { min: 0.05, max: 20, step: 0.05 })),
      ));
      break;
    case 'setColor':
      controls.push(field('颜色', colorBind(action, 'color', () => onSimChange())));
      break;
    case 'spawnAgent':
      controls.push(row(
        field('长度', numBind(action, 'length', () => onSimChange(), { min: 1, max: 200 })),
        field('方向', select(action.direction, [{ value: 'random', label: '随机' }, ...dirNames(state.cfg.grid.type).map((n) => ({ value: n, label: DIR_LABELS[n] || n }))], (v) => { action.direction = v; onSimChange(); })),
      ));
      break;
    case 'modifyRule':
      controls.push(row(
        field('目标规则', select(action.ruleId, state.cfg.environmentRules.map((r) => ({ value: r.id, label: r.name })), (v) => { action.ruleId = v; onSimChange(); })),
        field('操作', selBind(action, 'op', () => onSimChange(), [
          { value: 'disable', label: '停用' }, { value: 'enable', label: '启用' }, { value: 'setProbability', label: '设置概率' },
        ])),
        field('概率值', numBind(action, 'value', () => onSimChange(), { min: 0, max: 1, step: 0.05 })),
      ));
      break;
    case 'endRun':
      controls.push(field('结束原因', textBind(action, 'reason', () => onSimChange())));
      break;
    case 'log':
      controls.push(field('日志内容', textBind(action, 'message', () => onSimChange())));
      break;
    default:
      break;
  }
  return h('div', { class: 'action-item' }, controls);
}

function testRule(rule) {
  if (!state.result) { toast('请先运行模拟', 'warn'); return; }
  const hit = state.result.logs.find((l) => l.ruleId === rule.id);
  if (!hit) { toast('本次运行中该规则从未触发', 'warn'); return; }
  pause();
  gotoFrame(hit.tick);
  toast(`规则「${rule.name}」首次触发于第 ${hit.tick} 步`, 'success');
}

/* ---------------- 条件编辑器 ---------------- */

function conditionEditor(condition, onChange, rebuild) {
  const wrap = h('div', { class: 'condition' });
  wrap.appendChild(row(
    h('span', { class: 'mini-label' }, '组合方式'),
    select(condition.logic, [{ value: 'and', label: '全部满足 (AND)' }, { value: 'or', label: '任一满足 (OR)' }], (v) => { condition.logic = v; onChange(); }),
    button('+ 添加子句', () => { condition.clauses.push(defaultClause('count')); rebuild(); }, 'ghost small'),
  ));
  if (!condition.clauses.length) {
    wrap.appendChild(h('div', { class: 'hint' }, '暂无子句：条件恒成立'));
    return wrap;
  }
  condition.clauses.forEach((clause, i) => {
    wrap.appendChild(clauseEditor(condition, clause, i, onChange, rebuild));
  });
  return wrap;
}

function clauseEditor(parent, clause, index, onChange, rebuild) {
  const box = h('div', { class: 'clause' });
  box.appendChild(row(
    h('span', { class: 'clause-index' }, `${index + 1}`),
    select(clause.type, CLAUSE_TYPES, (v) => {
      Object.assign(clause, defaultClause(v));
      rebuild();
    }),
    checkbox(clause.invert, (v) => { clause.invert = v; onChange(); }, '取反'),
    button('↑', () => { swap(parent.clauses, index, index - 1); rebuild(); }, 'icon small'),
    button('↓', () => { swap(parent.clauses, index, index + 1); rebuild(); }, 'icon small'),
    button('✕', () => { parent.clauses.splice(index, 1); rebuild(); }, 'icon small danger'),
  ));

  const neighborhoodFields = () => row(
    field('邻域', selBind(clause, 'kind', () => onChange(), NEIGHBORHOODS)),
    field('半径', numBind(clause, 'radius', () => onChange(), { min: 1, max: 12 })),
    clause.type === 'count' || clause.type === 'proportion'
      ? checkbox(clause.includeSelf, (v) => { clause.includeSelf = v; onChange(); }, '包含中心格')
      : null,
  );

  switch (clause.type) {
    case 'count':
      box.appendChild(neighborhoodFields());
      box.appendChild(field('检测对象', objectsEditor(clause, onChange)));
      box.appendChild(row(
        field('比较', selBind(clause, 'comparator', () => onChange(), COMPARATORS)),
        field('数量', numBind(clause, 'value', () => onChange(), { min: 0, max: 100000 })),
      ));
      break;
    case 'proportion':
      box.appendChild(neighborhoodFields());
      box.appendChild(field('检测对象', objectsEditor(clause, onChange)));
      box.appendChild(field('比例条件', row(
        select(clause.comparator, COMPARATORS, (v) => { clause.comparator = v; onChange(); }),
        range(clause.value, (v) => { clause.value = v; onChange(); }, { min: 0, max: 1, step: 0.01 }),
      )));
      break;
    case 'exists':
      box.appendChild(neighborhoodFields());
      box.appendChild(field('检测对象', objectsEditor(clause, onChange)));
      break;
    case 'direction':
      box.appendChild(field('检测对象', objectsEditor(clause, onChange)));
      box.appendChild(row(
        field('相对方位', selBind(clause, 'rel', () => onChange(), state.cfg.grid.type === 'hex' ? REL_OPTIONS_HEX : REL_OPTIONS_SQUARE)),
        field('距离', numBind(clause, 'distance', () => onChange(), { min: 1, max: 12 })),
      ));
      break;
    case 'pattern':
      box.appendChild(field('邻域图案', textArea(clause.pattern, (v) => { clause.pattern = v; onChange(); }, { rows: state.cfg.grid.type === 'hex' ? 2 : 3 }),
        state.cfg.grid.type === 'hex'
          ? '中心 + 顺时针 6 邻：H 蛇头 / S 蛇身 / # 障碍 / M 标记 / . 空 / * 任意'
          : '3×3 行优先：H 蛇头 / S 蛇身 / # 障碍 / M 标记 / . 空 / * 任意'));
      break;
    case 'distance':
      box.appendChild(field('检测对象', objectsEditor(clause, onChange)));
      box.appendChild(row(
        field('比较', selBind(clause, 'comparator', () => onChange(), COMPARATORS)),
        field('距离', numBind(clause, 'value', () => onChange(), { min: 0, max: 400 })),
      ));
      break;
    case 'stat':
      box.appendChild(row(
        field('统计项', selBind(clause, 'key', () => onChange(), Object.entries(STAT_LABELS).map(([value, label]) => ({ value, label })))),
        field('比较', selBind(clause, 'comparator', () => onChange(), COMPARATORS)),
        field('数值', numBind(clause, 'value', () => onChange(), { min: -100000, max: 100000 })),
      ));
      break;
    case 'selfLength':
      box.appendChild(row(
        field('比较', selBind(clause, 'comparator', () => onChange(), COMPARATORS)),
        field('长度', numBind(clause, 'value', () => onChange(), { min: 1, max: 100000 })),
      ));
      break;
    case 'cellState':
      box.appendChild(row(
        field('位置', selBind(clause, 'position', () => onChange(), POSITIONS.filter((p) => p.value !== 'random' && p.value !== 'randomEmpty' && p.value !== 'randomNeighbor'))),
        field('状态', select(clause.state, stateOptions(), (v) => { clause.state = v; onChange(); })),
      ));
      break;
    case 'random':
      box.appendChild(field('触发概率', range(clause.probability, (v) => { clause.probability = v; onChange(); }, { min: 0, max: 1, step: 0.01 })));
      break;
    case 'group':
      box.appendChild(row(
        h('span', { class: 'mini-label' }, '子句组合'),
        select(clause.logic, [{ value: 'and', label: '全部满足 (AND)' }, { value: 'or', label: '任一满足 (OR)' }], (v) => { clause.logic = v; onChange(); }),
        button('+ 子句', () => { clause.clauses.push(defaultClause('count')); rebuild(); }, 'ghost small'),
      ));
      (clause.clauses || []).forEach((sub, i) => box.appendChild(clauseEditor(clause, sub, i, onChange, rebuild)));
      break;
    default:
      break;
  }
  return box;
}

function objectsEditor(clause, onChange) {
  const wrap = h('div', { class: 'chips' });
  const options = objectOptions();
  if (!clause.objects) clause.objects = ['obstacle'];
  for (const name of options) {
    const on = clause.objects.includes(name);
    const chip = h('button', {
      type: 'button',
      class: `chip${on ? ' on' : ''}`,
      onclick: () => {
        const i = clause.objects.indexOf(name);
        if (i >= 0) clause.objects.splice(i, 1);
        else clause.objects.push(name);
        if (!clause.objects.length) clause.objects.push('obstacle');
        chip.classList.toggle('on');
        onChange();
      },
    }, OBJECT_LABELS[name] || name);
    wrap.appendChild(chip);
  }
  return wrap;
}

function objectOptions() {
  const extra = state.cfg.caMode.states.map((s) => s.name).filter((n) => !BASE_OBJECTS.includes(n) && n !== 'empty');
  return [...BASE_OBJECTS, ...extra];
}

function stateOptions() {
  return state.cfg.caMode.states.map((s) => ({ value: s.name, label: s.name }));
}

/* ---------------- 元胞自动机 ---------------- */

function caGroup(cfg) {
  const ca = cfg.caMode;
  const body = [
    field('启用元胞自动机', chkBind(ca, 'enabled', () => { onSimChange(0); rebuildAll(); }, '启用')),
    h('div', { class: 'hint' }, '启用后，环境单元按状态转移规则演化；移动体规则与环境规则可同时生效，形成混合模式。'),
    field('环境状态集合', stateListEditor(ca.states)),
    row(
      field('邻域', selBind(ca, 'neighborhood', () => onSimChange(), NEIGHBORHOODS)),
      field('半径', numBind(ca, 'radius', () => onSimChange(), { min: 1, max: 4 })),
    ),
    row(
      field('边界条件', selBind(ca, 'boundary', () => onSimChange(), Object.entries(CA_BOUNDARY_LABELS).map(([value, label]) => ({ value, label })))),
      field('更新顺序', selBind(ca, 'update', () => onSimChange(), Object.entries(CA_UPDATE_LABELS).map(([value, label]) => ({ value, label })))),
    ),
    field('初始状态', selBind(ca.initial, 'mode', () => { onSimChange(); rebuildAll(); }, [
      { value: 'empty', label: '全空' }, { value: 'random', label: '随机散布' }, { value: 'pattern', label: '图案文本' },
    ])),
    ca.initial.mode === 'random'
      ? row(
        field('散布密度', rangeBind(ca.initial, 'density', () => onSimChange(), { min: 0, max: 1, step: 0.01 })),
        field('散布状态', select(ca.initial.state, stateOptions(), (v) => { ca.initial.state = v; onSimChange(); })),
      )
      : null,
    ca.initial.mode === 'pattern'
      ? field('图案文本', textArea(ca.initial.pattern, (v) => { ca.initial.pattern = v; onSimChange(); }, { rows: 5, placeholder: '每行一个字符串，O/#/状态符号 表示存活，. 表示空' }),
        '图案居中放置；符号可用状态首字母、O / X / # / @')
      : null,
    row(
      field('与环境同步方式', selBind(ca, 'syncWithAgent', () => onSimChange(), [
        { value: 'beforeMove', label: '移动前演化' },
        { value: 'afterMove', label: '移动后演化' },
        { value: 'interleaved', label: '交替更新' },
        { value: 'everyN', label: '每 N 步演化' },
      ])),
      ca.syncWithAgent === 'everyN' ? field('N', numBind(ca, 'every', () => onSimChange(), { min: 1 })) : null,
    ),
    field('状态转移规则表', caRulesEditor(ca)),
    field('快捷模板', row(
      button('生命游戏', () => applyCaTemplate(cfg, 'life'), 'ghost small'),
      button('六边形 CA', () => applyCaTemplate(cfg, 'hexCa'), 'ghost small'),
      button('森林火灾', () => applyCaTemplate(cfg, 'forest'), 'ghost small'),
      button('交通流', () => applyCaTemplate(cfg, 'traffic'), 'ghost small'),
    )),
  ];
  return group('元胞自动机模式', body, { open: false, badge: ca.enabled ? '已启用' : '' });
}

function stateListEditor(states) {
  const list = h('div', { class: 'state-list' });
  states.forEach((s, i) => {
    const isCore = s.name === 'empty' || s.name === 'obstacle' || s.name === 'marker';
    list.appendChild(h('div', { class: 'state-row' },
      h('input', {
        class: 'input tiny',
        value: s.name,
        disabled: s.name === 'empty' || undefined,
        onchange: (e) => { s.name = e.target.value.trim() || s.name; rebuildAll(); },
      }),
      h('span', { class: `swatch${s.color ? '' : ' empty'}` , style: { background: s.color || 'transparent' } }),
      colorInput(s.color || '#8899aa', (v) => { s.color = v; rebuildAll(); }),
      h('input', { class: 'input tiny', value: s.symbol, onchange: (e) => { s.symbol = e.target.value.slice(0, 1) || '?'; rebuildAll(); } }),
      select(s.render, [{ value: 'fill', label: '填充' }, { value: 'cross', label: '交叉' }, { value: 'dot', label: '圆点' }], (v) => { s.render = v; rebuildAll(); }),
      checkbox(s.blocking, (v) => { s.blocking = v; onSimChange(); }, '阻挡'),
      isCore
        ? h('span', { class: 'mini-label' }, '内置')
        : button('✕', () => { states.splice(i, 1); rebuildAll(); }, 'icon small danger'),
    ));
  });
  list.appendChild(button('+ 添加状态', () => {
    const n = states.length;
    states.push({ name: `state${n}`, color: '#4dabf7', blocking: false, symbol: 'S', render: 'fill' });
    rebuildAll();
  }, 'ghost small'));
  return list;
}

function caRulesEditor(ca) {
  const list = h('div', { class: 'rule-list' });
  ca.rules.forEach((rule, i) => {
    const rows = [
      row(
        textBind(rule, 'name', () => {}),
        chkBind(rule, 'enabled', () => onSimChange(), '启用'),
        select(rule.kind, [{ value: 'count', label: '计数规则' }, { value: 'traffic', label: '方向移动' }], (v) => { rule.kind = v; rebuildAll(); }),
        button('↑', () => { swap(ca.rules, i, i - 1); rebuildAll(); }, 'icon small'),
        button('↓', () => { swap(ca.rules, i, i + 1); rebuildAll(); }, 'icon small'),
        button('✕', () => { ca.rules.splice(i, 1); rebuildAll(); }, 'icon small danger'),
      ),
    ];
    rows.push(field('当前状态（from）', h('div', { class: 'chips' },
      h('button', {
        type: 'button',
        class: `chip${rule.from === '*' ? ' on' : ''}`,
        onclick: () => { rule.from = '*'; rebuildAll(); },
      }, '任意'),
      ...ca.states.map((s) => {
        const on = rule.from !== '*' && rule.from.includes(s.name);
        return h('button', {
          type: 'button',
          class: `chip${on ? ' on' : ''}`,
          onclick: () => {
            const cur = rule.from === '*' ? [] : [...rule.from];
            const k = cur.indexOf(s.name);
            if (k >= 0) cur.splice(k, 1);
            else cur.push(s.name);
            rule.from = cur.length ? cur : '*';
            rebuildAll();
          },
        }, s.name);
      }))));

    if (rule.kind === 'traffic') {
      rows.push(row(
        field('移动方向', select(rule.direction, dirNames(state.cfg.grid.type).map((n) => ({ value: n, label: DIR_LABELS[n] || n })), (v) => { rule.direction = v; onSimChange(); })),
        field('目标状态（to）', select(rule.to, stateOptions(), (v) => { rule.to = v; onSimChange(); })),
      ));
      rows.push(h('div', { class: 'hint' }, '方向移动规则：该状态沿指定方向前进一格（前方为目标状态时交换），如交通流 Rule 184。'));
    } else {
      rows.push(field('邻域计数条件', h('div', { class: 'counts' },
        ...rule.counts.map((c, ci) => h('div', { class: 'count-row' },
          select(c.state, stateOptions(), (v) => { c.state = v; onSimChange(); }),
          h('input', {
            class: 'input tiny',
            value: c.values ? c.values.join(',') : '',
            placeholder: '数量列表 如 3 或 0,1,4',
            onchange: (e) => {
              const arr = e.target.value.split(',').map((x) => Number(x.trim())).filter((x) => Number.isFinite(x));
              c.values = arr.length ? arr : null;
              onSimChange();
            },
          }),
          h('input', {
            class: 'input tiny',
            type: 'number',
            placeholder: 'min',
            value: c.min ?? '',
            onchange: (e) => { c.min = e.target.value === '' ? null : Number(e.target.value); onSimChange(); },
          }),
          h('input', {
            class: 'input tiny',
            type: 'number',
            placeholder: 'max',
            value: c.max ?? '',
            onchange: (e) => { c.max = e.target.value === '' ? null : Number(e.target.value); onSimChange(); },
          }),
          button('✕', () => { rule.counts.splice(ci, 1); rebuildAll(); }, 'icon small danger'),
        )),
        button('+ 计数条件', () => { rule.counts.push({ state: ca.states[1]?.name || 'obstacle', values: null, min: 1, max: null }); rebuildAll(); }, 'ghost small'))));
      rows.push(row(
        field('目标状态（to）', select(rule.to, stateOptions(), (v) => { rule.to = v; onSimChange(); })),
        field('规则概率', rangeBind(rule, 'probability', () => onSimChange(), { min: 0, max: 1, step: 0.01 })),
      ));
    }
    list.appendChild(group(rule.name || `规则 ${i + 1}`, rows, { open: false, badge: rule.enabled ? '' : '停用', key: `ca:${rule.id}` }));
  });
  list.appendChild(button('+ 添加状态转移规则', () => {
    ca.rules.push({
      id: `ca_${ca.rules.length}`,
      name: `规则 ${ca.rules.length + 1}`,
      enabled: true,
      kind: 'count',
      from: '*',
      counts: [{ state: ca.states[1]?.name || 'obstacle', values: [3], min: null, max: null }],
      to: ca.states[1]?.name || 'obstacle',
      probability: 1,
      direction: 'east',
    });
    rebuildAll();
  }, 'ghost small'));
  return list;
}

function applyCaTemplate(cfg, kind) {
  const ca = cfg.caMode;
  ca.enabled = true;
  ca.radius = 1;
  if (kind === 'life') {
    Object.assign(ca, {
      states: [{ name: 'empty', color: null, symbol: '.', blocking: false }, { name: 'alive', color: '#ffd43b', symbol: 'O', blocking: false }],
      neighborhood: 'moore',
      boundary: 'wrap',
      update: 'synchronous',
      initial: { mode: 'pattern', density: 0.3, state: 'alive', pattern: '.\n.O.\n..OO\n.OO' },
      rules: [
        { id: 'birth', name: '出生', enabled: true, kind: 'count', from: ['empty'], counts: [{ state: 'alive', values: [3] }], to: 'alive', probability: 1, direction: 'east' },
        { id: 'death', name: '死亡', enabled: true, kind: 'count', from: ['alive'], counts: [{ state: 'alive', values: [0, 1, 4, 5, 6, 7, 8] }], to: 'empty', probability: 1, direction: 'east' },
      ],
    });
  } else if (kind === 'hexCa') {
    cfg.grid.type = 'hex';
    cfg.body.shape = 'hexagon';
    cfg.start.direction = dirNames('hex')[0];
    Object.assign(ca, {
      states: [{ name: 'empty', color: null, symbol: '.', blocking: false }, { name: 'alive', color: '#63e6be', symbol: 'O', blocking: false }],
      neighborhood: 'hex',
      boundary: 'wrap',
      update: 'synchronous',
      initial: { mode: 'random', density: 0.4, state: 'alive', pattern: '' },
      rules: [
        { id: 'b', name: '出生', enabled: true, kind: 'count', from: ['empty'], counts: [{ state: 'alive', values: [2] }], to: 'alive', probability: 1, direction: 'east' },
        { id: 's', name: '存活', enabled: true, kind: 'count', from: ['alive'], counts: [{ state: 'alive', min: 3, max: 4 }], to: 'alive', probability: 1, direction: 'east' },
        { id: 'd', name: '死亡', enabled: true, kind: 'count', from: ['alive'], counts: [{ state: 'alive', values: [0, 1, 2, 5, 6] }], to: 'empty', probability: 1, direction: 'east' },
      ],
    });
  } else if (kind === 'forest') {
    Object.assign(ca, {
      states: [
        { name: 'empty', color: null, symbol: '.', blocking: false },
        { name: 'tree', color: '#2f9e44', symbol: 'T', blocking: true },
        { name: 'fire', color: '#ff6b35', symbol: 'F', blocking: false },
      ],
      neighborhood: 'vonNeumann',
      boundary: 'wrap',
      update: 'asynchronous',
      initial: { mode: 'random', density: 0.65, state: 'tree', pattern: '' },
      rules: [
        { id: 'burn', name: '燃烧', enabled: true, kind: 'count', from: ['tree'], counts: [{ state: 'fire', min: 1, max: null }], to: 'fire', probability: 0.7, direction: 'east' },
        { id: 'ash', name: '化为灰烬', enabled: true, kind: 'count', from: ['fire'], counts: [], to: 'empty', probability: 1, direction: 'east' },
        { id: 'grow', name: '生长', enabled: true, kind: 'count', from: ['empty'], counts: [], to: 'tree', probability: 0.02, direction: 'east' },
      ],
    });
  } else if (kind === 'traffic') {
    Object.assign(ca, {
      states: [
        { name: 'empty', color: null, symbol: '.', blocking: false },
        { name: 'car', color: '#4dabf7', symbol: 'C', blocking: true },
      ],
      neighborhood: 'vonNeumann',
      boundary: 'wrap',
      update: 'synchronous',
      initial: { mode: 'random', density: 0.3, state: 'car', pattern: '' },
      rules: [
        { id: 'move', name: '前进', enabled: true, kind: 'traffic', from: ['car'], counts: [], to: 'empty', probability: 1, direction: 'east' },
      ],
    });
    cfg.collision.obstacle = 'pass';
  }
  rebuildAll();
  toast('已应用元胞自动机模板', 'success');
}

/* ---------------- 结束条件 ---------------- */

function endGroup(cfg) {
  const ec = cfg.endConditions;
  const rows = [];
  const params = {
    wall: [], outOfBounds: [], selfCollision: [], obstacle: [],
    selfCollisionTotal: [['selfCollisionTotalN', '累计次数 n', { min: 1 }]],
    selfCollisionConsecutive: [['selfCollisionConsecutiveN', '连续次数 n', { min: 1 }]],
    maxSteps: [['maxSteps', '步数上限', { min: 1, max: MAX_STEPS_LIMIT }]],
    lengthReached: [['lengthTarget', '目标长度', { min: 1 }]],
    coverage: [['coveragePercent', '覆盖率阈值 %', { min: 1, max: 100 }]],
    maxTime: [['maxTimeMs', '时间上限 ms', { min: 1 }]],
    noMove: [], ruleEnd: [],
  };
  ec.priority.forEach((code, i) => {
    // maxSteps 的数值同时也是启用标记（false 表示未启用），取消勾选时要把数值单独记住
    const numericKeys = (params[code] || []).map(([key]) => key);
    const paramFields = [];
    const syncDisabled = [];
    for (const [key, label, opts] of params[code] || []) {
      if (key === 'maxSteps') {
        const remembered = typeof ec.maxSteps === 'number' ? ec.maxSteps : endParamMemory.maxSteps;
        const input = numberInput(remembered, (v) => {
          endParamMemory.maxSteps = v;
          if (typeof ec.maxSteps === 'number') ec.maxSteps = v;
          onSimChange();
        }, opts);
        input.disabled = typeof ec.maxSteps !== 'number';
        input.title = '取消勾选后不再限制步数；此处数值会被保留';
        syncDisabled.push((on) => { input.disabled = !on; });
        paramFields.push(field(label, input));
        continue;
      }
      paramFields.push(field(label, numBind(ec, key, () => onSimChange(), opts)));
    }
    const isOn = numericKeys.includes('maxSteps') ? typeof ec.maxSteps === 'number' : !!ec[code];
    const rowChildren = [
      h('span', { class: 'priority-no' }, `${i + 1}`),
      checkbox(isOn, (v) => {
        if (numericKeys.includes('maxSteps')) ec.maxSteps = v ? endParamMemory.maxSteps : false;
        else ec[code] = v;
        syncDisabled.forEach((fn) => fn(v));
        notifyEndConditionSync(code, v);
        onSimChange();
      }, END_LABELS[code] || code),
      ...paramFields,
      button('↑', () => { swap(ec.priority, i, i - 1); rebuildAll(); }, 'icon small'),
      button('↓', () => { swap(ec.priority, i, i + 1); rebuildAll(); }, 'icon small'),
    ];
    rows.push(h('div', {
      class: `end-row${isOn ? ' on' : ''}`,
      'data-end-code': code,
    }, rowChildren));
  });
  return group('结束规则（按优先级）', [
    h('div', { class: 'hint' }, `自上而下依次判断，命中第一个满足条件的规则即结束运行。可用 ↑ ↓ 调整优先级。取消勾选「达到步数上限」后不再限制步数（仅受安全帧上限保护，可在控制条处继续运行）。步数上限最大可设 10^15；单次运行超过 ${MAX_STORED_FRAMES} 步时画面帧按步长抽样缓存，步数与各项统计仍为逐步精确累计。`),
    ...rows,
  ], { open: false });
}

/* ---------------- 展示样式 ---------------- */

function styleGroup(cfg) {
  const s = cfg.style;
  return group('展示样式', [
    row(
      field('格子大小', rangeBind(s, 'cellSize', () => onStyleChange(), { min: 6, max: 120, step: 1 })),
      field('格子间距', rangeBind(s, 'gap', () => onStyleChange(), { min: 0, max: 20, step: 1 })),
    ),
    field('主题', row(
      checkbox(s.darkMode, (v) => { s.darkMode = v; onStyleChange(); }, '暗黑模式'),
      checkbox(s.showGrid, (v) => { s.showGrid = v; onStyleChange(); }, '网格线'),
      checkbox(s.axisLabels, (v) => { s.axisLabels = v; onStyleChange(); }, '坐标轴'),
    )),
    field('显示内容', row(
      checkbox(s.showTrail, (v) => { s.showTrail = v; onStyleChange(); }, '轨迹'),
      checkbox(s.showBody, (v) => { s.showBody = v; onStyleChange(); }, '身体'),
      checkbox(s.showArrows, (v) => { s.showArrows = v; onStyleChange(); }, '方向箭头'),
      checkbox(s.showStartEnd, (v) => { s.showStartEnd = v; onStyleChange(); }, '起点/终点'),
    )),
    field('环境显示', row(
      checkbox(s.showObstacles, (v) => { s.showObstacles = v; onStyleChange(); }, '障碍物'),
      checkbox(s.showMarkers, (v) => { s.showMarkers = v; onStyleChange(); }, '标记物'),
      checkbox(s.highlightRules, (v) => { s.highlightRules = v; onStyleChange(); }, '规则高亮'),
      checkbox(s.trailFade, (v) => { s.trailFade = v; onStyleChange(); }, '轨迹渐隐'),
    )),
  ], { open: false });
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function swap(arr, i, j) {
  if (j < 0 || j >= arr.length) return;
  const t = arr[i];
  arr[i] = arr[j];
  arr[j] = t;
}

/** 原生 range 输入（返回 input 元素本身，便于外部读写 value/max） */
function slider(value, onChange, opts = {}) {
  const input = h('input', {
    type: 'range',
    class: opts.cls || 'range',
    min: opts.min ?? 0,
    max: opts.max ?? 1,
    step: opts.step ?? 0.01,
  });
  input.value = String(value);
  input.addEventListener('input', () => onChange(Number(input.value)));
  return input;
}

/* 模块求值完成后再启动，避免引用尚未初始化的顶层常量 */
init();
