/**
 * 应用主体：配置面板、规则编辑器、播放控制、统计与日志、导入导出
 */
import {
  defaultConfig, normalizeConfig, defaultRule, defaultClause, defaultAction,
  validateConfig, diagnoseConfig, buildShareUrl, readConfigFromLocation, END_LABELS, MAX_STEPS_LIMIT,
  isBodyEnabled, INTERACTION_LABELS, SPAWN_LABELS, SPAWN_EVENTS, SPAWN_EVENT_LABELS, FADE_LENGTH_LIMIT,
  SKIN_MIME_TYPES, stripSkinAssets, LIFE_MIN, LIFE_MAX,
} from '../core/config.js';
import {
  defaultTrailQuery, queryTrail, trailQueryActive, trailQueryLabel, trailCellsToCSV, trailCellsToText,
  trailQueryBounds, validateTrailQuery, reconcileTrailQuery, sliceTrailUpToTick, TRAIL_RANGE_FIELDS,
  TRAIL_QUERY_LOGICS, TRAIL_QUERY_LOGIC_LABELS,
  snapshotTrail, snapshotMatchesGrid, compareSnapshots, compareToCSV, compareToText,
} from '../core/trail.js';
import { PRESETS, buildPresetConfig, matchPreset } from '../core/presets.js';
import { Simulation, DEFAULT_FRAME_CAP, MAX_FRAME_CAP, MAX_STORED_FRAMES } from '../core/simulation.js';
import { RNG } from '../core/rng.js';
import { formatScore } from '../core/score.js';
import { difficultyOf } from '../core/difficulty.js';
import { diffConfigs, summarizeConfigChanges } from '../core/config-diff.js';
import { Renderer } from './canvas.js';
import { dirNames, DIR_LABEL_CN as DIR_LABELS } from '../core/grid.js';
import { stateLabel, stateLabelWithKey } from '../core/world.js';
import { ACTION_LABELS, TURN_LABELS } from '../core/actions.js';
import { SUBJECT_LABELS, TRIGGER_LABELS } from '../core/rules.js';
import { CA_UPDATE_LABELS, CA_BOUNDARY_LABELS } from '../core/ca.js';
import { OBJECT_LABELS, STAT_LABELS } from '../core/conditions.js';
import {
  configToJSON, trailToCSV, trailToJSON, trailToSVG, logsToCSV, logsToJSON,
  frameToSVG, downloadText, downloadCanvasPNG, downloadSVG,
} from '../core/exporters.js';
import {
  h, clear, group, field, row, button, numberInput, textInput, textArea, select,
  checkbox, range, colorInput, numBind, selBind, chkBind, textBind, rangeBind,
  colorBind, toast, formatNumber, confirmDialog, alertDialog, dialogOpen,
} from './forms.js';

/* ------------------------------------------------------------------ */
/* 常量                                                                */
/* ------------------------------------------------------------------ */

const CLAUSE_TYPES = [
  { value: 'count', label: '数量' },
  { value: 'proportion', label: '比例' },
  { value: 'exists', label: '存在' },
  { value: 'direction', label: '方向关系' },
  { value: 'pattern', label: '图案匹配' },
  { value: 'distance', label: '最近距离' },
  { value: 'stat', label: '运行统计' },
  { value: 'selfLength', label: '自身长度' },
  { value: 'agentCount', label: '移动体数量' },
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

/** 轨迹 / 蛇身的连接方式选项（与 config.js 的 JOIN_MODES 对应） */
const JOIN_OPTIONS = [
  { value: 'curve', label: '曲线（贝塞尔）' },
  { value: 'line', label: '直线' },
  { value: 'angle', label: '预设角度切角' },
];

/** 轨迹颜色分级映射选项（与 config.js 的 TRAIL_COLOR_MODES 对应） */
const TRAIL_COLOR_OPTIONS = [
  { value: 'fade', label: '按新旧渐隐（默认）' },
  { value: 'visit', label: '按经过次数（热度）' },
  { value: 'order', label: '按经过次序' },
];

/* ------------------------------------------------------------------ */
/* 状态                                                                */
/* ------------------------------------------------------------------ */

const state = {
  cfg: null,
  result: null,
  frameIndex: 0,
  /** 帧间插值进度 [0,1)：播放时用于蛇身流畅位移 */
  frameAlpha: 0,
  playing: false,
  loop: true,
  autoRun: true,
  dirty: true,
  logFilter: 'all',
  logLimit: 400,
  frameCap: DEFAULT_FRAME_CAP,
  /** 坐标筛选查询条件（上下限 / 与或 / 反选） */
  trailQuery: defaultTrailQuery(),
  /** 统计口径：realtime 截至当前播放位置 / total 整轮汇总 */
  statMode: 'total',
  /** 用户保存的常用筛选配置 */
  trailPresets: [],
  /** 当前选中的筛选预设名（用于保存后回显） */
  trailPresetName: '',
  /** 最近一次筛选命中的格下标集合（用于高亮与导出） */
  trailFilter: null,
  /** 最近一次筛选命中的轨迹点（含次序 / 次数 / 首末步） */
  trailCells: [],
  /** 多轨迹对比：基准快照（冻结的轨迹数据） */
  trailSnapshot: null,
  /** 多轨迹对比：基准快照与当前运行结果的坐标差异 */
  compareDiff: null,
  /** 自适应速度：拥挤时自动放慢播放速度 */
  adaptive: false,
  /** 本轮运行的得分（总分 / 等级），由 summary.score 得到 */
  score: null,
  /** 当前地图的最高分（按网格类型 / 尺寸 / 边界策略区分） */
  highScore: 0,
  /**
   * 是否显示「运行评价」读数：得分 / 评分等级（控制条与统计面板）+ 难度 / 拥挤度（控制条）。
   * 默认隐藏，可在「展示样式 → 界面配置」开启，选择结果本地持久化。
   */
  showScore: false,
  /**
   * 排行榜「本轮成绩进入本地排行榜第 1 名」提示开关。
   * 默认关闭，可在「展示样式 → 界面配置」按需开启，选择结果本地持久化。
   */
  showRankToast: false,
  /** 模板基准配置：用于检测「载入模板」前的用户自定义改动 */
  cfgBaseline: null,
  /** 配置撤销栈：记录被模板 / 导入替换掉的配置，支持 Ctrl+Z 回退 */
  cfgHistory: [],
  /** 配置面板设置搜索关键词 */
  cfgSearch: '',
  /** 配置面板当前选项卡（四大类之一）：面板重建后保持用户所选类别 */
  cfgTab: 'core',
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
  // 启动即把当前配置记为「模板基准」：之后用户的自定义改动都由它与当前配置比对得出
  state.cfgBaseline = snapshotConfig(state.cfg);
  state.trailQuery = defaultTrailQuery();
  loadTrailState();
  els.canvas = document.getElementById('canvas');
  els.canvasWrap = document.getElementById('canvas-wrap');
  els.tooltip = document.getElementById('tooltip');
  els.controls = document.getElementById('controls');
  els.stageStats = document.getElementById('stage-stats');
  els.side = document.getElementById('side-panel');
  els.config = document.getElementById('config-panel');

  renderer = new Renderer(els.canvas);
  // 皮肤图片是异步解码的，解码完成后重绘一次，让上传的皮肤立即出现在画布上
  renderer.onSkinLoad = () => draw();
  buildControls();
  applyScoreVisibility();
  bindCanvasEvents();
  bindKeyboard();
  renderConfigPanel();
  renderSidePanel();
  notifyStartupDiagnostics();
  recompute({ immediate: true });
  // 自动存档：配置与上次一致时回到上次的播放位置（不一致则保持从头播放）
  if (restoreAutoSave()) toast(`已按自动存档回到上次进度：第 ${state.frameIndex + 1} 帧`, 'info');
  // 启动成功后再撤掉兜底提示（init 全同步，不会出现闪烁）
  const legacyHint = document.getElementById('legacy-hint');
  if (legacyHint) legacyHint.className = 'hidden';
}

/** 键盘快捷键：空格播放/暂停，← → 单步（Shift 加速跳 10 帧），Home / End 跳转首末帧，↑ ↓ 调整播放速度 */
function bindKeyboard() {
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    // 模态对话框打开时让位：Esc / 回车交由对话框处理
    if (dialogOpen()) return;
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      // Ctrl/Cmd + Z：撤销上一次配置整体替换（载入模板 / 导入 / 恢复）
      if (e.key === 'z' || e.key === 'Z') {
        e.preventDefault();
        undoConfigReplace();
      }
      return;
    }
    if (e.altKey) return;
    /** Shift 组合键用于「大步长」跳帧 */
    const jump = e.shiftKey ? 10 : 1;
    switch (e.key) {
      case ' ':
        e.preventDefault();
        if (state.playing) pause();
        else play();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        pause();
        gotoFrame(state.frameIndex - jump);
        break;
      case 'ArrowRight':
        e.preventDefault();
        pause();
        if (e.shiftKey) gotoFrame(state.frameIndex + jump);
        else if (advance()) frameChanged();
        break;
      case 'ArrowUp':
        e.preventDefault();
        nudgeSpeed(1.25);
        break;
      case 'ArrowDown':
        e.preventDefault();
        nudgeSpeed(0.8);
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
      case '-':
      case '_':
        e.preventDefault();
        setSpeed(state.cfg.speed / 2);
        break;
      case '=':
      case '+':
        e.preventDefault();
        setSpeed(state.cfg.speed * 2);
        break;
      case 'r':
      case 'R':
        e.preventDefault();
        pause();
        gotoFrame(0);
        break;
      case 'Escape':
        e.preventDefault();
        pause();
        break;
      default:
        break;
    }
  });
}

/** 按倍率微调播放速度，并同步控制条上的滑块与数值框 */
function nudgeSpeed(factor) {
  setSpeed(state.cfg.speed * factor);
}

/** 直接设定播放速度：收敛到 [0.5, 120] 并取 0.5 的整数倍，同步滑块 / 数值框 / 标签 */
function setSpeed(v) {
  const next = Math.max(0.5, Math.min(120, Math.round(Number(v) * 2) / 2));
  if (!Number.isFinite(next) || next === state.cfg.speed) return;
  state.cfg.speed = next;
  if (els.speedSlider) els.speedSlider.value = String(next);
  if (els.speedNum) els.speedNum.value = String(next);
  updateSpeedLabel();
}

/** 当前播放位置的难度评估：用于自适应调速与难度指示 */
function currentDifficulty() {
  const r = state.result;
  if (!r || !r.frames.length) return difficultyOf({}, null);
  const f = r.frames[statFrameIndex()];
  return difficultyOf(f ? f.stats : r.stats, r.grid);
}

/**
 * 跟随移动体：播放 / 跳帧时自动滚动画布容器，让主移动体始终位于视野内。
 * 仅在大网格下按需开启，默认关闭以免影响手动浏览。
 */
function followAgentView() {
  if (!state.cfg?.style?.followAgent || !state.result) return;
  const p = renderer.agentHeadPixel(state.frameIndex, 0);
  const wrap = els.canvasWrap;
  if (!p || !wrap) return;
  const x = wrap.querySelector('canvas').offsetLeft + p.x;
  const y = wrap.querySelector('canvas').offsetTop + p.y;
  const left = Math.max(0, x - wrap.clientWidth / 2);
  const top = Math.max(0, y - wrap.clientHeight / 2);
  if (Math.abs(wrap.scrollLeft - left) > 1) wrap.scrollLeft = left;
  if (Math.abs(wrap.scrollTop - top) > 1) wrap.scrollTop = top;
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
    // 超配额时（自定义皮肤的 dataURL 体积较大）退一步：去掉皮肤图片再存，
    // 保证网格 / 规则等其余设置刷新后不丢失
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(stripSkinAssets(cfg)));
    } catch (e2) {
      /* 隐私模式或仍超配额时静默忽略 */
    }
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

/* ---------------- 状态存档与读取（本地多存档） ---------------- */

const SAVE_KEY = 'gridsneaker:saves';
/** 本地存档条数上限，超出后按保存顺序淘汰最早的 */
const SAVE_LIMIT = 20;

function readSaves() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((s) => s && s.name && s.config) : [];
  } catch (e) {
    return [];
  }
}

/** 写入存档列表；配额不足时退一步去掉自定义皮肤图片后重存，保证存档本身不丢 */
function writeSaves(list) {
  const trimmed = list.slice(0, SAVE_LIMIT);
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(trimmed));
    return true;
  } catch (e) {
    /* 落到下方的降级存储 */
  }
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(trimmed.map((s) => ({ ...s, config: stripSkinAssets(s.config) }))));
    return true;
  } catch (e2) {
    toast('存档写入失败（浏览器存储配额不足，可先删除旧存档）', 'error');
    return false;
  }
}

/** 存档时间展示：同一天只显示时分秒，跨天带上日期 */
function formatSaveTime(ts) {
  const d = new Date(Number(ts) || 0);
  if (!Number.isFinite(d.getTime()) || !ts) return '-';
  const p = (n) => String(n).padStart(2, '0');
  const time = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  const today = new Date();
  const sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
  return sameDay ? time : `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${time}`;
}

/** 保存当前状态：配置 + 播放位置 + 统计口径，便于随时回到同一局面 */
function saveState(name) {
  const label = String(name || '').trim() || `存档 ${formatSaveTime(Date.now())}`;
  const entry = {
    name: label,
    savedAt: Date.now(),
    frameIndex: state.frameIndex,
    statMode: state.statMode,
    config: snapshotConfig(state.cfg),
  };
  const list = readSaves().filter((s) => s.name !== label);
  list.unshift(entry);
  if (!writeSaves(list)) return;
  toast(`已保存存档「${label}」`, 'success');
  renderSidePanel();
}

/** 读取存档：整体替换配置（自动重算整轮运行）后跳回保存时的播放位置 */
function loadState(name) {
  const entry = readSaves().find((s) => s.name === name);
  if (!entry) {
    toast('存档不存在或已被删除', 'warn');
    return;
  }
  applyConfigReplacement(normalizeConfig(entry.config), `读取存档「${name}」`, `已读取存档「${name}」`);
  const last = state.result ? state.result.frames.length - 1 : 0;
  state.frameIndex = Math.max(0, Math.min(Math.round(entry.frameIndex) || 0, last));
  if (entry.statMode) setStatMode(entry.statMode);
  draw();
}

/** 仅重绘存档列表（保存 / 删除后避免整块侧栏重建） */
let renderSaveList = () => {};

/** 状态存档区域（内联在「配置 / 状态存档」分组中） */
function savesSection() {
  const nameInput = textInput('', () => {}, { placeholder: '存档名称（留空则按时间命名）' });
  const host = h('div', { class: 'save-list' });
  renderSaveList = () => {
    clear(host);
    const list = readSaves();
    if (!list.length) {
      host.appendChild(h('div', { class: 'hint' }, '暂无存档。保存后会记录当前配置、播放位置与统计口径。'));
      return;
    }
    for (const s of list) {
      host.appendChild(h('div', { class: 'save-row' },
        h('span', { class: 'save-name', title: s.name }, s.name),
        h('span', { class: 'mini-label' }, formatSaveTime(s.savedAt)),
        button('读取', () => loadState(s.name), 'primary small'),
        button('删除', () => {
          writeSaves(readSaves().filter((x) => x.name !== s.name));
          toast(`已删除存档「${s.name}」`, 'info');
          renderSaveList();
        }, 'ghost small')));
    }
  };
  renderSaveList();
  return [
    h('div', { class: 'sub-title' }, '状态存档'),
    field('存档名称', nameInput),
    row(
      button('保存当前状态', () => saveState(nameInput.value), 'primary'),
      button('清空全部存档', () => {
        const list = readSaves();
        if (!list.length) { toast('暂无存档', 'info'); return; }
        confirmDialog({
          title: '清空全部存档',
          message: `将删除本地保存的 ${list.length} 条存档，此操作不可撤销。`,
          confirmText: '清空',
          danger: true,
        }).then((ok) => {
          if (!ok) return;
          writeSaves([]);
          toast('已清空全部存档', 'info');
          renderSaveList();
        });
      }, 'ghost'),
    ),
    h('div', { class: 'hint' }, `存档保存在浏览器本地（最多 ${SAVE_LIMIT} 条）：记录配置、播放位置与统计口径，读取后立即重算并跳回同一帧；自定义皮肤图片体积过大时会被省略。`),
    host,
  ];
}

/* ---------------- 配置自动存档 ---------------- */

const AUTO_SAVE_KEY = 'gridsneaker:autosave';
/** 自动存档落盘防抖：播放 / 跳帧时不必每一帧都写盘 */
let autoSaveTimer = null;
/** 自动存档 / 排行榜的局部刷新入口：重算后只更新列表，避免整块侧栏重建 */
let renderAutosaveList = () => {};
let renderScoreboardList = () => {};

/**
 * 自动记录最近一次运行进度：配置 + 播放位置 + 统计口径。
 * 与手动存档同构，但不占用存档条数；写入失败（配额不足）时退一步去掉自定义皮肤图片重存。
 */
function writeAutoSave() {
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => {
    autoSaveTimer = null;
    const payload = {
      config: snapshotConfig(state.cfg),
      frameIndex: state.frameIndex,
      statMode: state.statMode,
      savedAt: Date.now(),
    };
    try {
      localStorage.setItem(AUTO_SAVE_KEY, JSON.stringify(payload));
    } catch (e) {
      try {
        localStorage.setItem(AUTO_SAVE_KEY, JSON.stringify({ ...payload, config: stripSkinAssets(state.cfg) }));
      } catch (e2) {
        /* 隐私模式或仍超配额时静默忽略 */
      }
    }
    renderAutosaveList(); // 落盘后刷新「最近进度」一行
  }, 1200);
}

