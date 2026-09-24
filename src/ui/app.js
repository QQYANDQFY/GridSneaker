/**
 * 应用主体：配置面板、规则编辑器、播放控制、统计与日志、导入导出
 */
import {
  defaultConfig, normalizeConfig, defaultRule, defaultClause, defaultAction,
  validateConfig, diagnoseConfig, buildShareUrl, readConfigFromLocation, END_LABELS, MAX_STEPS_LIMIT,
  isBodyEnabled, INTERACTION_LABELS, SPAWN_LABELS, SPAWN_EVENTS, SPAWN_EVENT_LABELS, FADE_LENGTH_LIMIT,
  SKIN_MIME_TYPES, stripSkinAssets, LIFE_MIN, LIFE_MAX,
  DEFAULT_HIDDEN_STATS, TAB_COLOR_KEYS, TAB_COLORS_DEFAULT, MAX_AGENT_SLOTS,
  MOVE_KEYS, MOVE_LABELS, MARKER_CONDITION_TYPES, MARKER_CONDITION_LABELS,
  CELL_TOOLS, CELL_TOOL_LABELS, isTrapState, MAX_MARKER_TYPES, MAX_OBSTACLE_TYPES,
  SAFETY_ON_AVOID_MODES, SAFETY_ON_AVOID_LABELS,
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
  colorBind, toast, formatNumber, confirmDialog, alertDialog, dialogOpen, switchField,
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
/** 运行序号：长跑异步启动期间又发起新计算时，旧的一次作废 */
let runSeq = 0;
let activeLogEls = [];

/**
 * 画布格子编辑器的撤销 / 重做栈。
 * 仅保存 cellEditor.painted 的快照（JSON 字符串），与配置整体撤销（cfgHistory）互不干扰；
 * 步数上限由 cellEditor.historyLimit 控制（0 表示关闭历史记录）。
 */
const editHistory = { undo: [], redo: [] };
/** 拖拽连画的进行态：{ painting, erasing, last } —— 为 null 表示未在拖拽 */
let editDrag = null;
/** 编辑面板中的「已绘制格数」读数节点（重建面板后重新缓存） */
let editorCountEl = null;

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

/**
 * 「自撞即判定死亡」（扩展机制 → 蛇死亡转化）与结束规则「撞到自身」互斥的即时联动。
 *
 * 二者语义相反：前者让自撞只令该移动体消失、整轮运行继续；后者让自撞立即终止整轮运行。
 * 因此只允许其中一项开启——用户勾选任一项时，这里立刻取消并关闭另一项，
 * 无需再跳到另一个配置页手动修改。这里改的是工作配置 state.cfg，
 * 与配置规范化阶段（src/core/config.js）的自动关闭保持同一约束。
 *
 * @param {'selfCollision'|'die'|'enable'} source 本次由哪个开关触发
 * @returns {''|'selfCollision'|'die'} 被自动关闭的那一项，'' 表示无冲突、未做改动
 */
function syncSelfCollisionExclusive(source) {
  const t = state.cfg.transform;
  const ec = state.cfg.endConditions;
  if (source === 'selfCollision') {
    if (!(ec.selfCollision && t.dieOnSelfCollision)) return '';
    t.dieOnSelfCollision = false;
    return 'die';
  }
  // 来源为「自撞即判定死亡」或「蛇死亡转化」总开关：前者处于开启态时，「撞到自身」让位
  if (!(source === 'die' ? t.dieOnSelfCollision : (t.enabled && t.dieOnSelfCollision))) return '';
  if (!ec.selfCollision) return '';
  ec.selfCollision = false;
  return 'selfCollision';
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

  applyTabTheme(); // 首屏即应用选项卡配色与紧凑排版（配置可能来自本地存档或分享链接）
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
      // Ctrl/Cmd + Z：优先撤销画布格子编辑（编辑模式且有历史时），否则撤销上一次配置整体替换
      if (e.key === 'z' || e.key === 'Z') {
        e.preventDefault();
        if (e.shiftKey) {
          if (state.cfg.cellEditor.enabled && redoEdit()) toast('已重做上一次格子编辑', 'info');
        } else if (state.cfg.cellEditor.enabled && undoEdit()) {
          toast('已撤销上一次格子编辑', 'info');
        } else {
          undoConfigReplace();
        }
      } else if ((e.key === 'y' || e.key === 'Y') && state.cfg.cellEditor.enabled) {
        // Ctrl/Cmd + Y：部分平台的「重做」习惯键位
        e.preventDefault();
        if (redoEdit()) toast('已重做上一次格子编辑', 'info');
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
  return STAT_KEYS.filter(([key]) => {
    if (!state.showScore && SCORE_STAT_KEYS.has(key)) return false;
    return !isStatHidden(key);
  });
}

/**
 * 统计项是否被用户隐藏。
 * 生成新蛇 / 移动体消失 / 融合次数 / 排斥次数 / 生命机制等低频项默认隐藏
 * （默认值见 config.js 的 DEFAULT_HIDDEN_STATS），可在「统计模块 → 统计项显示配置」逐项开启。
 */
function isStatHidden(key) {
  const hidden = state.cfg && state.cfg.style ? state.cfg.style.hiddenStats : null;
  return Array.isArray(hidden) && hidden.includes(key);
}

/** 写入隐藏统计项集合并刷新统计面板（配置随场景保存 / 导出，故走 onSimChange 之外的轻量重绘） */
function setStatHidden(key, hidden) {
  const s = state.cfg.style;
  const set = new Set(Array.isArray(s.hiddenStats) ? s.hiddenStats : []);
  if (hidden) set.add(key);
  else set.delete(key);
  s.hiddenStats = STAT_KEYS.map(([k]) => k).filter((k) => set.has(k));
  state.dirty = true;
  renderStageStats();
  syncStatVisibilityCount();
}

/** 批量设置隐藏统计项（预设按钮：仅核心 / 全部显示 / 全部隐藏 / 恢复默认） */
function setHiddenStats(keys, message) {
  const set = new Set(keys);
  state.cfg.style.hiddenStats = STAT_KEYS.map(([k]) => k).filter((k) => set.has(k));
  state.dirty = true;
  renderStageStats();
  renderSidePanel();
  if (message) toast(message, 'info');
}

/** 刷新「统计项显示配置」上的当前可见 / 隐藏计数提示 */
function syncStatVisibilityCount() {
  const el = els.statVisibilityHint;
  if (!el) return;
  const total = STAT_KEYS.filter(([k]) => !SCORE_STAT_KEYS.has(k)).length;
  const visible = activeStatKeys().filter(([k]) => !SCORE_STAT_KEYS.has(k)).length;
  el.textContent = `当前显示 ${visible} / ${total} 项（得分与评级由上方「界面配置」的开关控制）`;
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

/** 长跑运行提示：长跑会同步占满主线程，先让浏览器把提示画出来再开始计算 */
function setRunBusy(busy, text) {
  const el = els.runLoading;
  if (!el) return;
  el.textContent = busy ? text || '正在运行模拟…' : '';
  el.classList.toggle('hidden', !busy);
}

function onSimChange(delay = 160) {
  state.dirty = true;
  refreshDiagnostics(); // 静态诊断只依赖配置，改动后立即反馈，无需等待重算
  if (state.autoRun) scheduleRun(delay);
}

function onStyleChange() {
  applyTabTheme(); // 选项卡配色 / 紧凑排版属于界面偏好，即使尚未运行模拟也要立即生效
  if (!state.result) return;
  // 同时传入移动体外观配置，使形状 / 尺寸 / 配色模式的修改即时生效（无需重新计算）
  renderer.setStyle(state.cfg.style, state.cfg.body);
  applyRendererExtras(state.cfg);
  draw();
}

/** 把配置中的安全帧上限收敛到 [1, MAX_FRAME_CAP]；缺省时回退到默认值 */
function clampFrameCap(v) {
  if (!Number.isFinite(v)) return DEFAULT_FRAME_CAP;
  return Math.min(MAX_FRAME_CAP, Math.max(1, Math.round(v)));
}

/**
 * 把「陷阱标识」与「格子编辑器」的运行期状态注入渲染器。
 * 陷阱集合与概率来自 obstacleTypes（与模拟层的判定入口 isTrapState 保持一致），
 * 编辑模式来自 cellEditor；二者都只作用于渲染层，不参与模拟计算。
 */
function applyRendererExtras(cfg) {
  if (!renderer) return;
  const traps = new Set();
  const info = new Map();
  for (const t of cfg.obstacleTypes) {
    if (!t.enabled || info.has(t.state) || !isTrapState(cfg, t.state)) continue;
    info.set(t.state, { name: t.name, ...t.trap });
    traps.add(t.state);
  }
  renderer.trapStates = traps;
  renderer.trapInfo = info;
  const ce = cfg.cellEditor;
  renderer.editMode = !!ce.enabled;
  renderer.brushSize = ce.brushSize;
  // 画笔预览配色按工具区分：擦除红 / 障碍物橙 / 元胞状态绿 / 标记物蓝
  renderer.editAccent = ce.tool === 'erase' ? '#ff7b72'
    : ce.tool === 'obstacle' ? '#ffa94d'
      : ce.tool === 'state' ? '#63e6be' : '#7cc0ff';
  // 编辑模式下把画布光标换成十字准星：一眼可知「点击画布 = 增删格子」已接管
  if (renderer.canvas && renderer.canvas.classList) {
    renderer.canvas.classList.toggle('editing', !!ce.enabled);
  }
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
  // 未启用「达到步数上限」时使用的安全帧上限；可由「场景与运行 → 单次运行步数上限」配置，
  // 也可由控制条的「继续运行」逐级提升（opts.frameCap 优先）
  const frameCap = Number.isFinite(opts.frameCap)
    ? Math.min(MAX_FRAME_CAP, Math.max(1, Math.round(opts.frameCap)))
    : clampFrameCap(cfg.frameCap);
  state.frameCap = frameCap;
  const effCap = cfg.endConditions.maxSteps === false
    ? frameCap
    : Math.max(1, Math.round(cfg.endConditions.maxSteps));
  // 画面帧超限时按步长抽样缓存，内存占用取决于缓存的帧数而非总步数
  const est = cfg.grid.width * cfg.grid.height * Math.min(effCap, MAX_STORED_FRAMES);
  if (est > 4e8) {
    toast('当前网格与步数组合数据量较大，可能占用较多内存与时间', 'warn');
  }
  // 预估计算量：每步都要推进移动体（常数开销），开启元胞自动机时还要遍历全网格。
  // 计算量大时先让浏览器画出「正在运行」提示，再把计算推到下一个事件循环，
  // 避免长跑期间界面完全无反馈、看起来像卡死。
  const caCells = cfg.caMode.enabled ? cfg.grid.width * cfg.grid.height : 0;
  const heavy = effCap * (8 + caCells) > 2e7;
  if (heavy && !opts.deferred) {
    const seq = ++runSeq;
    setRunBusy(true, `正在运行模拟（最多 ${effCap} 步）…`);
    setTimeout(() => {
      if (seq !== runSeq) return; // 期间已发起新的计算，本次作废
      try {
        recompute({ ...opts, deferred: true });
      } finally {
        setRunBusy(false);
      }
    }, 24);
    return;
  }
  if (!opts.deferred) setRunBusy(false); // 同步路径兜底：清掉可能残留的提示
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
  applyRendererExtras(cfg);
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
  let advanced = false;
  // 一个动画帧内可能推进多步（高倍速 / 掉帧后追帧）：中间帧不必逐个刷新 DOM，
  // 只记录是否发生过推进，循环结束后统一刷新一次，省下大量被立即覆盖的重复渲染。
  while (acc >= stepMs && guard++ < 400) {
    acc -= stepMs;
    if (!advance()) break;
    advanced = true;
  }
  if (advanced) frameChanged(); // 跨帧时才做帧统计 / 控件 / 日志高亮等 DOM 更新
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
  els.runLoading = h('span', { class: 'run-loading hidden' }, '');

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
  els.continueBtn = button(`继续运行 +${continueStep()}`, () => continueRun(), 'primary small');

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
    els.playBtn, els.prevBtn, els.stepBtn, els.resetBtn, els.endBtn, els.runBtn, els.runLoading));
  c.appendChild(h('div', { class: 'controls-line' },
    els.loopChk, els.autoChk, els.followChk, els.adaptiveChk));
  /**
   * 速度调节独立成行：「自适应速度」之后的滑杆与读数强制换行。
   * 原先与循环 / 自动运行 / 跟随 / 自适应挤在同一行，窄屏下换行位置不可控，
   * 滑杆会被压缩到难以拖动、读数也可能被裁掉；独立成行后布局稳定且始终完整可见。
   */
  c.appendChild(h('div', { class: 'controls-line speed-line' },
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

/**
 * 「继续运行」每次推进的步数：跟随「场景与运行 → 单次运行步数上限」。
 * 用户把单次运行长度调大后，继续运行的跨度同步放大，两处语义始终一致；
 * 未配置时回退到默认值。
 */
function continueStep() {
  const v = state.cfg ? Number(state.cfg.frameCap) : NaN;
  return Number.isFinite(v) && v > 0 ? clampFrameCap(v) : DEFAULT_FRAME_CAP;
}

/** 未启用「达到步数上限」时，逐级提升安全帧上限并重新运行 */
function continueRun() {
  if (!state.result) return;
  if (state.result.endReason?.code !== 'frameLimit') {
    toast('本次运行并非因安全步数上限而停止', 'warn');
    return;
  }
  const next = Math.min(MAX_FRAME_CAP, state.frameCap + continueStep());
  if (next <= state.frameCap) {
    toast(`已达到最大安全步数上限（${MAX_FRAME_CAP} 步）`, 'warn');
    return;
  }
  recompute({ frameCap: next });
  toast(`步数上限已提升至 ${next} 步并继续运行`, 'success');
}

/**
 * 结束原因 → 真正控制它的配置分组。
 * 「生命耗尽」「蛇已全部转化为环境」这类原因不在结束规则列表里，
 * 点「查看结束规则」时应直接带到控制它的分组，而不是笼统提示「不属于结束规则列表项」。
 */
const END_REASON_GROUP = {
  lifeDepleted: '生命机制（多生命）',
  transformDone: '蛇死亡转化',
};

/** 给配置分组一个短暂的定位高亮（与结束规则行的 .target 高亮同款） */
function flashCfgGroup(el) {
  if (!el) return;
  el.classList.add('target');
  setTimeout(() => el.classList.remove('target'), 2600);
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
    // 非结束规则项（如生命耗尽 / 全部转化为环境）：跳到真正控制它的分组
    const ownerKey = END_REASON_GROUP[reason.code];
    const owner = ownerKey ? revealConfigGroup(ownerKey) : null;
    if (owner) {
      owner.scrollIntoView({ block: 'start', behavior: 'smooth' });
      flashCfgGroup(owner);
      toast(`「${reason.label}」由「${ownerKey}」控制，已跳转到该分组`, 'info');
      return;
    }
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

/** 隐藏悬浮提示（同时清掉术语浮层的加宽态，避免影响下一次画布提示的宽度测量） */
function hideTooltip() {
  if (els.tooltip) els.tooltip.classList.remove('show', 'term-tip');
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

/**
 * 给元素绑定「专业术语说明」浮层。
 *
 * 复用画布悬浮提示的同一个浮层节点（#tooltip）：定位、边界翻转、滚动 / 缩放时自动隐藏
 * 等行为全部一致，既不必新增节点，也不会出现两个提示同时可见的情况。
 * 术语浮层只在鼠标进入 / 移动时显示，移出即隐藏。
 */
function bindTermTip(el, term) {
  if (!el || !term) return el;
  const show = (e) => {
    if (!els.tooltip) return;
    els.tooltip.innerHTML = termTipHtml(term);
    // 术语说明比坐标提示长，单独放宽浮层最大宽度（hideTooltip 会清掉该状态）
    els.tooltip.classList.add('show', 'term-tip');
    placeTooltip(e.clientX, e.clientY);
  };
  el.addEventListener('mouseenter', show);
  el.addEventListener('mousemove', show);
  el.addEventListener('mouseleave', hideTooltip);
  el.classList.add('has-term');
  return el;
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

/* ------------------------------------------------------------------ */
/* 画布格子编辑器（元胞自动机格子交互）                                 */
/*                                                                     */
/* 坐标来源始终是 renderer.hitTest()——它按画布内边距与格子间距反算     */
/* 行列号，与绘制走同一套几何换算，因此点击位置与格子严格一一对应，     */
/* 不存在额外的像素偏移。                                              */
/* ------------------------------------------------------------------ */

/** 编辑模式是否生效：开关打开且已有渲染结果（编辑写回配置后重算才能看到效果） */
function cellEditorActive() {
  return !!(state.cfg && state.cfg.cellEditor && state.cfg.cellEditor.enabled && state.result);
}

/** painted 列表 → Map（键为 "col,row"，便于按坐标增删） */
function paintedMap() {
  const map = new Map();
  for (const p of state.cfg.cellEditor.painted) map.set(`${p.col},${p.row}`, p);
  return map;
}

/** 画笔覆盖的格子（以点击格为中心取 n×n；n 为偶数时中心偏向左上） */
function brushCells(col, row, n) {
  const size = Math.max(1, Math.round(n || 1));
  const off = Math.floor((size - 1) / 2);
  const out = [];
  for (let dr = 0; dr < size; dr++) {
    for (let dc = 0; dc < size; dc++) {
      const c = { col: col - off + dc, row: row - off + dr };
      if (state.result.grid.inBounds(c)) out.push(c);
    }
  }
  return out;
}

/**
 * 「元胞自动机状态」工具当前要写入的状态名。
 * 面板上明确选中的状态优先；选择「自动」（stateName 为空或已失效）时，
 * 取状态集合中的首个非空状态——生命游戏等模板下即为「存活」（alive）。
 */
function cellEditorStateName(cfg) {
  const ce = cfg.cellEditor;
  const states = cfg.caMode.states;
  if (ce.stateName && states.some((s) => s.name === ce.stateName)) return ce.stateName;
  const first = states.find((s) => s.name !== 'empty');
  return first ? first.name : '';
}

/**
 * 按当前工具 / 类型解析「本次点击要写入的状态名」，返回 '' 表示本次不放置。
 * 障碍物支持两种模式：先选类型再点击（精准放置）、随机放置（按权重从随机池抽取）。
 * 元胞自动机状态工具直接把选中的环境状态写入格子（如生命游戏的「存活」）。
 */
function paintStateForCell() {
  const cfg = state.cfg;
  const ce = cfg.cellEditor;
  if (ce.tool === 'erase') return '';
  if (ce.tool === 'state') return cellEditorStateName(cfg);
  if (ce.tool === 'obstacle') {
    const types = cfg.obstacleTypes.filter((t) => t.enabled);
    if (!types.length) return '';
    if (ce.randomObstacle) {
      const pool = types.filter((t) => !ce.randomPool.length || ce.randomPool.includes(t.id));
      if (!pool.length) return '';
      // 随机放置的触发概率：低于 1 时本次点击可能不放置任何障碍物
      if (ce.randomProbability < 1 && Math.random() >= ce.randomProbability) return '';
      const total = pool.reduce((a, t) => a + Math.max(0, t.weight), 0);
      if (total <= 0) return pool[pool.length - 1].state;
      let r = Math.random() * total;
      for (const t of pool) { r -= Math.max(0, t.weight); if (r <= 0) return t.state; }
      return pool[pool.length - 1].state;
    }
    const t = types.find((x) => x.id === ce.obstacleTypeId) || types[0];
    return t.state;
  }
  // 标记物：优先选中的自定义标记物类型，其次第一个启用的类型，最后退回「交互标记物状态」首项
  const mt = cfg.markerTypes.find((t) => t.id === ce.markerTypeId && t.enabled)
    || cfg.markerTypes.find((t) => t.enabled);
  if (mt && cfg.caMode.states.some((s) => s.name === mt.state)) return mt.state;
  const mi = cfg.caMode.markerInteraction;
  const fallback = (mi.states || []).find((n) => cfg.caMode.states.some((s) => s.name === n));
  if (fallback) return fallback;
  const idx = cfg.caMode.states.findIndex((s) => s.name === 'marker');
  return idx >= 0 ? 'marker' : (cfg.caMode.states[1] ? cfg.caMode.states[1].name : '');
}

/** 记录一次编辑前的快照（受 historyLimit 限制；0 表示不记录） */
function pushEditHistory() {
  const limit = state.cfg.cellEditor.historyLimit;
  if (!limit) return;
  editHistory.undo.push(JSON.stringify(state.cfg.cellEditor.painted));
  if (editHistory.undo.length > limit) editHistory.undo.shift();
  editHistory.redo.length = 0;
}

/** 把 Map 写回配置并重算（0 延时可被连续拖拽合并，避免逐格重算） */
function commitPainted(map) {
  state.cfg.cellEditor.painted = [...map.values()];
  syncEditorCount();
  onSimChange(0);
}

/** 在指定格执行一次「添加 / 删除」（再次单击已放置元素 = 删除） */
function applyEditAt(col, row, opts = {}) {
  const ce = state.cfg.cellEditor;
  const cells = brushCells(col, row, ce.brushSize);
  const map = paintedMap();
  pushEditHistory();
  // 拖拽 / 强制添加时只增不减；否则以「中心格是否已放置」决定本次是添加还是删除
  const removing = !opts.erase && !opts.force && map.has(`${col},${row}`);
  for (const c of cells) {
    const k = `${c.col},${c.row}`;
    if (opts.erase || removing) { map.delete(k); continue; }
    const st = paintStateForCell();
    if (st) map.set(k, { col: c.col, row: c.row, state: st });
  }
  commitPainted(map);
}

/**
 * 拖拽连画时对单个格子的处理。
 * 不单独记录历史：整轮拖拽共用 mousedown 时压入的那一条快照，撤销时一次退掉整笔涂抹。
 */
function paintByDrag(c) {
  const map = paintedMap();
  const k = `${c.col},${c.row}`;
  if (editDrag.mode === 'erase') {
    map.delete(k);
  } else {
    const st = paintStateForCell();
    if (!st) return;
    map.set(k, { col: c.col, row: c.row, state: st });
  }
  state.cfg.cellEditor.painted = [...map.values()];
  syncEditorCount();
  onSimChange(0);
}

/** 撤销上一次编辑（返回 false 表示没有可撤销的历史） */
function undoEdit() {
  if (!editHistory.undo.length) return false;
  editHistory.redo.push(JSON.stringify(state.cfg.cellEditor.painted));
  state.cfg.cellEditor.painted = JSON.parse(editHistory.undo.pop());
  syncEditorCount();
  onSimChange(0);
  return true;
}

/** 重做上一次被撤销的编辑（返回 false 表示没有可重做的历史） */
function redoEdit() {
  if (!editHistory.redo.length) return false;
  editHistory.undo.push(JSON.stringify(state.cfg.cellEditor.painted));
  state.cfg.cellEditor.painted = JSON.parse(editHistory.redo.pop());
  syncEditorCount();
  onSimChange(0);
  return true;
}

/** 一键随机散布：按密度在整个网格上随机落点（用当前工具 / 类型写入状态） */
function scatterPainted() {
  const ce = state.cfg.cellEditor;
  const grid = state.result.grid;
  const map = paintedMap();
  pushEditHistory();
  for (let row = 0; row < grid.height; row++) {
    for (let col = 0; col < grid.width; col++) {
      if (Math.random() >= ce.scatterDensity) continue;
      const st = paintStateForCell();
      if (st) map.set(`${col},${row}`, { col, row, state: st });
    }
  }
  commitPainted(map);
  toast(`已按 ${(ce.scatterDensity * 100).toFixed(0)}% 密度随机散布`, 'success');
}

/** 清空全部手绘格子（破坏性操作，先经确认；清空后仍可撤销） */
async function clearPainted() {
  const n = state.cfg.cellEditor.painted.length;
  if (!n) { toast('当前没有手绘格子', 'info'); return; }
  const okClear = await confirmDialog({
    title: '清空全部手绘格子',
    message: `将删除当前手工绘制的 ${n} 个格子（初始环境补丁），此操作可通过「撤销」回退。`,
    confirmText: '清空',
    cancelText: '取消',
    danger: true,
  });
  if (!okClear) return;
  pushEditHistory();
  commitPainted(new Map());
  toast('已清空手绘格子', 'success');
}

/** 刷新编辑面板上的「已绘制格数 · 可撤销步数」读数 */
function syncEditorCount() {
  if (!editorCountEl) return;
  editorCountEl.textContent = `已绘制 ${state.cfg.cellEditor.painted.length} 格 · 可撤销 ${editHistory.undo.length} 步`;
}

function bindCanvasEvents() {
  els.canvas.addEventListener('mousemove', (e) => {
    if (!state.result) return;
    const c = renderer.hitTest(e.clientX, e.clientY);
    renderer.hover = c;
    // 拖拽连画：光标滑过的每一格都按起手时的模式（画 / 擦）处理
    if (editDrag && c) {
      const key = `${c.col},${c.row}`;
      if (editDrag.last !== key) {
        editDrag.last = key;
        paintByDrag(c);
      }
    }
    draw();
    // 悬浮提示总开关（「展示样式 → 悬浮提示」）关闭时只保留画布高亮，不弹提示浮层
    if (!c || renderer.style.hoverTip === false) {
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
    // 编辑模式下点击已在 mousedown 中处理（含「再次单击删除」语义），这里不再跳转
    if (cellEditorActive()) return;
    jumpToCellFirstPass(renderer.hitTest(e.clientX, e.clientY));
  });

  /* 左键按下即完成一次编辑（比 click 更跟手）：命中格已有同类元素则删除，否则添加 */
  els.canvas.addEventListener('mousedown', (e) => {
    if (!cellEditorActive() || e.button !== 0) return;
    const c = renderer.hitTest(e.clientX, e.clientY);
    if (!c) return;
    // 起手格是否已有元素，决定「再次单击删除」以及本轮拖拽是连画还是连擦
    const existed = state.cfg.cellEditor.painted.some((p) => p.col === c.col && p.row === c.row);
    applyEditAt(c.col, c.row);
    // 开启「拖拽连画」后继续按住拖动可连画 / 连擦（本轮的增删模式由起手动作决定）
    if (state.cfg.cellEditor.drag) {
      editDrag = { mode: existed ? 'erase' : 'paint', last: `${c.col},${c.row}` };
    }
  });
  window.addEventListener('mouseup', () => {
    if (!editDrag) return;
    editDrag = null;
    syncEditorCount();
  });
  /* 右键擦除：仅在编辑模式且开启「右键擦除」时接管，其余情况保留浏览器右键菜单 */
  els.canvas.addEventListener('contextmenu', (e) => {
    if (!cellEditorActive() || !state.cfg.cellEditor.rightClickErase) return;
    e.preventDefault();
    const c = renderer.hitTest(e.clientX, e.clientY);
    if (c) applyEditAt(c.col, c.row, { erase: true });
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
    if (!c || renderer.style.hoverTip === false) { hideTooltip(); return; }
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
    // 编辑模式下抬手即完成一次「添加 / 删除」，与桌面端单击语义一致
    if (cellEditorActive()) {
      if (c) applyEditAt(c.col, c.row);
      return;
    }
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
  ['stops', '停止次数'], ['trapTriggers', '陷阱触发'], ['trapDeaths', '陷阱死亡'],
  ['caSteps', 'CA 演进次数'], ['obstacleCount', '障碍物'], ['markerCount', '标记物'], ['seed', '随机种子'],
  ['rngCalls', '随机调用次数'],
  // 生命机制（多生命系统）
  ['lives', '剩余生命'], ['maxLives', '峰值生命'], ['lifeGains', '获得生命'], ['lifeLosses', '失去生命'],
  ['respawns', '重生次数'], ['lifeWarnings', '低生命预警'], ['finalDeaths', '最终死亡'],
];

/**
 * 统计项的功能归类。
 * 「统计项显示配置」按此分组逐项列出可开关的统计项，
 * 与 STAT_KEYS 的顺序保持一一对应（得分 / 评级不在其中：由「界面配置」统一控制）。
 */
const STAT_GROUPS = [
  {
    title: '运行与场景',
    keys: ['steps', 'framePos', 'frames', 'elapsed', 'endReason', 'ruleTriggers', 'seed', 'rngCalls'],
  },
  {
    title: '长度与碰撞',
    keys: ['length', 'finalLength', 'maxLength', 'collisions', 'selfCollisions', 'coverage', 'stops'],
  },
  {
    title: '移动体与交互',
    keys: ['agents', 'peakAgents', 'spawns', 'agentDeaths', 'merges', 'repels', 'markerInteractions'],
  },
  {
    title: '环境与转化',
    keys: ['obstacleCount', 'markerCount', 'caSteps', 'transformDeaths', 'transformedCells', 'collisionWarnings', 'trapTriggers', 'trapDeaths'],
  },
  {
    title: '生命机制（多生命）',
    keys: ['lives', 'maxLives', 'lifeGains', 'lifeLosses', 'respawns', 'lifeWarnings', 'finalDeaths'],
  },
];

/**
 * 统计术语说明表。
 * 统计面板里的读数（如「覆盖率」「CA 演进次数」）多是本平台特有的专业概念，
 * 只给一个短标签很难判断口径。这里为每个统计项补一份「是什么 / 怎么统计 / 何时有意义」的说明，
 * 悬浮统计格时以浮层呈现，帮助用户快速理解概念含义（说明文案与核心层的统计口径一一对应）。
 */
const STAT_TERMS = {
  steps: { name: '步数', desc: '已执行的模拟步数。每执行一步，全部存活的移动体各移动一格。' },
  framePos: { name: '当前帧 / 总帧数', desc: '当前播放位置对应的帧序号与本次回放缓存的总帧数。跳帧或拖动进度条时该读数会变化。' },
  frames: { name: '缓存帧数', desc: '本次运行实际保存的帧数量。长跑时会按固定间隔抽样（读数后附「抽样 1/N」），因此帧数可能少于步数。' },
  elapsed: { name: '运行耗时', desc: '从开始计算到得出结果的真实耗时（毫秒），不含播放动画的时间。可用于对比不同配置的运算开销。' },
  endReason: { name: '结束原因 / 本步事件', desc: '总计口径下显示本轮运行终止的判定原因；实时口径下显示当前帧发生的碰撞、增长等事件。' },
  score: { name: '得分', desc: '整轮运行的结算总分，由生存步数、覆盖率、长度等分项加权得出（点击统计格可查看分项明细）。' },
  scoreGrade: { name: '评分等级', desc: '由总分映射出的等级标签（如 S / A / B），用于快速判断本轮表现。' },
  collisions: { name: '碰撞次数', desc: '移动体与边界、障碍物或其它移动体发生碰撞的累计次数（含自撞）。' },
  selfCollisions: { name: '自撞次数', desc: '移动体撞到自身身体的累计次数。是否计入取决于「撞尾是否算碰撞」等碰撞设置。' },
  length: { name: '当前长度', desc: '当前帧移动体的体节数（含头部）。实时口径下随播放进度变化。' },
  finalLength: { name: '最终长度', desc: '本轮运行结束时的体节数，整轮量，两种统计口径下取值相同。' },
  maxLength: { name: '最大长度', desc: '整轮运行中出现过的最大体节数，反映增长机制的峰值效果。' },
  coverage: { name: '覆盖率', desc: '轨迹访问过的不重复格子数占网格总格数的百分比（去重统计）。数值越高说明探索越充分，100% 表示所有格子都至少经过一次。' },
  ruleTriggers: { name: '规则触发', desc: '环境感知规则（含每步移动前 / 移动后 / 进入新格 / 碰撞 / 撞墙 / 定时等阶段）的累计触发次数。条件为假的规则不会计入。' },
  agents: { name: '存活移动体', desc: '当前仍然存活的移动体数量。单蛇场景恒为 1（禁用蛇形实体时为 0）。' },
  peakAgents: { name: '峰值移动体', desc: '整轮运行中同时存活的移动体数量的最大值，用于观察多蛇生成与消亡的规模。' },
  spawns: { name: '生成新蛇', desc: '多蛇系统按时间或条件新增移动体的累计次数。' },
  agentDeaths: { name: '移动体消失', desc: '移动体因碰撞、生命耗尽或转化等原因从网格上消失的累计次数。' },
  merges: { name: '融合次数', desc: '多蛇系统中两条移动体相撞并按规则融合为一条的次数。' },
  repels: { name: '排斥次数', desc: '多蛇系统中两条移动体相撞并按规则相互弹开（而非融合或同归于尽）的次数。' },
  markerInteractions: { name: '标记物交互', desc: '移动体踏入交互标记物格、触发标记物效果（增长 / 缩短 / 转向等）的累计次数。' },
  transformDeaths: { name: '自撞死亡', desc: '开启「自撞即判定死亡」后，因撞到自身而直接死亡的累计次数（此时不再结束整轮运行）。' },
  transformedCells: { name: '转化节点', desc: '移动体死亡后，其身体体节就地写入环境（转为障碍物等状态）的格子总数。' },
  collisionWarnings: { name: '碰撞预警', desc: '开启「碰撞预警提示」后，被标记为「下一步会撞到自身身体」的危险落点累计数量。' },
  stops: { name: '停止次数', desc: '「停止」权重被抽中的累计次数：该回合原地不动，判定与撞上障碍物相同，同时计入碰撞次数。' },
  trapTriggers: { name: '陷阱触发', desc: '蛇尝试移动到已启用陷阱的障碍物格、并按触发概率成功触发的累计次数。' },
  trapDeaths: { name: '陷阱死亡', desc: '陷阱触发后按死亡概率判定为死亡、导致蛇消失的累计次数（每次判定都会写入运行日志）。' },
  caSteps: { name: 'CA 演进次数', desc: '元胞自动机执行的更新代数。每步移动结束后 CA 按设定规则推进一代，因此它与步数通常同步增长（含初始代）。' },
  obstacleCount: { name: '障碍物', desc: '当前环境中处于障碍物状态的格子数量（含 CA 演化与身体转化产生的障碍物）。' },
  markerCount: { name: '标记物', desc: '当前环境中处于标记物状态的格子数量，移动体踩到后会被消耗或触发效果。' },
  seed: { name: '随机种子', desc: '本次运行使用的随机种子。相同种子 + 相同配置必然得到完全相同的结果，便于复现与对比。' },
  rngCalls: { name: '随机调用次数', desc: '本次运行取用随机数的累计次数，可用于判断配置的随机性开销。' },
  lives: { name: '剩余生命', desc: '生命机制下当前剩余的生命条数；归零即触发最终死亡。' },
  maxLives: { name: '峰值生命', desc: '整轮运行中出现过的最大生命条数，用于观察获得生命的效果。' },
  lifeGains: { name: '获得生命', desc: '通过规则或标记物获得生命的累计次数。' },
  lifeLosses: { name: '失去生命', desc: '因碰撞、陷阱等原因失去生命的累计次数（不含最终死亡时的清空）。' },
  respawns: { name: '重生次数', desc: '失去一条生命后原地重生的累计次数（重生会重置身体长度与轨迹）。' },
  lifeWarnings: { name: '低生命预警', desc: '生命剩余量降到预警阈值时触发提示的累计次数。' },
  finalDeaths: { name: '最终死亡', desc: '生命耗尽或触发「死亡即停」导致移动体彻底退出的累计次数。' },
  lengthCurve: { name: '长度曲线', desc: '体节数随步数变化的迷你折线图。实时口径只画到当前播放位置，总计口径画完整条曲线。' },
  turnBars: { name: '转向分布', desc: '左转 / 直行 / 右转各自出现的次数占比。实时口径统计到当前帧，总计口径统计整轮运行。' },
};

/** 术语浮层文案（术语名加粗、说明换行），供统计格悬浮提示使用 */
function termTipHtml(term) {
  return `<b class="tip-term">${term.name}</b><span class="tip-desc">${term.desc}</span>`;
}

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
      stops: pick(st.stops ?? 0, s.stops || 0),
      trapTriggers: pick(st.trapTriggers ?? 0, s.trapTriggers || 0),
      trapDeaths: pick(st.trapDeaths ?? 0, s.trapDeaths || 0),
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
    const cell = h('div', {
      class: `stat ${key === 'endReason' ? 'wide' : ''}${clickable ? ' clickable' : ''}`,
      title: clickable ? '点击查看得分分项明细' : null,
      onclick: clickable ? showScoreDetail : null,
    }, h('span', { class: 'stat-label' }, label), span);
    // 专业术语说明：悬浮统计格显示「术语 + 口径说明」（覆盖率 / CA 演进次数等）
    bindTermTip(cell, STAT_TERMS[key]);
    host.appendChild(cell);
  }
  els.spark = h('canvas', { class: 'spark', width: 220, height: 44 });
  els.turnBars = h('div', { class: 'bars' });
  host.appendChild(bindTermTip(h('div', { class: 'stat wide' },
    h('span', { class: 'stat-label' }, '长度曲线'), els.spark), STAT_TERMS.lengthCurve));
  host.appendChild(bindTermTip(h('div', { class: 'stat wide' },
    h('span', { class: 'stat-label' }, '转向分布'), els.turnBars), STAT_TERMS.turnBars));
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

  // 一键展开 / 收起：侧边面板同样有十余个折叠分组，逐个点开较为繁琐
  side.appendChild(h('div', { class: 'panel-tools' },
    button('展开全部', () => setAllGroupsOpen(side, true), 'ghost small'),
    button('收起全部', () => setAllGroupsOpen(side, false), 'ghost small')));

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
    h('div', { class: 'hint' }, '统计面板中带虚线下划线的指标均有术语说明：把鼠标停在统计格上即可查看其统计口径（如「覆盖率」「CA 演进次数」等）。'),
    seg,
    els.statModeHint,
    row(button('复制统计摘要', () => {
      const text = statsSummaryText();
      if (!text) { toast('尚未运行模拟', 'warn'); return; }
      copyText(text, '统计摘要已复制');
    }, 'ghost small')),
    // 本地得分排行榜并入统计模块：成绩本身就是统计结论的留档，与统计口径同属一处更易查找。
    scoreboardGroup(),
    // 统计项显示配置：低频项默认隐藏，逐项开关满足个性化查看
    statVisibilityGroup(),
    // 坐标筛选查询并入统计模块：与统计口径共用同一轨迹数据源，
    // 切换口径或改变播放位置时查询结果会实时同步到统计面板与画面高亮。
    trailQueryGroup(),
  ], { key: 'stat-mode', open: false });
}

/* ------------------------------------------------------------------ */
/* 统计项显示配置                                                      */
/* ------------------------------------------------------------------ */

/** 「仅核心指标」预设保留的统计项：日常观察最常用的读数 */
const CORE_STAT_KEYS = ['steps', 'framePos', 'elapsed', 'endReason', 'length', 'coverage', 'collisions', 'agents', 'ruleTriggers'];

/** 可开关的统计项键名（得分 / 评级由「界面配置」控制，不在此列表内） */
function toggleableStatKeys() {
  return STAT_KEYS.map(([k]) => k).filter((k) => !SCORE_STAT_KEYS.has(k));
}

/** 统计项中文标签（缺失时回退为键名） */
function statLabel(key) {
  const hit = STAT_KEYS.find(([k]) => k === key);
  return hit ? hit[1] : key;
}

/**
 * 统计项显示配置面板。
 * 生成新蛇 / 移动体消失 / 融合次数 / 排斥次数 / 生命机制等低频项默认隐藏
 * （默认集合见 config.js 的 DEFAULT_HIDDEN_STATS），此处提供逐项开关与整组预设；
 * 隐藏只影响统计格与摘要行的生成，统计本身照常计算与导出。
 */
function statVisibilityGroup() {
  els.statVisibilityHint = h('div', { class: 'hint' }, '');
  syncStatVisibilityCount();
  const body = [
    h('div', { class: 'hint' }, '低频统计项（生成新蛇 / 移动体消失 / 融合次数 / 排斥次数 / 生命机制等）默认隐藏，仅保留高频核心指标，避免统计面板拥挤。勾选即可逐项开启；隐藏项不生成统计格与摘要行，统计与导出数据不受影响。'),
    h('div', { class: 'hint' }, '把鼠标停在任意统计项上，可查看该指标的口径说明（如「覆盖率」「CA 演进次数」等专业概念）。'),
    els.statVisibilityHint,
    row(
      button('仅核心指标', () => setHiddenStats(toggleableStatKeys().filter((k) => !CORE_STAT_KEYS.includes(k)), '已切换为「仅核心指标」'), 'ghost small'),
      button('全部显示', () => setHiddenStats([], '已显示全部统计项'), 'ghost small'),
      button('全部隐藏', () => setHiddenStats(toggleableStatKeys(), '已隐藏全部统计项'), 'ghost small'),
      button('恢复默认', () => setHiddenStats(DEFAULT_HIDDEN_STATS, '已恢复默认统计项显示'), 'ghost small'),
    ),
  ];
  for (const g of STAT_GROUPS) {
    body.push(h('div', { class: 'sub-title' }, g.title));
    body.push(h('div', { class: 'chips-line' },
      ...g.keys.map((key) => bindTermTip(
        checkbox(!isStatHidden(key), (on) => setStatHidden(key, !on), statLabel(key)),
        STAT_TERMS[key]))));
  }
  return group('统计项显示配置', body, { key: 'stat-visibility', open: false });
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
  // 口径切换时给统计面板一次淡入过渡，数值在原节点上更新，避免整块重绘造成的闪烁；
  // 低性能设备可在「色彩主题与界面」中关闭该动画（style.statFlash）
  if (els.stageStats && state.cfg.style.statFlash) {
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
  // 互斥约束兜底：载入模板 / 导入配置 / 载入分享链接可能同时带上两项互斥规则，
  // 这里在渲染前统一收敛，保证面板显示的勾选状态与实际运行语义一致。
  syncSelfCollisionExclusive('enable');
  syncControlBar();   // 载入模板 / 恢复配置后，控制条上的速度与「跟随移动体」同步为新配置
  applyTabTheme();    // 载入模板 / 导入配置后，选项卡配色与紧凑排版同步为新配置
  renderConfigPanel();
  renderSidePanel();
  recompute({ immediate: true });
}

/** 把配置中的播放相关取值同步回控制条控件 */
function syncControlBar() {
  if (els.speedSlider) els.speedSlider.value = String(state.cfg.speed);
  if (els.speedNum) els.speedNum.value = String(state.cfg.speed);
  if (els.followInput) els.followInput.checked = !!state.cfg.style.followAgent;
  // 「继续运行 +N」的跨度跟随「单次运行步数上限」，面板内改动后按钮文案同步刷新
  if (els.continueBtn) els.continueBtn.textContent = `继续运行 +${continueStep()}`;
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
  { key: 'core', label: '核心规则', hint: '网格与坐标、起点与移动体、基础移动规则（含停止）、碰撞与自撞、环境规则、画布格子编辑器、结束规则' },
  { key: 'visual', label: '视觉显示', hint: '基础视觉设置、高级视觉特效、悬停与提示、色彩主题配置' },
  { key: 'scene', label: '场景与运行', hint: '场景名称与描述、随机种子、规则执行方式、模拟帧率、单次运行步数上限、网格边界与多移动体规模' },
  { key: 'extend', label: '扩展机制', hint: '多蛇与交互、蛇死亡转化、生命机制、元胞自动机、自定义标记物类型、自定义障碍物类型（含陷阱）' },
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
    gridGroup(cfg),          // 网格与坐标
    bodyGroup(cfg),          // 起点 · 移动体 · 长度策略
    moveRulesGroup(cfg),     // 基础权重 · 条件概率 · 安全避撞
    collisionGroup(cfg),     // 碰撞与自撞处理
    envRulesGroup(cfg),      // 环境规则
    cellEditorGroup(cfg),    // 画布格子编辑器（点击增删格子元素）
    endGroup(cfg),           // 结束规则（按优先级）
  );
  panels.get('extend').append(
    multiSnakeGroup(cfg),    // 多蛇生成与交互
    transformGroup(cfg),     // 蛇死亡转化
    lifeGroup(cfg),          // 生命机制（多生命系统）
    caGroup(cfg),            // 元胞自动机
    markerTypesGroup(cfg),   // 自定义标记物类型（多维度自定义）
    obstacleTypesGroup(cfg), // 自定义障碍物类型（含陷阱属性）
  );
  panels.get('visual').append(
    visualBasicGroup(cfg),   // 基础视觉设置
    visualEffectsGroup(cfg), // 高级视觉特效
    visualOverlayGroup(cfg), // 悬停与提示
    visualThemeGroup(cfg),   // 色彩主题配置
  );
  panels.get('scene').append(sceneGroup(cfg), runControlGroup(cfg), sceneScaleGroup(cfg));

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
/** 搜索输入的防抖定时器（连续输入时只在停顿后过滤一次） */
let cfgSearchTimer = null;

function configSearchBar() {
  const input = h('input', {
    type: 'text',
    class: 'input cfg-search-input',
    placeholder: '搜索设置项（如：边界 / 长度 / 颜色 / 概率）',
  });
  input.value = state.cfgSearch;
  input.addEventListener('input', () => {
    state.cfgSearch = input.value;
    // 过滤需要对每个分组做一次 textContent 序列化，逐键触发在大面板上很卡，
    // 因此按输入停顿后再统一过滤（输入框本身仍即时回显）。
    if (cfgSearchTimer) clearTimeout(cfgSearchTimer);
    cfgSearchTimer = setTimeout(() => {
      cfgSearchTimer = null;
      applyConfigSearch(state.cfgSearch);
    }, 120);
  });
  els.cfgSearchHint = h('span', { class: 'mini-label' }, '');
  /**
   * 「清除」按钮的悬浮提示：按钮文案本身只有两个字，光看标签无法判断它清除的是
   * 搜索框内容还是整个配置。这里用项目统一的术语浮层（#tooltip）在悬停时给出完整说明，
   * 同时保留原生 title 作为无 JS / 触控端的兜底文案。
   */
  const clearBtn = button('清除', () => {
    if (cfgSearchTimer) { clearTimeout(cfgSearchTimer); cfgSearchTimer = null; }
    state.cfgSearch = '';
    input.value = '';
    applyConfigSearch('');
  }, 'ghost small');
  clearBtn.title = '清除当前搜索框内的全部输入内容，并还原搜索前的分组折叠状态';
  bindTermTip(clearBtn, {
    name: '清除搜索',
    desc: '清除当前搜索框内的全部输入内容，并还原搜索前的分组折叠状态；'
      + '仅影响搜索过滤结果，不会改动任何已保存的设置项。',
  });
  const expandBtn = button('展开全部', () => setAllGroupsOpen(els.config, true), 'ghost small');
  expandBtn.title = '展开当前选项卡下的全部折叠分组';
  const collapseBtn = button('收起全部', () => setAllGroupsOpen(els.config, false), 'ghost small');
  collapseBtn.title = '收起当前选项卡下的全部折叠分组';
  // Esc 清空搜索：输入框聚焦时即可一键还原，无需把光标移到「清除」按钮
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    clearBtn.click();
  });
  return h('div', { class: 'cfg-search' },
    input,
    clearBtn,
    expandBtn,
    collapseBtn,
    els.cfgSearchHint);
}

/**
 * 一键展开 / 收起容器内所有折叠分组。
 * 直接改写 <details>.open，group() 注册的 toggle 监听会把状态写回记忆表，
 * 因此面板重建（调整优先级 / 增删规则等）后仍保持一致。
 */
function setAllGroupsOpen(root, open) {
  if (!root) return;
  for (const g of root.querySelectorAll('details.group')) g.open = !!open;
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
    ]), '同步方式让同一步内的规则基于同一份快照判定，结果与规则书写顺序无关；异步则逐条即时生效'),
  ], { open: false });
}

