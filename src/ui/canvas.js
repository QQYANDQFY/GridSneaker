/**
 * Canvas 渲染器
 * 只负责绘制：消费 Simulation.run() 输出的 frames，不参与任何模拟逻辑
 * 支持方格 / 六边形、轨迹渐变、方向箭头、障碍物与标记物、规则高亮、起点终点、坐标轴、暗黑模式
 */
import { dirLabel } from '../core/grid.js';
import { stateLabel } from '../core/world.js';
import { buildTrail, unwrapTrail, visitStatsAt, revisitReached } from '../core/trail.js';

export const STYLE_DEFAULTS = {
  cellSize: 26,
  gap: 2,
  darkMode: true,
  showGrid: true,
  showTrail: true,
  showBody: true,
  showArrows: false,
  showCoords: false,
  showObstacles: true,
  showMarkers: true,
  /** 陷阱格标识：为启用了陷阱的障碍物格叠加危险外框与警示符号 */
  showTraps: true,
  /** 陷阱标识色 */
  trapColor: '#ff4d4f',
  highlightRules: true,
  showStartEnd: true,
  trailFade: true,
  /**
   * 轨迹亮度衰减：按「离开头部的步数（age）」衰减，走满 fadeLength 步后完全淡出。
   * mode = linear 线性（等速变暗） · exponential 指数（先急后缓，观感更接近余晖）
   */
  fadeMode: 'linear',
  fadeLength: 60,
  /**
   * 轨迹颜色分级映射：fade 随新旧渐隐（默认）· visit 按该格经过次数（热度）· order 按经过次序
   */
  trailColorMode: 'fade',
  /** 轨迹尖端平滑过渡：播放到两帧之间时把轨迹头部补到步内位置，随蛇头平滑滑动而非逐格跳变 */
  trailSmooth: true,
  /**
   * 在轨迹接缝处标出边界进出点（滑出 / 滑入两侧各一个标记）。
   * 与轨迹主体完全独立（关闭「轨迹」后仍可单独显示），默认关闭。
   */
  showCrossings: false,
  /** 边界进出点标记的尺寸倍数 */
  crossingScale: 1,
  /** 蛇头眼睛默认隐藏，仅在用户主动开启「展示样式 → 蛇头眼睛」时按朝向绘制 */
  showEyes: false,
  /** 融合 / 排斥 / 生成 / 标记物反馈等交互特效波纹 */
  showEffects: true,
  /** 蛇身发光，突出移动体位置 */
  glow: false,
  /** 悬停行列准线：鼠标悬浮时高亮所在整行 / 整列，便于在大网格上定位，默认关闭 */
  hoverCrosshair: false,
  /** 行列准线的中心导线宽度 */
  hoverCrosshairWidth: 1,
  /** 重访格高亮：把截至当前步数已被经过 ≥ revisitMin 次的格子标出来，默认关闭 */
  showRevisit: false,
  /** 重访判定阈值：经过次数达到该值即视为重访 */
  revisitMin: 2,
  /** 重访格高亮的填充不透明度 */
  revisitAlpha: 0.22,
  /** 悬浮提示总开关 */
  hoverTip: true,
  /** 悬浮提示：环境状态行 */
  hoverTipState: true,
  /** 悬浮提示：移动体行 */
  hoverTipAgent: true,
  /** 悬浮提示：轨迹统计与经过次数回溯 */
  hoverTipTrail: true,
  /** 悬浮提示：起点 / 终点 / 边界进出点等标记信息（仍与对应显示开关同步） */
  hoverTipMarkers: true,
  /**
   * 单蛇场景的提示精简：画面中只有一条移动体时，提示里的「历史累计经过次数」
   * 与「轨迹」行的「共 N 次」完全同值（同一份轨迹模型的全量口径），属重复信息，
   * 开启后单蛇场景只保留随播放进度变化的「当前路径经过次数」；多蛇场景两条口径并存。
   */
  hoverTipSlimSingleSnake: true,
  /** 轨迹方向箭头：沿已播放的轨迹按间隔绘制指向前进方向的箭头，默认关闭 */
  showTrailArrows: false,
  /** 方向箭头的间隔（格）：数值越小箭头越密 */
  trailArrowSpacing: 3,
  /** 方向箭头的尺寸倍数 */
  trailArrowScale: 1,
  /** 方向箭头的颜色 */
  trailArrowColor: '#ffd43b',
  /**
   * 本步变化高亮：把「当前帧相对上一帧环境状态发生变化」的格子标出来
   * （元胞自动机演化、标记物生成 / 消耗、障碍物变化等），默认关闭。
   */
  showStepDiff: false,
  /** 本步变化高亮的填充不透明度 */
  stepDiffAlpha: 0.22,
  /** 本步变化高亮的颜色 */
  stepDiffColor: '#7cf5d0',
  /**
   * 热点轨迹过滤：只绘制「该格经过次数达到阈值」的轨迹段，
   * 让人一眼看出反复踩踏的热点路径，默认关闭（行为与旧版本一致）。
   */
  trailHotOnly: false,
  /** 热点轨迹的经过次数阈值 */
  trailHotMin: 3,
  /** 轨迹 / 蛇身的连接方式：curve 曲线（贝塞尔） · line 直线 · angle 按预设角度切角连接的直线 */
  trailJoin: 'line',
  bodyJoin: 'line',
  /** angle 模式下的预设角度（度） */
  trailAngle: 45,
  /** 由连接方式派生，保留以兼容旧配置 */
  smoothTrail: true,
  smoothBody: true,
};

/** 交互特效在画面上保留的步数（越近越亮，形成脉冲感） */
const EFFECT_LOOKBACK = 6;

/** 交互特效类型（由模拟层写入 frame.highlights） */
const EFFECT_TYPES = new Set([
  'merge', 'repel', 'spawn', 'markerEffect', 'agentDeath', 'wrap', 'transform', 'warning',
  // 生命机制：拾取增益 / 陷阱扣命 / 低生命预警 / 生命耗尽 / 原地重生
  'lifeGain', 'lifeLoss', 'lifeWarning', 'lifeDepleted', 'respawn',
]);

/** 蛇死亡转化特效的主色调（转化的收束圆环），与目标状态填充色叠加形成过渡 */
const TRANSFORM_ACCENT = '#7cf5d0';
/** 碰撞预警特效色（危险格脉冲提示） */
const WARNING_ACCENT = '#ffb020';
/** 生命机制：增益 / 扣命 / 重生 / 生命耗尽的主色调 */
const LIFE_GAIN_ACCENT = '#63e6be';
const LIFE_LOSS_ACCENT = '#ff6b6b';
const LIFE_RESPAWN_ACCENT = '#7cc4ff';
const LIFE_WARN_ACCENT = '#ffb020';

/** 自定义皮肤的两个可上传部位：head 绘制在蛇头，body 绘制在其余体节 */
const SKIN_KEYS = ['head', 'body'];

/** 轨迹渐隐的色阶数：把连续渐变量化成有限档，合并同档线段一次描边（长轨迹下显著减少绘制调用） */
const FADE_BUCKETS = 16;
/** 轨迹采样点之间的最大像素间距，超过则断开（避免跨边界/换移动体时连出直线） */
const RUN_GAP_CELLS = 1.7;
/** 轨迹最亮处（紧贴头部）的不透明度：向尾部一路衰减到 0，保证完全淡出 */
const FADE_MAX_ALPHA = 0.62;
/** 指数衰减的陡峭度：越大越「先急后缓」；两端归一后仍然精确到 0 */
const EXP_FADE_K = 6;

/**
 * 轨迹颜色分级色带（visit / order 模式下按热度 / 次序取色）。
 * fade 模式没有色带：颜色仍由亮度（新旧）唯一决定。
 */
const TRAIL_COLOR_RAMPS = {
  visit: ['#4dabf7', '#51cf66', '#ffd43b', '#ff922b', '#ff6b6b'],
  order: ['#9775fa', '#4dabf7', '#38d9a9', '#ffd43b', '#ff8787'],
};

/** 边界穿越标记：滑出点（空心环）与滑入点（实心点）的配色 */
const CROSSING_OUT = 'rgba(255, 212, 59, 0.9)';
const CROSSING_IN = 'rgba(77, 171, 247, 0.95)';

/** 悬停高亮（格子描边 + 行列准线）的主色 */
const HOVER_ACCENT = '#4dabf7';

/** 重访格高亮的填充与描边色（暖色，与轨迹 / 筛选高亮区分开） */
const REVISIT_FILL = 'rgba(255, 107, 107, 0.55)';
const REVISIT_STROKE = 'rgba(255, 138, 101, 0.95)';

/** 坐标筛选高亮的填充与描边色 */
const FILTER_FILL = 'rgba(255, 212, 59, 0.20)';
const FILTER_COLOR = 'rgba(255, 212, 59, 0.95)';

/** 多轨迹对比：基准轨迹虚线色 + 三类差异格配色 */
const COMPARE_BASE_COLOR = 'rgba(147, 161, 177, 0.9)';
const COMPARE_SHARED = { fill: 'rgba(255, 212, 59, 0.16)', stroke: 'rgba(255, 212, 59, 0.85)' };
const COMPARE_ONLY_BASE = { fill: 'rgba(255, 107, 107, 0.18)', stroke: 'rgba(255, 107, 107, 0.9)' };
const COMPARE_ONLY_OTHER = { fill: 'rgba(81, 207, 102, 0.18)', stroke: 'rgba(81, 207, 102, 0.9)' };