function readAutoSave() {
  try {
    const raw = localStorage.getItem(AUTO_SAVE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    return obj && obj.config ? obj : null;
  } catch (e) {
    return null;
  }
}

function clearAutoSave() {
  try {
    localStorage.removeItem(AUTO_SAVE_KEY);
  } catch (e) {
    /* 静默忽略 */
  }
}

/**
 * 按自动存档跳回上次的播放位置。
 * 仅当自动存档中的配置与当前配置完全一致时才恢复——配置已被改动时跳回旧位置没有意义。
 */
function restoreAutoSave() {
  const entry = readAutoSave();
  if (!entry || !state.result) return false;
  let same = false;
  try {
    same = JSON.stringify(snapshotConfig(state.cfg)) === JSON.stringify(entry.config);
  } catch (e) {
    same = false;
  }
  if (!same) return false;
  const last = state.result.frames.length - 1;
  const idx = Math.max(0, Math.min(Math.round(Number(entry.frameIndex) || 0), last));
  if (idx <= 0) return false;
  if (entry.statMode === 'realtime' || entry.statMode === 'total') state.statMode = entry.statMode;
  syncStatModeUI();
  gotoFrame(idx);
  return true;
}

/** 配置自动存档区域（内联在「配置 / 状态存档」分组中） */
function autosaveSection() {
  const host = h('div', { class: 'save-list' });
  const sync = () => {
    clear(host);
    const entry = readAutoSave();
    if (!entry) {
      host.appendChild(h('div', { class: 'hint' }, '暂无自动存档。运行或跳帧后会每 1.2 秒自动记录一次进度。'));
      return;
    }
    host.appendChild(h('div', { class: 'save-row' },
      h('span', { class: 'save-name' }, '最近进度'),
      h('span', { class: 'mini-label' }, `第 ${Math.round(Number(entry.frameIndex) || 0) + 1} 帧 · ${formatSaveTime(entry.savedAt)}`),
      button('恢复', () => {
        if (!restoreAutoSave()) toast('自动存档的配置与当前配置不一致，未恢复播放位置', 'warn');
        sync();
      }, 'primary small'),
      button('清除', () => {
        clearAutoSave();
        toast('已清除自动存档', 'info');
        sync();
      }, 'ghost small')));
  };
  sync();
  renderAutosaveList = sync;
  return [
    h('div', { class: 'sub-title' }, '配置自动存档'),
    h('div', { class: 'hint' }, '自动存档只保留最近一次进度（配置 + 播放位置 + 统计口径）。刷新页面后配置由本地自动恢复，播放位置在配置一致时自动跳回；需要保留多个局面时请使用下方「状态存档」。'),
    host,
  ];
}

/* ---------------- 本地得分排行榜 ---------------- */

const SCOREBOARD_KEY = 'gridsneaker:scoreboard';
/** 排行榜保留条数 */
const SCOREBOARD_LIMIT = 20;

function readScoreboard() {
  try {
    const raw = localStorage.getItem(SCOREBOARD_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((r) => r && Number.isFinite(Number(r.total))) : [];
  } catch (e) {
    return [];
  }
}

function writeScoreboard(list) {
  try {
    localStorage.setItem(SCOREBOARD_KEY, JSON.stringify(list.slice(0, SCOREBOARD_LIMIT)));
  } catch (e) {
    /* 隐私模式静默忽略 */
  }
}

/** 一次成绩的去重指纹：同一配置反复重算不会重复入榜 */
function scoreSignature(entry) {
  return `${entry.seed}|${entry.steps}|${entry.total}|${entry.map}`;
}

/**
 * 记录本轮成绩到本地排行榜（按总分降序、限制条数）。
 * 返回本次成绩的名次（从 1 开始），未入榜返回 0。
 */
function recordScore(result) {
  const sc = result && result.summary && result.summary.score;
  if (!sc || !Number.isFinite(Number(sc.total))) return 0;
  const entry = {
    total: Math.round(Number(sc.total)),
    grade: sc.gradeLabel || '-',
    map: `${result.grid.type === 'hex' ? '六边形' : '方格'} ${result.grid.width}×${result.grid.height}`,
    steps: Math.round(Number(result.summary.steps) || 0),
    length: Math.round(Number(result.summary.maxLength) || 0),
    seed: Number(result.seed) || 0,
    at: Date.now(),
  };
  const list = readScoreboard();
  const sig = scoreSignature(entry);
  if (list.some((r) => scoreSignature(r) === sig)) return 0;
  list.push(entry);
  list.sort((a, b) => Number(b.total) - Number(a.total) || Number(b.at) - Number(a.at));
  const rank = list.indexOf(entry) + 1;
  writeScoreboard(list);
  return rank;
}

function scoreboardGroup() {
  const host = h('div', { class: 'save-list' });
  const sync = () => {
    clear(host);
    const list = readScoreboard();
    if (!list.length) {
      host.appendChild(h('div', { class: 'hint' }, '暂无成绩记录。每轮运行结束后会自动把成绩写入本地排行榜。'));
      return;
    }
    list.forEach((r, i) => {
      host.appendChild(h('div', { class: 'save-row' },
        h('span', { class: 'rank-no' }, `${i + 1}`),
        h('span', { class: 'save-name', title: `种子 ${r.seed} · 步数 ${r.steps}` }, `${formatScore(r.total)} · ${r.grade}`),
        h('span', { class: 'mini-label' }, `${r.map} · ${r.steps} 步 · 最长 ${r.length}`)));
    });
  };
  sync();
  renderScoreboardList = sync;
  return group('本地得分排行榜', [
    row(
      button('刷新', () => sync(), 'ghost small'),
      button('清空排行榜', () => {
        if (!readScoreboard().length) { toast('暂无成绩记录', 'info'); return; }
        writeScoreboard([]);
        toast('已清空本地得分排行榜', 'info');
        sync();
      }, 'ghost small'),
    ),
    h('div', { class: 'hint' }, `成绩保存在浏览器本地（最多 ${SCOREBOARD_LIMIT} 条，按总分降序）；同一轮运行反复重算不会重复入榜。`),
    host,
  ], { open: false });
}

/* ---------------- 筛选条件 / 统计口径 / 筛选预设的本地持久化 ---------------- */

const TRAIL_QUERY_KEY = 'gridsneaker:trail-query';
const TRAIL_MODE_KEY = 'gridsneaker:stat-mode';
const TRAIL_PRESET_KEY = 'gridsneaker:trail-presets';
/** 自适应速度开关 */
const ADAPTIVE_KEY = 'gridsneaker:adaptive-speed';
/** 最高分记录：按地图指纹分别保存，避免不同网格尺寸互相覆盖 */
const HIGH_SCORE_KEY = 'gridsneaker:high-score';
/** 「得分 / 评分等级」模块的显示偏好（默认隐藏） */
const SHOW_SCORE_KEY = 'gridsneaker:show-score';
/** 排行榜「进入第 1 名」提示偏好（默认关闭，按需开启） */
const RANK_TOAST_KEY = 'gridsneaker:rank-toast';
/** 预设数量上限，超出后按保存顺序淘汰最早的 */
const TRAIL_PRESET_LIMIT = 20;
/** 配置撤销栈上限 */
const CONFIG_HISTORY_LIMIT = 12;
/** 「载入模板」确认窗口中最多逐项列出的改动条数 */
const CONFIG_CHANGE_DISPLAY_LIMIT = 40;

let trailPersistTimer = null;

/** 写入筛选条件（防抖，滑动滑块时避免高频落盘） */
function saveTrailQuery() {
  if (trailPersistTimer) clearTimeout(trailPersistTimer);
  trailPersistTimer = setTimeout(() => {
    try {
      localStorage.setItem(TRAIL_QUERY_KEY, JSON.stringify(state.trailQuery));
    } catch (e) {
      /* 隐私模式或超配额时静默忽略 */
    }
  }, 260);
}

/** 启动时读取上次的筛选条件与统计口径，使刷新后配置保持不变 */
function loadTrailState() {
  try {
    const raw = localStorage.getItem(TRAIL_QUERY_KEY);
    if (raw) state.trailQuery = normalizeTrailQuery(JSON.parse(raw));
  } catch (e) {
    state.trailQuery = defaultTrailQuery();
  }
  try {
    const mode = localStorage.getItem(TRAIL_MODE_KEY);
    if (mode === 'realtime' || mode === 'total') state.statMode = mode;
  } catch (e) {
    /* 忽略读取失败 */
  }
  state.trailPresets = loadTrailPresets();
  state.adaptive = loadAdaptive();
  state.showScore = loadShowScore();
  state.showRankToast = loadShowRankToast();
}

/* ---------------- 得分系统：最高分与自适应速度的本地持久化 ---------------- */

/** 地图指纹：同一张地图（类型 / 尺寸 / 边界策略）共用一份最高分记录 */
function gridSignature(grid) {
  if (!grid) return 'unknown';
  return `${grid.type}-${grid.width}x${grid.height}-${grid.boundary}`;
}

/** 读取当前地图指纹对应的最高分 */
function loadHighScore(grid) {
  try {
    const raw = localStorage.getItem(HIGH_SCORE_KEY);
    if (!raw) return 0;
    const map = JSON.parse(raw);
    const v = Number(map && map[gridSignature(grid)]);
    return Number.isFinite(v) && v > 0 ? v : 0;
  } catch (e) {
    return 0;
  }
}

/** 记录最高分：仅当超过历史记录时写盘，返回是否刷新了记录 */
function saveHighScore(grid, total) {
  const key = gridSignature(grid);
  try {
    const raw = localStorage.getItem(HIGH_SCORE_KEY);
    const map = raw ? (JSON.parse(raw) || {}) : {};
    const prev = Number(map[key]) || 0;
    if (total <= prev) return false;
    map[key] = total;
    localStorage.setItem(HIGH_SCORE_KEY, JSON.stringify(map));
    return true;
  } catch (e) {
    return false;
  }
}

function loadAdaptive() {
  try {
    return localStorage.getItem(ADAPTIVE_KEY) === '1';
  } catch (e) {
    return false;
  }
}

function saveAdaptive(v) {
  try {
    localStorage.setItem(ADAPTIVE_KEY, v ? '1' : '0');
  } catch (e) {
    /* 隐私模式静默忽略 */
  }
}

/* ---------------- 界面显示偏好：运行评价读数（得分 / 评分等级 / 难度 / 拥挤度，默认隐藏） ---------------- */

/** 「得分 / 评分等级」在统计面板中的键名 */
const SCORE_STAT_KEYS = new Set(['score', 'scoreGrade']);

function loadShowScore() {
  try {
    return localStorage.getItem(SHOW_SCORE_KEY) === '1';
  } catch (e) {
    return false;
  }
}

function saveShowScore(v) {
  try {
    localStorage.setItem(SHOW_SCORE_KEY, v ? '1' : '0');
  } catch (e) {
    /* 隐私模式静默忽略 */
  }
}

/** 切换「运行评价」读数的显示状态：控制条得分行 / 难度行与统计面板两项同步显隐 */
function setShowScore(v) {
  state.showScore = !!v;
  saveShowScore(state.showScore);
  applyScoreVisibility();
  renderStageStats();
  toast(state.showScore ? '已显示「得分 / 评级 / 难度」' : '已隐藏「得分 / 评级 / 难度」', 'info');
}

/* ---------------- 界面显示偏好：排行榜「进入第 1 名」提示（默认关闭） ---------------- */

function loadShowRankToast() {
  try {
    return localStorage.getItem(RANK_TOAST_KEY) === '1';
  } catch (e) {
    return false;
  }
}

function saveShowRankToast(v) {
  try {
    localStorage.setItem(RANK_TOAST_KEY, v ? '1' : '0');
  } catch (e) {
    /* 隐私模式静默忽略 */
  }
}

/**
 * 切换排行榜「本轮成绩进入本地排行榜第 1 名」提示。
 * 默认关闭：榜单列表照常刷新，只是不再弹出提示条。
 */
function setShowRankToast(v) {
  state.showRankToast = !!v;
  saveShowRankToast(state.showRankToast);
  toast(state.showRankToast ? '已开启「排行榜第 1 名」提示' : '已关闭「排行榜第 1 名」提示', 'info');
}

/**
 * 按偏好切换控制条上运行评价读数的显隐：
 * 得分行（得分 + 最高分）与难度行（难度等级 + 拥挤度）作为同一类读数整体开关，
 * 整行一起隐藏可避免留下空行占位。
 */
function applyScoreVisibility() {
  if (els.evalLine) els.evalLine.classList.toggle('hidden', !state.showScore);
}

/** 当前需要展示的统计项：运行评价读数隐藏时不生成对应统计格与摘要行 */
function activeStatKeys() {
  return state.showScore ? STAT_KEYS : STAT_KEYS.filter(([key]) => !SCORE_STAT_KEYS.has(key));
}

/* ---------------- 配置基准 / 改动检测 / 撤销栈 ---------------- */

/** 深拷贝配置（配置为纯 JSON 结构，不含函数） */
function snapshotConfig(cfg) {
  return JSON.parse(JSON.stringify(cfg));
}

function rememberConfigBaseline(cfg) {
  state.cfgBaseline = snapshotConfig(cfg);
}

/** 当前配置相对「模板基准」的自定义改动条目 */
function collectConfigChanges() {
  if (!state.cfgBaseline) return [];
  return diffConfigs(state.cfgBaseline, state.cfg);
}

/** 配置即将被整体替换前记录现场，供 Ctrl+Z 撤销 */
function pushConfigHistory(label) {
  state.cfgHistory.push({
    label,
    cfg: snapshotConfig(state.cfg),
    baseline: state.cfgBaseline ? snapshotConfig(state.cfgBaseline) : null,
  });
  if (state.cfgHistory.length > CONFIG_HISTORY_LIMIT) state.cfgHistory.shift();
}

/** 用新配置整体替换当前配置，并把新配置记为新的模板基准 */
function applyConfigReplacement(cfg, label, okMsg) {
  pushConfigHistory(label);
  state.cfg = cfg;
  rememberConfigBaseline(cfg);
  state.frameIndex = 0;
  state.dirty = true;
  rebuildAll();
  if (okMsg) toast(okMsg, 'success');
}

/** 撤销上一次配置整体替换（载入模板 / 空白配置 / 导入 / 恢复） */
function undoConfigReplace() {
  const entry = state.cfgHistory.pop();
  if (!entry) {
    toast('没有可撤销的配置变更', 'info');
    return;
  }
  state.cfg = entry.cfg;
  state.cfgBaseline = entry.baseline;
  state.frameIndex = 0;
  state.dirty = true;
  rebuildAll();
  toast(`已撤销「${entry.label}」`, 'success');
}

/** 载入模板后的状态校验提示（如交互类模板未启用「蛇长度可变」） */
function warnAfterTemplate() {
  const warn = markerLengthWarning();
  if (warn) toast(warn, 'warn');
}

/**
 * 载入预设模板。
 * 载入前先用「模板基准 ↔ 当前配置」比对出用户的自定义改动：
 * 无改动直接载入；有改动则弹出确认窗口逐项列明将被覆盖的内容，
 * 由用户选择「覆盖保存」或「取消载入」，避免误操作丢失已调好的配置。
 */
function loadPresetTemplate(presetId) {
  const target = normalizeConfig(buildPresetConfig(presetId));
  const changes = collectConfigChanges();
  if (!changes.length) {
    applyConfigReplacement(target, '载入模板', '已载入模板');
    warnAfterTemplate();
    return;
  }
  const shown = changes.slice(0, CONFIG_CHANGE_DISPLAY_LIMIT);
  confirmDialog({
    title: '载入模板将覆盖当前自定义改动',
    message: `当前配置相对模板基准共有 ${changes.length} 处自定义改动，载入「${target.meta.name}」会覆盖以下内容：`,
    sections: summarizeConfigChanges(shown),
    footnote: changes.length > shown.length
      ? `仅列出前 ${shown.length} 项，实际共 ${changes.length} 项改动。覆盖后可用 Ctrl+Z 撤销。`
      : '覆盖后仍可用 Ctrl+Z 撤销本次载入。',
    confirmText: '覆盖保存',
    cancelText: '取消载入',
    danger: true,
  }).then((ok) => {
    if (!ok) {
      toast('已取消载入模板', 'info');
      return;
    }
    applyConfigReplacement(target, '载入模板', '已载入模板（原自定义改动已覆盖）');
    warnAfterTemplate();
  });
}

function loadTrailPresets() {
  try {
    const raw = localStorage.getItem(TRAIL_PRESET_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    return list
      .filter((p) => p && typeof p.name === 'string' && p.name && p.query)
      .slice(0, TRAIL_PRESET_LIMIT)
      .map((p) => ({ name: p.name, query: normalizeTrailQuery(p.query) }));
  } catch (e) {
    return [];
  }
}

function writeTrailPresets() {
  try {
    localStorage.setItem(TRAIL_PRESET_KEY, JSON.stringify(state.trailPresets));
  } catch (e) {
    /* 隐私模式或超配额时静默忽略 */
  }
}

/** 保存当前筛选条件为命名预设（同名覆盖，超出上限淘汰最早的） */
function saveTrailPreset(name) {
  const key = String(name || '').trim();
  if (!key) {
    toast('请先填写预设名称', 'warn');
    return false;
  }
  const query = normalizeTrailQuery(state.trailQuery);
  const idx = state.trailPresets.findIndex((p) => p.name === key);
  if (idx >= 0) state.trailPresets[idx] = { name: key, query };
  else state.trailPresets.unshift({ name: key, query });
  if (state.trailPresets.length > TRAIL_PRESET_LIMIT) state.trailPresets.length = TRAIL_PRESET_LIMIT;
  writeTrailPresets();
  state.trailPresetName = key;
  refreshTrailPresetSelect(key);
  toast(`已保存筛选预设「${key}」`, 'success');
  return true;
}

function removeTrailPreset(name) {
  const before = state.trailPresets.length;
  state.trailPresets = state.trailPresets.filter((p) => p.name !== name);
  if (state.trailPresets.length === before) {
    toast('请先选择要删除的预设', 'warn');
    return;
  }
  writeTrailPresets();
  state.trailPresetName = '';
  refreshTrailPresetSelect('');
  toast(`已删除预设「${name}」`, 'info');
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
  // 得分系统：结算本轮得分并刷新该地图的最高分记录
  state.score = result.summary.score || null;
  state.highScore = loadHighScore(result.grid);
  let brokeRecord = false;
  if (state.score) {
    brokeRecord = saveHighScore(result.grid, state.score.total);
    if (brokeRecord) state.highScore = state.score.total;
    // 本地得分排行榜：同一轮运行（去重指纹相同）反复重算不会重复入榜
    const rank = recordScore(result);
    // 「排行榜第 1 名」提示默认关闭（可在「展示样式 → 界面配置」开启），榜单本身照常记录
    if (rank === 1 && state.showRankToast) toast('本轮成绩进入本地排行榜第 1 名', 'success');
  }
  saveLocalConfig(cfg);
  writeAutoSave();
  renderer.setResult(result);
  renderer.setStyle(cfg.style, cfg.body);
  liveTrailCache = { tick: -1, at: 0, trail: null }; // 轨迹已重建，实时缓存失效
  renderStageStats();
  renderLog();
  updateControls();
  draw();
  syncStatModeUI(); // 新结果就绪后刷新口径提示（实时已统计帧数 / 总计步数）
  refreshTrailFilter(); // 轨迹模型已重建，按当前筛选条件重新高亮
  refreshCompare(); // 轨迹模型已重建，按基准快照重算差异叠加层
  refreshDiagnostics(); // 用本次运行的真实结果替换上一轮的运行期诊断
  renderScoreboardList(); // 本轮成绩已写入排行榜，只刷新列表不重建整块侧栏
  if (brokeRecord && state.score && state.showScore) toast(`刷新最高分：${formatScore(state.score.total)}（${state.score.gradeLabel}）`, 'success');
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

/** 仅重绘画布（播放中每个动画帧调用，不含任何 DOM 更新） */
function drawFrameOnly() {
  if (!state.result) return;
  renderer.draw(state.frameIndex, state.frameAlpha);
}

function draw() {
  if (!state.result) return;
  renderer.draw(state.frameIndex, state.frameAlpha);
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
  state.frameAlpha = 0;
  if (rafId) cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(loopTick);
  updateControls();
}

function pause() {
  state.playing = false;
  state.frameAlpha = 0;
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
  updateControls();
  draw();
  writeAutoSave(); // 暂停 / 单步 / 拖动时间轴后记录一次进度
  maybeRefreshLiveFilter(); // 暂停后按精确的播放位置重算一次筛选结果
}

function loopTick(ts) {
  if (!state.playing) return;
  if (!lastTs) lastTs = ts;
  const dt = Math.min(250, ts - lastTs);
  lastTs = ts;
  acc += dt;
  const baseMs = 1000 / Math.max(0.5, state.cfg.speed);
  // 自适应速度：拥挤度升高时按倍率放慢播放（倍率 0.3~1），给观察留出余量
  const stepMs = state.adaptive ? baseMs / Math.max(0.05, currentDifficulty().speedScale) : baseMs;
  let guard = 0;
  while (acc >= stepMs && guard++ < 400) {
    acc -= stepMs;
    if (!advance()) break;
    frameChanged(); // 跨帧时才做帧统计 / 控件 / 日志高亮等 DOM 更新
  }
  // 剩余时间比例即帧间进度：每个动画帧都按该进度重绘一次，
  // 低速度下也能得到逐帧连续的位移，而不会长时间静止后突然跳格。
  state.frameAlpha = Math.max(0, Math.min(1, acc / stepMs));
  drawFrameOnly();
  rafId = requestAnimationFrame(loopTick);
}

/** 帧变化后的轻量更新（播放中高频调用） */
function frameChanged() {
  draw();
  followAgentView();
  updateControls();
  highlightLogs();
  maybeRefreshLiveFilter(); // 实时口径下按节流刷新轨迹筛选结果
}

function gotoFrame(i) {
  if (!state.result) return;
  const last = state.result.frames.length - 1;
  state.frameIndex = Math.max(0, Math.min(last, Math.round(i)));
  state.frameAlpha = 0;
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
  els.followChk = checkbox(!!state.cfg.style.followAgent, (v) => {
    state.cfg.style.followAgent = v;
    saveLocalConfig(state.cfg);
    onStyleChange();
    followAgentView();
  }, '跟随移动体');
  els.followInput = els.followChk.querySelector('input');

  els.speedRange = range(state.cfg.speed, (v) => {
    state.cfg.speed = v;
    updateSpeedLabel();
  }, { min: 0.5, max: 120, step: 0.5, number: true, wrapClass: 'speed-wrap' });
  els.speedSlider = els.speedRange.querySelector('input[type="range"]');
  els.speedNum = els.speedRange.querySelector('input[type="number"]');
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

  // 运行评价读数：得分 / 评分等级 + 难度 / 拥挤度，默认隐藏，可在「展示样式 → 界面配置」开启
  els.scoreLabel = h('span', { class: 'score-label' }, '得分：尚未运行');
  // 动态难度：拥挤度与难度等级指示
  els.diffLabel = h('span', { class: 'hint' }, '');
  els.evalLine = h('div', { class: 'controls-line' }, els.scoreLabel, els.diffLabel);
  // 自适应速度：拥挤时自动放慢播放
  els.adaptiveChk = checkbox(state.adaptive, (v) => {
    state.adaptive = v;
    saveAdaptive(v);
    updateControls();
    toast(v ? '已开启自适应速度：拥挤时自动放慢播放' : '已关闭自适应速度', 'info');
  }, '自适应速度');
  els.adaptiveChk.title = '拥挤度升高时自动放慢播放速度（倍率 0.3~1），便于观察拥挤局面';

  // 速度档位：一键切换到常用播放速度
  const speedBtns = [0.5, 2, 8, 30, 120].map((v) => {
    const b = button(String(v), () => setSpeed(v), 'ghost small');
    b.title = `设为 ${v} 步/秒`;
    return b;
  });

  c.appendChild(h('div', { class: 'controls-line' },
    els.playBtn, els.prevBtn, els.stepBtn, els.resetBtn, els.endBtn, els.runBtn));
  c.appendChild(h('div', { class: 'controls-line' },
    els.loopChk, els.autoChk, els.followChk, els.adaptiveChk,
    h('span', { class: 'mini-label' }, '速度'), els.speedRange, els.speedLabel));
  c.appendChild(h('div', { class: 'controls-line' },
    h('span', { class: 'mini-label' }, '速度档位'), ...speedBtns));
  c.appendChild(h('div', { class: 'controls-line' },
    h('span', { class: 'mini-label' }, '种子'), els.seedInput, els.seedDice));
  c.appendChild(h('div', { class: 'controls-line' }, els.timeline, els.frameLabel));
  c.appendChild(h('div', { class: 'controls-line' }, els.endLabel, els.endJumpBtn, els.continueBtn));
  c.appendChild(els.evalLine);
  c.appendChild(h('div', { class: 'controls-line' },
    h('span', { class: 'hint' }, '快捷键：空格 播放/暂停 · ← → 单步（Shift 跳 10 帧） · ↑ ↓ 调速 · - = 减半/加倍 · Home / End 首末帧 · R 重置 · Esc 暂停 · Ctrl+Z 撤销配置')));
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
  const details = revealConfigGroup('结束规则（按优先级）');
  if (!details) { toast('未找到结束规则面板', 'warn'); return; }
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
  updateScoreLabel();
}

/** 刷新得分 / 最高分与当前难度指示 */
function updateScoreLabel() {
  if (els.scoreLabel) {
    const sc = state.score;
    els.scoreLabel.textContent = sc
      ? `得分 ${formatScore(sc.total)}（${sc.gradeLabel}） · 最高分 ${formatScore(state.highScore)}`
      : '得分：尚未运行';
    els.scoreLabel.classList.toggle('record', !!sc && state.highScore > 0 && sc.total >= state.highScore);
  }
  if (els.diffLabel) {
    const d = currentDifficulty();
    els.diffLabel.textContent = `难度 ${d.label} · 拥挤度 ${Math.round(d.crowding * 100)}%${state.adaptive ? ' · 自适应调速中' : ''}`;
  }
}

/** 得分分项明细：把总分拆成可解释的 6 项，说明每一个得分来源 */
function showScoreDetail() {
  const sc = state.score;
  if (!sc) {
    toast('尚未运行模拟', 'warn');
    return;
  }
  alertDialog({
    title: `得分明细 · ${sc.gradeLabel}`,
    message: `总分 ${formatScore(sc.total)} · 相对分 ${sc.ratio.toFixed(2)}（总分 ÷ 网格格数 ${state.result ? state.result.grid.size : '-'}）`,
    sections: [
      { title: '分项构成', items: sc.parts.map((p) => `${p.label}：${formatScore(p.value)}（${p.detail}）`) },
      ...(state.highScore > 0 ? [{ title: '地图记录', items: [`当前地图最高分：${formatScore(state.highScore)}`] }] : []),
    ],
  });
}

/** 隐藏悬浮提示 */
function hideTooltip() {
  if (els.tooltip) els.tooltip.classList.remove('show');
}

/**
 * 悬浮提示定位：跟随光标并做边界翻转（右侧不足则左移、下方不足则上移），
 * 提示浮层固定在视口层，因此不会被画布容器裁剪或被下方 UI 元素遮挡。
 */
function placeTooltip(clientX, clientY) {
  const tip = els.tooltip;
  const pad = 12;
  const off = 14;
  // 先回到左上角再测量：否则上一次的 left 会通过 shrink-to-fit 约束宽度，
  // 使同一段文案在不同位置测出不同宽度（换行行数 / 翻转时机随之漂移）
  tip.style.left = '0px';
  tip.style.top = '0px';
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  let left = clientX + off;
  if (left + w > window.innerWidth - pad) left = clientX - off - w;
  left = Math.max(pad, Math.min(left, Math.max(pad, window.innerWidth - pad - w)));
  let top = clientY + off;
  if (top + h > window.innerHeight - pad) top = clientY - off - h;
  top = Math.max(pad, Math.min(top, Math.max(pad, window.innerHeight - pad - h)));
  tip.style.left = `${Math.round(left)}px`;
  tip.style.top = `${Math.round(top)}px`;
}

/** 点按某个格子 → 跳到该格首次经过的步数（鼠标点击与移动端点按共用） */
function jumpToCellFirstPass(c) {
  if (!c || !state.result) return;
  const info = renderer.trailInfo.get(state.result.grid.idx(c.col, c.row));
  if (!info) return;
  pause();
  gotoFrame(frameIndexForTick(info.first));
  toast(`已跳转到该格首次经过的步数：第 ${info.first} 步`, 'info');
}

function bindCanvasEvents() {
  els.canvas.addEventListener('mousemove', (e) => {
    if (!state.result) return;
    const c = renderer.hitTest(e.clientX, e.clientY);
    renderer.hover = c;
    draw();
    if (!c) {
      hideTooltip();
      return;
    }
    els.tooltip.textContent = renderer.describe(state.frameIndex, c);
    els.tooltip.classList.add('show');
    placeTooltip(e.clientX, e.clientY);
  });
  els.canvas.addEventListener('mouseleave', () => {
    renderer.hover = null;
    hideTooltip();
    draw();
  });
  // 画布滚动 / 窗口尺寸变化时，如果提示仍在显示则按最后一次光标位置重新定位
  window.addEventListener('scroll', () => { if (els.tooltip?.classList.contains('show')) hideTooltip(); }, true);
  window.addEventListener('resize', () => hideTooltip());
  els.canvas.addEventListener('click', (e) => {
    jumpToCellFirstPass(renderer.hitTest(e.clientX, e.clientY));
  });

  // 移动端触控：点按显示格子信息并在抬手时跳转到该格首次经过的步数。
  // 不拦截 touchstart / touchmove 的默认行为，保留画布容器的滚动与双指缩放（CSS 侧限制 touch-action）。
  let touchStart = null;
  els.canvas.addEventListener('touchstart', (e) => {
    if (!state.result || e.touches.length !== 1) { touchStart = null; return; }
    const t = e.touches[0];
    touchStart = { x: t.clientX, y: t.clientY, moved: false };
    const c = renderer.hitTest(t.clientX, t.clientY);
    renderer.hover = c;
    draw();
    if (!c) { hideTooltip(); return; }
    els.tooltip.textContent = renderer.describe(state.frameIndex, c);
    els.tooltip.classList.add('show');
    placeTooltip(t.clientX, t.clientY);
  }, { passive: true });

  els.canvas.addEventListener('touchmove', (e) => {
    if (!touchStart || e.touches.length !== 1) return;
    const t = e.touches[0];
    // 位移超过阈值视为滚动 / 拖动手势，抬手时不触发跳转
    if (Math.abs(t.clientX - touchStart.x) > 8 || Math.abs(t.clientY - touchStart.y) > 8) {
      touchStart.moved = true;
      hideTooltip();
    }
  }, { passive: true });

  els.canvas.addEventListener('touchend', (e) => {
    const started = touchStart;
    touchStart = null;
    renderer.hover = null;
    draw();
    const t = e.changedTouches && e.changedTouches[0];
    if (!started || started.moved || !t) { hideTooltip(); return; }
    const c = renderer.hitTest(t.clientX, t.clientY);
    hideTooltip();
    jumpToCellFirstPass(c);
  }, { passive: true });

  els.canvas.addEventListener('touchcancel', () => {
    touchStart = null;
    renderer.hover = null;
    hideTooltip();
    draw();
  }, { passive: true });
}

/* ------------------------------------------------------------------ */
/* 统计面板                                                            */
/* ------------------------------------------------------------------ */

const STAT_KEYS = [
  ['steps', '步数'], ['framePos', '当前帧 / 总帧数'], ['frames', '缓存帧数'], ['elapsed', '运行耗时'],
  ['endReason', '结束原因 / 本步事件'], ['score', '得分'], ['scoreGrade', '评分等级'],
  ['collisions', '碰撞次数'], ['selfCollisions', '自撞次数'], ['length', '当前长度'],
  ['finalLength', '最终长度'], ['maxLength', '最大长度'], ['coverage', '覆盖率'], ['ruleTriggers', '规则触发'],
  ['agents', '存活移动体'], ['peakAgents', '峰值移动体'], ['spawns', '生成新蛇'], ['agentDeaths', '移动体消失'],
  ['merges', '融合次数'], ['repels', '排斥次数'], ['markerInteractions', '标记物交互'],
  ['transformDeaths', '自撞死亡'], ['transformedCells', '转化节点'], ['collisionWarnings', '碰撞预警'],
  ['caSteps', 'CA 演进次数'], ['obstacleCount', '障碍物'], ['markerCount', '标记物'], ['seed', '随机种子'],
  ['rngCalls', '随机调用次数'],
  // 生命机制（多生命系统）
  ['lives', '剩余生命'], ['maxLives', '峰值生命'], ['lifeGains', '获得生命'], ['lifeLosses', '失去生命'],
  ['respawns', '重生次数'], ['lifeWarnings', '低生命预警'], ['finalDeaths', '最终死亡'],
];

/** 运行耗时的展示格式：不足 1 秒按毫秒，超过按秒保留两位小数 */
function formatDuration(ms) {
  const v = Number(ms);
  if (!Number.isFinite(v) || v <= 0) return '-';
  return v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(2)} s`;
}

/** 统计口径：实时 = 截至当前播放位置（会话内动态数据）/ 总计 = 整轮运行全量汇总 */
const STAT_MODES = [
  { value: 'realtime', label: '实时统计', hint: '按当前播放位置统计，轨迹筛选范围随播放/跳帧同步变化' },
  { value: 'total', label: '总计统计', hint: '展示整轮运行的全量汇总与完整轨迹' },
];

/** 实时口径长度曲线的抽样上限（与迷你图宽度一致，长跑时避免逐帧拷贝） */
const SPARK_MAX_POINTS = 220;

function statModeInfo() {
  return STAT_MODES.find((m) => m.value === state.statMode) || STAT_MODES[1];
}

/** 当前口径对应的帧下标：实时取播放位置，总计取末帧 */
function statFrameIndex() {
  const r = state.result;
  if (!r || !r.frames.length) return 0;
  if (state.statMode !== 'realtime') return r.frames.length - 1;
  return Math.max(0, Math.min(state.frameIndex, r.frames.length - 1));
}

/** 实时口径的长度曲线：按像素宽度抽样，避免长跑时逐帧生成数组 */
function liveLengthHistory(frames, endIndex) {
  const count = endIndex + 1;
  const out = [];
  if (count <= SPARK_MAX_POINTS) {
    for (let i = 0; i <= endIndex; i++) out.push(frames[i].stats.length);
    return out;
  }
  const stride = count / SPARK_MAX_POINTS;
  for (let k = 0; k < SPARK_MAX_POINTS; k++) out.push(frames[Math.floor(k * stride)].stats.length);
  out[out.length - 1] = frames[endIndex].stats.length;
  return out;
}

/**
 * 按当前统计口径计算指标取值。
 * 两种口径共用同一套键（见 STAT_KEYS），因此切换时展示格式完全一致。
 */
function statValues() {
  const r = state.result;
  if (!r || !r.frames.length) return null;
  const i = statFrameIndex();
  const f = r.frames[i];
  const st = f ? f.stats : {};
  const live = state.statMode === 'realtime';
  const s = r.summary;
  const stride = r.frameStride > 1 ? `（抽样 1/${r.frameStride}）` : '';
  const pick = (liveValue, totalValue) => (live ? liveValue : totalValue);
  return {
    values: {
      steps: pick(st.steps ?? 0, s.steps),
      framePos: `${i + 1} / ${r.frames.length}`,
      elapsed: formatDuration(r.elapsedMs),
      frames: pick(`${i + 1}${stride}`, `${r.frames.length}${stride}`),
      endReason: pick(f && f.events && f.events.length ? f.events.map(eventLabel).join('、') : '—', s.endReason),
      // 得分为整轮量：两种口径都展示结束时的结算得分
      score: formatScore(s.score ? s.score.total : 0),
      scoreGrade: s.score ? s.score.gradeLabel : '-',
      collisions: pick(st.collisions, s.collisions),
      selfCollisions: pick(st.selfCollisions, s.selfCollisions),
      length: pick(st.length, s.finalLength),
      finalLength: s.finalLength,
      maxLength: pick(st.maxLength, s.maxLength),
      coverage: `${formatNumber(pick(st.coverage, s.coverage))}%`,
      ruleTriggers: pick(st.ruleTriggers, s.ruleTriggers),
      agents: pick(st.agents, s.agents),
      peakAgents: pick(st.peakAgents, s.peakAgents),
      spawns: pick(st.spawns, s.spawns),
      agentDeaths: pick(st.agentDeaths, s.agentDeaths),
      merges: pick(st.merges, s.merges),
      repels: pick(st.repels, r.stats.repels || 0),
      markerInteractions: pick(st.markerInteractions, r.stats.markerInteractions || 0),
      transformDeaths: pick(st.transformDeaths, s.transformDeaths || 0),
      transformedCells: pick(st.transformedCells, s.transformedCells || 0),
      collisionWarnings: pick(st.collisionWarnings, s.collisionWarnings || 0),
      caSteps: pick(st.caSteps, s.caSteps),
      obstacleCount: pick(st.obstacleCount, s.obstacleCount),
      markerCount: pick(st.markerCount, s.markerCount),
      // 生命机制：帧级快照含 lives / 增减 / 重生 / 预警 / 最终死亡，整轮汇总取自 summary
      lives: pick(st.lives ?? 0, s.lives ?? 0),
      maxLives: pick(st.lives ?? 0, s.maxLives ?? 0),
      lifeGains: pick(st.lifeGains ?? 0, s.lifeGains ?? 0),
      lifeLosses: pick(st.lifeLosses ?? 0, s.lifeLosses ?? 0),
      respawns: pick(st.respawns ?? 0, s.respawns ?? 0),
      lifeWarnings: pick(st.lifeWarnings ?? 0, s.lifeWarnings ?? 0),
      finalDeaths: pick(st.finalDeaths ?? 0, s.finalDeaths ?? 0),
      seed: r.seed,
      rngCalls: pick(st.rngCalls, r.rngCalls),
    },
    turns: live ? st : r.stats,
    history: live ? liveLengthHistory(r.frames, i) : r.stats.lengthHistory,
  };
}

function renderStageStats() {
  const host = els.stageStats;
  clear(host);
  els.statSpans = {};
  if (!state.result) return;
  // 得分模块默认隐藏：隐藏时不生成对应统计格，也无对应摘要行
  for (const [key, label] of activeStatKeys()) {
    const span = h('span', { class: 'stat-value' }, '-');
    els.statSpans[key] = span;
    const clickable = key === 'score';
    host.appendChild(h('div', {
      class: `stat ${key === 'endReason' ? 'wide' : ''}${clickable ? ' clickable' : ''}`,
      title: clickable ? '点击查看得分分项明细' : null,
      onclick: clickable ? showScoreDetail : null,
    }, h('span', { class: 'stat-label' }, label), span));
  }
  els.spark = h('canvas', { class: 'spark', width: 220, height: 44 });
  els.turnBars = h('div', { class: 'bars' });
  host.appendChild(h('div', { class: 'stat wide' },
    h('span', { class: 'stat-label' }, '长度曲线'), els.spark));
  host.appendChild(h('div', { class: 'stat wide' },
    h('span', { class: 'stat-label' }, '转向分布'), els.turnBars));
  fillStageStats();
}

/**
 * 按当前口径刷新统计数值与图表。
 * 只更新既有节点上的文本与画布内容，不重建 DOM，因此切换口径时不会闪烁。
 */
function fillStageStats() {
  const data = statValues();
  if (!data || !els.statSpans) return;
  for (const [key, span] of Object.entries(els.statSpans)) {
    span.textContent = String(data.values[key] ?? '-');
  }
  drawSparkline(els.spark, data.history);
  renderTurnBars(els.turnBars, data.turns);
}

/** 播放 / 跳帧后的统计刷新：仅实时口径需要跟随播放位置重算 */
function updateFrameStats() {
  if (!state.result) return;
  if (state.statMode === 'realtime') fillStageStats();
  if (!state.playing) syncStatModeHint();
  notifyLifeEvents();
}

/* ---------------- 生命机制：低生命 / 生命耗尽的即时提示 ---------------- */

/** 已提示过的事件键（type + 步数）：循环播放与反复重算都不会重复打扰 */
const lifeWarnedEvents = new Set();

/**
 * 播放到含「低生命预警 / 生命耗尽」事件的帧时给出一次提示。
 * 事件由模拟层写入帧数据，这里只负责把关键节点以提示条形式呈现给玩家。
 */
function notifyLifeEvents() {
  const life = state.cfg && state.cfg.life;
  const r = state.result;
  if (!life || !life.enabled || !r) return;
  const frame = r.frames[state.frameIndex];
  if (!frame || !Array.isArray(frame.events)) return;
  for (const e of frame.events) {
    if (e.type !== 'lifeWarning' && e.type !== 'lifeDepleted') continue;
    const key = `${e.type}:${frame.tick}`;
    if (lifeWarnedEvents.has(key)) continue;
    if (lifeWarnedEvents.size > 400) lifeWarnedEvents.clear();
    lifeWarnedEvents.add(key);
    if (e.type === 'lifeWarning') {
      toast(`低生命预警：仅剩 ${e.lives} 条生命（第 ${frame.tick} 步）`, 'warn');
    } else {
      toast(`生命耗尽：第 ${frame.tick} 步触发最终死亡`, 'error');
    }
  }
}

function eventLabel(e) {
  const map = {
    wall: '撞墙', obstacle: '撞障碍物', obstacleDestroyed: '撞毁障碍物', obstaclePass: '穿过障碍物',
    selfCollision: '撞到自身', grow: '增长', shrink: '缩短', eat: '吃到标记物', spawn: '生成移动体',
    merge: '蛇融合', repel: '蛇排斥', agentCollision: '移动体相撞', agentDeath: '移动体消失',
    agentRemoved: '移动体被移除', markerInteraction: '交互标记物',
    transform: '身体转化入环境', transformDeath: '自撞死亡', transformSkipped: '转化未触发',
    // 生命机制（多生命系统）
    lifeGain: '获得生命', lifeLoss: '失去生命', lifeWarning: '低生命预警',
    lifeDepleted: '生命耗尽', lifeRespawn: '原地重生', trapHit: '触发陷阱',
  };
  const pos = e.coord ? `(${e.coord.col},${e.coord.row})` : '';
  const extra = e.type === 'markerInteraction' && e.delta ? ` ${e.delta > 0 ? '+' : ''}${e.delta}` : '';
  const life = e.lives !== undefined && LIFELINE_EVENTS.has(e.type) ? ` → 剩余 ${e.lives} 条` : '';
  const count = e.type === 'transform' && e.count !== undefined ? ` ×${e.count}` : '';
  return `${map[e.type] || e.type}${extra}${life}${count}${pos}`;
}

/** 会在事件文本中附带「剩余生命」的事件类型 */
const LIFELINE_EVENTS = new Set(['lifeGain', 'lifeLoss', 'lifeWarning', 'lifeDepleted', 'lifeRespawn', 'trapHit']);

function drawSparkline(canvas, history) {
  if (!canvas) return;
  const w = canvas.width;
  const hh = canvas.height;
  const ctx = canvas.getContext('2d');
  // 步数上限可放宽到数十万，按像素宽度抽样，避免逐点绘制拖慢界面
  const maxPoints = Math.max(2, w);
  const src = Array.isArray(history) ? history : [];
  let data = src;
  if (src.length > maxPoints) {
    const stride = src.length / maxPoints;
    data = [];
    for (let i = 0; i < maxPoints; i++) data.push(src[Math.floor(i * stride)]);
    data[data.length - 1] = src[src.length - 1];
  }
  if (!data.length) data = [0];
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
}

/** 转向分布条：按当前口径的累计转向次数重绘（两种口径共用同样的行结构） */
function renderTurnBars(host, stats) {
  if (!host) return;
  const s = stats || {};
  const items = [
    ['左转', s.turnsLeft || 0, '#ff922b'],
    ['直行', s.turnsStraight || 0, '#4dabf7'],
    ['右转', s.turnsRight || 0, '#51cf66'],
    ['掉头', s.turnsReverse || 0, '#c084fc'],
  ];
  // 行结构固定（4 行），创建一次后只更新宽度与文本：
  // 实时口径下播放时每帧都会调用本函数，原地更新可避免逐帧销毁/重建 DOM 节点。
  let rows = host._turnRows;
  if (!rows) {
    rows = items.map(([label, , color]) => {
      const fill = h('div', { class: 'bar-fill', style: { background: color } });
      const val = h('span', { class: 'bar-val' });
      host.appendChild(h('div', { class: 'bar-row' },
        h('span', { class: 'bar-label' }, label),
        h('div', { class: 'bar-track' }, fill),
        val));
      return { fill, val };
    });
    host._turnRows = rows;
  }
  const total = Math.max(1, items.reduce((sum, it) => sum + it[1], 0));
  items.forEach((it, i) => {
    const pct = (it[1] / total) * 100;
    rows[i].fill.style.width = `${pct}%`;
    rows[i].val.textContent = `${it[1]} · ${pct.toFixed(1)}%`;
  });
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

  const currentPreset = matchPreset(state.cfg) || PRESETS[0];
  const presetSel = select(currentPreset.id, PRESETS.map((p) => ({ value: p.id, label: p.name })), () => {});
  const presetDesc = h('div', { class: 'hint' }, currentPreset.description);
  presetSel.addEventListener('change', () => {
    const p = PRESETS.find((x) => x.id === presetSel.value);
    if (p) presetDesc.textContent = p.description;
  });
  side.appendChild(group('预设模板', [
    field('模板', presetSel),
    presetDesc,
    row(
      button('载入模板', () => loadPresetTemplate(presetSel.value), 'primary'),
      button('空白配置', () => applyConfigReplacement(normalizeConfig(defaultConfig()), '空白配置', '已载入空白配置'), 'ghost'),
      button('恢复上次配置', () => {
        const last = loadLocalConfig();
        if (!last) { toast('本地没有可恢复的配置', 'warn'); return; }
        applyConfigReplacement(last, '恢复上次配置', '已恢复上次配置');
      }, 'ghost'),
      button('撤销上次变更', undoConfigReplace, 'ghost'),
    ),
    h('div', { class: 'hint' }, '载入模板前自动比对当前配置与模板基准，检测到自定义改动时会先列出将被覆盖的内容并等待确认；Ctrl+Z 可撤销最近一次配置替换。'),
  ], { open: false }));

  // 配置自动存档与状态存档合并到同一分组，便于统一管理「进度」与「局面」
  side.appendChild(group('配置 / 状态存档', [
    ...autosaveSection(),
    h('div', { class: 'divider' }),
    ...savesSection(),
  ], { open: false }));

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
        applyConfigReplacement(normalizeConfig(shared), '载入链接配置', '已从链接载入配置');
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
          applyConfigReplacement(normalizeConfig(obj), '导入配置', '配置导入成功');
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
    row(
      button('纯轨迹 SVG', () => withResult((r) => downloadSVG(trailToSVG(r, state.cfg.style), `trail-${r.seed}.svg`))),
      button('轨迹明细 CSV', () => withResult((r) => downloadText(`trail-cells-${r.seed}.csv`, trailCellsFullCSV(), 'text/csv;charset=utf-8'))),
    ),
  ], { open: false }));

  els.logHost = h('div', { class: 'log-list' });
  els.logCount = h('span', { class: 'mini-label' }, '');
  const filterSel = select(state.logFilter, [
    { value: 'all', label: '全部规则' },
    { value: 'frame', label: '仅当前步' },
    ...state.cfg.environmentRules.map((r) => ({ value: r.id, label: r.name })),
  ], (v) => { state.logFilter = v; renderLog(); });

  // 统计模块（内含「坐标筛选查询」子选项卡：与统计口径共享同一轨迹数据源）
  side.appendChild(statsModeGroup());

  side.appendChild(trailCompareGroup());

  side.appendChild(group('规则触发日志', [
    row(filterSel, els.logCount),
    els.logHost,
  ], { open: false }));

  // 面板重建后统计节点是全新的，需要用当前快照/差异重新填充
  updateCompareStat();
}

/* ------------------------------------------------------------------ */
/* 坐标筛选查询                                                        */
/* ------------------------------------------------------------------ */

/**
 * 统计模块：实时 / 总计口径切换。
 * 切换只更新统计数值文本与图表内容（不重建 DOM），因此不会出现闪烁。
 */
function statsModeGroup() {
  const seg = h('div', { class: 'mode-switch' });
  els.statModeBtns = {};
  for (const m of STAT_MODES) {
    const b = button(m.label, () => setStatMode(m.value), 'mode-btn');
    b.title = m.hint;
    els.statModeBtns[m.value] = b;
    seg.appendChild(b);
  }
  els.statModeHint = h('div', { class: 'hint' }, '');
  syncStatModeUI();
  return group('统计模块', [
    h('div', { class: 'hint' }, '实时统计按当前播放位置统计（含轨迹数据，随播放 / 跳帧变化）；总计统计展示整轮运行的全量汇总。两种口径共用同一套指标与展示格式。'),
    seg,
    els.statModeHint,
    row(button('复制统计摘要', () => {
      const text = statsSummaryText();
      if (!text) { toast('尚未运行模拟', 'warn'); return; }
      copyText(text, '统计摘要已复制');
    }, 'ghost small')),
    // 本地得分排行榜并入统计模块：成绩本身就是统计结论的留档，与统计口径同属一处更易查找。
    scoreboardGroup(),
    // 坐标筛选查询并入统计模块：与统计口径共用同一轨迹数据源，
    // 切换口径或改变播放位置时查询结果会实时同步到统计面板与画面高亮。
    trailQueryGroup(),
  ], { key: 'stat-mode', open: false });
}

/** 切换统计口径：更新控件高亮、状态提示、统计数值与轨迹筛选数据源 */
function setStatMode(mode) {
  if ((mode !== 'realtime' && mode !== 'total') || state.statMode === mode) return;
  state.statMode = mode;
  try {
    localStorage.setItem(TRAIL_MODE_KEY, mode);
  } catch (e) {
    /* 隐私模式静默忽略 */
  }
  // 口径切换时给统计面板一次淡入过渡，数值在原节点上更新，避免整块重绘造成的闪烁
  if (els.stageStats) {
    els.stageStats.classList.add('stat-switch');
    setTimeout(() => els.stageStats && els.stageStats.classList.remove('stat-switch'), 240);
  }
  syncStatModeUI();
  fillStageStats();
  liveTrailCache = { tick: -1, at: 0, trail: null };
  applyTrailQuery(true);
  toast(`已切换为「${statModeInfo().label}」`, 'info');
}

function syncStatModeUI() {
  if (els.statModeBtns) {
    for (const [value, btn] of Object.entries(els.statModeBtns)) {
      btn.classList.toggle('on', value === state.statMode);
      btn.setAttribute('aria-pressed', value === state.statMode ? 'true' : 'false');
    }
  }
  syncStatModeHint();
}

/**
 * 统计摘要文本：当前口径的全部指标 + 坐标筛选结论，供一键复制留档。
 * 未运行模拟时返回空串（调用方据此提示）。
 */
function statsSummaryText() {
  const data = statValues();
  if (!data) return '';
  const lines = [`# GridSneaker 统计摘要 · ${state.cfg.meta.name || '未命名'} · ${statModeInfo().label}`];
  for (const [key, label] of activeStatKeys()) lines.push(`${label}：${data.values[key] ?? '-'}`);
  if (state.trailCells && state.trailCells.length) {
    lines.push(`坐标筛选：匹配 ${state.trailCells.length} 个坐标 · ${trailQueryLabel(state.trailQuery)}`);
  }
  return lines.join('\n');
}

function syncStatModeHint() {
  const hint = els.statModeHint;
  if (!hint) return;
  const r = state.result;
  if (!r || !r.frames.length) {
    hint.textContent = '尚未运行模拟';
    return;
  }
  if (state.statMode === 'realtime') {
    const i = statFrameIndex();
    const tick = r.frames[i] ? r.frames[i].tick : 0;
    hint.textContent = `实时：已统计 ${i + 1} 帧（第 ${tick} 步 / 共 ${r.summary.steps} 步）`;
  } else {
    hint.textContent = `总计：整轮 ${r.summary.steps} 步 · ${r.frames.length} 帧的全量汇总`;
  }
}

/* ------------------------------------------------------------------ */
/* 坐标筛选查询                                                        */
/* ------------------------------------------------------------------ */

/** 列表最多渲染的条目数（超出仅提示，数据仍可完整导出） */
const TRAIL_QUERY_LIMIT = 400;
/** 轨迹点数量超过该值时改用异步筛选并显示加载状态，避免长任务卡住界面 */
const TRAIL_QUERY_ASYNC_THRESHOLD = 20000;
/** 实时口径下轨迹截取与筛选重算的最小间隔（播放中节流，保证动画流畅） */
const LIVE_TRAIL_MIN_INTERVAL = 220;

/** 筛选控件的引用表：键 → { input, slide } */
let trailQueryRefs = {};
/** 筛选请求序号：参数连续变化时丢弃过期的异步结果 */
let trailQuerySeq = 0;
/** 实时口径轨迹缓存（按当前播放步数截取） */
let liveTrailCache = { tick: -1, at: 0, trail: null };
let liveRefreshAt = 0;
/** 筛选结果 / 范围缓存：同一份轨迹 + 同一组条件直接复用，避免播放中重复全量扫描 */
let trailQueryCache = { key: '', res: null };
let trailBoundsCache = { key: '', bounds: null };

/**
 * 轨迹指纹：轨迹内容（点数 / 最大步数 / 末点步数）变化即失效。
 * 用于给筛选结果与范围统计做记忆化，避免同一份数据在「执行筛选 → 同步滑块 → 渲染列表」流程里被反复全量扫描。
 */
function trailFingerprint(trail) {
  if (!trail || !trail.order) return 'none';
  const n = trail.path ? trail.path.length : 0;
  const last = n ? trail.path[n - 1].tick : 0;
  return `${trail.order.length}/${trail.maxTick}/${last}`;
}

/** 带记忆化的坐标筛选查询 */
function cachedTrailQuery(trail, query) {
  const key = `${trailFingerprint(trail)}|${JSON.stringify(query)}`;
  if (trailQueryCache.key !== key) {
    trailQueryCache = { key, res: queryTrail(trail, query) };
  }
  return trailQueryCache.res;
}

/** 带记忆化的轨迹序数范围统计 */
function cachedTrailBounds(trail) {
  const key = trailFingerprint(trail);
  if (trailBoundsCache.key !== key) {
    trailBoundsCache = { key, bounds: trailQueryBounds(trail) };
  }
  return trailBoundsCache.bounds;
}

function nowMs() {
  return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
}

/**
 * 当前统计口径下的轨迹数据源：
 * 总计口径用全量轨迹；实时口径用截至当前播放位置的轨迹（按步数二分截取，无需重跑模拟）。
 * 播放中按最小间隔复用上次结果，避免逐帧重建十万级轨迹点。
 */
function trailForMode() {
  if (!renderer || !renderer.trail || !state.result) return null;
  if (state.statMode !== 'realtime') return renderer.trail;
  const f = state.result.frames[statFrameIndex()];
  const tick = f ? f.tick : 0;
  const now = nowMs();
  const cached = liveTrailCache;
  if (cached.trail && (cached.tick === tick || (state.playing && now - cached.at < LIVE_TRAIL_MIN_INTERVAL))) {
    return cached.trail;
  }
  const trail = sliceTrailUpToTick(renderer.trail, tick);
  liveTrailCache = { tick, at: now, trail };
  return trail;
}

/**
 * 坐标筛选查询面板：
 * 按轨迹点的序数范围（「经过次序」「经过次数」「首次步数」）筛选坐标，
 * 每组上下限都提供数值输入框与滑块（双向同步，改动即时生效），上限填 0 表示不限。
 * 支持「全部满足 / 任一满足」组合、反选，以及常用配置的保存 / 载入 / 导入。
 */
function trailQueryGroup() {
  const q = state.trailQuery;
  trailQueryRefs = {};
  els.trailQueryStat = h('div', { class: 'hint' }, '尚未执行筛选');
  els.trailQuerySource = h('div', { class: 'hint' }, '');
  els.trailQueryError = h('div', { class: 'query-error hidden' }, '');
  els.trailQueryLoading = h('div', { class: 'query-loading hidden' }, '');
  els.trailQueryList = h('div', { class: 'query-list' });
  const logicSel = select(q.logic,
    TRAIL_QUERY_LOGICS.map((v) => ({ value: v, label: TRAIL_QUERY_LOGIC_LABELS[v] })),
    (v) => { q.logic = v; commitTrailQuery(); });
  const invertChk = checkbox(q.invert, (v) => { q.invert = v; commitTrailQuery(); });
  els.trailLogicSel = logicSel;
  els.trailInvertChk = invertChk;

  const reset = () => {
    Object.assign(q, defaultTrailQuery());
    setTrailQueryError('');
    syncTrailQueryControls();
    commitTrailQuery();
  };

  const body = [
    h('div', { class: 'hint' }, '坐标维度分析：按轨迹点的序数范围筛选坐标，结果与上方统计口径实时同步（上限填 0 表示不限；输入框与滑块双向同步，调整后即时更新结果、画面高亮与统计面板）。'),
  ];
  for (const f of TRAIL_RANGE_FIELDS) body.push(trailRangeField(f));
  body.push(
    els.trailQueryError,
    field('组合方式', row(
      logicSel,
      h('label', { class: 'check-wrap' }, invertChk, h('span', {}, '反选')),
    ), '「反选」选中所有不在当前序数区间内的轨迹点坐标'),
    row(
      button('执行筛选', () => applyTrailQuery(true), 'primary'),
      button('清除筛选', reset, 'ghost'),
      button('复制坐标', () => copyText(trailCellsToText(state.trailCells || []), '已复制筛选结果坐标')),
      button('导出 CSV', () => downloadText('trail-query.csv', trailCellsToCSV(state.trailCells || []), 'text/csv;charset=utf-8')),
    ),
    trailPresetSection(),
    els.trailQuerySource,
    els.trailQueryStat,
    els.trailQueryLoading,
    els.trailQueryList,
  );
  return group('坐标筛选查询', body, { key: 'trail-query', open: false, badge: '坐标维度分析' });
}

/**
 * 单个序数范围条件的配置行：下限 / 上限各一行（数值输入框 + 滑块）。
 * 输入框停顿 220ms 即自动提交，滑块拖动实时提交，均无需刷新页面。
 */
function trailRangeField(f) {
  const line = (key) => {
    const lo = key === f.minKey ? f.minDefault : 0;
    const value = state.trailQuery[key];
    const num = numberInput(value, (v) => setTrailRangeValue(key, v), { min: lo, max: Math.max(1, value), step: 1, default: value });
    const slide = slider(value, (v) => setTrailRangeValue(key, v), { min: lo, max: Math.max(1, value), step: 1, cls: 'range query-range' });
    let timer = null;
    num.addEventListener('input', () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => num.dispatchEvent(new Event('change')), 220);
    });
    trailQueryRefs[key] = { input: num, slide, lo };
    return h('div', { class: 'range-line' },
      h('span', { class: 'range-tag' }, key === f.minKey ? '下限' : '上限'),
      num,
      slide);
  };
  return field(f.label, h('div', { class: 'range-rows' }, line(f.minKey), line(f.maxKey)),
    `${f.label}区间（含端点）；上限填 0 表示不限`);
}

/** 修改某个序数上下限：自动纠正非法区间 → 提示 → 同步控件 → 即时重算 */
function setTrailRangeValue(key, value) {
  const q = state.trailQuery;
  const fieldDef = TRAIL_RANGE_FIELDS.find((f) => f.minKey === key || f.maxKey === key);
  const raw = normalizeTrailQuery({ ...q, [key]: value });
  const fixed = reconcileTrailQuery(raw, key);
  const corrected = !!fieldDef
    && (fixed[fieldDef.minKey] !== raw[fieldDef.minKey] || fixed[fieldDef.maxKey] !== raw[fieldDef.maxKey]);
  Object.assign(q, fixed);
  setTrailQueryError(corrected
    ? `${fieldDef.label}：上限（${fixed[fieldDef.maxKey] || '不限'}）不能小于下限（${fixed[fieldDef.minKey]}），已自动纠正`
    : '');
  syncTrailQueryControls();
  commitTrailQuery();
}

/** 筛选条件变更后的统一出口：持久化 + 重算（即时生效） */
function commitTrailQuery() {
  saveTrailQuery();
  applyTrailQuery(true);
}

function setTrailQueryError(text) {
  const el = els.trailQueryError;
  if (!el) return;
  el.textContent = text || '';
  el.classList.toggle('hidden', !text);
}

/** 把当前筛选条件写回所有输入框与滑块（自动纠正 / 载入预设后需要回显） */
function syncTrailQueryControls() {
  for (const [key, ref] of Object.entries(trailQueryRefs)) {
    const v = String(state.trailQuery[key] ?? 0);
    if (document.activeElement !== ref.input) ref.input.value = v;
    ref.slide.value = v;
  }
  if (els.trailLogicSel) els.trailLogicSel.value = state.trailQuery.logic;
  if (els.trailInvertChk) els.trailInvertChk.checked = !!state.trailQuery.invert;
}

/**
 * 同步滑块的取值范围：随当前口径的数据源变化（实时口径轨迹点更少，上限随之收窄）。
 * 只扩大不缩小到当前取值以下，避免静默改动用户已配置的阈值。
 */
function syncTrailQueryLimits() {
  const bounds = cachedTrailBounds(trailForMode());
  for (const f of TRAIL_RANGE_FIELDS) {
    const b = bounds[f.bound] || { max: 1 };
    for (const key of [f.minKey, f.maxKey]) {
      const ref = trailQueryRefs[key];
      if (!ref) continue;
      const lo = key === f.minKey ? f.minDefault : 0;
      const hi = Math.max(b.max, Math.abs(Number(state.trailQuery[key])) || 0, lo + 1);
      ref.input.min = lo;
      ref.input.max = hi;
      ref.slide.min = lo;
      ref.slide.max = hi;
    }
  }
}

/** 筛选配置的保存 / 载入 / 导入 */
function trailPresetSection() {
  els.trailPresetName = textInput(state.trailPresetName, () => {}, { placeholder: '预设名称，如「前 200 个新坐标」' });
  els.trailPresetSel = h('select', { class: 'input' });
  refreshTrailPresetSelect(state.trailPresetName);
  const importArea = textArea('', () => {}, { rows: 2, placeholder: '粘贴筛选配置 JSON…' });
  return h('div', { class: 'query-preset' },
    h('div', { class: 'sub-title' }, '常用配置'),
    field('保存为预设', row(
      els.trailPresetName,
      button('保存', () => saveTrailPreset(els.trailPresetName.value), 'primary small'),
    ), '刷新页面后仍会保留当前条件下次自动生效'),
    field('已存预设', row(
      els.trailPresetSel,
      button('载入', () => loadTrailPreset(els.trailPresetSel.value)),
      button('删除', () => removeTrailPreset(els.trailPresetSel.value), 'ghost'),
    )),
    field('导入 / 导出', h('div', {},
      importArea,
      row(
        button('导入配置', () => importTrailQueryJSON(importArea.value), 'primary small'),
        button('复制当前配置', () => copyText(
          JSON.stringify({ query: normalizeTrailQuery(state.trailQuery) }, null, 2),
          '筛选配置 JSON 已复制'), 'ghost small'),
        button('清空', () => { importArea.value = ''; }, 'ghost small'),
      ))));
}

function refreshTrailPresetSelect(selected) {
  const sel = els.trailPresetSel;
  if (!sel) return;
  clear(sel);
  if (!state.trailPresets.length) {
    sel.appendChild(h('option', { value: '' }, '（暂无预设）'));
  } else {
    for (const p of state.trailPresets) sel.appendChild(h('option', { value: p.name }, p.name));
  }
  sel.value = selected || '';
}

function loadTrailPreset(name) {
  const preset = state.trailPresets.find((p) => p.name === name);
  if (!preset) {
    toast('请先选择要载入的预设', 'warn');
    return;
  }
  Object.assign(state.trailQuery, normalizeTrailQuery(preset.query));
  state.trailPresetName = preset.name;
  if (els.trailPresetName) els.trailPresetName.value = preset.name;
  setTrailQueryError('');
  syncTrailQueryControls();
  commitTrailQuery();
  toast(`已载入筛选预设「${preset.name}」`, 'success');
}

/** 导入筛选配置：支持 { name?, query } 结构与直接的筛选条件对象 */
function importTrailQueryJSON(text) {
  const raw = String(text || '').trim();
  if (!raw) {
    toast('请先粘贴筛选配置 JSON', 'warn');
    return;
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    toast(`JSON 解析失败：${e.message}`, 'error');
    return;
  }
  const query = obj && obj.query && typeof obj.query === 'object' ? obj.query : obj;
  const check = validateTrailQuery(query);
  if (!check.ok) toast(`${check.errors[0].message}，已自动纠正`, 'warn');
  Object.assign(state.trailQuery, reconcileTrailQuery(query));
  const name = obj && typeof obj.name === 'string' ? obj.name.trim() : '';
  if (name) saveTrailPreset(name);
  setTrailQueryError('');
  syncTrailQueryControls();
  commitTrailQuery();
  toast('筛选配置已导入', 'success');
}

/** 数据源提示：说明当前筛选作用在实时轨迹还是全量轨迹上 */
function updateTrailQuerySource(total) {
  const el = els.trailQuerySource;
  if (!el) return;
  const r = state.result;
  if (!r) {
    el.textContent = '';
    return;
  }
  if (state.statMode === 'realtime') {
    const i = statFrameIndex();
    el.textContent = `数据源：实时轨迹（截至第 ${r.frames[i] ? r.frames[i].tick : 0} 步），共 ${total} 个坐标`;
  } else {
    el.textContent = `数据源：全量轨迹（整轮 ${r.summary.steps} 步），共 ${total} 个坐标`;
  }
}

function setTrailQueryBusy(busy, text) {
  const el = els.trailQueryLoading;
  if (!el) return;
  el.textContent = busy ? text || '正在筛选…' : '';
  el.classList.toggle('hidden', !busy);
}

/**
 * 执行坐标筛选：更新画面高亮与结果列表。
 * 轨迹点数量较大时先给出加载状态，再把计算放到下一个事件循环，避免界面卡顿；
 * 参数连续变化时用序号丢弃过期结果。
 */
function applyTrailQuery(rerender = true) {
  const stat = els.trailQueryStat;
  const list = els.trailQueryList;
  if (!stat || !list) return;
  const seq = ++trailQuerySeq;
  if (!state.result || !renderer) {
    setTrailQueryBusy(false);
    stat.textContent = '尚未运行模拟';
    state.trailCells = [];
    state.trailFilter = null;
    if (rerender) clear(list);
    return;
  }
  const trail = trailForMode();
  syncTrailQueryLimits();
  const total = trail ? trail.order.length : 0;
  const heavy = total > TRAIL_QUERY_ASYNC_THRESHOLD;
  if (heavy) setTrailQueryBusy(true, `正在筛选 ${total} 个轨迹坐标…`);

  const run = () => {
    if (seq !== trailQuerySeq) return; // 参数已再次变化，丢弃本次结果
    const res = cachedTrailQuery(trail, state.trailQuery);
    const active = trailQueryActive(state.trailQuery);
    setTrailQueryBusy(false);
    updateTrailQuerySource(res.total);
    if (!active) {
      state.trailCells = [];
      state.trailFilter = null;
      renderer.setFilter(null);
      stat.textContent = `未设置筛选条件（共 ${res.total} 个轨迹坐标）`;
      if (rerender) clear(list);
      drawFrameOnly();
      return;
    }
    state.trailCells = res.cells;
    state.trailFilter = res.cells.map((c) => c.index);
    renderer.setFilter(state.trailFilter);
    stat.textContent = `匹配 ${res.matched} / ${res.total} 个坐标 · ${trailQueryLabel(state.trailQuery)}`;
    if (!rerender) {
      drawFrameOnly();
      return;
    }
    clear(list);
    if (!res.cells.length) {
      list.appendChild(h('div', { class: 'hint' }, '没有匹配的坐标'));
      drawFrameOnly();
      return;
    }
    for (const c of res.cells.slice(0, TRAIL_QUERY_LIMIT)) list.appendChild(trailCellRow(c));
    if (res.cells.length > TRAIL_QUERY_LIMIT) {
      list.appendChild(h('div', { class: 'hint' }, `仅显示前 ${TRAIL_QUERY_LIMIT} 项，可用「复制坐标 / 导出 CSV」获取全部结果`));
    }
    drawFrameOnly();
  };
  if (heavy) setTimeout(run, 0);
  else run();
}

/**
 * 实时口径下播放位置变化后的筛选刷新（节流）。
 * 未启用筛选时直接跳过，避免播放中做无意义的轨迹截取。
 */
function maybeRefreshLiveFilter() {
  if (state.statMode !== 'realtime' || !trailQueryActive(state.trailQuery)) return;
  const now = nowMs();
  if (state.playing && now - liveRefreshAt < LIVE_TRAIL_MIN_INTERVAL) return;
  liveRefreshAt = now;
  applyTrailQuery(true);
}

/** 筛选结果行：点击跳转到该坐标首次经过的步数 */
function trailCellRow(c) {
  const el = h('div', { class: 'query-item', title: '点击跳转到首次经过该坐标的步数' },
    h('span', { class: 'query-coord' }, `(${c.col}, ${c.row})`),
    h('span', { class: 'query-meta' }, `次序 #${c.order}`),
    h('span', { class: 'query-meta' }, `经过 ${c.visits} 次`),
    h('span', { class: 'query-meta' }, `首次第 ${c.first} 步`));
  el.addEventListener('click', () => {
    pause();
    gotoFrame(frameIndexForTick(c.first));
  });
  return el;
}

/** 重算后按当前条件刷新筛选（无匹配条件时保持关闭高亮） */
function refreshTrailFilter() {
  if (!renderer) return;
  applyTrailQuery(true);
}

function withResult(fn) {
  if (!state.result) { toast('尚未运行模拟', 'warn'); return; }
  fn(state.result);
}

/** 逐格轨迹明细（列 / 行 / 经过次序 / 次数 / 首末步），比「轨迹 CSV」更细） */
function trailCellsFullCSV() {
  if (!renderer || !renderer.trail) return '';
  return trailCellsToCSV(renderer.trail.order.map((i) => renderer.trail.info.get(i)));
}

/* ------------------------------------------------------------------ */
/* 多轨迹对比（轨迹快照）                                              */
/* ------------------------------------------------------------------ */

/**
 * 轨迹快照对比：
 * 「保存基准快照」把当前完整运行的轨迹冻结成基准数据；之后改动种子 / 参数 / 规则并重跑，
 * 面板给出与基准的坐标差异，画面上叠加基准虚线轨迹与三类差异格：
 *   黄 = 两条轨迹都经过（稳定路径）· 红 = 仅基准经过 · 绿 = 仅当前经过。
 */
function trailCompareGroup() {
  els.compareStat = h('div', { class: 'hint compare-stat' }, '尚未保存基准快照');
  els.compareList = h('div', { class: 'compare-list' });
  return group('轨迹快照对比', [
    h('div', { class: 'hint' }, '保存基准快照后重新运行（换种子 / 参数 / 规则），即可对比两条轨迹的坐标差异：重合率高说明路径稳定，红色格是基准走过而本次没走的路径。'),
    row(
      button('保存基准快照', takeTrailSnapshot, 'primary'),
      button('清除快照', clearTrailSnapshot, 'ghost'),
    ),
    row(
      button('复制对比摘要', () => {
        if (!state.compareDiff) { toast('请先保存快照并运行一次', 'warn'); return; }
        copyText(compareToText(state.compareDiff), '对比摘要已复制');
      }),
      button('导出对比 CSV', () => {
        if (!state.compareDiff) { toast('请先保存快照并运行一次', 'warn'); return; }
        downloadText(`trail-compare-${state.result.seed}.csv`, compareToCSV(state.compareDiff), 'text/csv;charset=utf-8');
      }),
    ),
    els.compareStat,
    els.compareList,
  ], { key: 'trail-compare', open: false });
}

/** 保存基准快照：冻结当前轨迹模型的纯数据副本 */
function takeTrailSnapshot() {
  if (!state.result || !renderer || !renderer.trail) { toast('尚未运行模拟', 'warn'); return; }
  const grid = state.result.grid;
  const label = `${state.cfg.meta.name || '未命名'} · 种子 ${state.result.seed} · 第 ${renderer.trail.maxTick} 步`;
  state.trailSnapshot = snapshotTrail(renderer.trail, grid, label);
  refreshCompare();
  toast(`已保存基准快照（${state.trailSnapshot.cells.length} 格）`, 'success');
}

function clearTrailSnapshot() {
  state.trailSnapshot = null;
  state.compareDiff = null;
  if (renderer) renderer.setCompare(null);
  updateCompareStat();
  drawFrameOnly();
}

/**
 * 重算对比结果并交给渲染器叠加。
 * 网格类别 / 尺寸与快照不一致时对比无意义，直接关闭叠加层并给出提示。
 */
function refreshCompare() {
  if (!renderer) return;
  const grid = state.result && state.result.grid;
  const snap = state.trailSnapshot;
  if (!snap) {
    state.compareDiff = null;
    renderer.setCompare(null);
    updateCompareStat();
    return;
  }
  if (!grid || !snapshotMatchesGrid(snap, grid)) {
    state.compareDiff = null;
    renderer.setCompare(null);
    updateCompareStat('基准快照与当前网格不一致（需同为相同类型与尺寸），已暂停叠加对比');
    return;
  }
  const current = snapshotTrail(renderer.trail, grid, 'current');
  const diff = compareSnapshots(snap, current);
  diff.grid = grid; // 供 compareToCSV 把格下标还原成行列
  state.compareDiff = diff;
  renderer.setCompare({ snapshot: snap, diff });
  updateCompareStat();
}

/** 对比统计与逐格列表（列表与画面高亮同源，便于点选核对） */
function updateCompareStat(override) {
  const stat = els.compareStat;
  const list = els.compareList;
  if (!stat) return;
  if (list) clear(list);
  if (override) { stat.textContent = override; return; }
  const snap = state.trailSnapshot;
  const diff = state.compareDiff;
  if (!snap) { stat.textContent = '尚未保存基准快照'; return; }
  stat.textContent = `基准：${snap.label}`;
  if (!diff) return;
  if (list) {
    for (const line of compareToText(diff).split('\n').slice(1)) {
      list.appendChild(h('div', { class: 'compare-item' }, line));
    }
  }
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
  return group('配置诊断', body, { open: false, key: DIAG_GROUP_KEY, badge });
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
  syncControlBar();   // 载入模板 / 恢复配置后，控制条上的速度与「跟随移动体」同步为新配置
  renderConfigPanel();
  renderSidePanel();
  recompute({ immediate: true });
}

/** 把配置中的播放相关取值同步回控制条控件 */
function syncControlBar() {
  if (els.speedSlider) els.speedSlider.value = String(state.cfg.speed);
  if (els.speedNum) els.speedNum.value = String(state.cfg.speed);
  if (els.followInput) els.followInput.checked = !!state.cfg.style.followAgent;
  updateSpeedLabel();
}

/**
 * 配置面板四大类选项卡。
 * 原先十余个分组平铺在同一列里，界面很长、视觉负担重；
 * 这里按「核心规则 / 视觉显示 / 场景与运行 / 扩展机制」收敛为 4 个入口，
 * 分组本身与其中所有控件原样保留，只是换了归属，功能可访问性不变。
 *
 * 命名说明：
 *  - core（核心规则）：网格与移动体等基础规则；
 *  - scene（场景与运行）：场景元信息与运行语义——名称 / 描述、随机种子（复现）、规则执行方式；
 *  - extend（扩展机制）：核心规则之外的可选机制——多蛇与交互、蛇死亡转化、生命机制、元胞自动机。
 *    后两类此前分别叫「操作控制」「难度参数」，但配置面板中并不存在「操作控制」类选项，
 *    真正的「难度」是运行期的拥挤度难度评估（见 difficulty.js，读数在控制条与统计面板），
 *    与选项卡内容无关，旧命名会误导用户，故按实际内容重新命名。
 *    另：本产品定位为「网格移动动画模拟平台」，各选项卡名称一律不再使用「游戏」这类自称。
 */
const CONFIG_TABS = [
  { key: 'core', label: '核心规则', hint: '网格与坐标、起点与移动体、基础移动规则、碰撞与自撞、环境规则、结束规则' },
  { key: 'visual', label: '视觉显示', hint: '格子绘制、轨迹与蛇身样式、特效开关' },
  { key: 'scene', label: '场景与运行', hint: '场景名称与描述、随机种子、规则执行方式' },
  { key: 'extend', label: '扩展机制', hint: '多蛇与交互、蛇死亡转化、生命机制、元胞自动机' },
];

/** 当前面板的选项卡切换函数：供「查看结束规则」等外部入口跳到目标分类 */
let activateCfgTab = () => {};

function renderConfigPanel() {
  const root = els.config;
  clear(root);
  endConditionSyncers.clear(); // 重建面板前清空旧的联动回调，避免重复累积
  const cfg = state.cfg;
  const searchBar = configSearchBar();
  root.appendChild(searchBar);

  const tabs = h('div', { class: 'cfg-tabs' });
  const nav = h('div', { class: 'cfg-tab-nav', role: 'tablist' });
  const panels = new Map();
  const buttons = new Map();
  activateCfgTab = (key) => {
    const target = CONFIG_TABS.some((t) => t.key === key) ? key : CONFIG_TABS[0].key;
    state.cfgTab = target;
    for (const t of CONFIG_TABS) {
      buttons.get(t.key).classList.toggle('on', t.key === target);
      buttons.get(t.key).setAttribute('aria-selected', t.key === target ? 'true' : 'false');
      panels.get(t.key).classList.toggle('hidden', t.key !== target);
    }
  };
  for (const t of CONFIG_TABS) {
    const b = button(t.label, () => activateCfgTab(t.key), 'tab-btn');
    b.title = t.hint;
    b.setAttribute('role', 'tab');
    b.dataset.tabKey = t.key;
    buttons.set(t.key, b);
    nav.appendChild(b);
    const panel = h('div', { class: 'cfg-tab-panel', role: 'tabpanel', dataset: { tabKey: t.key, tabLabel: t.label } });
    panels.set(t.key, panel);
  }

  // 分组归类：所有原分组都在，只是归入四大类之一
  panels.get('core').append(
    gridGroup(cfg),        // 网格与坐标
    bodyGroup(cfg),        // 起点 · 移动体 · 长度策略
    moveRulesGroup(cfg),   // 基础权重 · 条件概率 · 安全避撞
    collisionGroup(cfg),   // 碰撞与自撞处理
    envRulesGroup(cfg),    // 环境规则
    endGroup(cfg),         // 结束规则（按优先级）
  );
  panels.get('extend').append(
    multiSnakeGroup(cfg),  // 多蛇生成与交互
    transformGroup(cfg),   // 蛇死亡转化
    lifeGroup(cfg),        // 生命机制（多生命系统）
    caGroup(cfg),          // 元胞自动机
  );
  panels.get('visual').append(styleGroup(cfg));
  panels.get('scene').append(sceneGroup(cfg));

  tabs.appendChild(nav);
  for (const t of CONFIG_TABS) tabs.appendChild(panels.get(t.key));
  root.appendChild(tabs);
  // 选项卡导航与搜索框同处一个吸顶容器：滚动面板时二者始终可见，无需额外偏移计算
  searchBar.appendChild(nav);
  activateCfgTab(state.cfgTab);
  // 面板重建后按当前关键词重新过滤，避免调整参数后搜索状态丢失
  applyConfigSearch(state.cfgSearch);
}

/** 恢复选项卡面板的显隐（仅显示当前选项卡；搜索时会改为同时显示全部分类） */
function resetCfgTabPanels() {
  const tabs = els.config && els.config.querySelector('.cfg-tabs');
  if (!tabs) return;
  for (const p of tabs.querySelectorAll('.cfg-tab-panel')) {
    p.classList.toggle('hidden', p.dataset.tabKey !== state.cfgTab);
  }
}

/** 跳到包含指定分组的选项卡并展开该分组（供「查看结束规则」等入口使用） */
function revealConfigGroup(groupKey) {
  const details = els.config && els.config.querySelector(`details[data-group-key="${groupKey}"]`);
  if (!details) return null;
  const panel = details.closest('.cfg-tab-panel');
  if (panel && panel.dataset.tabKey !== state.cfgTab) activateCfgTab(panel.dataset.tabKey);
  details.open = true;
  return details;
}

/* ---------------- 设置搜索 ---------------- */

/** 由搜索自动展开过的分组键：清除搜索时还原为展开前的状态 */
const cfgSearchOpened = new Set();

function configSearchBar() {
  const input = h('input', {
    type: 'text',
    class: 'input cfg-search-input',
    placeholder: '搜索设置项（如：边界 / 长度 / 颜色 / 概率）',
  });
  input.value = state.cfgSearch;
  input.addEventListener('input', () => {
    state.cfgSearch = input.value;
    applyConfigSearch(input.value);
  });
  els.cfgSearchHint = h('span', { class: 'mini-label' }, '');
  return h('div', { class: 'cfg-search' },
    input,
    button('清除', () => { state.cfgSearch = ''; input.value = ''; applyConfigSearch(''); }, 'ghost small'),
    els.cfgSearchHint);
}

/**
 * 按关键词过滤配置分组：
 * 命中（自身或其子分组文本包含关键词）的分组保留并自动展开，未命中的整组隐藏；
 * 关键词清空后恢复全部显示，并收起由搜索自动展开的分组。
 * 由于分组被归入四大类选项卡，搜索时会临时展开全部分类（命中项不会藏在别的选项卡里），
 * 并在选项卡按钮上标注哪些分类有命中。
 */
function applyConfigSearch(query) {
  const root = els.config;
  if (!root) return;
  const groups = [...root.querySelectorAll('details.group')];
  const q = String(query || '').trim().toLowerCase();
  const tabs = root.querySelector('.cfg-tabs');
  // 选项卡导航位于搜索框的吸顶容器内，因此从根节点取按钮
  const navBtns = [...root.querySelectorAll('.cfg-tab-nav .tab-btn')];
  if (!q) {
    if (tabs) tabs.classList.remove('searching');
    for (const b of navBtns) b.classList.remove('has-hits', 'no-hits');
    for (const g of groups) {
      g.classList.remove('hidden');
      if (cfgSearchOpened.has(g.dataset.groupKey)) g.open = false;
    }
    cfgSearchOpened.clear();
    if (els.cfgSearchHint) els.cfgSearchHint.textContent = '';
    resetCfgTabPanels();
    return;
  }
  // 搜索期间隐藏选项卡切换（全部分类同时可见），由分组级过滤决定显示内容
  if (tabs) tabs.classList.add('searching');
  let matched = 0;
  for (const g of groups) {
    const hit = String(g.textContent || '').toLowerCase().includes(q);
    g.classList.toggle('hidden', !hit);
    if (!hit) continue;
    matched++;
    if (!g.open) {
      g.open = true;
      cfgSearchOpened.add(g.dataset.groupKey);
    }
  }
  for (const b of navBtns) {
    const panel = tabs.querySelector(`.cfg-tab-panel[data-tab-key="${b.dataset.tabKey}"]`);
    const hits = panel ? [...panel.querySelectorAll('details.group')].filter((g) => !g.classList.contains('hidden')).length : 0;
    b.classList.toggle('has-hits', hits > 0);
    b.classList.toggle('no-hits', hits === 0);
  }
  if (els.cfgSearchHint) {
    els.cfgSearchHint.textContent = matched ? `${matched} 个分组匹配` : '未找到匹配设置';
  }
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
  ], { open: false });
}