/**
 * 运行控制：决定「一轮运行跑多远、播放多快」的场景级参数。
 * 与控制条上的同名控件是同一份设置（速度写入 cfg.speed，帧上限写入 cfg.frameCap），
 * 面板内改动后靠 syncControlBar / rebuildAll 让两处读数保持一致。
 */
function runControlGroup(cfg) {
  const capHint = h('div', { class: 'hint' });
  const syncCapHint = () => {
    const on = cfg.endConditions.maxSteps !== false;
    capHint.textContent = on
      ? `当前「结束规则 → 达到步数上限」已启用（${Math.round(cfg.endConditions.maxSteps)} 步），本上限暂不参与判定，仅作为兜底保护。`
      : `未启用「达到步数上限」：一轮运行在本上限处停止，可用控制条「继续运行」逐级推进（每次 +${continueStep()} 步）。`;
  };
  syncCapHint();
  return group('运行控制', [
    field('模拟帧率（步/秒）', range(cfg.speed, (v) => setSpeed(v), {
      min: 0.5, max: 120, step: 0.5, number: true,
    }), '与控制条上的速度滑块是同一个设置：只影响播放快慢，不改变任何计算结果'),
    field('单次运行步数上限', numBind(cfg, 'frameCap', () => { syncCapHint(); onSimChange(0); }, {
      min: 1, max: MAX_FRAME_CAP, step: 100,
    }), '调大可一次算完更长的过程，代价是单次计算时间与画面缓存占用同步上升'),
    capHint,
  ], { open: false });
}