const THEME = {
  dark: { bg: '#0e1116', gridLine: '#232b36', fg: '#e6edf3', axis: '#7d8b9c', trailA: '#1d4e89', trailB: '#63b3ed' },
  light: { bg: '#f7f9fc', gridLine: '#d7dee7', fg: '#1f2933', axis: '#8b98a8', trailA: '#a9c8e8', trailB: '#2b6cb0' },
};

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.result = null;
    this.style = { ...STYLE_DEFAULTS };
    this.body = null;
    this.hover = null;
    /**
     * 陷阱状态集合（由界面从 obstacleTypes 注入）：仅这些状态的格子会叠加陷阱标识。
     * 空集合时渲染结果与旧版完全一致。
     */
    this.trapStates = new Set();
    /** 画布格子编辑模式：开启后悬浮高亮改为「画笔」样式（带尺寸预览） */
    this.editMode = false;
    /** 画笔尺寸（1 = 单格；n = 以光标为中心的 n×n 方块） */
    this.brushSize = 1;
    /** 画笔预览色（按当前工具 / 类型着色） */
    this.editAccent = '#7cc0ff';
    /** 轨迹模型：按经过时间升序的路径 + 逐格聚合信息（经过次序 / 次数 / 首末步） */
    this.trail = { path: [], order: [], info: new Map(), maxTick: 0 };
    this.trailInfo = new Map();
    /** 轨迹的连续展开像素坐标：穿越边界时相邻点仍只差一步（配合 trailRuns 的整圈平移绘制） */
    this.trailUn = null;
    this.trailRuns = [];
    /** 边界穿越标记（滑出 / 滑入两侧的像素坐标），与 trailUn 一起重建 */
    this.trailCrossings = [];
    /** 边界进出点的逐格索引：格下标 → { out:number[], in:number[] }（步数序列），供悬浮提示同步 */
    this.crossingCells = new Map();
    /** 当前绘制到的轨迹点下标（供穿越标记按播放进度筛选） */
    this.trailLo = 0;
    /** 重访格高亮缓存（按步数 / 阈值缓存，避免每帧全量重扫） */
    this._revisitCache = null;
    /** 热点轨迹掩码（按阈值 / 轨迹长度缓存，0 = 该点被过滤掉） */
    this.trailMask = null;
    this.trailMaskMin = 0;
    this.trailMaskLen = -1;
    /** 本步变化高亮缓存（按帧下标缓存「状态变化的格子」，避免每帧重新比较两份环境数组） */
    this._stepDiffCache = null;
    this.pixDirty = true;
    /** 颜色分级取值缓冲（按轨迹点下标）；fade 模式下为 null */
    this.trailCv = null;
    this.trailCvMode = '';
    /** 渐隐亮度进度缓冲（按段复用，避免每帧逐点分配） */
    this._fadeT = null;
    /** 渐隐档样式表缓存（主题 / 线宽 / 渐隐开关 / 颜色分级变化时重建） */
    this._fadeTable = null;
    /** 网格线离屏层：网格 / 尺寸 / 样式变化时重建 */
    this.gridLayer = null;
    this.gridDirty = true;
    /** 坐标筛选高亮：null 表示未启用；否则为格下标集合（独立离屏层，避免每帧重绘） */
    this.filterSet = null;
    this.filterLayer = null;
    this.filterDirty = true;
    /** 多轨迹对比叠加层：{ snapshot, diff }（同样走离屏层缓存） */
    this.compare = null;
    this.compareLayer = null;
    this.compareDirty = true;
    this.collisionPoints = [];
    this.startCoord = null;
    this.endCoord = null;
    /** 自定义皮肤：dataURL → Image 缓存；onSkinLoad 用于图片解码完成后触发重绘 */
    this.skinSrc = { head: '', body: '' };
    this.skinImg = { head: null, body: null };
    this.onSkinLoad = null;
    /** 蛇身皮肤离屏层：与主画布同尺寸，用于「描轮廓 → 图片蒙版填充」的合成 */
    this.skinLayer = null;
    this.size = { width: 0, height: 0, margin: 16 };
    this._scratchA = { x: 0, y: 0 };
  }

  setResult(result) {
    this.result = result;
    this.grid = result.grid;
    this.states = result.states;
    this.body = result.config.body;
    this.syncSkin();
    this.prepare();
    this.resize();
  }

  /** style 为展示样式；body 为移动体外观（形状/尺寸/配色），传入后立即生效，无需重算 */
  setStyle(style, body) {
    this.style = { ...STYLE_DEFAULTS, ...(style || {}) };
    if (body) this.body = body;
    this.syncSkin();
    this.pixDirty = true;
    this.filterDirty = true;
    this.resize();
  }

  /**
   * 同步自定义皮肤图片。
   * 配置中的 dataURL 与缓存不一致时重新解码；解码完成后回调 onSkinLoad 触发一次重绘。
   * 解码失败（文件损坏 / 非真实图片）时静默退回纯色绘制，不影响其余渲染。
   */
  syncSkin() {
    const skin = (this.body && this.body.skin) || {};
    for (const key of SKIN_KEYS) {
      const src = typeof skin[key] === 'string' ? skin[key] : '';
      if (this.skinSrc[key] === src) continue;
      this.skinSrc[key] = src;
      this.skinImg[key] = null;
      if (!src) continue;
      const img = new Image();
      img.onload = () => {
        if (this.skinSrc[key] !== src) return; // 加载期间皮肤已被替换 / 清除
        this.skinImg[key] = img;
        if (typeof this.onSkinLoad === 'function') this.onSkinLoad();
      };
      img.onerror = () => {
        if (this.skinSrc[key] !== src) return;
        this.skinSrc[key] = '';
      };
      img.src = src;
    }
  }

  /** 坐标筛选高亮：传入格下标集合（null / 空集表示关闭） */
  setFilter(indices) {
    this.filterSet = indices && indices.length ? new Set(indices) : null;
    this.filterDirty = true;
  }

  /**
   * 多轨迹对比叠加层。
   * @param {?{snapshot: object, diff: object}} compare 传入 null 关闭
   */
  setCompare(compare) {
    this.compare = compare || null;
    this.compareDirty = true;
  }

  /**
   * 预计算轨迹模型、碰撞点，避免每帧重复遍历。
   * 轨迹按经过时间升序保存，绘制时后经过的轨迹自然覆盖先经过的轨迹。
   */
  prepare() {
    const grid = this.grid;
    this.trail = buildTrail(grid, this.result.frames);
    this.trailInfo = this.trail.info;
    this._revisitCache = null;
    // 轨迹 / 环境都换了，热点掩码与本步变化高亮的缓存随之失效
    this.trailMask = null;
    this._stepDiffCache = null;
    this.prepareCrossingCells(grid);
    this.pixDirty = true;
    this.collisionPoints = [];

    for (const f of this.result.frames) {
      for (const [col, row] of f.collisions || []) {
        this.collisionPoints.push({ col, row, tick: f.tick });
      }
    }

    const firstFrame = this.result.frames[0];
    this.startCoord = firstFrame?.agents[0]?.segments?.[0] ? { col: firstFrame.agents[0].segments[0][0], row: firstFrame.agents[0].segments[0][1] } : null;
    const lastFrame = this.result.frames[this.result.frames.length - 1];
    this.endCoord = lastFrame?.agents[0]?.segments?.[0] ? { col: lastFrame.agents[0].segments[0][0], row: lastFrame.agents[0].segments[0][1] } : null;
  }

  /**
   * 边界进出点的逐格索引：把 unwrapTrail 解出的每一次接缝（滑出点 → 滑入点）
   * 反查到「格下标 → 该格作为滑出 / 滑入点的步数序列」。
   * 悬浮提示据此判断光标所在格是否为边界进出点，并给出对应步数；
   * 与画面标记同源（同一份 unwrapTrail 结果），因此两者永不脱节。
   */
  prepareCrossingCells(grid) {
    this.crossingCells = new Map();
    const path = this.trail.path;
    if (!path.length || grid.boundary !== 'wrap') return;
    const { crossings } = unwrapTrail(grid, path);
    for (const cr of crossings) {
      const out = path[cr.i - 1];
      const inn = path[cr.i];
      if (out) this.addCrossingCell(out.index, out.tick, 'out');
      if (inn) this.addCrossingCell(inn.index, inn.tick, 'in');
    }
  }

  addCrossingCell(index, tick, kind) {
    let rec = this.crossingCells.get(index);
    if (!rec) {
      rec = { out: [], in: [] };
      this.crossingCells.set(index, rec);
    }
    rec[kind].push(tick);
  }

  /**
   * 轨迹像素坐标 + 连续段缓存的惰性重建。
   * 播放时每帧都需要大量坐标换算，缓存后可避免重复的坐标计算与对象分配（长轨迹下的主要卡顿来源）。
   *
   * 边界穿越（wrap）时相邻两步的格坐标会「瞬移」到对侧，两个真实像素点相隔整张画面：
   * 旧实现按像素间距断段，跨缝的轨迹整段丢失（边缘格只显示半条轨迹）。
   * 这里改为与体节渲染同一套解算（见 unwrapTrail）：先沿轨迹累加环绕最短位移得到
   * 「连续展开坐标」，再把展开坐标按整圈平移折回网格区域附近，
   * 每段记录自己的整圈平移量 —— 段内相邻点恒差一步，跨缝处由前后两段的平移量衔接。
   */
  ensureTrailPix() {
    if (!this.pixDirty && this.trailUn && this.trailUn.length === this.trail.path.length * 2) return;
    const path = this.trail.path;
    const n = path.length;
    const un = new Float32Array(n * 2);
    // 轨迹变了，颜色分级取值缓冲与热点掩码随之失效
    this.trailCv = null;
    this.trailCvMode = '';
    this.trailMask = null;
    if (!n) {
      this.trailUn = un;
      this.trailRuns = [];
      this.trailCrossings = [];
      this.pixDirty = false;
      return;
    }
    const grid = this.grid;
    const width = grid.width;
    const height = grid.height;
    const { col, row, runs, crossings } = unwrapTrail(grid, path);
    // 整圈平移量（横向 width 格 / 纵向 height 格）对应的像素位移，用于把展开坐标折回网格区域
    const origin = this.center({ col: 0, row: 0 });
    const ax = this.center({ col: width, row: 0 }).x - origin.x;
    const ay = this.center({ col: width, row: 0 }).y - origin.y;
    const bx = this.center({ col: 0, row: height }).x - origin.x;
    const by = this.center({ col: 0, row: height }).y - origin.y;

    const scratch = this._scratchA;
    for (let i = 0; i < n; i++) {
      // 连续展开坐标：相邻点恒差一步，跨缝处也不会瞬移
      scratch.col = col[i];
      scratch.row = row[i];
      const u = this.center(scratch);
      un[i * 2] = u.x;
      un[i * 2 + 1] = u.y;
    }
    const segs = new Array(runs.length);
    for (let r = 0; r < runs.length; r++) {
      const run = runs[r];
      segs[r] = { from: run.from, to: run.to, ox: -(run.kx * ax + run.ky * bx), oy: -(run.kx * ay + run.ky * by) };
    }
    // 边界穿越标记：滑出侧取跨缝点的前一点（仍在网格内），滑入侧取跨缝点本身
    const marks = new Array(crossings.length);
    for (let c = 0; c < crossings.length; c++) {
      const cr = crossings[c];
      const oox = -(cr.okx * ax + cr.oky * bx);
      const ooy = -(cr.okx * ay + cr.oky * by);
      const nox = -(cr.nkx * ax + cr.nky * bx);
      const noy = -(cr.nkx * ay + cr.nky * by);
      marks[c] = {
        i: cr.i,
        outX: un[(cr.i - 1) * 2] + oox,
        outY: un[(cr.i - 1) * 2 + 1] + ooy,
        inX: un[cr.i * 2] + nox,
        inY: un[cr.i * 2 + 1] + noy,
      };
    }
    this.trailUn = un;
    this.trailRuns = segs;
    this.trailCrossings = marks;
    this.pixDirty = false;
  }

  resize() {
    if (!this.grid) return;
    const s = this.style;
    const margin = Math.max(16, Math.round(s.cellSize * 0.9));
    const size = this.grid.canvasSize(s.cellSize, s.gap, margin);
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    this.size = size;
    this.canvas.width = Math.max(1, Math.round(size.width * dpr));
    this.canvas.height = Math.max(1, Math.round(size.height * dpr));
    this.canvas.style.width = `${Math.round(size.width)}px`;
    this.canvas.style.height = `${Math.round(size.height)}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.pixDirty = true;
    this.filterDirty = true;
    this.compareDirty = true;
    this.gridDirty = true;
  }

  theme() {
    return this.style.darkMode ? THEME.dark : THEME.light;
  }

  center(c) {
    const p = this.grid.toPixel(c, this.style.cellSize, this.style.gap);
    return { x: p.x + this.size.margin, y: p.y + this.size.margin };
  }

  /**
   * 网格绘制区域（画布去掉四周留白）。
   * 穿越边界时体节会滑出该矩形，越界部分不画，改由对侧的镜像体节同步滑入，
   * 避免在留白区留下周期像或让体节横穿整张画面。
   */
  gridRect() {
    const m = this.size.margin;
    return { left: m, top: m, right: this.size.width - m, bottom: this.size.height - m };
  }

  /* ------------------------------------------------------------------ */

  /**
   * @param {number} frameIndex 帧下标（可为小数，用于帧间插值）
   * @param {number} alpha 帧间进度 [0,1)：0 表示正好停在该帧
   */
  draw(frameIndex, alpha = 0) {
    if (!this.result) return;
    const ctx = this.ctx;
    const s = this.style;
    const th = this.theme();
    const frames = this.result.frames;
    const i0 = Math.max(0, Math.min(frames.length - 1, Math.floor(frameIndex)));
    const frame = frames[i0];
    if (!frame) return;
    // 相邻帧之间按播放进度插值，得到亚步位移；抽样缓存（stride > 1）时按整段线性过渡，
    // 保证任意速度档位下运动都帧连续、过渡自然。
    const next = frames[i0 + 1];
    const t = next ? Math.max(0, Math.min(0.999, alpha)) : 0;
    const tickF = next ? frame.tick + (next.tick - frame.tick) * t : frame.tick;

    ctx.save();
    ctx.clearRect(0, 0, this.size.width, this.size.height);
    ctx.fillStyle = th.bg;
    ctx.fillRect(0, 0, this.size.width, this.size.height);

    if (s.showGrid) this.drawGrid();
    this.drawCells(frame, th);
    if (s.showTrail) this.drawTrail(frame, th, tickF);
    // 边界进出点与轨迹主体完全独立：关闭「轨迹」后仍按其自身开关单独绘制。
    // 未绘制轨迹时仍需按播放进度推进轨迹上界，标记才会随播放依次出现。
    else if (s.showCrossings) this.syncTrailCursor(tickF);
    // 方向箭头依附于轨迹：轨迹关闭时一并隐藏（上界已由 drawTrail / syncTrailCursor 推进）
    if (s.showTrail && s.showTrailArrows) this.drawTrailArrows(tickF);
    if (s.showCrossings) this.drawTrailCrossings();
    if (s.showStepDiff) this.drawStepDiff(i0, frame);
    if (s.showRevisit) this.drawRevisit(tickF);
    this.drawCompare();
    this.drawFilterHighlight();
    if (s.showEffects) this.drawEffects(i0);
    if (s.highlightRules) this.drawHighlights(frame);
    if (s.showBody) this.drawAgents(frame, t > 0 ? next : null, t);
    if (s.showStartEnd) this.drawStartEnd(frame);
    this.drawCollisions(frame);
    if (s.showCoords || s.axisLabels) this.drawAxis(th);
    if (this.hover && s.hoverCrosshair) this.drawHoverCrosshair();
    if (this.hover) this.drawHover();
    ctx.restore();
  }

  drawGrid() {
    this.ensureGridLayer();
    const layer = this.gridLayer;
    if (!layer) return;
    const ctx = this.ctx;
    ctx.drawImage(layer, 0, 0, layer.width, layer.height, 0, 0, this.size.width, this.size.height);
  }

  /**
   * 网格线离屏层：网格几何与配色只在网格 / 尺寸 / 样式变化时改变，
   * 缓存后每帧仅一次 drawImage，避免大网格下逐格 beginPath + stroke
   * （200×200 网格原来每帧约 4 万次描边，是渲染的主要开销之一）。
   */
  ensureGridLayer() {
    if (!this.gridDirty && this.gridLayer) return;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const w = this.size.width;
    const h = this.size.height;
    let layer = this.gridLayer;
    if (!layer) {
      layer = document.createElement('canvas');
      this.gridLayer = layer;
    }
    const pw = Math.max(1, Math.round(w * dpr));
    const ph = Math.max(1, Math.round(h * dpr));
    if (layer.width !== pw || layer.height !== ph) {
      layer.width = pw;
      layer.height = ph;
    }
    const lctx = layer.getContext('2d');
    lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    lctx.clearRect(0, 0, w, h);
    const { cellSize, gap } = this.style;
    lctx.lineWidth = 1;
    lctx.strokeStyle = this.theme().gridLine;
    const half = cellSize / 2 - gap / 2;
    for (const c of this.grid.allCoords()) {
      const p = this.center(c);
      if (this.grid.type === 'hex') {
        pathHex(lctx, p.x, p.y, cellSize / 2 - gap / 2);
      } else {
        roundRect(lctx, p.x - half, p.y - half, half * 2, half * 2, cellSize * 0.16);
      }
      lctx.stroke();
    }
    this.gridDirty = false;
  }

  drawCells(frame, th) {
    const ctx = this.ctx;
    const { cellSize, gap } = this.style;
    const s = this.style;
    const half = cellSize / 2 - gap / 2;
    for (let i = 0; i < frame.cells.length; i++) {
      const st = this.states[frame.cells[i]];
      if (!st || st.name === 'empty' || !st.color) continue;
      if (st.name === 'obstacle' && !s.showObstacles) continue;
      if (st.name === 'marker' && !s.showMarkers) continue;
      const c = this.grid.coord(i);
      const p = this.center(c);
      ctx.save();
      if (st.render === 'dot') {
        ctx.fillStyle = st.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, half * 0.52, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 0.35;
        ctx.strokeStyle = st.color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, half * 0.85, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        ctx.fillStyle = st.color;
        if (this.grid.type === 'hex') pathHex(ctx, p.x, p.y, half);
        else roundRect(ctx, p.x - half, p.y - half, half * 2, half * 2, cellSize * 0.16);
        ctx.fill();
        if (st.render === 'cross') {
          ctx.globalAlpha = 0.5;
          ctx.strokeStyle = th.darkMode ? '#0b0e12' : '#2b3440';
          ctx.lineWidth = Math.max(1, cellSize * 0.09);
          const k = half * 0.5;
          ctx.beginPath();
          ctx.moveTo(p.x - k, p.y - k);
          ctx.lineTo(p.x + k, p.y + k);
          ctx.moveTo(p.x + k, p.y - k);
          ctx.lineTo(p.x - k, p.y + k);
          ctx.stroke();
        }
      }
      ctx.restore();
    }
    // 陷阱格标识（独立于「显示障碍物」开关，有自己的 showTraps 开关）：
    // 危险色外框 + 中心警示符号，让「踩上去会死」的格子一眼可辨。
    if (s.showTraps !== false && this.trapStates && this.trapStates.size) {
      const trapColor = s.trapColor || '#ff4d4f';
      const outer = half + gap / 2;
      for (let i = 0; i < frame.cells.length; i++) {
        const st = this.states[frame.cells[i]];
        if (!st || !this.trapStates.has(st.name)) continue;
        const p = this.center(this.grid.coord(i));
        ctx.save();
        ctx.strokeStyle = trapColor;
        ctx.lineWidth = Math.max(1, cellSize * 0.08);
        ctx.beginPath();
        if (this.grid.type === 'hex') pathHex(ctx, p.x, p.y, outer);
        else roundRect(ctx, p.x - outer, p.y - outer, outer * 2, outer * 2, cellSize * 0.16);
        ctx.stroke();
        // 中心警示三角（危险标记）
        const k = half * 0.5;
        ctx.globalAlpha = 0.9;
        ctx.beginPath();
        ctx.moveTo(p.x - k, p.y + k * 0.8);
        ctx.lineTo(p.x, p.y - k * 0.9);
        ctx.lineTo(p.x + k, p.y + k * 0.8);
        ctx.closePath();
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  /**
   * 轨迹绘制：按「经过时间升序」绘制头部走过的格心。
   * 严格的时间顺序保证后经过的轨迹压在先经过的轨迹之上，
   * 新轨迹可以完全覆盖旧轨迹，不会再被旧轨迹阻塞 / 遮挡。
   *
   * 连接方式由 style.trailJoin 决定：
   *   curve 贝塞尔曲线串联（平滑）· line 直线段折线 · angle 按预设角度切角连接的直线型折线
   */
  drawTrail(frame, th, tickF) {
    const path = this.trail.path;
    if (!path.length) return;
    const tick = tickF === undefined ? frame.tick : tickF;
    // path 按 tick 升序：二分查找最后一个「经过时间 ≤ tick」的下标 + 1
    let lo = 0;
    let hi = path.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (path[mid].tick <= tick) lo = mid + 1;
      else hi = mid;
    }
    if (lo < 1) return;
    this.ensureTrailPix();
    this.ensureTrailCv();
    this.trailLo = lo;
    const mode = this.style.trailJoin;
    if (mode === 'curve' && lo > 1) this.drawTrailCurve(th, lo, tick);
    else if (mode === 'angle' && lo > 1) this.drawTrailAngle(th, lo, tick);
    else this.drawTrailLine(th, lo, tick);
  }

  /**
   * 轨迹方向箭头：沿「已经绘制到」的轨迹按固定间隔放置箭头，指向该处的前进方向。
   *
   * 间隔按像素距离累计（而非按轨迹点计数），因此转弯与直线上的箭头疏密一致；
   * 箭头亮度与轨迹渐隐 / 热点过滤同步（复用同一套段与亮度解算，过滤掉的段自然没有箭头），
   * 跨边界处按连续段绘制，不会在留白区留下指错方向的箭头。
   */
  drawTrailArrows(tick) {
    const lo = this.trailLo;
    if (lo < 2) return;
    const s = this.style;
    const spec = this.fadeSpec();
    const runs = this.trailRunsUpTo(lo, tick);
    if (!runs.length) return;
    const un = this.trailUn;
    const path = this.trail.path;
    const step = Math.max(1, Math.round(s.trailArrowSpacing) || 1) * (s.cellSize + s.gap);
    const size = Math.max(2, s.cellSize * 0.26 * (Number.isFinite(s.trailArrowScale) ? s.trailArrowScale : 1));
    const ctx = this.ctx;
    ctx.save();
    this.clipTrail();
    ctx.fillStyle = s.trailArrowColor || '#ffd43b';
    for (const run of runs) {
      let acc = 0;
      for (let k = run.from + 1; k <= run.to; k++) {
        const x0 = un[(k - 1) * 2] + run.ox;
        const y0 = un[(k - 1) * 2 + 1] + run.oy;
        const x1 = un[k * 2] + run.ox;
        const y1 = un[k * 2 + 1] + run.oy;
        acc += Math.hypot(x1 - x0, y1 - y0);
        if (acc < step) continue;
        acc = 0;
        const t = spec.on ? this.fadeProgress(tick - path[k].tick, spec) : 1;
        if (t <= 0) continue;
        this.drawTrailArrow(ctx, x1, y1, Math.atan2(y1 - y0, x1 - x0), size, t);
      }
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  /** 单个轨迹方向箭头：以 (x, y) 为尖端、朝向 ang 的实心三角 */
  drawTrailArrow(ctx, x, y, ang, size, t) {
    ctx.save();
    ctx.globalAlpha = 0.95 * Math.max(0, Math.min(1, t));
    ctx.translate(x, y);
    ctx.rotate(ang);
    ctx.beginPath();
    ctx.moveTo(size * 0.62, 0);
    ctx.lineTo(-size * 0.46, size * 0.52);
    ctx.lineTo(-size * 0.46, -size * 0.52);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  /**
   * 只推进轨迹上界、不描边轨迹。
   * 「边界进出点」独立于「轨迹」显示时，标记仍需按播放进度依次出现，
   * 因此这里复用与 drawTrail 完全相同的二分口径（保证两种显示方式下标记出现的时机一致）。
   */
  syncTrailCursor(tickF) {
    const path = this.trail.path;
    if (!path.length) return;
    let lo = 0;
    let hi = path.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (path[mid].tick <= tickF) lo = mid + 1;
      else hi = mid;
    }
    this.ensureTrailPix();
    this.trailLo = lo;
  }

  /**
   * 取 [0, lo) 范围内的轨迹点，并按连续段切分。
   * 段内保证步数连续、同一移动体，且坐标已按「展开坐标 + 整圈平移」给出连续折线
   * —— 跨边界处不再断开，穿越前后与接缝两侧的轨迹都能完整绘制。
   *
   * 亮度按「离开头部走过的步数 age = tick - 该点步数」衰减，而非按整段运行时长归一化：
   *   - 无论总步数是 50 还是 5000，尾巴都在固定 fadeLength 步内完整淡出；
   *   - age ≥ fadeLength 的点 alpha 已为 0，直接跳过（同时用二分把起点后移），
   *     高步数下不会再去遍历、量化、描边上万个早已看不见的点。
   *
   * 开启「热点轨迹过滤」时，被过滤掉的点在此处就切成断点：段内只保留连续的「热点点」，
   * 于是直线 / 切角 / 曲线三种连接方式都天然不会跨过被过滤的区间连线。
   */
  trailRunsUpTo(lo, tick) {
    const out = [];
    const src = this.trailRuns;
    const spec = this.fadeSpec();
    const mask = this.ensureTrailMask();
    const minTick = spec.on ? tick - spec.len : -Infinity;
    const path = this.trail.path;
    for (let ri = 0; ri < src.length; ri++) {
      const run = src[ri];
      if (run.from >= lo) break;
      const to = Math.min(run.to, lo - 1);
      if (to < run.from) continue;
      if (path[to].tick < minTick) continue; // 整段都已淡出，整段跳过
      let from = run.from;
      if (spec.on) {
        // 段内二分：第一个 age ≤ fadeLength 的点
        let loI = from;
        let hiI = to + 1;
        while (loI < hiI) {
          const mid = (loI + hiI) >> 1;
          if (path[mid].tick >= minTick) hiI = mid;
          else loI = mid + 1;
        }
        from = loI;
      }
      if (from > to) continue;
      if (!mask) {
        out.push({ from, to, ox: run.ox, oy: run.oy });
        continue;
      }
      let start = -1;
      for (let k = from; k <= to; k++) {
        if (mask[k]) {
          if (start < 0) start = k;
          continue;
        }
        if (start >= 0) {
          out.push({ from: start, to: k - 1, ox: run.ox, oy: run.oy });
          start = -1;
        }
      }
      if (start >= 0) out.push({ from: start, to, ox: run.ox, oy: run.oy });
    }
    return out;
  }

  /**
   * 计算段内各点的亮度进度，写入复用缓冲（下标与轨迹路径对齐）。
   * 逐点分配临时对象是长轨迹每帧的主要开销之一，这里改为按段复用的扁平数组。
   */
  fillFadeRun(from, to, tick, spec) {
    const path = this.trail.path;
    let ft = this._fadeT;
    if (!ft || ft.length < path.length) ft = this._fadeT = new Float32Array(path.length);
    // 关闭渐隐时整条轨迹统一亮度（全为 1），也就不必按亮度分桶
    if (!spec.on) {
      for (let k = from; k <= to; k++) ft[k] = 1;
      return ft;
    }
    for (let k = from; k <= to; k++) ft[k] = this.fadeProgress(tick - path[k].tick, spec);
    return ft;
  }

  /** 把段内下标物化为点列 {x,y,gi,t,cv}（供切角 / 贝塞尔几何复用既有实现） */
  runPoints(run, tick, spec) {
    const un = this.trailUn;
    const cv = this.trailCv;
    const path = this.trail.path;
    const pts = [];
    for (let k = run.from; k <= run.to; k++) {
      const t = spec.on ? this.fadeProgress(tick - path[k].tick, spec) : 1;
      if (t <= 0) continue;
      pts.push({ x: un[k * 2] + run.ox, y: un[k * 2 + 1] + run.oy, gi: k, t, cv: cv ? cv[k] : 0 });
    }
    return pts;
  }

  /** 轨迹渐隐参数（衰减开关 / 步长 / 模式） */
  fadeSpec() {
    const s = this.style;
    const len = Math.max(1, Number.isFinite(s.fadeLength) ? s.fadeLength : STYLE_DEFAULTS.fadeLength);
    return { on: !!s.trailFade, len, mode: s.fadeMode === 'exponential' ? 'exponential' : 'linear' };
  }

  /**
   * 亮度进度 t ∈ [0,1]：1 = 紧贴头部（最亮、最粗），0 = 已完全淡出。
   * 两种模式都在 age ≥ fadeLength 处精确归零（而非留一个最小不透明度），
   * 因此高步数下尾巴会被彻底擦掉，不会出现「整条轨迹常亮」。
   */
  fadeProgress(age, spec) {
    const p = Math.max(0, Math.min(1, age / spec.len));
    if (spec.mode === 'exponential') {
      const k = EXP_FADE_K;
      return (Math.exp(-k * p) - Math.exp(-k)) / (1 - Math.exp(-k));
    }
    return 1 - p;
  }

  /** 按亮度进度 t 计算描边参数（越接近 1 越新：越亮、越粗；t = 0 时 alpha 为 0） */
  fadeAt(th, t, baseWidth) {
    if (!this.style.trailFade) return { alpha: 0.34, color: th.trailB, width: baseWidth };
    const a = Math.max(0, Math.min(1, t));
    return {
      alpha: FADE_MAX_ALPHA * a,
      color: lerpColor(th.trailA, th.trailB, a),
      width: Math.max(0.5, baseWidth * (0.45 + 0.55 * a)),
    };
  }

  /** 渐隐量化档：同档的相邻线段合并为一次描边，长轨迹下显著减少绘制调用 */
  fadeBucket(t) {
    return Math.max(0, Math.min(FADE_BUCKETS - 1, Math.floor(t * FADE_BUCKETS)));
  }

  /** 当前颜色分级色带（fade 模式返回 null：颜色只由新旧亮度决定） */
  colorRamp() {
    return TRAIL_COLOR_RAMPS[this.style.trailColorMode] || null;
  }

  /**
   * 颜色分级取值缓冲（按轨迹点下标，∈ [0,1]）：visit 用经过次数热度，order 用经过次序。
   * 只与轨迹模型有关，因此一次构建、逐帧复用；fade 模式下不构建。
   */
  ensureTrailCv() {
    const mode = TRAIL_COLOR_RAMPS[this.style.trailColorMode] ? this.style.trailColorMode : 'fade';
    if (mode === 'fade') {
      this.trailCv = null;
      this.trailCvMode = '';
      return null;
    }
    const n = this.trail.path.length;
    if (this.trailCv && this.trailCvMode === mode && this.trailCv.length === n) return this.trailCv;
    const cv = new Float32Array(n);
    const info = this.trail.info;
    let maxVisits = 1;
    for (const cell of info.values()) if (cell.visits > maxVisits) maxVisits = cell.visits;
    const vDen = Math.max(1, maxVisits - 1);
    const oDen = Math.max(1, this.trail.order.length - 1);
    const path = this.trail.path;
    for (let i = 0; i < n; i++) {
      const cell = info.get(path[i].index);
      if (!cell) continue;
      cv[i] = mode === 'visit' ? (cell.visits - 1) / vDen : (cell.order - 1) / oDen;
    }
    this.trailCv = cv;
    this.trailCvMode = mode;
    return cv;
  }

  /**
   * 描边样式组合档 = 亮度档 × 颜色档。
   * fade 模式没有色带（cols = 1），颜色由亮度唯一决定，组合档退化回单一亮度档。
   */
  styleBucket(t, cv, cols) {
    const ab = this.fadeBucket(t);
    return cols === 1 ? ab : ab * cols + this.fadeBucket(cv);
  }

  /**
   * 渐隐档样式表：把每一档的描边参数（颜色 / 不透明度 / 线宽）预先算好。
   * 逐段重新插值配色并拼接颜色字符串是每帧描边的主要开销，
   * 按档量化后每帧只需一次查表（主题 / 线宽 / 渐隐开关 / 颜色分级变化时才重建）。
   */
  fadeStyleTable(th, baseWidth) {
    const ramp = this.colorRamp();
    const cols = ramp ? FADE_BUCKETS : 1;
    const c = this._fadeTable;
    // ramp 必须进入缓存键：热度 / 次序两种分级的档数都是 FADE_BUCKETS，
    // 只比较 cols 会把「按经过次数」与「按经过次序」视为同一张表，
    // 于是切换颜色分级后仍沿用旧色带（需等主题 / 线宽 / 渐隐开关变化才刷新）。
    if (c && c.th === th && c.baseWidth === baseWidth && c.fade === !!this.style.trailFade
      && c.cols === cols && c.ramp === ramp) return c;
    const size = FADE_BUCKETS * cols;
    const alphas = new Float64Array(size);
    const widths = new Float64Array(size);
    const colors = new Array(size);
    for (let ab = 0; ab < FADE_BUCKETS; ab++) {
      const base = this.fadeAt(th, (ab + 0.5) / FADE_BUCKETS, baseWidth);
      for (let cb = 0; cb < cols; cb++) {
        const i = ab * cols + cb;
        alphas[i] = base.alpha;
        widths[i] = base.width;
        colors[i] = ramp ? paletteColor(ramp, (cb + 0.5) / FADE_BUCKETS) : base.color;
      }
    }
    const table = { th, baseWidth, fade: !!this.style.trailFade, cols, ramp, alphas, widths, colors };
    this._fadeTable = table;
    return table;
  }

  /**
   * 热点轨迹掩码：按「该格的经过次数 ≥ 阈值」逐点标记（1 = 保留，0 = 过滤）。
   *
   * 掩码交给 trailRunsUpTo() 把被过滤的点切成段断点：段内只保留连续的热点点，
   * 于是热点过滤自动适配三种连接方式（直线 / 切角 / 曲线）与两种颜色分级，
   * 无需为每种几何单独实现，也不会跨过被过滤的区间连线。
   * 经过次数取整轮口径（与「按经过次数取色」一致），因此过滤结果稳定，
   * 不会随播放进度反复显隐；阈值或轨迹变化时重建。
   */
  ensureTrailMask() {
    if (!this.style.trailHotOnly) {
      this.trailMask = null;
      return null;
    }
    const min = Math.max(2, Math.round(this.style.trailHotMin) || 2);
    const n = this.trail.path.length;
    if (this.trailMask && this.trailMaskMin === min && this.trailMaskLen === n) return this.trailMask;
    const path = this.trail.path;
    const info = this.trailInfo;
    const mask = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const cell = info.get(path[i].index);
      mask[i] = cell && cell.visits >= min ? 1 : 0;
    }
    this.trailMask = mask;
    this.trailMaskMin = min;
    this.trailMaskLen = n;
    return mask;
  }

  /**
   * 轨迹绘制外层：把绘制裁剪到网格区域。
   * 跨缝时折回对侧的镜像段只应出现在网格内，避免落到四周留白区。
   */
  clipTrail() {
    const ctx = this.ctx;
    const rect = this.gridRect();
    ctx.save();
    ctx.beginPath();
    ctx.rect(rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top);
    ctx.clip();
  }

  /**
   * 轨迹尖端平滑过渡：播放位置落在两步之间时，把轨迹头部沿展开坐标补到步内位置，
   * 让轨迹随蛇头平滑滑动（与体节的帧间插值一致），而不是逐格跳变。
   * 只在头部与下一个轨迹点同属一段（同移动体、步数连续、且落在同一展开段）时补画，
   * 因此补出的这一小段永远不会横穿画面。
   * @returns {{x0:number,y0:number,x1:number,y1:number,gi:number}|null}
   */
  smoothHead(lo, tick) {
    if (!this.style.trailSmooth) return null;
    const path = this.trail.path;
    if (lo < 1 || lo >= path.length) return null;
    const a = path[lo - 1];
    const b = path[lo];
    if (b.tick - a.tick !== 1 || b.agent !== a.agent) return null;
    const f = tick - a.tick;
    if (!(f > 0)) return null;
    const runs = this.trailRuns;
    let run = null;
    for (let i = runs.length - 1; i >= 0; i--) {
      if (runs[i].from <= lo - 1 && runs[i].to >= lo) {
        run = runs[i];
        break;
      }
    }
    if (!run) return null;
    const un = this.trailUn;
    const x0 = un[(lo - 1) * 2] + run.ox;
    const y0 = un[(lo - 1) * 2 + 1] + run.oy;
    const x1 = un[lo * 2] + run.ox;
    const y1 = un[lo * 2 + 1] + run.oy;
    const k = f > 1 ? 1 : f;
    return { x0, y0, x1: x0 + (x1 - x0) * k, y1: y0 + (y1 - y0) * k, gi: lo };
  }

  /** 补画轨迹尖端（紧贴头部的最亮一小段），与体节的帧间插值保持同步 */
  strokeSmoothTip(th, lo, tick, baseWidth) {
    const tip = this.smoothHead(lo, tick);
    if (!tip) return;
    const ctx = this.ctx;
    const tab = this.fadeStyleTable(th, baseWidth);
    const cv = this.trailCv;
    const b = this.styleBucket(1, cv && lo - 1 < cv.length ? cv[lo - 1] : 0, tab.cols);
    ctx.globalAlpha = tab.alphas[b];
    ctx.strokeStyle = tab.colors[b];
    ctx.lineWidth = tab.widths[b];
    ctx.beginPath();
    ctx.moveTo(tip.x0, tip.y0);
    ctx.lineTo(tip.x1, tip.y1);
    ctx.stroke();
  }

  /**
   * 边界进出点标记：在接缝两侧各画一个标记 ——
   * 滑出侧为空心环（仍位于网格内的最后一点），滑入侧为实心点（从对侧出现的第一点）。
   * 只标记已经绘制到的穿越事件（下标小于当前轨迹上界），标记随播放推进依次出现。
   * 标记尺寸由 style.crossingScale 缩放；本方法不依赖轨迹是否绘制（与轨迹主体完全独立）。
   */
  drawTrailCrossings() {
    const marks = this.trailCrossings;
    if (!marks || !marks.length) return;
    const ctx = this.ctx;
    const lo = this.trailLo;
    const scale = Number.isFinite(this.style.crossingScale) ? this.style.crossingScale : 1;
    const r = Math.max(1.2, this.style.cellSize * 0.12 * scale);
    ctx.save();
    this.clipTrail();
    ctx.lineWidth = Math.max(1, r * 0.55);
    for (const m of marks) {
      if (m.i >= lo) continue;
      ctx.strokeStyle = CROSSING_OUT;
      ctx.beginPath();
      ctx.arc(m.outX, m.outY, r * 1.5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = CROSSING_IN;
      ctx.beginPath();
      ctx.arc(m.inX, m.inY, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /**
   * 重访格高亮：把「截至当前步数已被经过 ≥ revisitMin 次」的格子标出来。
   * 判定与播放进度同步（未走过的格与尚未形成重访的格都不标），
   * 因此不会提前泄露后面的轨迹；结果按步数 / 阈值缓存，逐帧播放不重复全量扫描。
   */
  drawRevisit(tick) {
    const cells = this.revisitCells(tick);
    if (!cells.length) return;
    const ctx = this.ctx;
    const s = this.style;
    const half = (s.cellSize - s.gap) / 2;
    const alpha = Number.isFinite(s.revisitAlpha) ? s.revisitAlpha : 0.22;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = REVISIT_FILL;
    ctx.strokeStyle = REVISIT_STROKE;
    ctx.lineWidth = Math.max(1, s.cellSize * 0.06);
    for (const info of cells) {
      const p = this.center(info);
      if (this.grid.type === 'hex') pathHex(ctx, p.x, p.y, half * 0.92);
      else roundRect(ctx, p.x - half, p.y - half, half * 2, half * 2, s.cellSize * 0.18);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  /** 截至 tick 已经达到重访阈值的格子信息（按步数 / 阈值缓存） */
  revisitCells(tick) {
    const min = Math.max(2, Math.round(this.style.revisitMin) || 2);
    const cache = this._revisitCache;
    if (cache && cache.tick === tick && cache.min === min) return cache.cells;
    const cells = [];
    if (this.trailInfo && this.trailInfo.size) {
      for (const info of this.trailInfo.values()) {
        if (revisitReached(info, tick, min)) cells.push(info);
      }
    }
    this._revisitCache = { tick, min, cells };
    return cells;
  }

  /**
   * 帧间变化高亮：把「当前帧与上一帧环境状态不同」的格子标出来 ——
   * 元胞自动机的出生 / 死亡、标记物的生成与消耗、障碍物增删都能一眼看到。
   *
   * 帧按采样步长存储（长跑时 frameStride 会翻倍），因此两帧之间可能相隔多步，
   * 此时高亮的是这段间隔内的净变化；比较结果按帧下标缓存，
   * 播放中同一帧被反复重绘时不会重复遍历两份环境数组。
   */
  drawStepDiff(i0, frame) {
    const prev = this.result.frames[i0 - 1];
    if (!prev) return;
    const cache = this._stepDiffCache;
    let cells;
    if (cache && cache.i0 === i0 && cache.frame === frame && cache.prev === prev) {
      cells = cache.cells;
    } else {
      cells = [];
      const a = frame.cells;
      const b = prev.cells;
      const n = Math.min(a.length, b.length);
      for (let i = 0; i < n; i++) if (a[i] !== b[i]) cells.push(i);
      this._stepDiffCache = { i0, frame, prev, cells };
    }
    if (!cells.length) return;
    const ctx = this.ctx;
    const s = this.style;
    const color = s.stepDiffColor || '#7cf5d0';
    const half = (s.cellSize - s.gap) / 2;
    ctx.save();
    ctx.globalAlpha = Number.isFinite(s.stepDiffAlpha) ? s.stepDiffAlpha : 0.22;
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1, s.cellSize * 0.07);
    for (const i of cells) {
      const p = this.center(this.grid.coord(i));
      if (this.grid.type === 'hex') pathHex(ctx, p.x, p.y, half * 0.92);
      else roundRect(ctx, p.x - half, p.y - half, half * 2, half * 2, s.cellSize * 0.18);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * 悬停行列准线：把光标所在整行 / 整列以淡色带标出，并在格心画一条十字导线，
   * 便于在大网格上快速定位坐标；绘制范围裁剪到网格区域，不侵入四周留白。
   */
  drawHoverCrosshair() {
    const ctx = this.ctx;
    const s = this.style;
    const { cellSize, gap } = s;
    const p = this.center(this.hover);
    const rect = this.gridRect();
    const w = rect.right - rect.left;
    const h = rect.bottom - rect.top;
    const pitch = cellSize + gap;
    const lw = Number.isFinite(s.hoverCrosshairWidth) ? s.hoverCrosshairWidth : 1;
    ctx.save();
    ctx.beginPath();
    ctx.rect(rect.left, rect.top, w, h);
    ctx.clip();
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = HOVER_ACCENT;
    ctx.fillRect(p.x - pitch / 2, rect.top, pitch, h);
    ctx.fillRect(rect.left, p.y - pitch / 2, w, pitch);
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = HOVER_ACCENT;
    ctx.lineWidth = Math.max(0.5, lw);
    ctx.beginPath();
    ctx.moveTo(p.x, rect.top);
    ctx.lineTo(p.x, rect.bottom);
    ctx.moveTo(rect.left, p.y);
    ctx.lineTo(rect.right, p.y);
    ctx.stroke();
    ctx.restore();
  }

  /** 直线型轨迹：直接在展开坐标缓存上描边，不物化点对象 */
  drawTrailLine(th, lo, tick) {
    const ctx = this.ctx;
    const { cellSize, gap } = this.style;
    const baseWidth = Math.max(1.5, (cellSize - gap) * 0.34);
    const spec = this.fadeSpec();
    const runs = this.trailRunsUpTo(lo, tick);
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    this.clipTrail();
    for (const run of runs) this.strokeRun(th, run, baseWidth, tick, spec);
    this.strokeSmoothTip(th, lo, tick, baseWidth);
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  /**
   * 段描边（无分配）：直接读展开坐标缓存与复用亮度缓冲，
   * 按渐隐档分桶把同档的相邻线段合并为一次描边 —— 长轨迹下显著减少绘制调用。
   */
  strokeRun(th, run, baseWidth, tick, spec) {
    const ctx = this.ctx;
    const un = this.trailUn;
    const cv = this.trailCv;
    const ft = this.fillFadeRun(run.from, run.to, tick, spec);
    const tab = this.fadeStyleTable(th, baseWidth);
    const cols = tab.cols;
    const end = run.to;
    let start = run.from;
    while (start <= end && ft[start] <= 0) start++; // 已完全淡出的点直接跳过
    if (start > end) return;
    if (start === end) {
      const b = this.styleBucket(ft[start], cv ? cv[start] : 0, cols);
      ctx.globalAlpha = tab.alphas[b];
      ctx.fillStyle = tab.colors[b];
      ctx.beginPath();
      ctx.arc(un[start * 2] + run.ox, un[start * 2 + 1] + run.oy, baseWidth * 0.5, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    let bucket = this.styleBucket((ft[start] + ft[start + 1]) / 2, cv ? (cv[start] + cv[start + 1]) / 2 : 0, cols);
    for (let k = start + 1; k <= end; k++) {
      const next = k < end
        ? this.styleBucket((ft[k] + ft[k + 1]) / 2, cv ? (cv[k] + cv[k + 1]) / 2 : 0, cols)
        : -1;
      if (next === bucket) continue;
      ctx.globalAlpha = tab.alphas[bucket];
      ctx.strokeStyle = tab.colors[bucket];
      ctx.lineWidth = tab.widths[bucket];
      ctx.beginPath();
      ctx.moveTo(un[start * 2] + run.ox, un[start * 2 + 1] + run.oy);
      for (let j = start + 1; j <= k; j++) ctx.lineTo(un[j * 2] + run.ox, un[j * 2 + 1] + run.oy);
      ctx.stroke();
      start = k;
      bucket = next;
    }
  }

  /** 按预设角度切角连接的直线型轨迹 */
  drawTrailAngle(th, lo, tick) {
    const ctx = this.ctx;
    const { cellSize, gap } = this.style;
    const baseWidth = Math.max(1.5, (cellSize - gap) * 0.34);
    const spec = this.fadeSpec();
    const runs = this.trailRunsUpTo(lo, tick);
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    this.clipTrail();
    for (const run of runs) {
      const pts = this.runPoints(run, tick, spec);
      if (!pts.length) continue;
      this.strokePolyline(th, pts.length === 1 ? pts : bevelChain(pts, this.style.trailAngle), baseWidth);
    }
    this.strokeSmoothTip(th, lo, tick, baseWidth);
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  /** 折线描边：按渐隐档分桶，同档的相邻段合并成一条路径只描一次 */
  strokePolyline(th, run, baseWidth) {
    const ctx = this.ctx;
    const last = run.length - 1;
    const tab = this.fadeStyleTable(th, baseWidth);
    const cols = tab.cols;
    if (last === 0) {
      const b = this.styleBucket(run[0].t, run[0].cv, cols);
      ctx.globalAlpha = tab.alphas[b];
      ctx.fillStyle = tab.colors[b];
      ctx.beginPath();
      ctx.arc(run[0].x, run[0].y, baseWidth * 0.5, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    let start = 0;
    let bucket = this.styleBucket((run[0].t + run[1].t) / 2, (run[0].cv + run[1].cv) / 2, cols);
    for (let k = 1; k <= last; k++) {
      const next = k < last
        ? this.styleBucket((run[k].t + run[k + 1].t) / 2, (run[k].cv + run[k + 1].cv) / 2, cols)
        : -1;
      if (next === bucket) continue;
      ctx.globalAlpha = tab.alphas[bucket];
      ctx.strokeStyle = tab.colors[bucket];
      ctx.lineWidth = tab.widths[bucket];
      ctx.beginPath();
      ctx.moveTo(run[start].x, run[start].y);
      for (let j = start + 1; j <= k; j++) ctx.lineTo(run[j].x, run[j].y);
      ctx.stroke();
      start = k;
      bucket = next;
    }
  }

  /** 曲线型轨迹：把已访问格心用贝塞尔曲线串联（Catmull-Rom），形成连续平滑的轨迹 */
  drawTrailCurve(th, lo, tick) {
    const ctx = this.ctx;
    const { cellSize, gap } = this.style;
    const baseWidth = Math.max(1.5, (cellSize - gap) * 0.34);
    const spec = this.fadeSpec();
    const runs = this.trailRunsUpTo(lo, tick);
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    this.clipTrail();
    for (const run of runs) {
      const run_ = this.runPoints(run, tick, spec);
      if (!run_.length) continue;
      if (run_.length === 1) {
        this.strokePolyline(th, run_, baseWidth);
        continue;
      }
      const segs = bezierSegments(run_);
      const tab = this.fadeStyleTable(th, baseWidth);
      const cols = tab.cols;
      let start = 0;
      let bucket = this.styleBucket((run_[0].t + run_[1].t) / 2, (run_[0].cv + run_[1].cv) / 2, cols);
      for (let k = 1; k <= segs.length; k++) {
        const next = k < segs.length
          ? this.styleBucket((run_[k].t + run_[k + 1].t) / 2, (run_[k].cv + run_[k + 1].cv) / 2, cols)
          : -1;
        if (next === bucket) continue;
        ctx.globalAlpha = tab.alphas[bucket];
        ctx.strokeStyle = tab.colors[bucket];
        ctx.lineWidth = tab.widths[bucket];
        ctx.beginPath();
        ctx.moveTo(segs[start].p0.x, segs[start].p0.y);
        for (let j = start; j < k; j++) {
          const sg = segs[j];
          ctx.bezierCurveTo(sg.c1.x, sg.c1.y, sg.c2.x, sg.c2.y, sg.p1.x, sg.p1.y);
        }
        ctx.stroke();
        start = k;
        bucket = next;
      }
    }
    this.strokeSmoothTip(th, lo, tick, baseWidth);
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  /* --------------------------- 坐标筛选高亮 --------------------------- */

  /**
   * 筛选高亮离屏层：筛选集合不变时复用上一帧的图层，只做一次 drawImage，
   * 避免每帧对成百上千个格做描边。
   */
  ensureFilterLayer() {
    if (!this.filterDirty && this.filterLayer) return;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const w = this.size.width;
    const h = this.size.height;
    let layer = this.filterLayer;
    if (!layer) {
      layer = document.createElement('canvas');
      this.filterLayer = layer;
    }
    const pw = Math.max(1, Math.round(w * dpr));
    const ph = Math.max(1, Math.round(h * dpr));
    if (layer.width !== pw || layer.height !== ph) {
      layer.width = pw;
      layer.height = ph;
    }
    const lctx = layer.getContext('2d');
    lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    lctx.clearRect(0, 0, w, h);
    const set = this.filterSet;
    if (set && set.size) {
      const { cellSize, gap } = this.style;
      const half = (cellSize - gap) / 2;
      lctx.save();
      lctx.fillStyle = FILTER_FILL;
      lctx.strokeStyle = FILTER_COLOR;
      lctx.lineWidth = Math.max(1.5, cellSize * 0.1);
      for (const index of set) {
        const p = this.center(this.grid.coord(index));
        if (this.grid.type === 'hex') pathHex(lctx, p.x, p.y, half * 0.88);
        else roundRect(lctx, p.x - half * 0.88, p.y - half * 0.88, half * 1.76, half * 1.76, cellSize * 0.18);
        lctx.fill();
        lctx.stroke();
      }
      lctx.restore();
    }
    this.filterDirty = false;
  }

  /** 绘制坐标筛选高亮（在轨迹之上、移动体之下） */
  drawFilterHighlight() {
    if (!this.filterSet || !this.filterSet.size) return;
    this.ensureFilterLayer();
    const layer = this.filterLayer;
    if (!layer) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.drawImage(layer, 0, 0, layer.width, layer.height, 0, 0, this.size.width, this.size.height);
    ctx.restore();
  }

  /* --------------------------- 多轨迹对比 --------------------------- */

  /**
   * 多轨迹对比离屏层：基准快照的虚线轨迹 + 三类差异格（共有 / 仅基准 / 仅当前）。
   * 与坐标筛选一样做图层缓存，快照与结果都不变时每帧只有一次 drawImage。
   */
  ensureCompareLayer() {
    if (!this.compareDirty && this.compareLayer) return;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const w = this.size.width;
    const h = this.size.height;
    let layer = this.compareLayer;
    if (!layer) {
      layer = document.createElement('canvas');
      this.compareLayer = layer;
    }
    const pw = Math.max(1, Math.round(w * dpr));
    const ph = Math.max(1, Math.round(h * dpr));
    if (layer.width !== pw || layer.height !== ph) {
      layer.width = pw;
      layer.height = ph;
    }
    const lctx = layer.getContext('2d');
    lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    lctx.clearRect(0, 0, w, h);
    this.compareDirty = false;
    const cmp = this.compare;
    if (!cmp || !cmp.snapshot) return;

    const { cellSize, gap } = this.style;
    const pitch = cellSize + gap;
    const half = (cellSize - gap) / 2;

    // 1) 基准轨迹：虚线折线（按像素间距断开，避免跨边界连出穿图直线）
    const path = cmp.snapshot.path || [];
    if (path.length > 1) {
      lctx.save();
      lctx.setLineDash([Math.max(3, cellSize * 0.26), Math.max(2, cellSize * 0.2)]);
      lctx.lineWidth = Math.max(1, cellSize * 0.14);
      lctx.strokeStyle = COMPARE_BASE_COLOR;
      lctx.globalAlpha = 0.85;
      lctx.lineCap = 'round';
      lctx.beginPath();
      let px = NaN;
      let py = NaN;
      for (let i = 0; i < path.length; i++) {
        const idx = path[i].index;
        const p = this.center({ col: idx % this.grid.width, row: (idx / this.grid.width) | 0 });
        if (i === 0 || Math.hypot(p.x - px, p.y - py) > pitch * RUN_GAP_CELLS) {
          if (i > 0) lctx.stroke();
          lctx.beginPath();
          lctx.moveTo(p.x, p.y);
        } else {
          lctx.lineTo(p.x, p.y);
        }
        px = p.x;
        py = p.y;
      }
      lctx.stroke();
      lctx.restore();
    }

    // 2) 差异格：共有（黄）· 仅基准（红）· 仅当前（绿）
    const diff = cmp.diff;
    if (diff) {
      const groups = [
        [diff.onlyBase, COMPARE_ONLY_BASE],
        [diff.onlyOther, COMPARE_ONLY_OTHER],
        [diff.shared, COMPARE_SHARED],
      ];
      for (const [list, color] of groups) {
        if (!list || !list.length) continue;
        lctx.save();
        lctx.fillStyle = color.fill;
        lctx.strokeStyle = color.stroke;
        lctx.lineWidth = Math.max(1, cellSize * 0.08);
        for (const index of list) {
          const p = this.center({ col: index % this.grid.width, row: (index / this.grid.width) | 0 });
          if (this.grid.type === 'hex') pathHex(lctx, p.x, p.y, half * 0.72);
          else roundRect(lctx, p.x - half * 0.72, p.y - half * 0.72, half * 1.44, half * 1.44, cellSize * 0.2);
          lctx.fill();
          lctx.stroke();
        }
        lctx.restore();
      }
    }
  }

  /** 绘制多轨迹对比叠加层（在轨迹之上、筛选高亮之下） */
  drawCompare() {
    if (!this.compare || !this.compare.snapshot) return;
    this.ensureCompareLayer();
    const layer = this.compareLayer;
    if (!layer) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.drawImage(layer, 0, 0, layer.width, layer.height, 0, 0, this.size.width, this.size.height);
    ctx.restore();
  }

  drawHighlights(frame) {
    if (!frame.highlights || !frame.highlights.length) return;
    const ctx = this.ctx;
    const { cellSize } = this.style;
    const half = cellSize / 2;
    const colors = { wall: '#ff922b', collision: '#ff5d5d', turn: '#51cf66', cell: '#e5e9f0', spawn: '#c084fc', merge: '#c084fc', repel: '#ffd166', markerEffect: '#ffd166', agentDeath: '#ff5d5d', transform: TRANSFORM_ACCENT, warning: WARNING_ACCENT };
    for (const h of frame.highlights) {
      if (h.col === undefined || h.row === undefined) continue;
      const p = this.center({ col: h.col, row: h.row });
      const color = h.state ? (this.stateColor(h.state) || '#e5e9f0') : (colors[h.type] || '#e5e9f0');
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1.5, cellSize * 0.09);
      ctx.globalAlpha = 0.95;
      if (this.grid.type === 'hex') pathHex(ctx, p.x, p.y, half * 0.92);
      else roundRect(ctx, p.x - half * 0.92, p.y - half * 0.92, half * 1.84, half * 1.84, cellSize * 0.2);
      ctx.stroke();
      ctx.restore();
    }
  }

  /**
   * 蛇身绘制：
   *  1) 用相邻帧对体节位置做插值，得到亚步坐标，实现体节节点的流畅位移（帧连续）；
   *  2) 穿越边界时体节平滑滑出网格区域，同时在对侧由镜像体节同步滑入；
   *  3) 按 style.bodyJoin 把相邻体节连成连续蛇身：
   *     curve 贝塞尔曲线 · line 直线段 · angle 按预设角度切角连接的直线型折线。
   * 这样无论哪种连接方式，蛇身都是平滑、规整、帧连续的形态，不再有生硬的逐格拼接。
   */
  drawAgents(frame, nextFrame, alpha = 0) {
    const ctx = this.ctx;
    const cfgBody = this.body || this.result.config.body;
    const { cellSize } = this.style;
    const half = cellSize / 2;
    const scale = Math.max(0.1, Math.min(1.6, cfgBody?.segmentSize ?? 0.82));
    const shape = cfgBody?.shape || 'round';
    const rect = this.gridRect();

    ctx.save();
    // 绘制范围裁剪到网格区域：跨越边界时体节滑出的一侧按真实像素被裁掉，
    // 对侧镜像体节同步滑入，两侧始终各有半个体节在场，
    // 既不会在四周留白里留下周期像，也不会出现体节整段消失的闪现。
    ctx.beginPath();
    ctx.rect(rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top);
    ctx.clip();

    for (let ai = frame.agents.length - 1; ai >= 0; ai--) {
      const a = frame.agents[ai];
      if (!a.segments.length) continue;
      const n = a.segments.length;
      const b = nextFrame ? nextFrame.agents.find((x) => x.id === a.id) : null;
      const model = this.agentPoints(a, b, alpha);
      const pts = model.pts;
      const ghostRuns = model.ghosts;
      const colorAt = (i) => segmentColor(a, i, n, cfgBody);
      const radius = half * scale;
      // 皮肤已解码完成时优先使用皮肤贴图；未设置 / 正在解码 / 解码失败时退回纯色绘制
      const bodySkin = this.skinImg.body;
      const headSkin = this.skinImg.head;

      if (bodySkin && (pts.length || ghostRuns.length)) {
        if (pts.length) this.drawSkinRibbon(a, pts, radius, bodySkin);
        for (const run of ghostRuns) this.drawSkinRibbon(a, run, radius, bodySkin);
      } else {
        if (pts.length > 1) {
          this.strokeRibbon(a, pts, colorAt, radius, cfgBody);
        } else if (pts.length === 1) {
          ctx.save();
          ctx.fillStyle = colorAt(pts[0].gi);
          ctx.globalAlpha = a.alive ? 1 : 0.45;
          drawShape(ctx, pts[0].x, pts[0].y, radius, this.grid.type, shape);
          ctx.fill();
          ctx.restore();
        }
        // 对侧镜像：与本体使用同一套配色与连接方式，保证两侧同步滑入 / 滑出
        for (const run of ghostRuns) this.strokeRibbon(a, run, colorAt, radius, cfgBody);
      }
      if (this.style.showArrows) this.drawArrow(a, cellSize);
      // 蛇头：跨缝时本体与镜像同时各露出半个，两侧都按同一朝向绘制眼睛 / 白点，
      // 避免滑出的一侧失去「头部」标识、另一侧冒出一个无标识的体节
      const heads = [];
      if (pts.length && pts[0].gi === 0) heads.push(pts[0]);
      const headGhost = ghostRuns.find((run) => run[0] && run[0].gi === 0);
      if (headGhost) heads.push(headGhost[0]);
      if (heads.length) {
        const ang = this.headAngle(a, model.headTarget);
        for (const hd of heads) {
          // 仅有蛇身皮肤时，用头部配色重绘蛇头节点，避免头尾难以区分
          if (headSkin) {
            this.drawSkinHead(hd, radius, cfgBody, headSkin, a.alive);
          } else if (bodySkin) {
            ctx.save();
            ctx.globalAlpha = a.alive ? 1 : 0.45;
            ctx.fillStyle = colorAt(0);
            drawShape(ctx, hd.x, hd.y, radius, this.grid.type, shape);
            ctx.fill();
            ctx.restore();
          }
          if (this.style.showEyes) {
            this.drawEyes(hd, ang, radius);
          } else if (!headSkin) {
            ctx.save();
            ctx.fillStyle = 'rgba(255,255,255,0.92)';
            ctx.globalAlpha = 0.5;
            ctx.beginPath();
            ctx.arc(hd.x, hd.y, Math.max(1.2, radius * 0.22), 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
          }
        }
      }
    }
    ctx.restore();
  }

  /**
   * 体节中心坐标：b 为下一帧的同一移动体，alpha ∈ [0,1) 为帧间进度。
   *
   * 边界穿越（wrap）时相邻两帧的格坐标会「瞬移」到对侧，若直接线性插值，
   * 体节会贴着整张画面横扫过去（错误闪现）。这里分三步解算：
   *  1) 先把本帧体节链解算成「连续展开坐标」：以蛇头所在格为锚点，沿链逐节累加环绕最短位移。
   *     展开坐标下相邻两节永远只差一格，因此整条蛇身在任何进度下都是一条连续的链，
   *     不会出现某几节被单独插值到对侧、与其余体节相隔整张画面（体节视觉分离 / 孤立体节）。
   *  2) 每节按「展开坐标 → 加上本步环绕最短位移」插值，单步位移始终不超过一格，
   *     体节平滑滑出边界，而不会横穿画面。
   *  3) 整条链再按网格周期平移出镜像副本（见 periodicRuns），与本体同步滑入 / 滑出。
   *     相邻两帧的位移不足一圈时，展开坐标下的落点与真实落点之差即环绕平移量，
   *     记为镜像偏移（gx / gy）供外部查询。
   *
   * @returns {{pts: Array, ghosts: Array<Array>, headTarget: object|null}}
   */
  agentPoints(a, b, alpha) {
    const segsA = a.segments;
    const segsB = b && b.segments.length ? b.segments : null;
    const pts = [];
    let headTarget = null;
    // 1) 连续展开坐标：锚点为蛇头格，逐节累加与前一节之间的环绕最短位移
    const un = new Array(segsA.length);
    for (let i = 0; i < segsA.length; i++) {
      if (!i) {
        un[i] = { col: segsA[i][0], row: segsA[i][1] };
        continue;
      }
      const d = this.grid.wrapDelta(
        { col: segsA[i - 1][0], row: segsA[i - 1][1] },
        { col: segsA[i][0], row: segsA[i][1] },
      );
      un[i] = { col: un[i - 1].col + d.dc, row: un[i - 1].row + d.dr };
    }
    for (let i = 0; i < segsA.length; i++) {
      const from = un[i];
      const pa = this.center(from);
      const p = { x: pa.x, y: pa.y, gi: i };
      if (segsB && alpha > 0) {
        const s = segsB[Math.min(i, segsB.length - 1)];
        const to = { col: s[0], row: s[1] };
        const d = this.grid.wrapDelta({ col: segsA[i][0], row: segsA[i][1] }, to);
        const target = this.center({ col: from.col + d.dc, row: from.row + d.dr });
        p.x += (target.x - pa.x) * alpha;
        p.y += (target.y - pa.y) * alpha;
        if (i === 0) headTarget = target;
        // 真实落点与未环绕落点不一致，说明本步穿越了边界：
        // 两者之差即环绕平移量，记录对侧镜像坐标供外部查询
        if (d.dc !== to.col - segsA[i][0] || d.dr !== to.row - segsA[i][1]) {
          const real = this.center(to);
          p.gx = p.x + real.x - target.x;
          p.gy = p.y + real.y - target.y;
        }
      }
      pts.push(p);
    }
    return { pts, ghosts: this.periodicRuns(pts), headTarget };
  }

  /**
   * 体节链的周期镜像副本：把整条链按网格周期（横向 / 纵向）平移，只保留可能与网格区域相交的副本。
   *
   * 穿越边界时画面上必须同时看到「滑出的一侧」与「滑入的一侧」。副本取自同一条连续展开的链，
   * 因此副本自身也是连续的一条蛇身，不会出现脱离蛇身的孤立体节（低速播放时尤其明显）。
   */
  periodicRuns(pts) {
    const out = [];
    const g = this.grid;
    if (!pts.length || !g || g.boundary !== 'wrap') return out;
    const wrapX = g.width > 1;
    const wrapY = g.height > 1;
    if (!wrapX && !wrapY) return out;
    const rect = this.gridRect();
    // 体节半径 + 描边余量：副本只要有可能露出一角就保留
    const pad = (this.style.cellSize / 2) * ((this.body && this.body.segmentSize) || 0.82) + 4;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    const origin = this.center({ col: 0, row: 0 });
    const px = this.center({ col: g.width, row: 0 }).x - origin.x;
    const py = this.center({ col: 0, row: g.height }).y - origin.y;
    // 周期数由几何关系推出：小网格下窗口可能跨越多个周期，故按需多取几份（上限 ±3 份）
    const kMin = wrapX ? Math.max(-3, Math.ceil((rect.left - pad - maxX) / px)) : 0;
    const kMax = wrapX ? Math.min(3, Math.floor((rect.right + pad - minX) / px)) : 0;
    const lMin = wrapY ? Math.max(-3, Math.ceil((rect.top - pad - maxY) / py)) : 0;
    const lMax = wrapY ? Math.min(3, Math.floor((rect.bottom + pad - minY) / py)) : 0;
    for (let k = kMin; k <= kMax; k++) {
      for (let l = lMin; l <= lMax; l++) {
        if (!k && !l) continue; // (0, 0) 即本体，由调用方直接绘制
        const dx = k * px;
        const dy = l * py;
        out.push(pts.map((p) => ({ x: p.x + dx, y: p.y + dy, gi: p.gi })));
      }
    }
    return out;
  }

  /**
   * 蛇头朝向角：播放时取真实位移方向（按环绕最短位移解算，穿越边界时朝向不会翻转），
   * 静止时取当前朝向的前方格方向。
   */
  headAngle(a, headTarget) {
    const from = this.center({ col: a.segments[0][0], row: a.segments[0][1] });
    let to = null;
    if (headTarget && (Math.abs(headTarget.x - from.x) > 0.01 || Math.abs(headTarget.y - from.y) > 0.01)) to = headTarget;
    if (!to) {
      const nxt = this.grid.step({ col: a.segments[0][0], row: a.segments[0][1] }, a.dir);
      const raw = this.grid.toPixel(nxt, this.style.cellSize, this.style.gap);
      to = { x: raw.x + this.size.margin, y: raw.y + this.size.margin };
    }
    return Math.atan2(to.y - from.y, to.x - from.x);
  }

  /** 指定移动体在指定帧的蛇头像素坐标（供「跟随移动体」滚动定位，坐标不含容器边距） */
  agentHeadPixel(frameIndex, agentIndex = 0) {
    if (!this.result) return null;
    const frames = this.result.frames;
    const f = frames[Math.max(0, Math.min(frames.length - 1, Math.round(frameIndex)))];
    const a = f?.agents?.[agentIndex];
    if (!a || !a.segments?.length) return null;
    return this.center({ col: a.segments[0][0], row: a.segments[0][1] });
  }

  /**
   * 把体节中心连成一条连续蛇身。
   * curve 逐段贝塞尔；line / angle 直线段（angle 先做预设角度切角）。
   * 第一遍描深色轮廓保证在任意背景上清晰，第二遍按体节配色描边（头粗尾细）。
   */
  strokeRibbon(a, pts, colorAt, radius, cfgBody) {
    const ctx = this.ctx;
    const { cellSize } = this.style;
    const headColor = a.color || cfgBody?.colors?.head || '#ff5d5d';
    const alpha = a.alive ? 1 : 0.45;
    const last = Math.max(1, pts.length - 1);
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const geo of this.ribbonRuns(pts)) {
      if (geo.single) {
        const p = geo.pts[0];
        ctx.globalAlpha = alpha;
        ctx.shadowBlur = 0;
        ctx.fillStyle = colorAt(p.gi);
        ctx.beginPath();
        ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      this.strokeRibbonOutline(ctx, geo, radius, alpha);
      // 第二遍：按体节配色描边，头粗尾细
      for (let k = 0; k < geo.count; k++) {
        const gi = geo.verts[k].gi;
        const t = gi / last;
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = colorAt(gi);
        ctx.lineWidth = ribbonWidth(radius, t);
        if (this.style.glow) {
          ctx.shadowColor = gi === 0 ? headColor : colorAt(gi);
          ctx.shadowBlur = cellSize * (gi === 0 ? 0.8 : 0.45);
        } else {
          ctx.shadowBlur = 0;
        }
        this.traceRibbonGeo(ctx, geo, k);
        ctx.stroke();
      }
    }
    ctx.shadowBlur = 0;
    ctx.restore();
  }

  /** 蛇身深色轮廓：保证体节在任意背景（含亮色皮肤 / 浅色网格）上都清晰可辨 */
  strokeRibbonOutline(ctx, geo, radius, alpha) {
    ctx.globalAlpha = alpha * 0.45;
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.lineWidth = Math.max(2, radius * 2 + 2);
    ctx.shadowBlur = 0;
    traceChain(ctx, geo.verts, geo.segs);
    ctx.stroke();
  }

  /**
   * 蛇身链的几何切分：按最大间距拆成若干连续 run（跨边界 / 换移动体处断开），
   * 再把每个 run 转成「切角折线」或「贝塞尔段」，供描边与蒙版共用同一套几何。
   */
  ribbonRuns(pts) {
    const { cellSize, gap } = this.style;
    const mode = this.style.bodyJoin;
    const out = [];
    for (const run of splitRuns(pts, (cellSize + gap) * RUN_GAP_CELLS)) {
      if (run.length === 1) {
        out.push({ pts: run, single: true });
        continue;
      }
      const verts = mode === 'angle' ? bevelChain(run, this.style.trailAngle) : run;
      const segs = mode === 'curve' ? bezierSegments(verts) : null;
      out.push({ pts: run, verts, segs, count: segs ? segs.length : verts.length - 1 });
    }
    return out;
  }

  /** 描出几何体的第 k 段（直线 / 切角折线 / 贝塞尔由 verts / segs 决定） */
  traceRibbonGeo(ctx, geo, k) {
    if (geo.segs) traceBezier(ctx, geo.segs[k]);
    else traceLine(ctx, geo.verts[k], geo.verts[k + 1]);
  }

  /**
   * 蛇身皮肤：把上传的图片平铺作为蛇身填充。
   *
   * 实现为「离屏蒙版」——先在离屏层按体节线宽描出蛇身轮廓，再用 source-in 让图片
   * 只保留在轮廓内，最后整层贴回主画布。相比逐体节贴图，轮廓连续无接缝，
   * 且形状（含头粗尾细的收束）与纯色绘制完全一致。
   */
  drawSkinRibbon(a, pts, radius, img) {
    const ctx = this.ctx;
    const alpha = a.alive ? 1 : 0.45;
    const geoList = this.ribbonRuns(pts);
    const last = Math.max(1, pts.length - 1);

    // 1) 主画布先描深色轮廓，避免皮肤贴到背景上缺少边界
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const geo of geoList) {
      if (!geo.single) this.strokeRibbonOutline(ctx, geo, radius, alpha);
    }
    ctx.restore();

    // 2) 离屏层描出蛇身轮廓（与纯色绘制使用同一套线宽，保证形态一致）
    const sctx = this.ensureSkinLayer();
    sctx.save();
    sctx.globalAlpha = 1;
    sctx.lineCap = 'round';
    sctx.lineJoin = 'round';
    sctx.fillStyle = '#fff';
    sctx.strokeStyle = '#fff';
    for (const geo of geoList) {
      if (geo.single) {
        const p = geo.pts[0];
        sctx.beginPath();
        sctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
        sctx.fill();
        continue;
      }
      for (let k = 0; k < geo.count; k++) {
        sctx.lineWidth = ribbonWidth(radius, geo.verts[k].gi / last);
        this.traceRibbonGeo(sctx, geo, k);
        sctx.stroke();
      }
    }
    sctx.restore();

    // 3) source-in：仅在轮廓内保留图片图案（其余区域被清空）
    const pattern = this.skinPattern(img);
    if (pattern) {
      sctx.save();
      sctx.globalCompositeOperation = 'source-in';
      sctx.fillStyle = pattern;
      sctx.fillRect(0, 0, this.size.width, this.size.height);
      sctx.restore();
    }

    // 4) 整层贴回主画布（沿用裁剪与存活状态的整体透明度）
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.drawImage(this.skinLayer, 0, 0, this.size.width, this.size.height);
    ctx.restore();
  }

  /**
   * 皮肤图片的重复图案：按体节尺寸缩放后平铺，原点是网格左上角，
   * 使每个体节都落在图片的同一区域上（整张图正好铺满一格）。
   */
  skinPattern(img) {
    const pattern = this.ctx.createPattern(img, 'repeat');
    if (!pattern) return null;
    const cell = this.style.cellSize + this.style.gap;
    const m = new DOMMatrix();
    m.a = cell / Math.max(1, img.width);
    m.d = cell / Math.max(1, img.height);
    m.e = this.size.margin;
    m.f = this.size.margin;
    try {
      pattern.setTransform(m);
    } catch (e) {
      /* 老内核不支持图案变换时退回默认平铺（仍能正常显示皮肤） */
    }
    return pattern;
  }

  /** 蛇头皮肤：按体节形状裁切贴图后绘制在蛇头节点上 */
  drawSkinHead(p, radius, cfgBody, img, alive) {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = alive ? 1 : 0.45;
    drawShape(ctx, p.x, p.y, radius, this.grid.type, cfgBody?.shape || 'round');
    ctx.clip();
    ctx.drawImage(img, p.x - radius, p.y - radius, radius * 2, radius * 2);
    ctx.restore();
  }

  /** 蛇身皮肤离屏层：与主画布同像素尺寸（含 dpr），每次使用前清空 */
  ensureSkinLayer() {
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    if (!this.skinLayer) this.skinLayer = document.createElement('canvas');
    if (this.skinLayer.width !== this.canvas.width || this.skinLayer.height !== this.canvas.height) {
      this.skinLayer.width = this.canvas.width;
      this.skinLayer.height = this.canvas.height;
    }
    const sctx = this.skinLayer.getContext('2d');
    sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    sctx.clearRect(0, 0, this.size.width, this.size.height);
    return sctx;
  }

  /** 蛇头双眼：ang 为前进方向角，双眼沿前进方向前移并左右分布 */
  drawEyes(p, ang, r) {
    const ctx = this.ctx;
    const fx = Math.cos(ang);
    const fy = Math.sin(ang);
    const px = -fy;
    const py = fx;
    const forward = r * 0.34;
    const side = r * 0.38;
    const eyeR = Math.max(1, r * 0.24);
    const cx = p.x + fx * forward;
    const cy = p.y + fy * forward;
    ctx.save();
    // 眼白 + 深色瞳孔，形成明确的朝向提示
    for (const s of [-1, 1]) {
      const ex = cx + px * side * s;
      const ey = cy + py * side * s;
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      ctx.beginPath();
      ctx.arc(ex, ey, eyeR, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(20,24,30,0.9)';
      ctx.beginPath();
      ctx.arc(ex + fx * eyeR * 0.35, ey + fy * eyeR * 0.35, eyeR * 0.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /**
   * 交互特效：把最近若干步内的融合 / 排斥 / 生成 / 标记物反馈绘制为渐隐波纹，
   * 让多蛇交互与标记物反馈在画面上有明确的视觉反馈。
   */
  drawEffects(frameIndex) {
    const frames = this.result.frames;
    const start = Math.max(0, frameIndex - EFFECT_LOOKBACK);
    const ctx = this.ctx;
    const { cellSize } = this.style;
    const half = cellSize / 2;
    const colors = { merge: '#c084fc', repel: '#ffd166', spawn: '#63e6be', markerEffect: '#ffd166', agentDeath: '#ff5d5d', wrap: '#4cc9f0', transform: TRANSFORM_ACCENT, warning: WARNING_ACCENT, lifeGain: LIFE_GAIN_ACCENT, lifeLoss: LIFE_LOSS_ACCENT, lifeWarning: LIFE_WARN_ACCENT, lifeDepleted: LIFE_LOSS_ACCENT, respawn: LIFE_RESPAWN_ACCENT };
    for (let fi = start; fi <= frameIndex; fi++) {
      const f = frames[fi];
      if (!f || !f.highlights) continue;
      const age = frameIndex - fi;
      const t = 1 - age / (EFFECT_LOOKBACK + 1);
      for (const h of f.highlights) {
        if (!EFFECT_TYPES.has(h.type)) continue;
        if (h.col === undefined || h.row === undefined) continue;
        const p = this.center({ col: h.col, row: h.row });
        // 蛇死亡转化：专用过渡动画（体节色块淡入目标状态色 + 收束圆环），
        // 比通用波纹更能表达「身体节点并入元胞自动机」的过程
        if (h.type === 'transform') {
          this.drawTransformEffect(p, t, cellSize, h.state ? this.stateColor(h.state) : null);
          continue;
        }
        // 重生：以蛇头为中心向外扩散的同心环，表达「原地重生」的扩散感
        if (h.type === 'respawn') {
          this.drawRespawnEffect(p, t, cellSize);
          continue;
        }
        // 低生命预警：危险格脉冲 + 警示环
        if (h.type === 'lifeWarning') {
          this.drawLifeWarningEffect(p, t, cellSize);
          continue;
        }
        const color = h.color || (h.state ? (this.stateColor(h.state) || colors[h.type]) : colors[h.type]) || '#e5e9f0';
        // 边界穿越：沿进出方向在网格内补一段渐隐的「穿梭」光带，
        // 让「从对侧滑入」在画面上有明确的方向感
        if (h.type === 'wrap') this.drawWrapStreak(p, h, t, cellSize, color);
        ctx.save();
        ctx.globalAlpha = 0.15 + 0.6 * t;
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(1.5, cellSize * 0.08);
        const grow = half * (0.55 + 0.6 * (1 - t));
        if (this.grid.type === 'hex') pathHex(ctx, p.x, p.y, grow);
        else roundRect(ctx, p.x - grow, p.y - grow, grow * 2, grow * 2, cellSize * 0.22);
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  /**
   * 蛇死亡转化：身体节点「并入环境」的过渡动画。
   *
   * 时间轴 t 由 1（刚刚发生）衰减到 0（6 步后结束）：
   *   - 体节色块：以目标状态色从中心淡入并略微收缩，预示该节点即将成为的元胞形态；
   *   - 收束圆环：由外向内收拢，表达「被环境吸收」的方向感；
   *   - 两者叠加后，节点在几步内从「蛇身」连续过渡为「环境单元」，避免突然跳变。
   *
   * @param {object} p   格中心像素坐标
   * @param {number} t   剩余强度 [0,1]
   * @param {number} cellSize 格边长
   * @param {string|null} stateColor 目标状态的颜色（取不到时退回转化主色调）
   */
  drawTransformEffect(p, t, cellSize, stateColor) {
    const ctx = this.ctx;
    const half = cellSize / 2;
    const hex = this.grid.type === 'hex';
    ctx.save();
    // 体节色块 → 目标状态色：越接近结束越贴近最终元胞（视觉连贯）
    ctx.globalAlpha = 0.7 * t;
    ctx.fillStyle = stateColor || TRANSFORM_ACCENT;
    const grow = half * (0.42 + 0.58 * t);
    if (hex) pathHex(ctx, p.x, p.y, grow * 0.95);
    else roundRect(ctx, p.x - grow, p.y - grow, grow * 2, grow * 2, cellSize * 0.2);
    ctx.fill();
    // 收束圆环：半径随 t 减小而向内收拢
    ctx.globalAlpha = 0.25 + 0.65 * t;
    ctx.strokeStyle = TRANSFORM_ACCENT;
    ctx.lineWidth = Math.max(1.5, cellSize * 0.09);
    const ring = half * (0.5 + 1.2 * (1 - t));
    if (hex) pathHex(ctx, p.x, p.y, ring);
    else roundRect(ctx, p.x - ring, p.y - ring, ring * 2, ring * 2, cellSize * 0.24);
    ctx.stroke();
    ctx.restore();
  }

  /**
   * 生命机制 · 原地重生：蛇头格淡入 + 两圈向外扩散的同心环。
   * 时间轴 t 由 1 衰减到 0，环半径随 (1-t) 增大，形成「重生波」的扩散感。
   */
  drawRespawnEffect(p, t, cellSize) {
    const ctx = this.ctx;
    const half = cellSize / 2;
    const hex = this.grid.type === 'hex';
    ctx.save();
    ctx.globalAlpha = 0.35 + 0.5 * t;
    ctx.fillStyle = LIFE_RESPAWN_ACCENT;
    const grow = half * (0.35 + 0.3 * t);
    if (hex) pathHex(ctx, p.x, p.y, grow);
    else roundRect(ctx, p.x - grow, p.y - grow, grow * 2, grow * 2, cellSize * 0.2);
    ctx.fill();
    for (let k = 0; k < 2; k++) {
      const phase = (1 - t) + k * 0.35;
      const ring = half * (0.7 + 2.1 * phase);
      ctx.globalAlpha = Math.max(0, (0.75 - k * 0.3) * t);
      ctx.strokeStyle = k ? '#ffffff' : LIFE_RESPAWN_ACCENT;
      ctx.lineWidth = Math.max(1.2, cellSize * (0.09 - k * 0.03));
      if (hex) pathHex(ctx, p.x, p.y, ring);
      else roundRect(ctx, p.x - ring, p.y - ring, ring * 2, ring * 2, cellSize * 0.24);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** 生命机制 · 低生命预警：危险格脉冲填充 + 警示环 */
  drawLifeWarningEffect(p, t, cellSize) {
    const ctx = this.ctx;
    const half = cellSize / 2;
    const hex = this.grid.type === 'hex';
    ctx.save();
    const pulse = 0.5 + 0.5 * Math.sin((1 - t) * Math.PI * 3);
    ctx.globalAlpha = (0.18 + 0.5 * pulse) * t;
    ctx.fillStyle = LIFE_WARN_ACCENT;
    if (hex) pathHex(ctx, p.x, p.y, half * 0.92);
    else roundRect(ctx, p.x - half * 0.92, p.y - half * 0.92, half * 1.84, half * 1.84, cellSize * 0.2);
    ctx.fill();
    ctx.globalAlpha = 0.35 + 0.55 * t;
    ctx.strokeStyle = LIFE_WARN_ACCENT;
    ctx.lineWidth = Math.max(1.4, cellSize * 0.1);
    const ring = half * (0.6 + 0.5 * (1 - t));
    if (hex) pathHex(ctx, p.x, p.y, ring);
    else roundRect(ctx, p.x - ring, p.y - ring, ring * 2, ring * 2, cellSize * 0.24);
    ctx.stroke();
    ctx.restore();
  }

  /**
   * 边界穿越的「穿梭」光带：从落点格朝进入方向画一段由粗到细、由亮到暗的拖尾。
   *
   * 落点格位于网格边缘，进入方向指向网格内部，因此光带不会溢出网格区域；
   * 仍按网格矩形裁剪一次，避免极端样式下越界。
   */
  drawWrapStreak(p, h, t, cellSize, color) {
    if (h.fromCol === undefined || h.fromRow === undefined) return;
    const from = this.center({ col: h.fromCol, row: h.fromRow });
    const dx = p.x - from.x;
    const dy = p.y - from.y;
    const len = Math.hypot(dx, dy);
    if (!len) return;
    const ux = dx / len;
    const uy = dy / len;
    const reach = cellSize * (0.85 + 0.95 * (1 - t));
    const steps = 6;
    const ctx = this.ctx;
    const rect = this.gridRect();
    ctx.save();
    ctx.beginPath();
    ctx.rect(rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top);
    ctx.clip();
    ctx.strokeStyle = color;
    ctx.lineCap = 'round';
    for (let i = 0; i < steps; i++) {
      const a0 = (i / steps) * reach;
      const a1 = ((i + 0.75) / steps) * reach;
      ctx.globalAlpha = Math.max(0, (0.5 - i * 0.075) * (0.35 + 0.65 * t));
      ctx.lineWidth = Math.max(1, cellSize * 0.26 * (1 - i / steps) * (0.5 + 0.5 * t));
      ctx.beginPath();
      ctx.moveTo(p.x + ux * a0, p.y + uy * a0);
      ctx.lineTo(p.x + ux * a1, p.y + uy * a1);
      ctx.stroke();
    }
    ctx.restore();
  }

  drawArrow(a, cellSize) {
    const ctx = this.ctx;
    const [hc, hr] = a.segments[0];
    const p1 = this.center({ col: hc, row: hr });
    const nxt = this.grid.step({ col: hc, row: hr }, a.dir);
    const raw = this.grid.toPixel(nxt, cellSize, this.style.gap);
    const p2 = { x: raw.x + this.size.margin, y: raw.y + this.size.margin };
    const ang = Math.atan2(p2.y - p1.y, p2.x - p1.x);
    const r = (cellSize / 2) * 0.62;
    ctx.save();
    ctx.translate(p1.x + Math.cos(ang) * r * 0.55, p1.y + Math.sin(ang) * r * 0.55);
    ctx.rotate(ang);
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(r * 0.55, 0);
    ctx.lineTo(-r * 0.28, r * 0.4);
    ctx.lineTo(-r * 0.28, -r * 0.4);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  drawStartEnd(frame) {
    const ctx = this.ctx;
    const { cellSize } = this.style;
    const r = cellSize * 0.42;
    if (this.startCoord) {
      const p = this.center(this.startCoord);
      ctx.save();
      ctx.strokeStyle = '#51cf66';
      ctx.lineWidth = Math.max(1.5, cellSize * 0.1);
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    const isEnd = frame.tick === this.result.frames[this.result.frames.length - 1].tick;
    if (isEnd && this.result.endReason && this.endCoord) {
      const p = this.center(this.endCoord);
      ctx.save();
      ctx.strokeStyle = '#ffd43b';
      ctx.lineWidth = Math.max(1.5, cellSize * 0.1);
      ctx.setLineDash([cellSize * 0.2, cellSize * 0.16]);
      ctx.beginPath();
      ctx.arc(p.x, p.y, r * 1.2, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  drawCollisions(frame) {
    const ctx = this.ctx;
    const { cellSize } = this.style;
    const r = cellSize * 0.16;
    const seen = new Set();
    for (const cp of this.collisionPoints) {
      if (cp.tick > frame.tick) break;
      const key = `${cp.col}:${cp.row}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const p = this.center(cp);
      ctx.save();
      ctx.fillStyle = '#ff5d5d';
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(1.5, r), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  drawAxis(th) {
    const ctx = this.ctx;
    const s = this.style;
    const step = Math.max(1, Math.round(56 / s.cellSize));
    const font = Math.max(9, Math.round(s.cellSize * 0.34));
    ctx.save();
    ctx.fillStyle = th.axis;
    ctx.font = `${font}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let col = 0; col < this.grid.width; col += step) {
      const p = this.center({ col, row: 0 });
      if (this.grid.type === 'square') ctx.fillText(String(col), p.x, p.y - s.cellSize * 0.85);
      else ctx.fillText(String(col), p.x, p.y - s.cellSize * 0.75);
    }
    ctx.textAlign = 'right';
    for (let row = 0; row < this.grid.height; row += step) {
      const p = this.center({ col: 0, row });
      ctx.fillText(String(row), p.x - s.cellSize * 0.75, p.y);
    }
    ctx.restore();
  }

  drawHover() {
    const ctx = this.ctx;
    const { cellSize, gap } = this.style;
    const p = this.center(this.hover);
    ctx.save();
    // 编辑模式：按画笔尺寸画出实际会被改写的范围，避免「点了却没改到预想格子」
    if (this.editMode) {
      const n = Math.max(1, Math.round(this.brushSize || 1));
      const off = Math.floor((n - 1) / 2);
      const half = cellSize / 2 - gap / 2;
      for (let dr = 0; dr < n; dr++) {
        for (let dc = 0; dc < n; dc++) {
          const c = { col: this.hover.col - off + dc, row: this.hover.row - off + dr };
          if (!this.grid.inBounds(c)) continue;
          const q = this.center(c);
          if (this.grid.type === 'hex') pathHex(ctx, q.x, q.y, half);
          else roundRect(ctx, q.x - half, q.y - half, half * 2, half * 2, cellSize * 0.2);
          ctx.globalAlpha = 0.18;
          ctx.fillStyle = this.editAccent;
          ctx.fill();
          ctx.globalAlpha = 1;
          ctx.strokeStyle = this.editAccent;
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      }
      ctx.restore();
      return;
    }
    ctx.strokeStyle = HOVER_ACCENT;
    ctx.lineWidth = 1.5;
    const half = cellSize / 2;
    if (this.grid.type === 'hex') pathHex(ctx, p.x, p.y, half * 0.9);
    else roundRect(ctx, p.x - half * 0.9, p.y - half * 0.9, half * 1.8, half * 1.8, cellSize * 0.2);
    ctx.stroke();
    ctx.restore();
  }

  stateColor(name) {
    const st = this.states.find((s) => s.name === name);
    return st ? st.color : null;
  }

  /* 坐标反查（用于鼠标悬停） */
  hitTest(clientX, clientY) {
    if (!this.grid) return null;
    const rect = this.canvas.getBoundingClientRect();
    const x = clientX - rect.left - this.size.margin;
    const y = clientY - rect.top - this.size.margin;
    const { cellSize, gap } = this.style;
    if (this.grid.type === 'square') {
      const pitch = cellSize + gap;
      const col = Math.floor(x / pitch);
      const row = Math.floor(y / pitch);
      const c = { col, row };
      return this.grid.inBounds(c) ? c : null;
    }
    const R = cellSize / 2;
    const w = Math.sqrt(3) * R;
    const approxRow = Math.floor(y / (1.5 * R));
    let best = null;
    let bestD = Infinity;
    for (let row = approxRow - 1; row <= approxRow + 1; row++) {
      const col = Math.round((x - w * 0.5 - w * 0.5 * (row & 1)) / w);
      for (const cand of [{ col, row }, { col: col - 1, row }, { col: col + 1, row }]) {
        if (!this.grid.inBounds(cand)) continue;
        const p = this.grid.toPixel(cand, cellSize, gap);
        const d = Math.hypot(p.x - x, p.y - y);
        if (d < bestD) { bestD = d; best = cand; }
      }
    }
    return best;
  }

  /**
   * 当前帧的悬浮提示文本（用于鼠标悬浮格子时的浮层）。
   *
   * 内容与「已开启的显示状态」严格同步：起始点 / 终点标记、边界进出点标记、轨迹、移动体
   * 各自跟随对应的显示开关，未开启的可视化元素不会在提示中出现；
   * 轨迹部分给出「当前路径经过次数」，并在多蛇场景下额外给出「历史累计经过次数」
   * （单蛇场景下该值与「轨迹」行的「共 N 次」重复，按 hoverTipSlimSingleSnake 自动省略）。
   */
  describe(frameIndex, coord) {
    const s = this.style;
    const frames = this.result.frames;
    const frame = frames[Math.max(0, Math.min(frameIndex, frames.length - 1))];
    if (!frame) return '';
    if (s.hoverTip === false) return '';
    const lines = [`坐标 (${coord.col}, ${coord.row})`];
    const index = this.grid.idx(coord.col, coord.row);
    const info = this.trailInfo.get(index);

    if (s.hoverTipState !== false) {
      const st = this.states[frame.cells[index]];
      lines.push(`环境：${st ? stateLabel(st.name) : '空格'}`);
      // 陷阱格补充说明：悬浮即可读到触发 / 死亡概率，无需翻配置面板
      const trap = this.trapInfo && this.trapInfo.get(st ? st.name : '');
      if (trap) {
        lines.push(`陷阱：触发 ${Math.round(trap.triggerProbability * 100)}% · 死亡 ${Math.round(trap.deathProbability * 100)}%（${trap.name}）`);
      }
    }

    // 标记类信息：与「起点/终点」「边界进出点」两个显示开关同步，未开启则不出现
    if (s.hoverTipMarkers !== false) {
      const isStart = s.showStartEnd && this.startCoord
        && this.startCoord.col === coord.col && this.startCoord.row === coord.row;
      if (isStart) lines.push(`起点标记：本格为起始点${info ? `（首次第 ${info.first} 步）` : ''}`);
      const isEnd = s.showStartEnd && this.endCoord
        && this.endCoord.col === coord.col && this.endCoord.row === coord.row;
      if (isEnd) lines.push('终点标记：本格为结束点');
      if (s.showCrossings && this.crossingCells) {
        const rec = this.crossingCells.get(index);
        const parts = [];
        if (rec) {
          const out = this.crossingSteps(rec.out, frame.tick);
          const inn = this.crossingSteps(rec.in, frame.tick);
          if (out) parts.push(`滑出（${out}）`);
          if (inn) parts.push(`滑入（${inn}）`);
        }
        if (parts.length) lines.push(`边界进出点：${parts.join(' · ')}`);
      }
    }

    if (s.hoverTipAgent !== false && s.showBody) {
      for (const a of frame.agents) {
        const i = a.segments.findIndex(([c, r]) => c === coord.col && r === coord.row);
        if (i === 0) lines.push(`${a.label}：蛇头（方向 ${dirLabel(this.grid.type, a.dir)}）`);
        else if (i > 0) lines.push(`${a.label}：第 ${i} 节`);
      }
    }

    if (s.hoverTipTrail !== false && s.showTrail && info) {
      lines.push(`轨迹：次序 #${info.order} · 首次第 ${info.first} 步 · 末次第 ${info.last} 步 · 共 ${info.visits} 次`);
      const at = visitStatsAt(info, frame.tick);
      if (at) {
        // 统一表述：at.count 是「截至当前步数」的经过次数，info.visits 则是整轮累计，
        // 前者随播放进度增长、后者是最终结果，两者分开陈述可避免「统计口径」歧义。
        lines.push(`当前路径经过次数：第 ${at.count} 次（最近一次经过：第 ${at.last} 步）`);
        // 单蛇场景（画面中只有一条移动体）没有「多蛇聚合」的歧义：「轨迹」行的「共 N 次」
        // 即整轮累计，再列一条同值的「历史累计经过次数」纯属重复信息，
        // 因此此时只保留随播放进度变化的「当前路径经过次数」，提示更简洁精准。
        const slim = s.hoverTipSlimSingleSnake !== false && frame.agents.length <= 1;
        if (!slim) {
          lines.push(at.prev === null
            ? `历史累计经过次数：共 ${info.visits} 次（本格首次经过，此前无经过记录）`
            : `历史累计经过次数：共 ${info.visits} 次（上次经过：第 ${at.prev} 步）`);
        }
      }
    }
    return lines.join('\n');
  }

  /**
   * 边界进出点的步数文案：只列出「已经播放到」的穿越事件（与画面标记同步出现），
   * 超过 3 次时以「等 N 次」收尾，避免提示浮层被长列表撑开。
   */
  crossingSteps(ticks, tick) {
    if (!ticks || !ticks.length) return '';
    const shown = [];
    let hit = 0;
    for (const t of ticks) {
      if (t > tick) continue;
      hit++;
      if (shown.length < 3) shown.push(t);
    }
    if (!hit) return '';
    return hit > shown.length ? `第 ${shown.join('、')} 步 等 ${hit} 次` : `第 ${shown.join('、')} 步`;
  }
}