function gridGroup(cfg) {
  const g = cfg.grid;
  // 格数提示随宽 / 高即时刷新：改宽高不会重建面板，静态文本会停留在旧值
  const gridSizeLabel = h('div', { class: 'hint' });
  const syncGridSize = () => { gridSizeLabel.textContent = `网格共 ${g.width * g.height} 格`; };
  syncGridSize();
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
      field('宽', numBind(g, 'width', () => { syncGridSize(); onSimChange(); }, { min: 2, max: 400 })),
      field('高', numBind(g, 'height', () => { syncGridSize(); onSimChange(); }, { min: 2, max: 400 })),
    ),
    field('边界行为', selBind(g, 'boundary', () => onSimChange(), [
      { value: 'stop', label: '停止（撞墙即停）' },
      { value: 'bounce', label: '反弹' },
      { value: 'wrap', label: '穿越到另一侧' },
      { value: 'randomTurn', label: '随机转向' },
      { value: 'custom', label: '自定义（由环境规则决定）' },
    ])),
    gridSizeLabel,
  ], { open: false });
}

function bodyGroup(cfg) {
  const b = cfg.body;
  const defaultSegmentSize = defaultConfig().body.segmentSize;
  const sizeInput = numBind(b, 'segmentSize', () => onStyleChange(), { min: 0.1, max: 1.6, step: 0.02 });
  const bodyStateLabel = h('span', { class: 'mini-label' });
  const syncBodyState = () => {
    bodyStateLabel.textContent = isBodyEnabled(cfg) ? '当前：蛇形实体已启用' : '当前：不生成蛇形实体';
  };
  syncBodyState();
  return group('移动体与身体', [
    row(
      field('起点 col/x', numBind(cfg.start, 'col', () => onSimChange(), { min: 0, max: cfg.grid.width - 1 })),
      field('起点 row/y', numBind(cfg.start, 'row', () => onSimChange(), { min: 0, max: cfg.grid.height - 1 })),
    ),
    field('起始方向', selBind(cfg.start, 'direction', () => onSimChange(), [
      ...dirNames(cfg.grid.type).map((n) => ({ value: n, label: DIR_LABELS[n] || n })),
      { value: 'random', label: '任意（每次运行随机）' },
    ]), '选择「任意」时由随机种子决定，同一种子结果可复现'),
    field('蛇形实体开关', row(
      chkBind(b, 'enabled', () => { syncBodyState(); onSimChange(0); }, '生成蛇形实体'),
      bodyStateLabel,
    )),
    row(
      field('初始长度', numBind(b, 'initialLength', () => { syncBodyState(); onSimChange(); }, { min: 0, max: 100000 })),
      field('体节尺寸', row(
        sizeInput,
        button('重置', () => {
          b.segmentSize = defaultSegmentSize;
          sizeInput.value = defaultSegmentSize;
          onStyleChange();
        }, 'ghost small'),
      )),
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
        '逗号分隔的十六进制颜色，从头到尾沿体节渐变')
      : null,
    skinSection(cfg),
    lengthSection(cfg),
  ], { open: false });
}