/**
 * 场景边界与规模：直接决定地图形态与生态容量的三个参数。
 * 这些参数在「核心规则 / 扩展机制」里也有对应分组，此处提供集中调整的入口，
 * 改动后会重建面板，保证两处读数不会出现一旧一新。
 */
function sceneScaleGroup(cfg) {
  const g = cfg.grid;
  const sp = cfg.multiSnake.spawn;
  const syncStart = () => {
    cfg.start.col = Math.min(cfg.start.col, g.width - 1);
    cfg.start.row = Math.min(cfg.start.row, g.height - 1);
  };
  const sizeLabel = h('div', { class: 'hint' });
  const syncSizeLabel = () => { sizeLabel.textContent = `网格共 ${g.width * g.height} 格`; };
  syncSizeLabel();
  return group('场景边界与规模', [
    row(
      field('宽', numBind(g, 'width', () => { syncStart(); syncSizeLabel(); onSimChange(); rebuildAll(); }, { min: 2, max: 400 })),
      field('高', numBind(g, 'height', () => { syncStart(); syncSizeLabel(); onSimChange(); rebuildAll(); }, { min: 2, max: 400 })),
    ),
    field('边界行为', selBind(g, 'boundary', () => {
      syncBoundaryAvoidance();
      onSimChange();
      rebuildAll();
    }, [
      { value: 'stop', label: '停止（撞墙即停）' },
      { value: 'bounce', label: '反弹' },
      { value: 'wrap', label: '穿越到另一侧' },
      { value: 'randomTurn', label: '随机转向' },
      { value: 'custom', label: '自定义（由环境规则决定）' },
    ]), '与「核心规则 → 网格与坐标 → 边界行为」是同一个设置；改为不可穿越时自动补开「安全避撞 → 边界规避」'),
    sizeLabel,
    switchField('启用多蛇系统',
      chkBind(cfg.multiSnake, 'enabled', () => { onSimChange(0); rebuildAll(); }, '启用'),
      '多蛇生态的规模开关；生成方式 / 交互结果 / 逐蛇安全避撞等细节见「扩展机制 → 多蛇生成与交互系统」'),
    row(
      field('最大同时存在', numBind(sp, 'maxAgents', () => onSimChange(), { min: 1, max: MAX_AGENT_SLOTS })),
      field('生成总数上限', numBind(sp, 'maxTotal', () => onSimChange(), { min: 0, max: 1000000 })),
    ),
    h('div', { class: 'hint' }, '「生成总数上限」为 0 表示不限制；长时间运行时建议与「最大同时存在」配合设一个总数，避免蛇数量无限累积。'),
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
    field('边界行为', selBind(g, 'boundary', () => {
      // 边界改为不可穿越时自动补开「安全避撞 → 边界规避」，避免实体照着墙撞
      syncBoundaryAvoidance();
      onSimChange();
      rebuildAll();
    }, [
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
    switchField('蛇形实体开关',
      chkBind(b, 'enabled', () => { syncBodyState(); onSimChange(0); }, '生成蛇形实体'),
      bodyStateLabel),
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

/**
 * 左/直/右/停权重占比说明（引擎按占比归一化，权重绝对值不影响比例）。
 * 「停止」与其它三项同权：占比 > 0 时该回合有一定几率原地不动（等价于撞上障碍物的无效位移）。
 */
function weightSummary(m) {
  const sum = MOVE_KEYS.reduce((a, k) => a + (Number(m[k]) || 0), 0);
  if (sum <= 0) return '权重全为 0，运行时按均匀分布处理';
  const parts = MOVE_KEYS
    .filter((k) => (Number(m[k]) || 0) > 0)
    .map((k) => `${MOVE_LABELS[k]} ${(m[k] / sum * 100).toFixed(1)}%`);
  return `概率：${parts.join(' · ')}`;
}

/* ---------------- 移动规则：基础权重 · 条件概率 · 安全避撞 ---------------- */

function moveRulesGroup(cfg) {
  const m = cfg.moveRules;
  const weightHint = h('div', { class: 'hint' }, weightSummary(m));
  const upd = () => { onSimChange(); weightHint.textContent = weightSummary(m); };

  const list = h('div', { class: 'rule-list' });
  cfg.advancedRules.forEach((r, index) => {
    // 旧规则可能缺少「停止」权重（升级前保存的配置），这里补齐以保证滑条有初值
    if (!r.moves || typeof r.moves !== 'object') r.moves = {};
    for (const k of MOVE_KEYS) if (!Number.isFinite(Number(r.moves[k]))) r.moves[k] = 0;
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
      ...MOVE_KEYS.map((k) => field(
        `${MOVE_LABELS[k]}权重`,
        rangeBind(r.moves, k, updWeights, { min: 0, max: 1, step: 0.01, number: true }),
        k === 'stop' ? '原地不动（与撞上障碍物等效，无法完成有效位移）' : null,
      )),
      hint,
      field('优先级', numBind(r, 'priority', () => onSimChange(), { step: 1 }), '数值越大越优先匹配'),
    ];
    list.appendChild(group(r.name || '条件概率规则', body, { open: false, badge: r.enabled ? '' : '停用', key: `adv:${r.id}` }));
  });

  return group('移动规则', [
    h('div', { class: 'sub-title' }, '基础权重'),
    ...MOVE_KEYS.map((k) => field(
      `${MOVE_LABELS[k]}权重`,
      rangeBind(m, k, upd, { min: 0, max: 1, step: 0.01, number: true }),
      k === 'stop' ? '默认 0（不停止）：设为正值后该回合有几率原地不动，判定与撞上障碍物一致' : null,
    )),
    weightHint,
    h('div', { class: 'sub-title' }, '条件概率规则（按优先级匹配，命中后改用其权重）'),
    list,
    button('+ 添加条件概率规则', () => {
      cfg.advancedRules.push({
        id: `adv_${Math.random().toString(36).slice(2, 8)}`,
        enabled: true,
        name: `条件概率 ${cfg.advancedRules.length + 1}`,
        condition: { logic: 'and', clauses: [defaultClause('count')] },
        moves: { left: 0.2, straight: 0.6, right: 0.2, stop: 0 },
        priority: 1,
      });
      rebuildAll();
    }, 'ghost'),
    safetySection(cfg),
  ], { open: false });
}

/* ---------------- 安全避撞预设（方向选择的条件概率增强） ---------------- */

/**
 * 边界改为「不可穿越」时自动补上「边界规避」。
 * 撞墙即结束 / 掉头的边界下，不规避等于放任实体去撞墙；
 * 只做「自动补开」，不会关掉用户已开启的项，用户后续手动修改依然生效。
 */
function syncBoundaryAvoidance() {
  const cfg = state.cfg;
  if (cfg.grid.boundary !== 'wrap') cfg.safety.avoidWall = true;
}

function safetySection(cfg) {
  const s = cfg.safety;
  const wallMatters = cfg.grid.boundary !== 'wrap';
  const note = h('div', { class: 'hint' });
  const syncNote = () => {
    const on = [
      s.avoidBody && '自身身体',
      s.avoidObstacle && '障碍物',
      s.avoidOtherAgents && '其它移动体',
      s.avoidWall && '不可穿越边界',
    ].filter(Boolean);
    note.textContent = on.length
      ? `已启用（${on.join(' / ')}）：方向选择前先剔除被阻塞的候选方向，全部可行方向都被阻塞时才回落到原始权重。`
      : '未启用：方向选择完全按基础 / 条件概率权重进行。';
    if (on.length) {
      note.textContent += s.onAvoid === 'stop'
        ? ' 避撞触发后：立即停止运动。'
        : ' 避撞触发后：自动切换其他可行方向继续运动。';
    }
  };
  syncNote();
  /**
   * 单项开关：取消任一项时把「避开全部」同步为关闭，保证总开关与子项状态始终一致。
   * 不做禁用 / 锁定，用户随时可以手动改回。
   */
  const item = (key, label) => chkBind(s, key, (v) => {
    if (!v) s.avoidAll = false;
    onSimChange();
    rebuildAll();
  }, label);
  const count = ['avoidBody', 'avoidObstacle', 'avoidOtherAgents', 'avoidWall'].filter((k) => s[k]).length;
  return group('安全避撞预设（方向选择）', [
    switchField('避开全部',
      chkBind(s, 'avoidAll', (v) => {
        s.avoidBody = v;
        s.avoidObstacle = v;
        s.avoidOtherAgents = v;
        s.avoidWall = v;
        onSimChange();
        rebuildAll();
      }, '一键开启 / 关闭全部规避项（默认开启）'),
      '默认开启：一次性打开下面的全部规避项。仍可逐项手动调整——取消任一项会同步关闭本开关，不会被强制锁定。'),
    field('规避对象', h('div', { class: 'chips-line' },
      item('avoidBody', '自身身体'),
      item('avoidObstacle', '障碍物'),
      item('avoidOtherAgents', '其它移动体')),
      '规避是「择优」而非「禁止」：仍有可行方向时按权重择优，从而降低自撞概率'),
    field('规避边界', h('div', { class: 'chips-line' }, item('avoidWall', '不可穿越的边界')),
      wallMatters
        ? '当前边界不可穿越：开启后实体不再触碰边界，撞墙 / 反弹都只会发生在无路可走时'
        : '当前边界为「穿越到另一侧」：越界会环绕回网格内，本项不生效；把边界改为停止 / 反弹后会自动开启'),
    field('避撞触发后的处理',
      select(s.onAvoid, SAFETY_ON_AVOID_MODES.map((v) => ({ value: v, label: SAFETY_ON_AVOID_LABELS[v] })), (v) => {
        s.onAvoid = v;
        onSimChange();
        rebuildAll();
      }),
      s.onAvoid === 'stop'
        ? '避撞机制介入（本步本应朝向的方向被判定为不安全）时原地停止运动：不产生位移，计入「停止次数」并遵循「撞到障碍物」的结束规则与生命机制'
        : '避撞机制介入时自动切换到其他可行方向继续运动（默认，与旧版行为完全一致）'),
    note,
    field('碰撞预警提示', h('div', { class: 'chips-line' },
      chkBind(s, 'warnSelfCollision', () => onSimChange(), '标记「下一步会撞到自身身体」的危险格')),
      '开启后每步检查各可行朝向，把会导致自撞的落点标为警示色；长蛇场景会带来少量额外开销，默认关闭'),
  ], { open: false, badge: count ? `已启用 ${count} 项` : '' });
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
    switchField('启用多蛇系统',
      chkBind(m, 'enabled', () => { onSimChange(0); rebuildAll(); }, '启用'),
      '主移动体终止时整场结束，其它蛇终止只计入「移动体消失」'),
    row(
      field('生成方式', selBind(sp, 'mode', () => { onSimChange(); rebuildAll(); }, Object.entries(SPAWN_LABELS).map(([value, label]) => ({ value, label })))),
      field('最大同时存在', numBind(sp, 'maxAgents', () => onSimChange(), { min: 1, max: MAX_AGENT_SLOTS })),
    ),
    field('生成总数上限', numBind(sp, 'maxTotal', () => onSimChange(), { min: 0, max: 1000000 }),
      '整轮运行累计生成的蛇数量上限；0 表示不限制。与「最大同时存在」配合，可避免长跑时蛇数量无限累积'),
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

  bodies.push(perAgentSafetySection(m));

  return group('多蛇生成与交互系统', bodies, { open: false, badge: m.enabled ? '已启用' : '' });
}

/**
 * 逐蛇安全避撞：为每条移动体单独开关「安全避撞预设」。
 *
 * 之所以按「出现顺序」而不是「当前存活顺序」编号：每个移动体的身份必须稳定，
 * 否则中途有蛇死亡时，后面所有蛇的开关都会跟着错位，用户看到的行为会在运行中漂移。
 * 因此下标 0 固定给主移动体、下标 n 固定给第 n 条生成的蛇（画布上的「蛇n」）。
 * 未单独设置的槽位记为 null，跟随上方「新生移动体默认」，用户只需关心真正要区别对待的那几条。
 */
function perAgentSafetySection(m) {
  const safety = m.safety;
  const perAgent = safety.perAgent;
  /** 保证 perAgent 至少有 n 个槽位（新槽位默认 null = 跟随默认） */
  const ensureSlots = (n) => { while (perAgent.length < n) perAgent.push(null); };
  /** 该槽位当前生效的取值：已显式设置则用它，否则跟随「新生移动体默认」 */
  const slotOn = (i) => {
    const v = perAgent[i];
    return v === true || v === false ? v : safety.default !== false;
  };
  const commit = () => { onSimChange(); rebuildAll(); };
  const chip = (i, label) => checkbox(slotOn(i), (v) => {
    ensureSlots(i + 1);
    perAgent[i] = v;
    commit();
  }, label);

  const snakeCount = Math.max(0, perAgent.length - 1);
  const chips = [chip(0, '主移动体')];
  for (let i = 1; i <= snakeCount; i++) chips.push(chip(i, `蛇${i}`));
  const explicit = perAgent.filter((v) => v === true || v === false).length;

  return group('逐蛇安全避撞', [
    switchField('新生移动体默认',
      chkBind(safety, 'default', () => commit(), '启用'),
      '未在下方单独设置的移动体沿用本项；关闭后这些移动体不再规避，会真实撞上身体 / 障碍物 / 其它移动体 / 边界'),
    field('逐条开关', h('div', { class: 'chips-line' }, ...chips),
      '按生成顺序对应：主移动体、蛇1、蛇2……与画布上的标签一致。关闭某条即该移动体不参与安全避撞'),
    row(
      button('＋ 增加一条蛇', () => {
        if (perAgent.length >= MAX_AGENT_SLOTS) {
          toast(`逐蛇开关最多配置 ${MAX_AGENT_SLOTS} 条`, 'warn');
          return;
        }
        // 首次增加时槽位 0（主移动体）也一并占位，保证下标与「蛇n」编号对齐
        ensureSlots(perAgent.length === 0 ? 2 : perAgent.length + 1);
        commit();
      }, 'ghost small'),
      button('－ 减少一条蛇', () => {
        if (perAgent.length <= 1) {
          toast('至少保留「主移动体」一个槽位；要全部跟随默认请用「跟随默认」', 'warn');
          return;
        }
        perAgent.pop();
        commit();
      }, 'ghost small'),
      button('跟随默认', () => {
        safety.perAgent = [];
        commit();
      }, 'ghost small'),
    ),
    h('div', { class: 'hint' },
      m.enabled
        ? '关闭安全避撞的移动体不再剔除被阻塞的方向，因此会真实发生自撞与碰撞——这正是观察「哪些个体会被淘汰」所需要的。'
        : '当前未启用多蛇系统：所有移动体统一沿用「核心规则 → 安全避撞预设」。启用本系统后，这里的逐条设置才会生效。'),
  ], { open: false, badge: explicit ? `已单独设置 ${explicit} 条` : '' });
}

/* ---------------- 碰撞与边界 ---------------- */

function collisionGroup(cfg) {
  const c = cfg.collision;
  const sp = cfg.selfCollisionPolicy;
  // 「连续自撞上限」只在「结束规则 → 撞到自身」勾选时才参与结束判定，
  // 因此这里跟随该结束规则的可编辑状态联动置灰。
  // 「自撞即判定死亡」与「撞到自身」互斥（开启前者会自动关闭后者），故只需看后者。
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

/* ---------------- 长度策略（并入「移动体与身体」） ---------------- */

function lengthSection(cfg) {
  const lp = cfg.body.lengthPolicy;
  const subEditor = (sub, title) => [
    h('div', { class: 'sub-title' }, title),
    switchField('启用', chkBind(sub, 'enabled', () => onSimChange(), '启用'), '仅在长度策略为「可变」时生效'),
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

/** 转义 HTML 特殊字符（说明浮层里会拼接用户自定义的状态名 / 类型名，避免破坏浮层结构） */
function escHtml(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/**
 * 「交互标记物状态」的悬浮说明文案。
 * 按当前配置实时生成——是否已勾选、是否阻挡、命中了哪些反馈规则、挂载了哪些自定义标记物类型，
 * 一次性回答「功能 / 生效规则 / 使用场景」三个问题，无需来回翻配置。
 */
function markerStateTip(s) {
  const cfg = state.cfg;
  const mi = cfg.caMode.markerInteraction;
  const active = mi.states.includes(s.name);
  const fxs = mi.effects.filter((e) => e.enabled && e.state === s.name);
  const types = cfg.markerTypes.filter((t) => t.enabled && t.state === s.name);
  const lines = [
    `<b>功能</b>：${active ? '已设为交互标记物，蛇头进入该格时按下方反馈规则表产生效果。' : '尚未设为交互标记物：勾选本状态后才会参与交互。'}`,
    `<b>生效规则</b>：${s.blocking
      ? '当前标记为「阻挡」状态，移动体无法进入，交互反馈不会触发（需先取消阻挡）。'
      : `非阻挡状态，移动体可进入；共命中 ${fxs.length} 条启用中的反馈规则${fxs.length ? `（${escHtml(fxs.map((e) => e.name).join(' / '))}），按列表顺序自上而下匹配，可分别设置概率、消耗与变色` : '（可在下方反馈规则表新增）'}。`}`,
    `<b>使用场景</b>：${escHtml(markerUsageScene(s, fxs.length))}`,
  ];
  if (types.length) {
    const detail = types.map((t) => `${t.name}·权重 ${t.weight}·${MARKER_CONDITION_LABELS[t.condition.type]}`).join('；');
    lines.push(`<b>自定义类型</b>：${escHtml(detail)}；运行时先判断生效条件，再按权重抽取其中一个生效。`);
  }
  return { name: `状态「${escHtml(stateLabelWithKey(s.name))}」`, desc: lines.join('<br>') };
}

/** 依据该状态当前承担的角色，给出一句「适合用在哪」的场景提示 */
function markerUsageScene(s, fxCount) {
  const cfg = state.cfg;
  if (cfg.obstacleTypes.some((t) => t.enabled && t.state === s.name)) return '该状态同时被某个障碍物类型引用，碰撞处理优先于标记物交互。';
  if (fxCount > 0) return '常用于「吃食物变长」「踩到减速」「中毒缩短」等玩法：把食物格设为本状态并配置长度变化即可。';
  return '适合作为待激活的交互点：勾选后新增一条反馈规则即可让它对移动体产生影响。';
}

/** 「交互标记物状态」选择区：每个标记物按钮后追加一个带「?」的说明入口 */
function markerStateChips(ca, mi) {
  const box = h('div', { class: 'chips' });
  for (const s of ca.states) {
    const on = mi.states.includes(s.name);
    const chip = h('button', {
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
    const help = bindTermTip(h('button', {
      type: 'button',
      class: 'chip-help',
      title: '查看该标记物的详细说明',
      'aria-label': `${s.name} 标记物说明`,
    }, '?'), markerStateTip(s));
    box.appendChild(h('span', { class: 'chip-item' }, chip, help));
  }
  return box;
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
  wrap.appendChild(field('交互标记物状态', markerStateChips(ca, mi),
    '可多选；被选中的状态一旦与蛇头重合即触发下面的反馈规则。点击每个标记物右侧的「?」可查看该标记物的功能、生效规则与使用场景'));

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

/* ---------------- 自定义标记物类型（多维度自定义体系） ---------------- */

/** 类型「引用状态」下拉项：排除 empty（类型必须挂在一个可放置的状态上） */
function typeStateOptions() {
  return state.cfg.caMode.states
    .filter((s) => s.name !== 'empty')
    .map((s) => ({ value: s.name, label: stateLabelWithKey(s.name) }));
}

/** 「外观绘制方式」下拉项：空值表示继承状态自身的绘制方式 */
function typeRenderOptions() {
  return [
    { value: '', label: '继承状态' },
    { value: 'fill', label: '填充' },
    { value: 'cross', label: '交叉' },
    { value: 'dot', label: '圆点' },
  ];
}

/** 「外观符号」输入框：留空表示继承状态符号 */
function typeSymbolInput(t) {
  return h('input', {
    class: 'input tiny',
    value: t.symbol || '',
    placeholder: '继承',
    maxlength: 1,
    onchange: (e) => { t.symbol = e.target.value.slice(0, 1); onSimChange(); rebuildAll(); },
  });
}

/** 标记物类型的「生效条件」编辑行：条件类型 + 阈值（阈值含义随类型变化） */
function markerConditionRow(t) {
  const c = t.condition;
  const label = c.type === 'probability' ? '生效概率'
    : c.type === 'minLength' ? '最小蛇长'
      : c.type === 'maxLength' ? '最大蛇长'
        : c.type === 'minSteps' ? '最小步数' : '';
  return row(
    field('生效条件', selBind(c, 'type', () => { onSimChange(); rebuildAll(); },
      MARKER_CONDITION_TYPES.map((v) => ({ value: v, label: MARKER_CONDITION_LABELS[v] }))),
      '条件不满足时本类型不参与抽取（不会消耗随机数）'),
    c.type === 'always' ? null : field(label, numBind(c, 'value', () => onSimChange(),
      c.type === 'probability' ? { min: 0, max: 1, step: 0.01 } : { min: 0, max: 100000 })),
  );
}

/** 标记物类型的「内置反馈」编辑：关闭（null）时沿用「反馈规则表」 */
function markerTypeEffectEditor(t) {
  const box = h('div', {});
  box.appendChild(checkbox(!!t.effect, (v) => {
    t.effect = v ? { mode: 'delta', value: 1, probability: 1, consume: true, consumeTo: 'empty', color: '' } : null;
    onSimChange();
    rebuildAll();
  }, '使用本类型独立的反馈参数'));
  if (!t.effect) return box;
  const e = t.effect;
  box.appendChild(row(
    field('变化方式', selBind(e, 'mode', () => { onSimChange(); rebuildAll(); }, [
      { value: 'delta', label: '增减固定长度' },
      { value: 'percent', label: '按当前长度百分比' },
      { value: 'set', label: '直接设定长度' },
    ])),
    field(e.mode === 'percent' ? '百分比（%，负数为缩短）' : e.mode === 'set' ? '目标长度' : '变化量（负数为缩短）',
      numBind(e, 'value', () => onSimChange(), e.mode === 'set' ? { min: 1, max: 100000 } : { min: -1000, max: 1000 })),
  ));
  box.appendChild(row(
    field('触发概率', rangeBind(e, 'probability', () => onSimChange(), { min: 0, max: 1, step: 0.01 })),
    field('消耗标记物', row(
      chkBind(e, 'consume', () => onSimChange(), '消耗'),
      select(e.consumeTo, stateOptions(), (v) => { e.consumeTo = v; onSimChange(); }),
    ), '消耗后该格变为右侧状态'),
    field('反馈变色', row(
      colorInput(e.color || '#51cf66', (v) => { e.color = v; onSimChange(); }),
      button('清除', () => { e.color = ''; onSimChange(); rebuildAll(); }, 'ghost small'),
    ), '留空表示不变色'),
  ));
  return box;
}

/**
 * 自定义标记物类型编辑器。
 * 列表中的每一条即一次「新增标记物」：外观样式 / 生效条件 / 触发权重三组属性独立可配，
 * 后续补充更多标记物只需在此追加记录，模拟层会自动纳入条件判定与权重抽取。
 */
function markerTypesGroup(cfg) {
  const list = h('div', { class: 'rule-list' });
  cfg.markerTypes.forEach((t, i) => {
    const body = [
      row(
        textBind(t, 'name', () => {}),
        chkBind(t, 'enabled', () => onSimChange(), '启用'),
        orderActions(
          button('↑', () => { swap(cfg.markerTypes, i, i - 1); rebuildAll(); }, 'icon small'),
          button('↓', () => { swap(cfg.markerTypes, i, i + 1); rebuildAll(); }, 'icon small'),
          button('✕', () => { cfg.markerTypes.splice(i, 1); rebuildAll(); }, 'icon small danger'),
        ),
      ),
      field('引用状态', select(t.state, typeStateOptions(), (v) => { t.state = v; onSimChange(); rebuildAll(); }),
        '挂载到哪个元胞状态：蛇头进入该状态的格子即视为碰到本标记物'),
      row(
        field('触发权重', rangeBind(t, 'weight', () => onSimChange(), { min: 0, max: 1, step: 0.01, number: true }),
          '同一状态下多个类型按权重占比抽取一个生效'),
        markerConditionRow(t),
      ),
      row(
        field('外观配色', row(
          colorInput(t.color || '#ffd43b', (v) => { t.color = v; onSimChange(); }),
          button('继承', () => { t.color = ''; onSimChange(); rebuildAll(); }, 'ghost small'),
        ), '留空（点「继承」）表示沿用状态本身的颜色'),
        field('外观符号', typeSymbolInput(t), '留空表示沿用状态符号'),
        field('绘制方式', select(t.render || '', typeRenderOptions(), (v) => { t.render = v; onSimChange(); rebuildAll(); })),
      ),
      field('内置反馈', markerTypeEffectEditor(t), '开启后本类型使用自己的反馈参数，不再走「反馈规则表」'),
    ];
    list.appendChild(group(t.name || `标记物 ${i + 1}`, body, { open: false, badge: t.enabled ? '' : '停用', key: `mk:${t.id}` }));
  });
  return group('自定义标记物类型', [
    h('div', { class: 'hint' }, '在「交互标记物状态」之上再挂一层「类型」：同一状态可拥有多个标记物类型，各自带外观样式、生效条件与触发权重。运行时先判条件、再按权重抽取一个生效；列表为空时行为与旧版完全一致（不启用类型层）。'),
    list,
    button('+ 添加标记物类型', () => {
      if (cfg.markerTypes.length >= MAX_MARKER_TYPES) {
        toast(`标记物类型最多 ${MAX_MARKER_TYPES} 个`, 'warn');
        return;
      }
      const fallback = cfg.caMode.markerInteraction.states[0]
        || (cfg.caMode.states.find((s) => s.name === 'marker') || {}).name
        || cfg.caMode.states[1].name;
      cfg.markerTypes.push({
        id: `mk_${Math.random().toString(36).slice(2, 8)}`,
        name: `标记物 ${cfg.markerTypes.length + 1}`,
        enabled: true,
        state: fallback,
        weight: 1,
        color: '',
        symbol: '',
        render: '',
        condition: { type: 'always', value: 0 },
        effect: null,
      });
      rebuildAll();
    }, 'ghost'),
  ], { open: false, badge: cfg.markerTypes.length ? `${cfg.markerTypes.length} 个` : '' });
}

/* ---------------- 自定义障碍物类型（含陷阱属性） ---------------- */

/**
 * 自定义障碍物类型编辑器。
 * 除外观与引用状态外，每种障碍物可独立开启「陷阱」：先按触发概率判定是否触发，
 * 触发后再按死亡概率判定蛇是否死亡，两级判定都可写日志，便于调参。
 */
function obstacleTypesGroup(cfg) {
  const list = h('div', { class: 'rule-list' });
  cfg.obstacleTypes.forEach((t, i) => {
    const tr = t.trap;
    const body = [
      row(
        textBind(t, 'name', () => {}),
        chkBind(t, 'enabled', () => onSimChange(), '启用'),
        orderActions(
          button('↑', () => { swap(cfg.obstacleTypes, i, i - 1); rebuildAll(); }, 'icon small'),
          button('↓', () => { swap(cfg.obstacleTypes, i, i + 1); rebuildAll(); }, 'icon small'),
          button('✕', () => { cfg.obstacleTypes.splice(i, 1); rebuildAll(); }, 'icon small danger'),
        ),
      ),
      row(
        field('引用状态', select(t.state, typeStateOptions(), (v) => { t.state = v; onSimChange(); rebuildAll(); }),
          '撞到这个状态的格子即视为撞上本障碍物类型'),
        field('随机权重', numBind(t, 'weight', () => onSimChange(), { min: 0, step: 0.1 }),
          '「随机放置」模式按权重占比抽取类型'),
      ),
      row(
        field('外观配色', row(
          colorInput(t.color || '#868e96', (v) => { t.color = v; onSimChange(); }),
          button('继承', () => { t.color = ''; onSimChange(); rebuildAll(); }, 'ghost small'),
        ), '留空（点「继承」）表示沿用状态本身的颜色'),
        field('外观符号', typeSymbolInput(t), '留空表示沿用状态符号'),
        field('绘制方式', select(t.render || '', typeRenderOptions(), (v) => { t.render = v; onSimChange(); rebuildAll(); })),
      ),
      h('div', { class: 'sub-title' }, '陷阱属性'),
      switchField('启用陷阱', chkBind(tr, 'enabled', () => { onSimChange(); rebuildAll(); }, '启用'),
        '开启后：蛇尝试移动到本类型格子时先判「触发概率」，触发后再判「死亡概率」；格子会在画布上叠加危险标识'),
      tr.enabled ? row(
        field('触发概率', rangeBind(tr, 'triggerProbability', () => onSimChange(), { min: 0, max: 1, step: 0.01, number: true }),
          '蛇尝试移动到陷阱格时触发判定的几率（0 = 从不触发）'),
        field('死亡概率', rangeBind(tr, 'deathProbability', () => onSimChange(), { min: 0, max: 1, step: 0.01, number: true }),
          '触发后判定为死亡的几率（1 = 必死，0 = 只触发不死）'),
      ) : null,
      tr.enabled ? switchField('记录判定日志', chkBind(tr, 'log', () => onSimChange(), '写入运行日志'),
        '在「运行日志」中逐次记录触发 / 未触发 / 死亡判定，便于调试概率参数') : null,
    ];
    return list.appendChild(group(t.name || `障碍物 ${i + 1}`, body, {
      open: false,
      badge: tr.enabled ? '陷阱' : '',
      key: `ob:${t.id}`,
    }));
  });
  const trapCount = cfg.obstacleTypes.filter((t) => t.enabled && t.trap.enabled).length;
  return group('自定义障碍物类型', [
    h('div', { class: 'hint' }, '每种障碍物类型可独立配置外观、引用状态、随机权重与陷阱属性。列表至少保留一项（清空时会自动回退到内置「障碍物」）。'),
    list,
    button('+ 添加障碍物类型', () => {
      if (cfg.obstacleTypes.length >= MAX_OBSTACLE_TYPES) {
        toast(`障碍物类型最多 ${MAX_OBSTACLE_TYPES} 个`, 'warn');
        return;
      }
      cfg.obstacleTypes.push({
        id: `ob_${Math.random().toString(36).slice(2, 8)}`,
        name: `障碍物 ${cfg.obstacleTypes.length + 1}`,
        enabled: true,
        state: 'obstacle',
        weight: 1,
        color: '',
        symbol: '',
        render: '',
        trap: { enabled: false, triggerProbability: 1, deathProbability: 0.5, log: true },
      });
      rebuildAll();
    }, 'ghost'),
  ], { open: false, badge: trapCount ? `${trapCount} 个陷阱` : '' });
}

/* ---------------- 画布格子编辑器 ---------------- */

/** 「随机池」选择区：为空表示全部启用的障碍物类型 */
function obstaclePoolEditor(cfg) {
  const ce = cfg.cellEditor;
  const box = h('div', { class: 'chips' });
  const candidates = cfg.obstacleTypes.filter((t) => t.enabled);
  if (!candidates.length) box.appendChild(h('span', { class: 'mini-label' }, '没有启用的障碍物类型'));
  for (const t of candidates) {
    box.appendChild(h('button', {
      type: 'button',
      class: `chip${ce.randomPool.includes(t.id) ? ' on' : ''}`,
      title: `随机权重：${t.weight}`,
      onclick: () => {
        const i = ce.randomPool.indexOf(t.id);
        if (i >= 0) ce.randomPool.splice(i, 1);
        else ce.randomPool.push(t.id);
        onSimChange();
        rebuildAll();
      },
    }, `${t.name} · 权重 ${t.weight}`));
  }
  return box;
}

/**
 * 画布格子编辑器面板。
 * 除「点击增删」总开关外，把编辑效率相关的可选项（画笔尺寸 / 拖拽连画 / 右键擦除 /
 * 撤销历史 / 随机放置 / 一键散布）全部收敛到一处，每一项都可独立开关。
 */
function cellEditorGroup(cfg) {
  const ce = cfg.cellEditor;
  editorCountEl = h('div', { class: 'hint' }, '');
  // 「已绘制格数 · 可撤销步数」读数：编辑过程中由 syncEditorCount 就地刷新
  syncEditorCount();
  const markerOptions = [
    { value: '', label: '自动（交互标记物首项）' },
    ...cfg.markerTypes.filter((t) => t.enabled).map((t) => ({ value: t.id, label: t.name })),
  ];
  const obstacleOptions = [
    { value: '', label: '自动（首个启用的类型）' },
    ...cfg.obstacleTypes.filter((t) => t.enabled).map((t) => ({ value: t.id, label: t.name })),
  ];
  // 「元胞自动机状态」工具的可选状态：全部非空环境状态（含生命游戏的「存活」）
  const stateOptions = [
    { value: '', label: `自动（首个非空状态：${stateLabel(cellEditorStateName(cfg)) || '无'}）` },
    ...cfg.caMode.states.filter((s) => s.name !== 'empty')
      .map((s) => ({ value: s.name, label: stateLabelWithKey(s.name) })),
  ];
  // 「本次点击实际会写入哪个状态」的实时读数：把「自动」的解析结果摊开，避免选择歧义
  const placedStateLabel = h('div', { class: 'hint' },
    `本次点击将放置：${stateLabel(cellEditorStateName(cfg)) || '无'}（${cellEditorStateName(cfg) || '—'}）`);
  const body = [
    switchField('启用画布格子编辑', chkBind(ce, 'enabled', () => { onSimChange(); rebuildAll(); }, '启用'),
      '开启后：左键单击格子添加元素、再次单击同一格删除；关闭时点击画布仍是「跳到该格首次经过的步数」'),
  ];
  if (!ce.enabled) {
    body.push(h('div', { class: 'hint' }, '未启用：画布点击保持「跳转到首次经过步数」的原行为。'));
    return group('画布格子编辑器', body, { open: false });
  }
  body.push(
    h('div', { class: 'sub-title' }, '放置工具'),
    field('编辑工具', select(ce.tool, CELL_TOOLS.map((v) => ({ value: v, label: CELL_TOOL_LABELS[v] })), (v) => { ce.tool = v; onSimChange(); rebuildAll(); }),
      '标记物 / 障碍物 / 元胞自动机状态 / 擦除：擦除工具下点击即清空格子'),
    ce.tool === 'marker'
      ? field('标记物类型', select(ce.markerTypeId, markerOptions, (v) => { ce.markerTypeId = v; onSimChange(); rebuildAll(); }),
        '选择要放置的标记物类型；选「自动」时使用交互标记物状态中的首项')
      : null,
    ce.tool === 'state'
      ? field('目标状态', select(ce.stateName, stateOptions, (v) => { ce.stateName = v; onSimChange(); rebuildAll(); }),
        '把任意非空的环境状态直接写入格子（如生命游戏的「存活」＝alive）；选「自动」时取首个非空状态')
      : null,
    ce.tool === 'state' ? placedStateLabel : null,
    ce.tool === 'obstacle'
      ? switchField('随机放置模式', chkBind(ce, 'randomObstacle', () => { onSimChange(); rebuildAll(); }, '启用'),
        '开启后从「随机池」按权重抽取类型；关闭则用下方选中的类型精准放置')
      : null,
    ce.tool === 'obstacle' && !ce.randomObstacle
      ? field('障碍物类型', select(ce.obstacleTypeId, obstacleOptions, (v) => { ce.obstacleTypeId = v; onSimChange(); rebuildAll(); }),
        '先选类型再点击格子，实现精准放置')
      : null,
    ce.tool === 'obstacle' && ce.randomObstacle
      ? field('随机池', obstaclePoolEditor(cfg), '未选择任何类型时表示「全部启用的障碍物类型」')
      : null,
    ce.tool === 'obstacle' && ce.randomObstacle
      ? field('放置概率', rangeBind(ce, 'randomProbability', () => onSimChange(), { min: 0, max: 1, step: 0.01, number: true }),
        '每次点击有多大概率真的放置（低于 1 时可能出现「点了没放」）')
      : null,

    h('div', { class: 'sub-title' }, '编辑效率'),
    field('画笔尺寸', rangeBind(ce, 'brushSize', () => { onSimChange(); rebuildAll(); }, { min: 1, max: 9, step: 1, number: true }),
      'n×n 方块：以点击格为中心一次改写多格（画布上会预览实际范围）'),
    switchField('拖拽连画', chkBind(ce, 'drag', () => onSimChange(), '按住左键拖动连续绘制'),
      '默认开启：起手格已放置则本轮为连擦，否则为连画；整轮拖拽只记一条撤销历史'),
    switchField('右键擦除', chkBind(ce, 'rightClickErase', () => onSimChange(), '右键单击直接清空格子'),
      '仅在编辑模式下接管右键；关闭后右键恢复浏览器菜单'),
    field('撤销历史上限', numBind(ce, 'historyLimit', () => onSimChange(), { min: 0, max: 1000 }),
      '0 表示关闭历史记录；快捷键 Ctrl+Z 撤销、Ctrl+Shift+Z 或 Ctrl+Y 重做'),
    field('散布密度', rangeBind(ce, 'scatterDensity', () => onSimChange(), { min: 0, max: 1, step: 0.01 }),
      '「一键随机散布」按此密度在整个网格上随机落点'),
    row(
      button('一键随机散布', scatterPainted, 'ghost'),
      button('撤销', () => { if (!undoEdit()) toast('没有可撤销的编辑', 'info'); }, 'ghost'),
      button('重做', () => { if (!redoEdit()) toast('没有可重做的编辑', 'info'); }, 'ghost'),
      button('清空手绘', clearPainted, 'ghost danger'),
    ),
    editorCountEl,
  );
  return group('画布格子编辑器', body, { open: false, badge: `${ce.painted.length} 格` });
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
  // 互斥联动：本组的「启用」/「自撞即判定死亡」一旦让「自撞即判定死亡」生效，
  // 结束规则「撞到自身」就会被自动取消勾选。该规则的复选框位于另一个分组
  //（核心规则 → 结束规则），因此这里重建面板，让两处的勾选状态即时同步。
  const syncExclusive = (source) => {
    const closed = syncSelfCollisionExclusive(source);
    if (closed) toast('已自动关闭结束规则「撞到自身」：它与「自撞即判定死亡」互斥', 'info');
    rebuildAll();
  };
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
      chkBind(t, 'enabled', () => syncExclusive('enable'), '自撞致死后按概率并入环境')),
      '关闭时自撞完全沿用「碰撞与自撞处理 → 自撞处理」的原有策略'),
    field('自撞即判定死亡', chkBind(t, 'dieOnSelfCollision', () => syncExclusive('die'), '自撞即判定死亡（不结束运行）'),
      '与「结束规则 → 撞到自身」互斥：开启本项会自动取消勾选后者；关闭本项后后者可重新勾选'),
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
    const cb = checkbox(isOn, (v) => {
      if (numericKeys.includes('maxSteps')) ec.maxSteps = v ? endParamMemory.maxSteps : false;
      else ec[code] = v;
      syncDisabled.forEach((fn) => fn(v));
      notifyEndConditionSync(code, v);
      // 互斥联动：勾选「撞到自身」时自动关闭「蛇死亡转化 → 自撞即判定死亡」（位于另一个分组），
      // 因此需要重建面板，让两处的勾选状态即时同步，无需用户跳转过去手动修改。
      if (code === 'selfCollision') {
        const closed = syncSelfCollisionExclusive('selfCollision');
        if (closed) {
          toast('已自动关闭「自撞即判定死亡」：它与结束规则「撞到自身」互斥', 'info');
          rebuildAll();
          return;
        }
      }
      onSimChange();
    }, END_LABELS[code] || code);
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
      class: `end-row${isOn ? ' on' : ''}`,
      'data-end-code': code,
    }, rowChildren));
  });
  // 互斥提示：开启「自撞即判定死亡」等价于关闭本规则，这里给出说明与反手一键切换
  const dieActive = !!(cfg.transform.enabled && cfg.transform.dieOnSelfCollision);
  const enabledCount = ec.priority
    .filter((code) => (code === 'maxSteps' ? typeof ec.maxSteps === 'number' : !!ec[code])).length;
  return group('结束规则（按优先级）', [
    h('div', { class: 'hint' }, '自上而下依次判断，命中第一条满足条件的规则即结束运行；可用 ↑ ↓ 调整优先级。取消勾选「达到步数上限」后不再限制步数（仅受安全帧上限保护，可在控制条继续运行）。'),
    dieActive
      ? h('div', { class: 'hint end-hint-line' },
        '「撞到自身」已由「扩展机制 → 蛇死亡转化 → 自撞即判定死亡」自动关闭（二者互斥：自撞只让该移动体消失、不结束运行）。',
        button('一键改为「撞到自身」结束', () => {
          cfg.transform.dieOnSelfCollision = false;
          ec.selfCollision = true;
          rebuildAll();
          toast('已改为由结束规则「撞到自身」终止运行', 'success');
        }, 'ghost small'))
      : null,
    ...rows,
  ], { open: false, badge: `已启用 ${enabledCount} 项` });
}

/* ---------------- 展示样式（视觉显示主选项卡） ---------------- */

/*
 * 「视觉显示」曾用一层「子选项卡」来压缩首屏长度，但子选项卡的标题与内部折叠分组
 * 完全同名（如「基础视觉设置」），界面上于是出现
 * 「主选项卡 → 同名子选项卡 → 同名折叠分组 → 字段」四层，
 * 用户无法判断某个设置项究竟挂在子选项卡上还是分组上——多出来的那一层反而模糊了从属关系。
 *
 * 现在改为把四类视觉设置直接作为主选项卡下的折叠分组（与其它三个主选项卡结构完全一致），
 * 层级收敛为「主选项卡 → 折叠分组 → 字段」三层：
 *   - 分组默认收起，首屏只露出四行标题，无需再靠子选项卡压缩长度；
 *   - 每个分组沿用 group() 的深度配色、左侧色条与徽标，「属于哪一类、在哪一层」一眼可辨；
 *   - 设置搜索不再需要「搜索时展开全部子面板」的特殊处理，命中项始终落在同一套分组里。
 */

/** 视觉设置分组一：基础视觉设置（格子绘制 · 显示内容 · 环境显示 · 连接方式） */
function visualBasicGroup(cfg) {
  const s = cfg.style;
  return group('基础视觉设置', [
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
      checkbox(s.showCrossings, (v) => { s.showCrossings = v; onStyleChange(); }, '边界进出点'),
    ), '「边界进出点」与「轨迹」相互独立：默认关闭，可单独开启；即使关闭「轨迹」，进出点标记仍按播放进度依次出现'),
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
  ], { key: 'visual-basic', open: false });
}

/** 视觉设置分组二：高级视觉特效（轨迹衰减与配色 · 渲染效果 · 进出点标记） */
function visualEffectsGroup(cfg) {
  const s = cfg.style;
  return group('高级视觉特效', [
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
      checkbox(s.showEffects, (v) => { s.showEffects = v; onStyleChange(); }, '交互特效'),
      checkbox(s.glow, (v) => { s.glow = v; onStyleChange(); }, '蛇身发光'),
      checkbox(s.showEyes, (v) => { s.showEyes = v; onStyleChange(); }, '蛇头眼睛'),
    ), '「轨迹尖端平滑」让轨迹随蛇头平滑滑动（而非逐格跳变）；蛇头眼睛默认隐藏，勾选后显示'),
    field('进出点标记尺寸', rangeBind(s, 'crossingScale', () => onStyleChange(), { min: 0.4, max: 3, step: 0.1 }),
      '边界进出点标记（滑出空心环 / 滑入实心点）的尺寸倍数；仅在开启「边界进出点」时可见'),
  ], { key: 'visual-effects', open: false });
}

/** 视觉设置分组三：悬停与提示（重访高亮 · 行列准线 · 悬浮提示内容 · 穿越日志） */
function visualOverlayGroup(cfg) {
  const s = cfg.style;
  return group('悬停与提示', [
    switchField('重访格高亮',
      checkbox(s.showRevisit, (v) => { s.showRevisit = v; onStyleChange(); }, '开启'),
      '把「截至当前步数已被经过达到阈值」的格子标出来（与播放进度同步，不提前泄露后面的轨迹）'),
    field('重访判定次数', rangeBind(s, 'revisitMin', () => onStyleChange(), { min: 2, max: 20, step: 1, number: true }),
      '经过次数达到该值的格子视为重访；数值越大，只保留反复踩踏的热点格'),
    field('重访高亮不透明度', rangeBind(s, 'revisitAlpha', () => onStyleChange(), { min: 0.05, max: 0.6, step: 0.01 }),
      '重访格高亮的填充不透明度；调低可与轨迹叠加观察'),
    switchField('悬停行列准线',
      checkbox(s.hoverCrosshair, (v) => { s.hoverCrosshair = v; onStyleChange(); }, '开启'),
      '鼠标悬浮时高亮所在整行 / 整列并在格心画出十字导线，便于在大网格上定位坐标'),
    field('准线宽度', rangeBind(s, 'hoverCrosshairWidth', () => onStyleChange(), { min: 0.5, max: 4, step: 0.5 }),
      '行列准线中心导线的线宽；仅在开启「悬停行列准线」时可感知'),
    switchField('悬浮提示',
      checkbox(s.hoverTip, (v) => { s.hoverTip = v; onStyleChange(); }, '总开关'),
      '关闭后鼠标悬浮只保留画布高亮，不再弹出信息浮层'),
    field('提示内容', row(
      checkbox(s.hoverTipState, (v) => { s.hoverTipState = v; onStyleChange(); }, '环境状态'),
      checkbox(s.hoverTipAgent, (v) => { s.hoverTipAgent = v; onStyleChange(); }, '移动体'),
      checkbox(s.hoverTipTrail, (v) => { s.hoverTipTrail = v; onStyleChange(); }, '轨迹回溯'),
      checkbox(s.hoverTipMarkers, (v) => { s.hoverTipMarkers = v; onStyleChange(); }, '标记信息'),
    ), '提示内容与当前已开启的显示状态严格同步：起点/终点、边界进出点、轨迹、移动体等未开启的可视化元素不会出现在提示中；「轨迹回溯」包含首次 / 末次经过步数、当前路径经过次数与历史累计经过次数'),
    switchField('穿越事件日志',
      checkbox(cfg.events.logCrossings, (v) => { cfg.events.logCrossings = v; onSimChange(); }, '记录边界穿越到规则日志'),
      '开启后每次穿越边界都写入一条「边界穿越」日志（含滑出 / 滑入坐标），可在日志面板按规则过滤查看'),
  ], { key: 'visual-overlay', open: false });
}

/* ---------------- 色彩主题配置：选项卡配色 / 排版 / 界面读数 ---------------- */

/** 色值合法性：与 config.js 的 HEX_COLOR 保持一致 */
const HEX_COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * 选项卡配色的六个色槽（已激活 / 未激活 × 背景 / 文字 / 边框）。
 * tabColors 为纯界面配置，改动只需重绘样式变量并本地落盘，不触发模拟重算。
 */
const TAB_COLOR_FIELDS = [
  { key: 'activeBg', label: '激活 · 背景' },
  { key: 'activeText', label: '激活 · 文字' },
  { key: 'activeBorder', label: '激活 · 边框' },
  { key: 'inactiveBg', label: '未激活 · 背景' },
  { key: 'inactiveText', label: '未激活 · 文字' },
  { key: 'inactiveBorder', label: '未激活 · 边框' },
];

/** 单个色槽：取色器 + 十六进制文本框双向同步（文本框支持直接粘贴精确色值） */
function tabColorField(label, key) {
  const obj = state.cfg.style.tabColors;
  const picker = colorInput(obj[key], (v) => {
    obj[key] = v;
    text.value = v;
    commitUiPref();
    applyTabTheme();
  });
  const text = textInput(obj[key], (v) => {
    const val = String(v).trim();
    if (!HEX_COLOR_RE.test(val)) {
      toast('请输入合法的十六进制色值，如 #2f6da8', 'warn');
      text.value = obj[key];
      return;
    }
    obj[key] = val;
    picker.value = val;
    commitUiPref();
    applyTabTheme();
  }, { placeholder: '#2f6da8' });
  text.classList.add('tiny');
  return field(label, row(picker, text));
}

/** 视觉设置分组四：色彩主题配置（选项卡配色 · 排版 · 界面读数） */
function visualThemeGroup(cfg) {
  const s = cfg.style;
  return group('色彩主题配置', [
    h('div', { class: 'hint' }, '选项卡配色分为「已激活 / 未激活」两种状态，各含背景色、文字色、边框色三个色槽，可逐项自定义；未激活项默认压暗降饱和、激活项高亮配纯白文字，两态色差明显。'),
    h('div', { class: 'tab-preview' },
      h('span', { class: 'tab-demo on' }, '已激活'),
      h('span', { class: 'tab-demo' }, '未激活')),
    row(
      tabColorField(TAB_COLOR_FIELDS[0].label, 'activeBg'),
      tabColorField(TAB_COLOR_FIELDS[1].label, 'activeText'),
    ),
    row(
      tabColorField(TAB_COLOR_FIELDS[2].label, 'activeBorder'),
      tabColorField(TAB_COLOR_FIELDS[3].label, 'inactiveBg'),
    ),
    row(
      tabColorField(TAB_COLOR_FIELDS[4].label, 'inactiveText'),
      tabColorField(TAB_COLOR_FIELDS[5].label, 'inactiveBorder'),
    ),
    row(
      button('重置为默认配色', () => {
        Object.assign(s.tabColors, TAB_COLORS_DEFAULT);
        applyTabTheme();
        commitUiPref();
        renderConfigPanel();
        toast('已恢复默认选项卡配色', 'info');
      }, 'ghost small'),
    ),
    h('div', { class: 'divider' }),
    switchField('紧凑排版',
      checkbox(s.compact, (v) => { s.compact = v; applyTabTheme(); commitUiPref(); }, '开启'),
      '压缩分组、字段与统计格的间距，适合小屏或希望一屏看到更多设置项时'),
    switchField('统计切换淡入',
      checkbox(s.statFlash, (v) => { s.statFlash = v; commitUiPref(); }, '开启'),
      '切换实时 / 总计统计口径时数值做一次淡入过渡；低性能设备可关闭以减少重绘'),
    field('界面配置', row(
      checkbox(state.showScore, (v) => setShowScore(v), '得分 / 评级 / 难度 / 拥挤度'),
      checkbox(state.showRankToast, (v) => setShowRankToast(v), '排行榜第 1 名提示'),
    ), '均默认关闭；前者控制得分 / 评级 / 难度 / 拥挤度读数（地图最高分记录始终照常保存），后者控制本轮成绩进入本地排行榜第 1 名时的提示条（榜单本身照常记录）'),
  ], { key: 'visual-theme', open: false });
}

/**
 * 把选项卡配色与紧凑排版应用到界面。
 * 配色以 CSS 自定义属性写入根元素，由 styles.css 的选项卡规则消费；
 * 紧凑模式在 body 上挂 .compact 类，由样式表统一压缩间距。
 * 纯界面偏好，不影响画布渲染与模拟结果。
 */
function applyTabTheme() {
  const style = state.cfg && state.cfg.style ? state.cfg.style : {};
  const t = style.tabColors || TAB_COLORS_DEFAULT;
  const root = document.documentElement;
  root.style.setProperty('--tab-on-bg', t.activeBg);
  root.style.setProperty('--tab-on-text', t.activeText);
  root.style.setProperty('--tab-on-border', t.activeBorder);
  root.style.setProperty('--tab-off-bg', t.inactiveBg);
  root.style.setProperty('--tab-off-text', t.inactiveText);
  root.style.setProperty('--tab-off-border', t.inactiveBorder);
  if (document.body) document.body.classList.toggle('compact', !!style.compact);
}

/** 仅影响界面呈现的配置改动（选项卡配色 / 紧凑模式 / 统计项显隐）：本地落盘但不触发重算 */
function commitUiPref() {
  state.dirty = true;
  saveLocalConfig(state.cfg);
  writeAutoSave();
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