/* ------------------------------ 绘制工具 ------------------------------ */

/** 蛇身线宽：由头（t=0）到尾（t=1）逐渐收束，避免长蛇尾部显得臃肿 */
function ribbonWidth(radius, t) {
  return Math.max(1.5, radius * 2 * (1 - 0.16 * t));
}

function drawShape(ctx, x, y, r, gridType, shape) {
  if (gridType === 'hex') {
    pathHex(ctx, x, y, r);
    return;
  }
  if (shape === 'square') {
    ctx.beginPath();
    ctx.rect(x - r, y - r, r * 2, r * 2);
    return;
  }
  if (shape === 'hexagon') {
    pathHex(ctx, x, y, r);
    return;
  }
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
}

function pathHex(ctx, x, y, r) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const ang = (Math.PI / 180) * (60 * i - 30);
    const px = x + r * Math.cos(ang);
    const py = y + r * Math.sin(ang);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

function roundRect(ctx, x, y, w, hh, r) {
  const rr = Math.min(r, w / 2, hh / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + hh - rr);
  ctx.quadraticCurveTo(x + w, y + hh, x + w - rr, y + hh);
  ctx.lineTo(x + rr, y + hh);
  ctx.quadraticCurveTo(x, y + hh, x, y + hh - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

export function lerpColor(a, b, t) {
  const pa = hexToRgb(a);
  const pb = hexToRgb(b);
  const k = Math.max(0, Math.min(1, t));
  const p = pa.map((v, i) => Math.round(v + (pb[i] - v) * k));
  return `rgb(${p[0]}, ${p[1]}, ${p[2]})`;
}

/** 按比例压暗颜色（t=0 原色，t=1 全黑） */
export function shadeColor(hex, t) {
  const p = hexToRgb(hex).map((v) => Math.round(v * (1 - Math.max(0, Math.min(1, t)))));
  return `rgb(${p[0]}, ${p[1]}, ${p[2]})`;
}

/** 多色色带取色：stops 为颜色序列，t ∈ [0,1] 表示在色带上的位置 */
export function paletteColor(stops, t) {
  if (!stops || !stops.length) return '#8899aa';
  if (stops.length === 1) return stops[0];
  const k = Math.max(0, Math.min(1, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(k));
  return lerpColor(stops[i], stops[i + 1], k - i);
}

function hexToRgb(hex) {
  const s = String(hex || '#888888').replace('#', '');
  const full = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
  return [0, 2, 4].map((i) => parseInt(full.substr(i, 2), 16) || 0);
}

/** 体节配色：逐个体配色优先，其次按配置的配色模式（渐变 / 单色 / 自定义多色） */
function segmentColor(a, i, n, cfgBody) {
  const own = a.color || null;
  const headColor = own || cfgBody?.colors?.head || '#ff5d5d';
  const tailColor = own || cfgBody?.colors?.tail || '#7a4dff';
  const solidColor = own || cfgBody?.colors?.solid || '#ff5d5d';
  const mode = cfgBody?.colorMode || 'gradient';
  const t = n > 1 ? i / (n - 1) : 0;
  if (own) {
    // 独立配色：单色 → 深色尾端渐变，便于区分不同个体
    return mode === 'solid' ? solidColor : lerpColor(headColor, shadeColor(headColor, 0.45), t);
  }
  if (mode === 'solid') return solidColor;
  const palette = (mode === 'custom' && Array.isArray(cfgBody?.colors?.custom)) ? cfgBody.colors.custom : null;
  return (palette && palette.length) ? paletteColor(palette, t) : lerpColor(headColor, tailColor, t);
}

/**
 * Catmull-Rom → 三次贝塞尔：把点列转成逐段贝塞尔控制点，
 * 使折线变成经过每个节点的平滑曲线（逐段返回，便于按段着色与断点切分）。
 */
function bezierSegments(pts) {
  const segs = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    segs.push({
      p0: p1,
      c1: { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 },
      c2: { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 },
      p1: p2,
    });
  }
  return segs;
}

function traceBezier(ctx, s) {
  ctx.beginPath();
  ctx.moveTo(s.p0.x, s.p0.y);
  ctx.bezierCurveTo(s.c1.x, s.c1.y, s.c2.x, s.c2.y, s.p1.x, s.p1.y);
}

function traceLine(ctx, a, b) {
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
}

/** 描出整条连接路径（贝塞尔或直线），供一次描边（如深色轮廓）使用 */
function traceChain(ctx, verts, segs) {
  ctx.beginPath();
  if (segs && segs.length) {
    ctx.moveTo(segs[0].p0.x, segs[0].p0.y);
    for (const s of segs) ctx.bezierCurveTo(s.c1.x, s.c1.y, s.c2.x, s.c2.y, s.p1.x, s.p1.y);
  } else {
    ctx.moveTo(verts[0].x, verts[0].y);
    for (let k = 1; k < verts.length; k++) ctx.lineTo(verts[k].x, verts[k].y);
  }
}

/** 单位向量 */
function unit(dx, dy) {
  const d = Math.hypot(dx, dy);
  return d > 1e-6 ? { x: dx / d, y: dy / d } : { x: 0, y: 0 };
}

/** 单个拐角最多切掉两臂长度的比例 */
const BEVEL_CUT = 0.45;

/**
 * 预设角度切角：把折线的每个拐角替换为一段直线连接段，
 * 连接段方向与「进入方向」的夹角固定为 angleDeg（不足时退化为原拐角），
 * 得到「直线型 + 按预设角度连接」的规整连续折线（而非贝塞尔弧线）。
 *
 * 几何：拐角处进入方向 d1、离开方向 d2，转角 T = ∠(d1, d2)。
 * 连接段起点距拐角 u、终点距拐角 s，要求连接段与 d1 夹角为 A，
 * 由正弦定理得 s / u = sinA / sin(T - A)；再按臂长上限等比收缩，避免超出相邻采样点。
 */
function bevelChain(pts, angleDeg) {
  const n = pts.length;
  if (n < 3) return pts.map((p) => ({ x: p.x, y: p.y, gi: p.gi, t: p.t, cv: p.cv }));
  const A = Math.max(0.02, Math.min(Math.PI * 0.47, (angleDeg * Math.PI) / 180));
  const out = [{ x: pts[0].x, y: pts[0].y, gi: pts[0].gi, t: pts[0].t, cv: pts[0].cv }];
  for (let i = 1; i < n - 1; i++) {
    const prev = pts[i - 1];
    const p = pts[i];
    const next = pts[i + 1];
    const lenIn = Math.hypot(p.x - prev.x, p.y - prev.y);
    const lenOut = Math.hypot(next.x - p.x, next.y - p.y);
    const d1 = unit(p.x - prev.x, p.y - prev.y);
    const d2 = unit(next.x - p.x, next.y - p.y);
    const cosT = Math.max(-1, Math.min(1, d1.x * d2.x + d1.y * d2.y));
    const T = Math.acos(cosT);
    // 直线通过（无转角）或预设角度不小于转角时，保持原拐角
    if (lenIn < 1e-6 || lenOut < 1e-6 || T < 0.06 || A >= T - 0.06) {
      out.push({ x: p.x, y: p.y, gi: p.gi, t: p.t, cv: p.cv });
      continue;
    }
    const sinDa = Math.sin(T - A);
    const uCapIn = lenIn * BEVEL_CUT;
    const uCapOut = (lenOut * BEVEL_CUT * sinDa) / Math.sin(A);
    const u = Math.min(uCapIn, uCapOut);
    const s = (u * Math.sin(A)) / sinDa;
    out.push({ x: p.x - d1.x * u, y: p.y - d1.y * u, gi: prev.gi, t: prev.t, cv: prev.cv });
    out.push({ x: p.x + d2.x * s, y: p.y + d2.y * s, gi: p.gi, t: p.t, cv: p.cv });
  }
  out.push({ x: pts[n - 1].x, y: pts[n - 1].y, gi: pts[n - 1].gi, t: pts[n - 1].t, cv: pts[n - 1].cv });
  return out;
}

/** 把点列按「相邻点距离 ≤ maxDist」切成若干连续段，避免在断点（如穿越边界）之间画出跨图直线 */
function splitRuns(pts, maxDist) {
  const runs = [];
  let cur = [];
  for (const p of pts) {
    const prev = cur[cur.length - 1];
    if (prev && Math.hypot(p.x - prev.x, p.y - prev.y) > maxDist) {
      runs.push(cur);
      cur = [];
    }
    cur.push(p);
  }
  if (cur.length) runs.push(cur);
  return runs;
}