/* ---------------- 移动体与身体：自定义皮肤 ---------------- */

/** 皮肤图片的像素边长范围：过小放大后模糊，过大则拖慢每帧绘制与配置序列化 */
const SKIN_MIN_PIXELS = 16;
const SKIN_MAX_PIXELS = 2048;
/** 皮肤图片的文件体积上限 */
const SKIN_MAX_BYTES = 2 * 1024 * 1024;

/**
 * 自定义皮肤分组：蛇头 / 蛇身各一个本地上传控件。
 * 上传后写入 cfg.body.skin（dataURL），由渲染器贴到对应体节上。
 */
function skinSection(cfg) {
  const hint = h('div', { class: 'hint' },
    `支持 JPG / PNG / WebP，建议使用正方形图片；边长 ${SKIN_MIN_PIXELS}~${SKIN_MAX_PIXELS} 像素、单张不超过 2 MB。`
    + '皮肤会随「导出 JSON」一并保存，但不会写入分享链接（图片体积会超出链接长度上限）。');
  return group('自定义皮肤（上传图片）', [
    skinField(cfg, 'head', '蛇头皮肤'),
    skinField(cfg, 'body', '蛇身皮肤'),
    hint,
  ], { key: 'body-skin', open: false });
}

/**
 * 单个部位的上传控件：预览 + 选择 + 清除。
 * 选择文件后先校验格式 / 体积 / 尺寸，任一环节失败都保持原皮肤不变并提示原因。
 */
function skinField(cfg, key, label) {
  const skin = cfg.body.skin;
  const input = h('input', {
    type: 'file',
    class: 'skin-file',
    accept: SKIN_MIME_TYPES.join(','),
  });
  const preview = h('div', { class: 'skin-preview' });
  const paint = () => {
    clear(preview);
    if (skin[key]) {
      preview.classList.add('has-image');
      preview.appendChild(h('img', { src: skin[key], alt: label }));
    } else {
      preview.classList.remove('has-image');
      preview.appendChild(h('span', { class: 'skin-empty' }, '未设置'));
    }
  };
  paint();

  input.addEventListener('change', () => {
    const file = input.files && input.files[0];
    input.value = ''; // 复位以便再次选择同一个文件
    if (!file) return;
    readSkinFile(file)
      .then((dataUrl) => {
        skin[key] = dataUrl;
        paint();
        onStyleChange();
        toast(`${label}已更新`, 'info');
      })
      .catch((err) => toast(`${label}载入失败：${err.message}`, 'error'));
  });

  return field(label, h('div', { class: 'skin-row' },
    preview,
    h('div', { class: 'skin-col' },
      row(
        button('选择图片', () => input.click(), 'ghost small'),
        button('清除', () => {
          if (!skin[key]) return;
          skin[key] = '';
          paint();
          onStyleChange();
          toast(`已清除${label}`, 'info');
        }, 'ghost small'),
      ),
      input,
    ),
  ));
}

/**
 * 读取并校验皮肤图片，成功时返回可用于渲染与持久化的 dataURL。
 * 校验顺序：格式（JPG / PNG / WebP）→ 体积 → 可解码 → 像素尺寸，
 * 便于一失败就给出最直接的提示，而不是等到渲染阶段才发现问题。
 */
function readSkinFile(file) {
  return new Promise((resolve, reject) => {
    if (!SKIN_MIME_TYPES.includes(file.type)) {
      reject(new Error('仅支持 JPG / PNG / WebP 格式'));
      return;
    }
    if (file.size > SKIN_MAX_BYTES) {
      reject(new Error(`文件过大（${(file.size / 1024 / 1024).toFixed(1)} MB，上限 2 MB）`));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      const img = new Image();
      img.onerror = () => reject(new Error('图片解析失败或文件已损坏'));
      img.onload = () => {
        const { width, height } = img;
        if (width < SKIN_MIN_PIXELS || height < SKIN_MIN_PIXELS) {
          reject(new Error(`图片过小（${width}×${height}，至少 ${SKIN_MIN_PIXELS}×${SKIN_MIN_PIXELS}）`));
          return;
        }
        if (width > SKIN_MAX_PIXELS || height > SKIN_MAX_PIXELS) {
          reject(new Error(`图片过大（${width}×${height}，最多 ${SKIN_MAX_PIXELS}×${SKIN_MAX_PIXELS}）`));
          return;
        }
        resolve(dataUrl);
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  });
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

/* ---------------- 移动规则：基础权重 · 条件概率 · 安全避撞 ---------------- */

function moveRulesGroup(cfg) {
  const m = cfg.moveRules;
  const weightHint = h('div', { class: 'hint' }, weightSummary(m));
  const upd = () => { onSimChange(); weightHint.textContent = weightSummary(m); };

  const list = h('div', { class: 'rule-list' });
  cfg.advancedRules.forEach((r, index) => {
    const hint = h('div', { class: 'hint' }, weightSummary(r.moves));
    const updWeights = () => { onSimChange(); hint.textContent = weightSummary(r.moves); };
    const body = [
      row(
        textBind(r, 'name', () => {}),
        chkBind(r, 'enabled', () => onSimChange(), '启用'),
        orderActions(
          button('↑', () => { swap(cfg.advancedRules, index, index - 1); rebuildAll(); }, 'icon small'),
          button('↓', () => { swap(cfg.advancedRules, index, index + 1); rebuildAll(); }, 'icon small'),
          button('✕', () => { cfg.advancedRules.splice(index, 1); rebuildAll(); }, 'icon small danger'),
        ),
      ),
      field('条件', conditionEditor(r.condition, () => onSimChange(), () => rebuildAll()), '条件满足时使用下面的权重'),
      field('左转权重', rangeBind(r.moves, 'left', updWeights, { min: 0, max: 1, step: 0.01, number: true })),
      field('直行权重', rangeBind(r.moves, 'straight', updWeights, { min: 0, max: 1, step: 0.01, number: true })),
      field('右转权重', rangeBind(r.moves, 'right', updWeights, { min: 0, max: 1, step: 0.01, number: true })),
      hint,
      field('优先级', numBind(r, 'priority', () => onSimChange(), { step: 1 }), '数值越大越优先匹配'),
    ];
    list.appendChild(group(r.name || '条件概率规则', body, { open: false, badge: r.enabled ? '' : '停用', key: `adv:${r.id}` }));
  });

  return group('移动规则', [
    h('div', { class: 'sub-title' }, '基础权重'),
    field('左转权重', rangeBind(m, 'left', upd, { min: 0, max: 1, step: 0.01, number: true })),
    field('直行权重', rangeBind(m, 'straight', upd, { min: 0, max: 1, step: 0.01, number: true })),
    field('右转权重', rangeBind(m, 'right', upd, { min: 0, max: 1, step: 0.01, number: true })),
    weightHint,
    h('div', { class: 'sub-title' }, '条件概率规则（按优先级匹配，命中后改用其权重）'),
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
    safetySection(cfg),
  ], { open: false });
}

/* ---------------- 安全避撞预设（方向选择的条件概率增强） ---------------- */

function safetySection(cfg) {
  const s = cfg.safety;
  const note = h('div', { class: 'hint' });
  const syncNote = () => {
    note.textContent = (s.avoidBody || s.avoidObstacle || s.avoidOtherAgents)
      ? '已启用：方向选择前先剔除被阻塞的候选方向，全部可行方向都被阻塞时才回落到原始权重。'
      : '未启用：方向选择完全按基础 / 条件概率权重进行。';
  };
  syncNote();
  const bind = (key, label) => chkBind(s, key, () => { syncNote(); onSimChange(); }, label);
  return group('安全避撞预设（方向选择）', [
    field('规避对象', h('div', { class: 'chips-line' },
      bind('avoidBody', '自身身体'),
      bind('avoidObstacle', '障碍物'),
      bind('avoidOtherAgents', '其它移动体')),
      '规避是「择优」而非「禁止」：仍有可行方向时按权重择优，从而降低自撞概率'),
    note,
    field('碰撞预警提示', h('div', { class: 'chips-line' },
      chkBind(s, 'warnSelfCollision', () => onSimChange(), '标记「下一步会撞到自身身体」的危险格')),
      '开启后每步检查各可行朝向，把会导致自撞的落点标为警示色；长蛇场景会带来少量额外开销，默认关闭'),
  ], { open: false, badge: (s.avoidBody || s.avoidObstacle || s.avoidOtherAgents) ? '已启用' : '' });
}

/* ---------------- 多蛇生成与交互 ---------------- */

function multiSnakeGroup(cfg) {
  const m = cfg.multiSnake;
  const sp = m.spawn;
  const it = m.interaction;
  const paletteInput = () => textInput((it.colorPalette || []).join(', '), (v) => {
    const list = parseColorList(v);
    if (list.length) {
      it.colorPalette = list;
      onSimChange();
    } else {
      toast('请至少填写一个合法的十六进制颜色，如 #ff5d5d', 'warn');
    }
  }, { placeholder: '#ff5d5d, #ffd166, #51cf66' });

  const bodies = [
    field('启用多蛇系统', chkBind(m, 'enabled', () => { onSimChange(0); rebuildAll(); }, '启用'),
      '主移动体终止时整场结束，其它蛇终止只计入「移动体消失」'),
    row(
      field('生成方式', selBind(sp, 'mode', () => { onSimChange(); rebuildAll(); }, Object.entries(SPAWN_LABELS).map(([value, label]) => ({ value, label })))),
      field('最大同时存在', numBind(sp, 'maxAgents', () => onSimChange(), { min: 1, max: 64 })),
    ),
  ];

  if (sp.mode === 'time') {
    bodies.push(field('预定时间点（步）', textInput(sp.times.join(', '), (v) => {
      const list = String(v).split(/[\s,，;；]+/).map((x) => Math.round(Number(x))).filter((x) => Number.isFinite(x) && x > 0);
      sp.times = list;
      onSimChange();
    }, { placeholder: '20, 60, 120' }), '逗号分隔的步数；到达该步时生成一条新蛇'));
  } else if (sp.mode === 'interval') {
    bodies.push(row(
      field('最小间隔（步）', numBind(sp, 'minInterval', () => onSimChange(), { min: 1 })),
      field('最大间隔（步）', numBind(sp, 'maxInterval', () => onSimChange(), { min: 1 })),
    ), h('div', { class: 'hint' }, '每次生成后，在 [最小, 最大] 区间内随机抽取下一次生成间隔（由随机种子决定，可复现）'));
  } else {
    bodies.push(field('触发事件', h('div', { class: 'chips-line' },
      ...SPAWN_EVENTS.map((ev) => checkbox(sp.events.includes(ev), (on) => {
        const i = sp.events.indexOf(ev);
        if (on && i < 0) sp.events.push(ev);
        else if (!on && i >= 0) sp.events.splice(i, 1);
        onSimChange();
      }, SPAWN_EVENT_LABELS[ev] || ev))), '事件发生的当步生成一条新蛇'));
  }

  bodies.push(
    row(
      field('新蛇长度', numBind(sp, 'length', () => onSimChange(), { min: 1, max: 200 })),
      field('新蛇方向', select(sp.direction, [{ value: 'random', label: '随机' }, ...dirNames(cfg.grid.type).map((n) => ({ value: n, label: DIR_LABELS[n] || n }))], (v) => { sp.direction = v; onSimChange(); })),
      field('生成概率', rangeBind(sp, 'probability', () => onSimChange(), { min: 0, max: 1, step: 0.01 })),
    ),
    field('交互结果', selBind(it, 'mode', () => { onSimChange(); rebuildAll(); }, Object.entries(INTERACTION_LABELS).map(([value, label]) => ({ value, label })))),
    field('逐个体配色', paletteInput(), '逗号分隔的颜色序列，按生成顺序循环取色，便于在画面上区分不同的蛇'),
  );

  if (it.mode === 'repel') {
    bodies.push(h('div', { class: 'hint' }, '排斥：两蛇相遇时回退到上一步并计为一次排斥。'));
  } else if (it.mode === 'merge') {
    bodies.push(h('div', { class: 'hint' }, '融合：较短的蛇并入较长的一条，长度叠加。'));
  } else if (it.mode === 'collide') {
    bodies.push(h('div', { class: 'hint' }, '碰撞：两蛇头对头相遇时双方消失；涉及主移动体则整场结束。'));
  }

  return group('多蛇生成与交互系统', bodies, { open: false, badge: m.enabled ? '已启用' : '' });
}

/* ---------------- 碰撞与边界 ---------------- */

function collisionGroup(cfg) {
  const c = cfg.collision;
  const sp = cfg.selfCollisionPolicy;
  // 「连续自撞上限」只在「结束规则 → 撞到自身」勾选时才参与结束判定，
  // 因此这里跟随该结束规则的可编辑状态联动置灰。
  // 另外，「自撞即判定死亡」开启时该结束规则被互斥禁用，本项同样失效。
  const maxConsecutiveInput = numBind(sp, 'maxConsecutive', () => onSimChange(), { min: 1, max: 100000 });
  const syncMaxConsecutive = (on) => {
    maxConsecutiveInput.disabled = !on;
    maxConsecutiveInput.title = on ? '' : '需先勾选「结束规则 → 撞到自身」，该项才会生效';
  };
  bindEndConditionSync('selfCollision', syncMaxConsecutive);
  syncMaxConsecutive(!!cfg.endConditions.selfCollision && !(cfg.transform.enabled && cfg.transform.dieOnSelfCollision));
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

/* ---------------- 长度策略（并入「移动体与身体」） ---------------- */

function lengthSection(cfg) {
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
    field('模式', selBind(lp, 'mode', () => {
      onSimChange();
      // 切回「固定」而交互仍在生效时，立即醒目提示「蛇长度可变」未启用
      const warn = markerLengthWarning();
      if (warn) toast(warn, 'warn');
    }, [
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
        orderActions(
          button('↑', () => { swap(cfg.environmentRules, index, index - 1); rebuildAll(); }, 'icon small'),
          button('↓', () => { swap(cfg.environmentRules, index, index + 1); rebuildAll(); }, 'icon small'),
          button('✕', () => { cfg.environmentRules.splice(index, 1); rebuildAll(); }, 'icon small danger'),
        ),
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
    h('div', { class: 'hint' }, '蛇头 / 蛇身 / 二者满足周围环境条件时，触发对应后果动作。'),
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
  ], { open: false });
}

function actionEditor(rule, action, index) {
  const controls = [];
  const rebuild = () => rebuildAll();
  controls.push(row(
    select(action.type, Object.entries(ACTION_LABELS).map(([value, label]) => ({ value, label })), (v) => {
      Object.assign(action, defaultAction(v));
      rebuild();
    }),
    orderActions(
      button('↑', () => { swap(rule.actions, index, index - 1); rebuild(); }, 'icon small'),
      button('↓', () => { swap(rule.actions, index, index + 1); rebuild(); }, 'icon small'),
      button('✕', () => { rule.actions.splice(index, 1); rebuild(); }, 'icon small danger'),
    ),
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
    case 'removeAgent':
      controls.push(field('移除哪一条', selBind(action, 'target', () => onSimChange(), [
        { value: 'nearest', label: '距离最近的其它移动体' },
        { value: 'random', label: '随机一条' },
        { value: 'largest', label: '最长的一条' },
        { value: 'oldest', label: '最早生成的一条' },
      ]), '主移动体不会被移除'));
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
    orderActions(
      button('↑', () => { swap(parent.clauses, index, index - 1); rebuild(); }, 'icon small'),
      button('↓', () => { swap(parent.clauses, index, index + 1); rebuild(); }, 'icon small'),
      button('✕', () => { parent.clauses.splice(index, 1); rebuild(); }, 'icon small danger'),
    ),
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
    case 'agentCount':
      box.appendChild(row(
        field('比较', selBind(clause, 'comparator', () => onChange(), COMPARATORS)),
        field('存活移动体数', numBind(clause, 'value', () => onChange(), { min: 0, max: 1000 })),
      ), h('div', { class: 'hint' }, '统计当前所有存活的移动体（含主移动体与生成出来的新蛇）'));
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
  // 下拉项显示「中文名（内部键名）」：界面术语中文化的同时保留内部键名，便于与配置 / 分享链接对照
  return state.cfg.caMode.states.map((s) => ({ value: s.name, label: stateLabelWithKey(s.name) }));
}

/* ---------------- 元胞自动机 ---------------- */

function caGroup(cfg) {
  const ca = cfg.caMode;
  const body = [
    field('启用元胞自动机', chkBind(ca, 'enabled', () => { onSimChange(0); rebuildAll(); }, '启用')),
    h('div', { class: 'hint' }, '环境单元按状态转移规则演化，可与移动体 / 环境规则同时生效（混合模式）。'),
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
    field('稳定即收尾', row(
      chkBind(ca, 'stopOnStable', () => { onSimChange(); rebuildAll(); }, 'CA 进入稳定态时结束运行'),
      field('连续稳定步数', numBind(ca, 'stableSteps', () => onSimChange(), { min: 1, max: 1000 })),
    ), '连续若干次演化中所有单元都没有变化时结束运行（纯 CA 场景常用）；勾选后会同步打开「结束规则 → 元胞自动机稳定」'),
    field('标记物交互机制', markerInteractionEditor(ca),
      '把指定的元胞状态定义为「交互标记物」：蛇头进入该格时按反馈规则表产生长度 / 颜色变化，可设置消耗该标记物'),
    field('状态转移规则表', caRulesEditor(ca)),
    field('快捷模板', row(
      button('生命游戏（无干涉）', () => applyCaTemplate(cfg, 'life'), 'ghost small'),
      button('生命游戏（交互）', () => applyCaTemplate(cfg, 'lifeInteractive'), 'ghost small'),
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
      h('span', { class: 'mini-label', title: `内部键名：${s.name}` }, stateLabel(s.name)),
      h('input', {
        class: 'input tiny',
        value: s.name,
        title: '内部键名（规则条件、分享链接中引用此名称，修改后原规则可能失效）',
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

/**
 * 「蛇长度可变」状态校验。
 * 标记物 / 生命游戏交互已启用、但「长度策略」仍是「固定」时，
 * 反馈规则里的长度增减不会生效——返回醒目提示文案，无需提示时返回 null。
 */
function markerLengthWarning() {
  const cfg = state.cfg;
  const mi = cfg.caMode.markerInteraction;
  if (!mi.enabled || cfg.body.lengthPolicy.mode !== 'fixed') return null;
  const changesLength = mi.effects.some((e) => e.enabled && (e.mode === 'set' || Math.abs(Number(e.value) || 0) > 0));
  if (!changesLength) return null;
  return '⚠ 未启用「蛇长度可变」：当前「长度策略」为「固定」，长度恒等于初始长度，交互吞噬 / 触碰带来的长度变化不会生效。请把「长度策略」改为「可变」。';
}

/**
 * 标记物交互编辑器：将指定元胞状态定义为交互标记物，并配置「触碰反馈规则表」。
 * 每条反馈可独立设置作用状态、变化方式（增减 / 百分比 / 直接设定）、概率、是否消耗标记物与变色。
 */
function markerInteractionEditor(ca) {
  const mi = ca.markerInteraction;
  const wrap = h('div', { class: 'rule-list' });
  wrap.appendChild(field('启用标记物交互', chkBind(mi, 'enabled', () => { onSimChange(); rebuildAll(); }, '启用')));
  if (markerLengthWarning()) {
    wrap.appendChild(h('div', { class: 'alert warn' },
      h('span', { class: 'alert-icon' }, '⚠'),
      h('div', { class: 'alert-text' },
        h('strong', {}, '未启用「蛇长度可变」'),
        h('div', {}, '当前「长度策略」为「固定」，长度恒等于初始长度，反馈规则里的长度增减不会生效（变色与消耗仍然生效）。'),
      ),
      button('改为可变长度', () => {
        state.cfg.body.lengthPolicy.mode = 'variable';
        onSimChange();
        rebuildAll();
        toast('已把「长度策略」改为「可变」，长度变化即刻生效', 'success');
      }, 'primary small'),
    ));
  }
  wrap.appendChild(field('交互标记物状态', h('div', { class: 'chips' },
    ...ca.states.map((s) => {
      const on = mi.states.includes(s.name);
      return h('button', {
        type: 'button',
        class: `chip${on ? ' on' : ''}`,
        title: `内部键名：${s.name}`,
        onclick: () => {
          const i = mi.states.indexOf(s.name);
          if (i >= 0) mi.states.splice(i, 1);
          else mi.states.push(s.name);
          onSimChange();
          rebuildAll();
        },
      }, stateLabelWithKey(s.name));
    })), '可多选；被选中的状态一旦与蛇头重合即触发下面的反馈规则'));

  const list = h('div', { class: 'rule-list' });
  mi.effects.forEach((fx, i) => {
    const body = [
      row(
        textBind(fx, 'name', () => {}),
        chkBind(fx, 'enabled', () => onSimChange(), '启用'),
        orderActions(
          button('↑', () => { swap(mi.effects, i, i - 1); rebuildAll(); }, 'icon small'),
          button('↓', () => { swap(mi.effects, i, i + 1); rebuildAll(); }, 'icon small'),
          button('✕', () => { mi.effects.splice(i, 1); rebuildAll(); }, 'icon small danger'),
        ),
      ),
      row(
        field('作用状态', select(fx.state, stateOptions(), (v) => { fx.state = v; onSimChange(); })),
        field('变化方式', selBind(fx, 'mode', () => { onSimChange(); rebuildAll(); }, [
          { value: 'delta', label: '增减固定长度' },
          { value: 'percent', label: '按当前长度百分比' },
          { value: 'set', label: '直接设定长度' },
        ])),
        field(fx.mode === 'percent' ? '百分比（% ，负数为缩短）' : fx.mode === 'set' ? '目标长度' : '变化量（负数为缩短）',
          numBind(fx, 'value', () => onSimChange(), fx.mode === 'set' ? { min: 1, max: 100000 } : { min: -1000, max: 1000 })),
      ),
      row(
        field('触发概率', rangeBind(fx, 'probability', () => onSimChange(), { min: 0, max: 1, step: 0.01 })),
        field('消耗标记物', row(
          chkBind(fx, 'consume', () => onSimChange(), '消耗'),
          select(fx.consumeTo, stateOptions(), (v) => { fx.consumeTo = v; onSimChange(); }),
        ), '消耗后该格变为右侧状态'),
        field('反馈变色', row(
          colorInput(fx.color || '#51cf66', (v) => { fx.color = v; onSimChange(); }),
          button('清除', () => { fx.color = ''; rebuildAll(); }, 'ghost small'),
        ), '留空表示不变色'),
      ),
    ];
    list.appendChild(group(fx.name || `反馈 ${i + 1}`, body, { open: false, badge: fx.enabled ? '' : '停用', key: `fx:${fx.id}` }));
  });

  wrap.appendChild(list);
  wrap.appendChild(button('+ 添加反馈规则', () => {
    mi.effects.push({
      id: `fx_${Math.random().toString(36).slice(2, 8)}`,
      name: `反馈 ${mi.effects.length + 1}`,
      enabled: true,
      state: mi.states[0] || 'marker',
      mode: 'delta',
      value: 1,
      probability: 1,
      consume: true,
      consumeTo: 'empty',
      color: '',
    });
    rebuildAll();
  }, 'ghost small'));
  return wrap;
}

function caRulesEditor(ca) {
  const list = h('div', { class: 'rule-list' });
  ca.rules.forEach((rule, i) => {
    const rows = [
      row(
        textBind(rule, 'name', () => {}),
        chkBind(rule, 'enabled', () => onSimChange(), '启用'),
        select(rule.kind, [{ value: 'count', label: '计数规则' }, { value: 'traffic', label: '方向移动' }], (v) => { rule.kind = v; rebuildAll(); }),
        orderActions(
          button('↑', () => { swap(ca.rules, i, i - 1); rebuildAll(); }, 'icon small'),
          button('↓', () => { swap(ca.rules, i, i + 1); rebuildAll(); }, 'icon small'),
          button('✕', () => { ca.rules.splice(i, 1); rebuildAll(); }, 'icon small danger'),
        ),
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
          title: `内部键名：${s.name}`,
          onclick: () => {
            const cur = rule.from === '*' ? [] : [...rule.from];
            const k = cur.indexOf(s.name);
            if (k >= 0) cur.splice(k, 1);
            else cur.push(s.name);
            rule.from = cur.length ? cur : '*';
            rebuildAll();
          },
        }, stateLabelWithKey(s.name));
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

/** CA 快捷模板 → 预设 id 的映射：应用后同步场景名，使「预设模板」下拉正确回显 */
const CA_TEMPLATE_PRESET_IDS = {
  life: 'life',
  lifeInteractive: 'life-interactive',
  hexCa: 'hex-ca',
  forest: 'forest-fire',
  traffic: 'traffic',
};

function applyCaTemplate(cfg, kind) {
  pushConfigHistory('应用 CA 快捷模板');
  const ca = cfg.caMode;
  ca.enabled = true;
  ca.radius = 1;
  if (kind === 'life' || kind === 'lifeInteractive') {
    const interactive = kind === 'lifeInteractive';
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
      markerInteraction: interactive
        ? {
          enabled: true,
          states: ['alive'],
          effects: [{
            id: 'fx_swallow', name: '吞噬活细胞', enabled: true, state: 'alive',
            mode: 'delta', value: 1, probability: 1, consume: true, consumeTo: 'empty', color: '#51cf66',
          }],
        }
        : { enabled: false, states: ['alive'], effects: [] },
    });
    if (interactive) {
      // 交互版：吞噬活细胞才会增长，必须先启用「蛇长度可变」
      cfg.body.lengthPolicy.mode = 'variable';
    }
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
  // 与「预设模板」下拉保持一致：快捷模板对应的预设存在时同步场景名，
  // 避免应用后面板仍显示上一个预设（如「随机游走」）造成误解。
  const preset = PRESETS.find((p) => p.id === CA_TEMPLATE_PRESET_IDS[kind]);
  if (preset) cfg.meta.name = preset.name;
  rebuildAll();
  // 快捷模板同样视作一次基准变更：之后的用户改动都以这里的配置为基准比对
  rememberConfigBaseline(state.cfg);
  toast(kind === 'lifeInteractive' ? '已应用「生命游戏（交互版）」模板：吞噬活细胞即增长' : '已应用元胞自动机模板', 'success');
  // 状态校验：交互版依赖「蛇长度可变」，未启用时立刻醒目提示
  const warn = markerLengthWarning();
  if (warn) toast(warn, 'warn');
}

/* ---------------- 蛇死亡转化（概率参数可视化调节） ---------------- */

/**
 * 蛇死亡转化面板：两个概率参数用「滑杆 + 数值框」双向绑定，拖动即重算，
 * 并实时给出「期望并入环境的节点数」读数与一次蒙特卡洛抽样试算，
 * 让 0~1 的概率取值不再是抽象数字。
 */
function transformGroup(cfg) {
  const t = cfg.transform;
  const pct = (v) => `${(Math.round(Number(v) * 1000) / 10).toFixed(1)}%`;
  const nodeCount = () => Math.max(1, Math.round(Number(cfg.body.initialLength) || 1));
  const estimate = h('span', { class: 'mini-label' }, '');
  const syncEstimate = () => {
    const segs = nodeCount();
    const expected = t.globalProbability * t.segmentProbability * segs;
    estimate.textContent = `按初始长度 ${segs} 节估算：平均约 ${expected.toFixed(2)} 节并入环境；未命中全局概率时蛇只消失、环境不变。`;
  };
  syncEstimate();
  // 自撞规则互斥绑定：本组的两项开关共同决定「结束规则 → 撞到自身」的锁定态，
  // 而锁定态是派生值、只在面板重建时重新计算，因此改动后整体重建面板以同步禁用状态。
  const syncSelfCollisionLock = () => rebuildAll();
  const onProbChange = () => { syncEstimate(); onSimChange(); };

  /** 蒙特卡洛试算：用与模拟层相同的判定顺序（先全局、再逐节）抽样，读出实际触发率与转化节数 */
  const runSample = () => {
    const rng = new RNG(cfg.seed || 1);
    const segs = nodeCount();
    const rounds = 2000;
    let triggers = 0;
    let cells = 0;
    for (let i = 0; i < rounds; i++) {
      if (rng.next() >= t.globalProbability) continue;
      triggers++;
      for (let s = 0; s < segs; s++) if (rng.next() < t.segmentProbability) cells++;
    }
    const avg = triggers ? cells / triggers : 0;
    toast(`试算 ${rounds} 次：转化触发 ${triggers} 次（${pct(triggers / rounds)}），触发时平均转化 ${avg.toFixed(2)} 节`, 'info');
  };

  const stateSelect = selBind(t, 'state', () => { onSimChange(); }, cfg.caMode.states
    .filter((s) => s.name !== 'empty')
    .map((s) => ({ value: s.name, label: stateLabelWithKey(s.name) })));

  return group('蛇死亡转化', [
    field('启用', h('div', { class: 'chips-line' },
      chkBind(t, 'enabled', () => syncSelfCollisionLock(), '自撞致死后按概率并入环境')),
      '关闭时自撞完全沿用「碰撞与自撞处理 → 自撞处理」的原有策略'),
    field('自撞即判定死亡', chkBind(t, 'dieOnSelfCollision', () => syncSelfCollisionLock(), '自撞即判定死亡（不结束运行）'),
      '开启后「结束规则 → 撞到自身」会被自动禁用且不可手动修改（互斥绑定），关闭本项即恢复编辑'),
    field('全局触发概率', rangeBind(t, 'globalProbability', onProbChange, { min: 0, max: 1, step: 0.01, number: true }),
      '蛇死亡后是否启动转化流程的总概率'),
    field('分段转化概率', rangeBind(t, 'segmentProbability', onProbChange, { min: 0, max: 1, step: 0.01, number: true }),
      '每个身体节点独立转化为环境状态的概率'),
    field('转化目标状态', stateSelect,
      '转化后的节点写入该环境状态并参与元胞自动机演化；选择阻挡类状态时还会成为蛇的障碍'),
    field('期望试算', h('div', { class: 'row' },
      button('抽样试算', runSample, 'ghost small'), estimate)),
    h('div', { class: 'hint' }, '自撞死亡只让该移动体从场上消失，主循环与元胞自动机继续运行；身体节点在几步内以过渡动画连续并入环境。'),
  ], { open: false, badge: t.enabled ? '已启用' : '' });
}

/* ---------------- 生命机制（多生命系统） ---------------- */

function lifeGroup(cfg) {
  const life = cfg.life;
  /** 由元胞自动机状态集合生成「多选格子状态」控件：勾选即写入对应状态名数组 */
  const statePicker = (arr) => {
    const wrap = h('div', { class: 'chips-line' });
    const options = cfg.caMode.states.filter((s) => s.name !== 'empty');
    if (!options.length) return h('div', { class: 'hint' }, '当前状态集合中暂无可选状态');
    for (const s of options) {
      wrap.appendChild(checkbox(arr.includes(s.name), (v) => {
        const i = arr.indexOf(s.name);
        if (v && i < 0) arr.push(s.name);
        else if (!v && i >= 0) arr.splice(i, 1);
        onSimChange();
      }, stateLabelWithKey(s.name)));
    }
    return wrap;
  };
  return group('生命机制（多生命）', [
    field('启用', h('div', { class: 'chips-line' },
      chkBind(life, 'enabled', () => rebuildAll(), '启用多生命系统')),
      '关闭时沿用「单条命」的原有行为：致命判定立即结束（或按「蛇死亡转化」处理）。启用后生命耗尽才触发最终死亡'),
    field('初始生命', rangeBind(life, 'initialLives', () => rebuildAll(), {
      min: LIFE_MIN, max: LIFE_MAX, step: 1, number: true,
    }), `取值区间 ${LIFE_MIN} ~ ${LIFE_MAX}：单条生命耗尽时保留蛇头位置与得分，仅重置蛇身长度并播放重生动画`),
    field('死亡后仍可移动', chkBind(life, 'keepMovingAfterDeath', () => rebuildAll(), '死亡后仍可移动'),
      '默认关闭（推荐）：致命判定后立即停止移动并移除蛇头与蛇身。开启后死亡的蛇会以「僵尸态」保留在场上继续移动，仅用于观察'),
    field('低生命预警阈值', rangeBind(life, 'warnThreshold', () => onSimChange(), {
      min: 0, max: LIFE_MAX, step: 1, number: true,
    }), '剩余生命降至该数值时给出高亮与提示；设为 0 表示不预警'),
    h('div', { class: 'sub-title' }, '重生参数'),
    row(
      field('重生长度', numBind(life.respawn, 'length', () => onSimChange(), { min: 1, max: 100000 })),
      field('重生无敌步数', numBind(life.respawn, 'invincibleTicks', () => onSimChange(), { min: 0, max: 100000 })),
    ),
    field('增加生命的格子', statePicker(life.items.gainStates),
      '蛇头踏入这些状态时获得生命（上限 9）；未启用本机制时这些状态不产生效果'),
    row(
      field('每次增加', numBind(life.items, 'gainAmount', () => onSimChange(), { min: 0, max: LIFE_MAX })),
      field('拾取后清除该格', chkBind(life.items, 'consumeGain', () => onSimChange(), '吃掉后变空')),
    ),
    field('扣除生命的格子', statePicker(life.items.lossStates),
      '蛇头踏入这些状态时扣除生命（非致命）；扣到 0 条才触发最终死亡'),
    field('每次扣除', numBind(life.items, 'lossAmount', () => onSimChange(), { min: 1, max: LIFE_MAX })),
    h('div', { class: 'hint' }, '增减生命的状态取自「元胞自动机 → 状态集合」；未配置任何增减来源时，生命只会在致命判定时递减。'),
  ], { open: false, badge: life.enabled ? `初始 ${life.initialLives} 条` : '' });
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
    // 互斥绑定（派生值）：开启「蛇死亡转化 → 自撞即判定死亡」时，「撞到自身」被自动禁用且不可手动修改。
    // 这里不改写 ec.selfCollision 的原始值，关闭前者后该规则会原样恢复。
    const locked = code === 'selfCollision' && !!(cfg.transform.enabled && cfg.transform.dieOnSelfCollision);
    const cbLabel = (END_LABELS[code] || code) + (locked ? '（已因「自撞即判定死亡」互斥禁用）' : '');
    const cb = checkbox(locked ? false : isOn, (v) => {
      if (numericKeys.includes('maxSteps')) ec.maxSteps = v ? endParamMemory.maxSteps : false;
      else ec[code] = v;
      syncDisabled.forEach((fn) => fn(v));
      notifyEndConditionSync(code, v);
      onSimChange();
    }, cbLabel);
    if (locked) {
      const input = cb.querySelector('input');
      if (input) input.disabled = true;
      cb.title = '已开启「蛇死亡转化 → 自撞即判定死亡」：自撞只会让该移动体消失（或按生命机制扣命重生），不会触发本规则；关闭前者即可恢复编辑';
    }
    const rowOn = locked ? false : isOn;
    const rowChildren = [
      h('span', { class: 'priority-no' }, `${i + 1}`),
      cb,
      ...paramFields,
      orderActions(
        button('↑', () => { swap(ec.priority, i, i - 1); rebuildAll(); }, 'icon small'),
        button('↓', () => { swap(ec.priority, i, i + 1); rebuildAll(); }, 'icon small'),
      ),
    ];
    rows.push(h('div', {
      class: `end-row${rowOn ? ' on' : ''}${locked ? ' locked' : ''}`,
      'data-end-code': code,
    }, rowChildren));
  });
  return group('结束规则（按优先级）', [
    h('div', { class: 'hint' }, '自上而下依次判断，命中第一条满足条件的规则即结束运行；可用 ↑ ↓ 调整优先级。取消勾选「达到步数上限」后不再限制步数（仅受安全帧上限保护，可在控制条继续运行）。'),
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
    )),
    field('连接方式', row(
      h('span', { class: 'mini-label' }, '轨迹'),
      selBind(s, 'trailJoin', () => onStyleChange(), JOIN_OPTIONS),
      h('span', { class: 'mini-label' }, '蛇身'),
      selBind(s, 'bodyJoin', () => onStyleChange(), JOIN_OPTIONS),
    ), '曲线：贝塞尔平滑 · 直线：直线段折线 · 预设角度：按指定夹角切角连接的直线型折线'),
    field('切角角度', rangeBind(s, 'trailAngle', () => onStyleChange(), { min: 5, max: 85, step: 1 }), '仅「预设角度」连接方式生效：连接线与进入方向的夹角（度）'),
    field('轨迹衰减模式', selBind(s, 'fadeMode', () => onStyleChange(), [
      { value: 'linear', label: '线性（等速变暗）' },
      { value: 'exponential', label: '指数（先急后缓）' },
    ]), '轨迹亮度按「离开头部的步数」衰减；未勾选「轨迹渐隐」时此项不生效'),
    field('轨迹颜色分级', selBind(s, 'trailColorMode', () => onStyleChange(), TRAIL_COLOR_OPTIONS),
      '按新旧渐隐：颜色随轨迹亮度变化；按经过次数 / 次序：整条轨迹按色带分级染色（与「轨迹渐隐」的亮度衰减叠加）'),
    field('衰减步长（步）', rangeBind(s, 'fadeLength', () => onStyleChange(), {
      min: FADE_LENGTH_LIMIT.min, max: FADE_LENGTH_LIMIT.max, step: 1, number: true,
    }), '轨迹点离开头部多少步后完全淡出；步长越大尾巴拖得越长，越小则越快消失'),
    field('渲染效果', row(
      checkbox(s.trailFade, (v) => { s.trailFade = v; onStyleChange(); }, '轨迹渐隐'),
      checkbox(s.trailSmooth, (v) => { s.trailSmooth = v; onStyleChange(); }, '轨迹尖端平滑'),
      checkbox(s.showCrossings, (v) => { s.showCrossings = v; onStyleChange(); }, '边界穿越标记'),
      checkbox(s.showEffects, (v) => { s.showEffects = v; onStyleChange(); }, '交互特效'),
      checkbox(s.glow, (v) => { s.glow = v; onStyleChange(); }, '蛇身发光'),
      checkbox(s.showEyes, (v) => { s.showEyes = v; onStyleChange(); }, '蛇头眼睛'),
    ), '「轨迹尖端平滑」让轨迹随蛇头平滑滑动（而非逐格跳变）；「边界穿越标记」在接缝两侧标出滑出 / 滑入点；蛇头眼睛默认隐藏，勾选后显示'),
    field('穿越事件日志', row(
      checkbox(cfg.events.logCrossings, (v) => { cfg.events.logCrossings = v; onSimChange(); }, '记录边界穿越到规则日志'),
    ), '开启后每次穿越边界都写入一条「边界穿越」日志（含滑出 / 滑入坐标），可在日志面板按规则过滤查看'),
    field('界面配置', row(
      checkbox(state.showScore, (v) => setShowScore(v), '得分 / 评级 / 难度 / 拥挤度'),
      checkbox(state.showRankToast, (v) => setShowRankToast(v), '排行榜第 1 名提示'),
    ), '均默认关闭；前者控制得分 / 评级 / 难度 / 拥挤度读数（地图最高分记录始终照常保存），后者控制本轮成绩进入本地排行榜第 1 名时的提示条（榜单本身照常记录）'),
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

/**
 * 排序 / 删除按钮簇（↑ ↓ ✕）。
 * 必须包成一个不换行的容器再放进行里：否则每个按钮都是独立的 flex 项，
 * 行宽不足时会各自换行，出现「↑ 在上一行、↓ 在下一行」的错位。
 */
function orderActions(...buttons) {
  return h('div', { class: 'row-actions' }, ...buttons.filter(Boolean));
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
