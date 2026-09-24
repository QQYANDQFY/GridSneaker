/**
 * 配置模型：默认值、规范化、版本迁移、校验、URL 分享
 */
import { normalizeStates } from './world.js';
import { Grid, parseDir, DIR_LABEL_CN } from './grid.js';
import { patternStateNameAt, clearPatternCell, parsePatternText } from './ca.js';

export const CONFIG_VERSION = '1.2';

/** 「达到步数上限」允许设置的最大步数：远超 10^12，且仍在 Number 精确整数范围内（< 2^53） */
export const MAX_STEPS_LIMIT = 1e15;

/** 生命机制：初始生命数值的合法区间（含端点），界面上以滑动条呈现 */
export const LIFE_MIN = 1;
export const LIFE_MAX = 9;

export const END_PRIORITY_DEFAULT = [
  'wall',
  'outOfBounds',
  'selfCollision',
  'selfCollisionConsecutive',
  'selfCollisionTotal',
  'obstacle',
  'maxSteps',
  'lengthReached',
  'coverage',
  'noMove',
  'allAgentsGone',
  'caStable',
  'maxTime',
  'ruleEnd',
];

export const END_LABELS = {
  wall: '撞墙',
  outOfBounds: '越界',
  selfCollision: '撞到自身',
  selfCollisionConsecutive: '连续撞自身 N 次',
  selfCollisionTotal: '累计撞自身 N 次',
  obstacle: '撞到障碍物',
  maxSteps: '达到步数上限',
  lengthReached: '达到指定长度',
  coverage: '覆盖率达到阈值',
  noMove: '无路可走',
  maxTime: '达到时间上限',
  ruleEnd: '环境规则触发结束',
  frameLimit: '达到安全步数上限',
  caStable: '元胞自动机稳定',
  allAgentsGone: '所有移动体均已消失',
  transformDone: '蛇已全部转化为环境',
  /** 生命机制：生命耗尽后的最终死亡 */
  lifeDepleted: '生命耗尽',
  manual: '手动结束',
};

/** 多蛇之间的交互结果模式 */
export const INTERACTION_MODES = ['collide', 'merge', 'repel', 'pass'];
export const INTERACTION_LABELS = {
  collide: '碰撞（按碰撞规则处理）',
  merge: '融合（吞并对方并合并长度）',
  repel: '排斥（避开对方，不结束运行）',
  pass: '穿行（互不影响）',
};

/** 新蛇生成的触发方式 */
export const SPAWN_MODES = ['time', 'interval', 'event'];
export const SPAWN_LABELS = {
  time: '按预定时间点',
  interval: '按随机时间间隔',
  event: '按特殊事件',
};

/** 可用于「特殊事件」生成触发的运行事件 */
export const SPAWN_EVENTS = ['eat', 'markerInteraction', 'selfCollision', 'wall', 'obstacle', 'merge'];
export const SPAWN_EVENT_LABELS = {
  eat: '吃到标记物',
  markerInteraction: '触碰交互标记物',
  selfCollision: '发生自撞',
  wall: '撞墙/越界',
  obstacle: '撞到障碍物',
  merge: '发生融合',
};

export const DEFAULT_STATES = [
  { name: 'empty', color: null, blocking: false, symbol: '.', render: 'fill' },
  { name: 'obstacle', color: '#5b6472', blocking: true, symbol: '#', render: 'cross' },
  { name: 'marker', color: '#ffd166', blocking: false, symbol: 'M', render: 'dot' },
];

export function defaultGrid() {
  // 默认边界行为为「穿越到另一侧」：蛇头触碰画布边界时从对侧对应位置重新出现。
  return { type: 'square', width: 24, height: 24, boundary: 'wrap' };
}

export function defaultRule(overrides = {}) {
  return normalizeRule({
    id: `rule_${Math.random().toString(36).slice(2, 8)}`,
    name: '新规则',
    enabled: true,
    subject: 'head',
    trigger: 'afterStep',
    condition: { logic: 'and', clauses: [{ type: 'count', kind: 'moore', radius: 1, objects: ['obstacle'], comparator: '>=', value: 2 }] },
    actions: [{ type: 'createMarker', position: 'current' }],
    priority: 1,
    probability: 1,
    cooldown: 0,
    maxTriggers: 0,
    once: false,
    ...overrides,
  });
}

/** 条件子句默认值（供规则编辑器使用） */
export function defaultClause(type = 'count') {
  const base = { type, invert: false };
  switch (type) {
    case 'count':
      return { ...base, kind: 'moore', radius: 1, objects: ['obstacle'], comparator: '>=', value: 2, includeSelf: false };
    case 'proportion':
      return { ...base, kind: 'moore', radius: 1, objects: ['empty'], comparator: '<', value: 0.3 };
    case 'exists':
      return { ...base, kind: 'moore', radius: 1, objects: ['marker'] };
    case 'direction':
      return { ...base, objects: ['obstacle'], rel: 'front', distance: 1 };
    case 'pattern':
      return { ...base, pattern: '.#.\n#S#\n...' };
    case 'distance':
      return { ...base, objects: ['obstacle'], comparator: '<=', value: 2 };
    case 'stat':
      return { ...base, key: 'steps', comparator: '>=', value: 10 };
    case 'selfLength':
      return { ...base, comparator: '>=', value: 10 };
    case 'agentCount':
      return { ...base, comparator: '>=', value: 2 };
    case 'cellState':
      return { ...base, position: 'front', state: 'obstacle' };
    case 'random':
      return { ...base, probability: 0.5 };
    case 'group':
      return { logic: 'or', invert: false, type: 'group', clauses: [{ type: 'count', kind: 'moore', radius: 1, objects: ['obstacle'], comparator: '>=', value: 1 }] };
    default:
      return base;
  }
}

export function defaultAction(type = 'createObstacle') {
  switch (type) {
    case 'createObstacle':
      return { type, position: 'current', count: 1 };
    case 'removeObstacle':
      return { type, position: 'current' };
    case 'createMarker':
      return { type, position: 'current', count: 1 };
    case 'removeMarker':
      return { type, position: 'current' };
    case 'setCellState':
      return { type, position: 'front', state: 'obstacle' };
    case 'clearState':
      return { type, state: 'obstacle' };
    case 'forceTurn':
      return { type, turn: 'right' };
    case 'randomTurn':
      return { type, weights: { left: 1, straight: 1, right: 1 } };
    case 'changeLength':
      return { type, amount: 1 };
    case 'setLength':
      return { type, value: 5 };
    case 'changeSpeed':
      return { type, factor: 1.5, min: 0.1, max: 8 };
    case 'setColor':
      return { type, color: '#ff7ab6' };
    case 'spawnAgent':
      return { type, length: 3, direction: 'random' };
    case 'removeAgent':
      return { type, target: 'nearest' };
    case 'modifyRule':
      return { type, ruleId: '', op: 'disable', value: 0 };
    case 'endRun':
      return { type, reason: '环境规则结束' };
    case 'log':
      return { type, message: '触发' };
    case 'paintTrail':
      return { type, position: 'current', state: 'trail' };
    default:
      return { type };
  }
}

export function defaultConfig() {
  return {
    version: CONFIG_VERSION,
    meta: { name: '默认场景', description: '随机游走 + 环境规则' },
    grid: defaultGrid(),
    start: { col: 12, row: 12, direction: 'up' },
    body: {
      // 蛇形实体总开关：关闭后地图上不再生成任何蛇形实体（纯环境 / 纯 CA 演化）
      enabled: true,
      initialLength: 3,
      segmentSize: 0.82,
      shape: 'round',
      colorMode: 'gradient',
      colors: {
        head: '#ff5d5d',
        tail: '#7a4dff',
        solid: '#ff5d5d',
        trail: '#2f7bd6',
        custom: ['#ff5d5d', '#ffd166', '#51cf66', '#4dabf7', '#c084fc'],
      },
      lengthPolicy: {
        mode: 'fixed',
        growth: { enabled: false, trigger: 'step', amount: 1, probability: 1, maxLength: 50, minLength: 1, interval: 1 },
        shrink: { enabled: false, trigger: 'step', amount: 1, probability: 0.05, maxLength: 100000, minLength: 1, interval: 1 },
      },
      /**
       * 自定义皮肤：用户上传的图片（dataURL），head 绘制在蛇头、body 绘制在其余体节。
       * 空字符串表示未使用皮肤，此时按「配色模式」的纯色 / 渐变绘制。
       */
      skin: { head: '', body: '' },
    },
    moveRules: { left: 0.33, straight: 0.34, right: 0.33 },
    /**
     * 安全避撞预设：在方向选择阶段先剔除会撞到自身身体（可选：障碍物 / 其它移动体）的候选方向，
     * 仅当所有可行方向均被阻塞时才回落到原始权重，从而触发原本的碰撞逻辑。
     */
    safety: {
      avoidBody: false,
      avoidObstacle: false,
      avoidOtherAgents: true,
      /** 碰撞预警提示：在画面上标出下一步会撞到自身身体的危险格（默认关闭） */
      warnSelfCollision: false,
    },
    /** 多蛇生成与交互系统 */
    multiSnake: {
      enabled: false,
      spawn: {
        mode: 'time',
        times: [20, 60, 120],
        minInterval: 30,
        maxInterval: 90,
        maxAgents: 6,
        length: 3,
        direction: 'random',
        events: ['eat'],
        probability: 1,
      },
      interaction: {
        mode: 'collide',
        colorPalette: ['#ff5d5d', '#ffd166', '#51cf66', '#4dabf7', '#c084fc', '#f783ac', '#63e6be', '#ffa94d'],
      },
    },
    ruleExecution: 'async',
    advancedRules: [],
    collision: {
      headIntoBody: true,
      headIntoTail: false,
      wall: true,
      outOfBounds: true,
      obstacle: 'stop',
      countMode: 'total',
    },
    selfCollisionPolicy: { action: 'stop', n: 2, maxConsecutive: 5 },
    /**
     * 过程性事件记录：把边界穿越这类「不是规则触发、但值得回溯」的事件写入规则日志。
     * 关闭后不影响运行结果，只是不再产生对应日志条目。
     */
    events: { logCrossings: true },
    /**
     * 蛇死亡转化：自撞致死后，按概率把身体节点并入元胞自动机（写入目标状态）。
     *
     * 与既有「自撞处理」的关系：
     *  - enabled = false 时自撞完全沿用 selfCollisionPolicy 的原有处理，默认值保证旧场景零变化；
     *  - enabled = true 且 dieOnSelfCollision = true 时，自撞只让该移动体从场上消失
     *    （含主移动体），**不会终止整轮运行**，主循环继续驱动元胞自动机演化。
     */
    transform: {
      enabled: false,
      /** 自撞即判定死亡（取代「自撞处理」策略；死亡不等于结束运行） */
      dieOnSelfCollision: true,
      /** 全局触发概率：蛇死亡后是否启动转化流程 */
      globalProbability: 0.6,
      /** 分段转化概率：每个身体节点独立转化为环境状态的概率 */
      segmentProbability: 0.5,
      /** 转化目标状态名（必须是 caMode.states 中真实存在且非 empty 的状态） */
      state: 'obstacle',
    },
    /**
     * 生命机制（多生命系统）。
     *
     * 默认关闭，旧场景零变化。开启后：
     *  - 主移动体携带 initialLives 条生命（1~9），致命判定（自撞 / 撞墙 / 越界 / 撞障碍物）
     *    先扣 1 条命并原地重生（保留头部位置、得分等进度，只重置蛇身长度 + 播放重生动画）；
     *  - 生命耗尽才触发最终死亡（沿用 transform / 结束规则的原有收尾方式）；
     *  - 触碰 items.gainStates 中的格子 +gainAmount 条命，触碰 items.lossStates 中的格子 -lossAmount 条命。
     *
     * keepMovingAfterDeath：死亡后是否仍可移动。
     * **默认关闭**——关闭时蛇一旦判定死亡立即停止所有移动逻辑，并从画面上删去蛇头与蛇身。
     */
    life: {
      enabled: false,
      /** 初始生命（1~9） */
      initialLives: 3,
      /** 死亡后仍可移动（默认关闭，保证死亡即刻停止并移除蛇头蛇身） */
      keepMovingAfterDeath: false,
      /** 生命低至该值时给出预警提示（0 表示不预警） */
      warnThreshold: 1,
      /** 单条生命耗尽后的重生参数 */
      respawn: {
        /** 重生后的蛇身长度 */
        length: 3,
        /** 重生后的无敌步数（该步数内不再触发致命判定） */
        invincibleTicks: 2,
      },
      /** 环境中的增 / 减生命来源 */
      items: {
        /** 触碰后增加生命的格子状态 */
        gainStates: ['marker'],
        gainAmount: 1,
        /** 增益格子是否在拾取后被清空 */
        consumeGain: true,
        /** 触碰后扣除生命的格子状态（非致命陷阱） */
        lossStates: [],
        lossAmount: 1,
      },
    },
    environmentRules: [],
    caMode: {
      enabled: false,
      states: DEFAULT_STATES,
      neighborhood: 'moore',
      radius: 1,
      boundary: 'wrap',
      update: 'synchronous',
      rules: [],
      initial: { mode: 'empty', density: 0.3, pattern: '' },
      syncWithAgent: 'afterMove',
      every: 1,
      stopWhenAgentEnds: false,
      /** 元胞稳定态检测：连续 stableSteps 次演化都没有任何单元变化时结束运行（纯 CA 场景的收尾体验） */
      stopOnStable: false,
      stableSteps: 3,
      /**
       * 标记物交互机制：把指定的元胞状态定义为「交互标记物」，
       * 移动体触碰后按反馈规则表产生长度 / 颜色 / 消耗等状态变化。
       */
      markerInteraction: {
        enabled: false,
        states: ['marker'],
        effects: [
          {
            id: 'fx_grow',
            name: '触碰增长',
            enabled: true,
            state: 'marker',
            mode: 'delta',
            value: 1,
            probability: 1,
            consume: true,
            consumeTo: 'empty',
            color: '',
          },
        ],
      },
    },
    endConditions: {
      wall: true,
      outOfBounds: true,
      selfCollision: true,
      selfCollisionTotal: false,
      selfCollisionTotalN: 3,
      selfCollisionConsecutive: false,
      selfCollisionConsecutiveN: 3,
      obstacle: false,
      maxSteps: 200,
      lengthReached: false,
      lengthTarget: 50,
      coverage: false,
      coveragePercent: 80,
      noMove: true,
      maxTime: false,
      maxTimeMs: 5000,
      ruleEnd: true,
      /** 元胞自动机进入稳定态时结束（也可由 caMode.stopOnStable 强制开启） */
      caStable: false,
      /** 曾经存在过的移动体全部消失时结束 */
      allAgentsGone: false,
      priority: [...END_PRIORITY_DEFAULT],
    },
    seed: 12345,
    speed: 8,
    style: {
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
      highlightRules: true,
      showStartEnd: true,
      trailFade: true,
      /**
       * 轨迹亮度衰减：按「离开头部的步数（age）」衰减，走满 fadeLength 步后完全淡出。
       * fadeMode = linear 线性 · exponential 指数（先急后缓）
       */
      fadeMode: 'linear',
      fadeLength: 60,
      /**
       * 轨迹颜色分级映射：fade 按新旧渐隐 · visit 按经过次数（热度）· order 按经过次序
       */
      trailColorMode: 'fade',
      /** 轨迹尖端平滑过渡：播放到两帧之间时补出头部所在的一小段，让轨迹跟随蛇头平滑滑动 */
      trailSmooth: true,
      /** 在轨迹接缝处标出边界穿越点 */
      showCrossings: true,
      /** 蛇头眼睛默认隐藏，需在「展示样式 → 渲染效果」中主动开启 */
      showEyes: false,
      showEffects: true,
      glow: false,
      /** 轨迹 / 蛇身的连接方式：curve 曲线（贝塞尔） · line 直线 · angle 按预设角度切角连接的直线 */
      trailJoin: 'line',
      bodyJoin: 'line',
      /** angle 模式下的预设角度（度）：连接线与进入方向的夹角 */
      trailAngle: 45,
      /** 由连接方式派生，保留以兼容旧配置与导出 */
      smoothTrail: true,
      smoothBody: true,
      /** 播放时自动滚动视图跟随首个移动体，默认关闭 */
      followAgent: false,
      background: null,
      gridLine: null,
      axisLabels: true,
    },
  };
}

/* ------------------------------------------------------------------ */
/* 规范化                                                              */
/* ------------------------------------------------------------------ */

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const bool = (v, d) => (v === undefined || v === null ? d : !!v);
const str = (v, d) => (v === undefined || v === null ? d : String(v));

const COMPARATORS = ['>=', '<=', '==', '>', '<', '!='];
function normComparator(c, d = '>=') {
  return COMPARATORS.includes(c) ? c : d;
}

const HEX_COLOR = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
/** 自定义色带：仅保留合法的十六进制颜色，为空时回退到默认色带 */
function normColorList(v, fallback) {
  if (!Array.isArray(v)) return [...fallback];
  const list = v.map((c) => String(c).trim()).filter((c) => HEX_COLOR.test(c));
  return list.length ? list : [...fallback];
}

/** 自定义皮肤支持的上传格式（与界面「自定义皮肤」的格式校验保持一致） */
export const SKIN_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
/** 皮肤字段的合法形态：JPG / PNG / WebP 三种格式的 base64 dataURL */
const SKIN_DATA_URL = /^data:image\/(?:jpe?g|png|webp);base64,[a-z0-9+/=]+$/i;

/** 配置中的皮肤字段是否为受支持的图片 dataURL */
export function isSkinImage(v) {
  return typeof v === 'string' && SKIN_DATA_URL.test(v.trim());
}

/** 皮肤规范化：仅保留受支持的图片 dataURL，非法值 / 缺失字段一律回退为「未设置」 */
function normSkin(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    head: isSkinImage(src.head) ? String(src.head).trim() : '',
    body: isSkinImage(src.body) ? String(src.body).trim() : '',
  };
}

function normClause(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const invert = !!raw.invert;
  // 支持简写：{neighborhood, objects, count:{min,max,exact}}
  if (!raw.type && (raw.objects || raw.neighborhood || raw.count)) {
    const kind = normNeighborhood(raw.neighborhood || raw.kind);
    const radius = clamp(num(raw.radius, 1), 1, 12);
    const objects = normObjects(raw.objects);
    const count = raw.count;
    if (count && typeof count === 'object') {
      const clauses = [];
      if (count.min !== undefined) clauses.push({ type: 'count', kind, radius, objects, comparator: '>=', value: num(count.min, 1), invert, includeSelf: !!raw.includeSelf });
      if (count.max !== undefined) clauses.push({ type: 'count', kind, radius, objects, comparator: '<=', value: num(count.max, 1), invert, includeSelf: !!raw.includeSelf });
      if (count.exact !== undefined || count.equals !== undefined) {
        clauses.push({ type: 'count', kind, radius, objects, comparator: '==', value: num(count.exact ?? count.equals, 1), invert, includeSelf: !!raw.includeSelf });
      }
      if (count.value !== undefined) {
        clauses.push({ type: 'count', kind, radius, objects, comparator: normComparator(count.comparator), value: num(count.value, 1), invert, includeSelf: !!raw.includeSelf });
      }
      if (clauses.length === 1) return clauses[0];
      if (clauses.length > 1) return { type: 'group', logic: 'and', invert: false, clauses };
    }
    return { type: 'count', kind, radius, objects, comparator: '>=', value: 1, invert, includeSelf: !!raw.includeSelf };
  }

  const t = str(raw.type, 'count');
  const kind = normNeighborhood(raw.kind || raw.neighborhood);
  const radius = clamp(num(raw.radius, 1), 1, 12);
  switch (t) {
    case 'count':
      return { type: 'count', kind, radius, objects: normObjects(raw.objects), comparator: normComparator(raw.comparator), value: num(raw.value, 1), invert, includeSelf: !!raw.includeSelf };
    case 'proportion':
      return { type: 'proportion', kind, radius, objects: normObjects(raw.objects), comparator: normComparator(raw.comparator, '<'), value: num(raw.value, 0.3), invert, includeSelf: !!raw.includeSelf };
    case 'exists':
      return { type: 'exists', kind, radius, objects: normObjects(raw.objects), invert };
    case 'direction':
      return { type: 'direction', objects: normObjects(raw.objects), rel: str(raw.rel, 'front'), distance: clamp(num(raw.distance, 1), 1, 12), invert };
    case 'pattern':
      return { type: 'pattern', pattern: str(raw.pattern, ''), invert };
    case 'distance':
      return { type: 'distance', objects: normObjects(raw.objects), comparator: normComparator(raw.comparator, '<='), value: num(raw.value, 2), invert };
    case 'stat':
      return { type: 'stat', key: str(raw.key, 'steps'), comparator: normComparator(raw.comparator), value: num(raw.value, 10), invert };
    case 'selfLength':
      return { type: 'selfLength', comparator: normComparator(raw.comparator), value: num(raw.value, 10), invert };
    case 'agentCount':
      return { type: 'agentCount', comparator: normComparator(raw.comparator), value: num(raw.value, 2), invert };
    case 'cellState':
      return { type: 'cellState', position: str(raw.position, 'front'), state: str(raw.state, 'obstacle'), invert };
    case 'random':
      return { type: 'random', probability: clamp(num(raw.probability, 0.5), 0, 1), invert };
    case 'group': {
      const clauses = (Array.isArray(raw.clauses) ? raw.clauses : []).map(normClause).filter(Boolean);
      return { type: 'group', logic: raw.logic === 'or' ? 'or' : 'and', invert, clauses };
    }
    default:
      return { type: 'count', kind, radius, objects: ['obstacle'], comparator: '>=', value: 1, invert, includeSelf: false };
  }
}

function normNeighborhood(v) {
  const s = str(v, 'moore').toLowerCase();
  if (['vonneumann', 'von_neumann', 'neumann', '4', 'four'].includes(s)) return 'vonNeumann';
  if (['moore', '8', 'eight'].includes(s)) return 'moore';
  if (['hex', 'hexagonal', '6'].includes(s)) return 'hex';
  if (['radius', 'r'].includes(s)) return 'radius';
  return 'moore';
}

function normObjects(v) {
  if (Array.isArray(v)) {
    const list = v.map(String).filter(Boolean);
    return list.length ? list : ['obstacle'];
  }
  if (typeof v === 'string' && v) return [v];
  return ['obstacle'];
}

function normAction(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const type = str(raw.type, '');
  const a = { ...raw, type };
  switch (type) {
    case 'forceTurn':
      a.turn = str(raw.turn ?? raw.direction ?? 'right', 'right');
      a.probability = clamp(num(raw.probability, 1), 0, 1);
      return a;
    case 'randomTurn':
      a.weights = {
        left: Math.max(0, num(raw.weights?.left, 1)),
        straight: Math.max(0, num(raw.weights?.straight, 1)),
        right: Math.max(0, num(raw.weights?.right, 1)),
      };
      return a;
    case 'createObstacle':
    case 'createMarker':
      a.position = str(raw.position, 'current');
      a.count = clamp(num(raw.count, 1), 1, 64);
      return a;
    case 'removeObstacle':
    case 'removeMarker':
      a.position = str(raw.position, 'current');
      return a;
    case 'setCellState':
      a.position = str(raw.position, 'front');
      a.state = str(raw.state, 'obstacle');
      return a;
    case 'clearState':
      a.state = str(raw.state, 'obstacle');
      return a;
    case 'changeLength':
      a.amount = Math.round(num(raw.amount, 1));
      return a;
    case 'setLength':
      a.value = clamp(Math.round(num(raw.value, 3)), 1, 100000);
      return a;
    case 'changeSpeed':
      a.factor = num(raw.factor, 1.5);
      return a;
    case 'spawnAgent':
      a.length = clamp(Math.round(num(raw.length, 3)), 1, 200);
      a.direction = str(raw.direction, 'random');
      return a;
    case 'removeAgent':
      a.target = ['nearest', 'random', 'largest', 'oldest'].includes(raw.target) ? raw.target : 'nearest';
      return a;
    case 'modifyRule':
      a.ruleId = str(raw.ruleId, '');
      a.op = str(raw.op, 'disable');
      a.value = num(raw.value, 0);
      return a;
    case 'endRun':
      a.reason = str(raw.reason, '环境规则结束');
      return a;
    case 'log':
      a.message = str(raw.message, '触发');
      return a;
    case 'paintTrail':
      a.position = str(raw.position, 'current');
      a.state = str(raw.state, 'trail');
      return a;
    default:
      return a;
  }
}

export function normalizeCondition(raw) {
  if (!raw) return { logic: 'and', clauses: [] };
  if (Array.isArray(raw)) return { logic: 'and', clauses: raw.map(normClause).filter(Boolean) };
  if (raw.clauses) {
    return { logic: raw.logic === 'or' ? 'or' : 'and', clauses: raw.clauses.map(normClause).filter(Boolean) };
  }
  const c = normClause(raw);
  return { logic: 'and', clauses: c ? [c] : [] };
}

export function normalizeRule(raw = {}) {
  const subjects = ['head', 'body', 'headAndBody', 'anySegment', 'segment', 'allAgents', 'cell'];
  const triggers = ['beforeStep', 'afterStep', 'onEnter', 'onCollision', 'onBoundary', 'timer', 'manual'];
  return {
    id: str(raw.id, `rule_${Math.random().toString(36).slice(2, 8)}`),
    name: str(raw.name, '未命名规则'),
    enabled: bool(raw.enabled, true),
    subject: subjects.includes(raw.subject) ? raw.subject : 'head',
    segmentIndex: Math.round(num(raw.segmentIndex, 1)),
    trigger: triggers.includes(raw.trigger) ? raw.trigger : 'afterStep',
    interval: clamp(Math.round(num(raw.interval, 5)), 1, 100000),
    condition: normalizeCondition(raw.condition),
    actions: (Array.isArray(raw.actions) ? raw.actions : []).map(normAction).filter(Boolean),
    priority: Math.round(num(raw.priority, 1)),
    probability: clamp(num(raw.probability, 1), 0, 1),
    cooldown: clamp(Math.round(num(raw.cooldown, 0)), 0, 100000),
    maxTriggers: clamp(Math.round(num(raw.maxTriggers, 0)), 0, 1000000),
    once: !!raw.once,
  };
}

function normLengthPolicy(raw = {}) {
  const d = defaultConfig().body.lengthPolicy;
  const mode = ['fixed', 'variable', 'custom'].includes(raw.mode) ? raw.mode : 'fixed';
  const normSub = (s, def) => ({
    enabled: bool(s?.enabled, def.enabled),
    trigger: ['step', 'eat', 'collision', 'event', 'timer'].includes(s?.trigger) ? s.trigger : def.trigger,
    amount: Math.round(num(s?.amount, def.amount)),
    probability: clamp(num(s?.probability, def.probability), 0, 1),
    interval: clamp(Math.round(num(s?.interval, def.interval)), 1, 100000),
    maxLength: clamp(Math.round(num(s?.maxLength ?? def.maxLength, def.maxLength)), 1, 100000),
    minLength: clamp(Math.round(num(s?.minLength ?? def.minLength, def.minLength)), 1, 100000),
  });
  return {
    mode,
    growth: normSub(raw.growth, d.growth),
    shrink: normSub(raw.shrink, d.shrink),
  };
}

function normAdvancedRules(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((r) => ({
    id: str(r.id, `adv_${Math.random().toString(36).slice(2, 8)}`),
    enabled: bool(r.enabled, true),
    name: str(r.name, '条件概率'),
    condition: normalizeCondition(r.condition || r.when || null),
    moves: {
      left: Math.max(0, num(r.moves?.left, 0.33)),
      straight: Math.max(0, num(r.moves?.straight, 0.34)),
      right: Math.max(0, num(r.moves?.right, 0.33)),
    },
    priority: Math.round(num(r.priority, 1)),
  }));
}

function normCaRules(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((r, i) => {
    const counts = Array.isArray(r.counts)
      ? r.counts.map((c) => ({
        state: str(c.state, 'alive'),
        values: Array.isArray(c.values) ? c.values.map((v) => Math.round(num(v, 0))) : null,
        min: c.min !== undefined ? Math.round(num(c.min, 0)) : null,
        max: c.max !== undefined ? Math.round(num(c.max, 0)) : null,
      }))
      : [];
    return {
      id: str(r.id, `ca_${i}`),
      name: str(r.name, `规则 ${i + 1}`),
      enabled: bool(r.enabled, true),
      kind: ['count', 'traffic'].includes(r.kind) ? r.kind : 'count',
      from: Array.isArray(r.from) ? r.from.map(String) : r.from === '*' || !r.from ? '*' : [String(r.from)],
      counts,
      to: str(r.to, 'empty'),
      probability: clamp(num(r.probability, 1), 0, 1),
      direction: str(r.direction, 'east'),
    };
  });
}

/** 轨迹 / 蛇身的连接方式 */
export const JOIN_MODES = ['curve', 'line', 'angle'];

/** 轨迹亮度衰减模式：线性 / 指数 */
export const FADE_MODES = ['linear', 'exponential'];

/** 轨迹颜色分级映射：fade 按新旧渐隐 · visit 按经过次数（热度）· order 按经过次序 */
export const TRAIL_COLOR_MODES = ['fade', 'visit', 'order'];

/** 轨迹衰减步长的允许范围（步） */
export const FADE_LENGTH_LIMIT = { min: 2, max: 2000 };

/**
 * 连接方式规范化：
 * 优先读取 trailJoin / bodyJoin；旧配置只有 smoothTrail / smoothBody 布尔值时按
 * 「开 = 曲线，关 = 直线」换算，保证历史配置与分享链接的表现不变。
 */
function normJoin(raw, joinKey, smoothKey, fallback) {
  if (JOIN_MODES.includes(raw[joinKey])) return raw[joinKey];
  if (raw[joinKey] !== undefined) return fallback;
  return bool(raw[smoothKey], fallback === 'curve') ? 'curve' : 'line';
}

function normalizeStyle(raw = {}) {
  const d = defaultConfig().style;
  const trailJoin = normJoin(raw, 'trailJoin', 'smoothTrail', d.trailJoin);
  const bodyJoin = normJoin(raw, 'bodyJoin', 'smoothBody', d.bodyJoin);
  return {
    ...d,
    ...raw,
    cellSize: clamp(num(raw.cellSize, d.cellSize), 6, 120),
    gap: clamp(num(raw.gap, d.gap), 0, 20),
    darkMode: bool(raw.darkMode, d.darkMode),
    showGrid: bool(raw.showGrid, d.showGrid),
    showTrail: bool(raw.showTrail, d.showTrail),
    showBody: bool(raw.showBody, d.showBody),
    showArrows: bool(raw.showArrows, d.showArrows),
    showCoords: bool(raw.showCoords, d.showCoords),
    showObstacles: bool(raw.showObstacles, d.showObstacles),
    showMarkers: bool(raw.showMarkers, d.showMarkers),
    highlightRules: bool(raw.highlightRules, d.highlightRules),
    showStartEnd: bool(raw.showStartEnd, d.showStartEnd),
    trailFade: bool(raw.trailFade, d.trailFade),
    fadeMode: FADE_MODES.includes(raw.fadeMode) ? raw.fadeMode : d.fadeMode,
    fadeLength: clamp(num(raw.fadeLength, d.fadeLength), FADE_LENGTH_LIMIT.min, FADE_LENGTH_LIMIT.max),
    trailColorMode: TRAIL_COLOR_MODES.includes(raw.trailColorMode) ? raw.trailColorMode : d.trailColorMode,
    trailSmooth: bool(raw.trailSmooth, d.trailSmooth),
    showCrossings: bool(raw.showCrossings, d.showCrossings),
    axisLabels: bool(raw.axisLabels, d.axisLabels),
    showEyes: bool(raw.showEyes, d.showEyes),
    showEffects: bool(raw.showEffects, d.showEffects),
    glow: bool(raw.glow, d.glow),
    trailJoin,
    bodyJoin,
    trailAngle: clamp(num(raw.trailAngle, d.trailAngle), 5, 85),
    smoothTrail: trailJoin === 'curve',
    smoothBody: bodyJoin === 'curve',
    followAgent: bool(raw.followAgent, d.followAgent),
  };
}

/** 安全避撞预设 */
function normSafety(raw = {}) {
  const d = defaultConfig().safety;
  return {
    avoidBody: bool(raw.avoidBody, d.avoidBody),
    avoidObstacle: bool(raw.avoidObstacle, d.avoidObstacle),
    avoidOtherAgents: bool(raw.avoidOtherAgents, d.avoidOtherAgents),
    /** 碰撞预警提示：标出「下一步会撞到自身身体」的危险格（默认关闭，避免长蛇额外开销） */
    warnSelfCollision: bool(raw.warnSelfCollision, d.warnSelfCollision),
  };
}

/** 标记物交互反馈规则表 */
function normMarkerEffects(raw) {
  const d = defaultConfig().caMode.markerInteraction.effects;
  const list = Array.isArray(raw) ? raw : d;
  const out = list.map((e, i) => ({
    id: str(e?.id, `fx_${i}`),
    name: str(e?.name, `反馈 ${i + 1}`),
    enabled: bool(e?.enabled, true),
    state: str(e?.state, 'marker'),
    mode: ['set', 'percent'].includes(e?.mode) ? e.mode : 'delta',
    value: Math.round(num(e?.value, 1)),
    probability: clamp(num(e?.probability, 1), 0, 1),
    consume: bool(e?.consume, true),
    consumeTo: str(e?.consumeTo, 'empty'),
    color: HEX_COLOR.test(String(e?.color || '')) ? String(e.color) : '',
  }));
  return out;
}

function normCaMarkerInteraction(raw = {}) {
  const d = defaultConfig().caMode.markerInteraction;
  const states = Array.isArray(raw.states) && raw.states.length ? raw.states.map(String) : [...d.states];
  return {
    enabled: bool(raw.enabled, d.enabled),
    states,
    effects: normMarkerEffects(raw.effects),
  };
}

/**
 * 「蛇死亡转化」参数规范化。
 * 两个概率都夹取到 [0,1]；转化目标状态必须落在当前状态集合中真实存在且非 empty 的位置，
 * 否则写入时会被 stateIndexOf 退化成索引 0（视觉上「转化了但什么都没出现」）。
 */
function normTransform(rawT, states) {
  const d = defaultConfig().transform;
  const t = rawT && typeof rawT === 'object' ? rawT : {};
  const names = states.map((s) => s.name);
  const want = str(t.state, d.state);
  const fallback = names.find((n) => n !== 'empty') || 'empty';
  return {
    enabled: bool(t.enabled, d.enabled),
    dieOnSelfCollision: bool(t.dieOnSelfCollision, d.dieOnSelfCollision),
    globalProbability: clamp(num(t.globalProbability, d.globalProbability), 0, 1),
    segmentProbability: clamp(num(t.segmentProbability, d.segmentProbability), 0, 1),
    state: names.includes(want) && want !== 'empty' ? want : fallback,
  };
}

/**
 * 「生命机制」参数规范化。
 *  - initialLives / warnThreshold 等数值全部夹取到合法区间；
 *  - 增 / 减生命的状态名必须真实存在于状态集合中（empty 除外），否则会被静默丢弃，
 *    避免配置里写了一个不存在的「陷阱状态」后机制永不生效却毫无提示。
 */
function normLife(rawL, states) {
  const d = defaultConfig().life;
  const l = rawL && typeof rawL === 'object' ? rawL : {};
  const names = new Set(states.map((s) => s.name));
  const pickStates = (v, fb) => {
    const src = Array.isArray(v) ? v : fb;
    const out = [];
    for (const item of src) {
      const n = String(item);
      if (!names.has(n) || n === 'empty' || out.includes(n)) continue;
      out.push(n);
    }
    return out;
  };
  const r = l.respawn && typeof l.respawn === 'object' ? l.respawn : {};
  const it = l.items && typeof l.items === 'object' ? l.items : {};
  return {
    enabled: bool(l.enabled, d.enabled),
    initialLives: clamp(Math.round(num(l.initialLives, d.initialLives)), LIFE_MIN, LIFE_MAX),
    keepMovingAfterDeath: bool(l.keepMovingAfterDeath, d.keepMovingAfterDeath),
    warnThreshold: clamp(Math.round(num(l.warnThreshold, d.warnThreshold)), 0, LIFE_MAX),
    respawn: {
      length: clamp(Math.round(num(r.length, d.respawn.length)), 1, 100000),
      invincibleTicks: clamp(Math.round(num(r.invincibleTicks, d.respawn.invincibleTicks)), 0, 100000),
    },
    items: {
      gainStates: pickStates(it.gainStates, d.items.gainStates),
      gainAmount: clamp(Math.round(num(it.gainAmount, d.items.gainAmount)), 0, LIFE_MAX),
      consumeGain: bool(it.consumeGain, d.items.consumeGain),
      lossStates: pickStates(it.lossStates, d.items.lossStates),
      lossAmount: clamp(Math.round(num(it.lossAmount, d.items.lossAmount)), 1, LIFE_MAX),
    },
  };
}

function normMultiSnake(raw = {}) {
  const d = defaultConfig().multiSnake;
  const sp = raw.spawn || {};
  const it = raw.interaction || {};
  const palette = normColorList(it.colorPalette, d.interaction.colorPalette);
  return {
    enabled: bool(raw.enabled, d.enabled),
    spawn: {
      mode: SPAWN_MODES.includes(sp.mode) ? sp.mode : d.spawn.mode,
      times: (Array.isArray(sp.times) ? sp.times : d.spawn.times)
        .map((v) => Math.round(num(v, 0)))
        .filter((v) => v > 0)
        .sort((a, b) => a - b),
      minInterval: clamp(Math.round(num(sp.minInterval, d.spawn.minInterval)), 1, 100000),
      maxInterval: clamp(Math.round(num(sp.maxInterval, d.spawn.maxInterval)), 1, 100000),
      maxAgents: clamp(Math.round(num(sp.maxAgents, d.spawn.maxAgents)), 1, 64),
      length: clamp(Math.round(num(sp.length, d.spawn.length)), 1, 200),
      direction: str(sp.direction, d.spawn.direction),
      events: (Array.isArray(sp.events) ? sp.events : d.spawn.events).map(String).filter((e) => SPAWN_EVENTS.includes(e)),
      probability: clamp(num(sp.probability, d.spawn.probability), 0, 1),
    },
    interaction: {
      mode: INTERACTION_MODES.includes(it.mode) ? it.mode : d.interaction.mode,
      colorPalette: palette,
    },
  };
}

/**
 * 规范化 + 迁移。支持规范完整格式，也支持需求文档中的紧凑格式（x/y、rules、count.min 等）。
 */
export function normalizeConfig(rawInput = {}) {
  const raw = migrate(rawInput);
  const d = defaultConfig();

  const gridRaw = raw.grid || {};
  const grid = {
    type: gridRaw.type === 'hex' ? 'hex' : 'square',
    width: clamp(Math.round(num(gridRaw.width, d.grid.width)), 2, 400),
    height: clamp(Math.round(num(gridRaw.height, d.grid.height)), 2, 400),
    boundary: ['stop', 'bounce', 'wrap', 'randomTurn', 'custom'].includes(gridRaw.boundary) ? gridRaw.boundary : 'stop',
  };

  const startRaw = raw.start || {};
  const start = {
    col: gridRaw.type === 'hex'
      ? clamp(Math.round(num(startRaw.col ?? startRaw.x, d.start.col)), 0, grid.width - 1)
      : clamp(Math.round(num(startRaw.col ?? startRaw.x, d.start.col)), 0, grid.width - 1),
    row: clamp(Math.round(num(startRaw.row ?? startRaw.y, d.start.row)), 0, grid.height - 1),
    direction: str(startRaw.direction, d.start.direction),
  };

  const bodyRaw = raw.body || {};
  const body = {
    // 初始长度允许 0：与 enabled=false 等效，均表示「不生成蛇形实体」
    enabled: bool(bodyRaw.enabled, d.body.enabled),
    initialLength: clamp(Math.round(num(bodyRaw.initialLength, d.body.initialLength)), 0, 100000),
    segmentSize: clamp(num(bodyRaw.segmentSize, d.body.segmentSize), 0.1, 1.6),
    shape: ['round', 'square', 'hexagon'].includes(bodyRaw.shape) ? bodyRaw.shape : d.body.shape,
    colorMode: ['gradient', 'solid', 'custom'].includes(bodyRaw.colorMode) ? bodyRaw.colorMode : d.body.colorMode,
    colors: {
      ...d.body.colors,
      ...(bodyRaw.colors || {}),
      custom: normColorList(bodyRaw.colors?.custom, d.body.colors.custom),
    },
    skin: normSkin(bodyRaw.skin),
    lengthPolicy: normLengthPolicy(bodyRaw.lengthPolicy),
  };

  const movesRaw = raw.moveRules || raw.rules || raw.moves || {};
  const moveRules = {
    left: Math.max(0, num(movesRaw.left, d.moveRules.left)),
    straight: Math.max(0, num(movesRaw.straight, d.moveRules.straight)),
    right: Math.max(0, num(movesRaw.right, d.moveRules.right)),
  };

  const collisionRaw = raw.collision || {};
  const collision = {
    headIntoBody: bool(collisionRaw.headIntoBody, true),
    headIntoTail: bool(collisionRaw.headIntoTail, false),
    wall: bool(collisionRaw.wall, true),
    outOfBounds: bool(collisionRaw.outOfBounds, true),
    obstacle: ['stop', 'destroy', 'pass', 'turn'].includes(collisionRaw.obstacle) ? collisionRaw.obstacle : 'stop',
    countMode: collisionRaw.countMode === 'consecutive' ? 'consecutive' : 'total',
  };

  const scRaw = raw.selfCollisionPolicy || {};
  const selfCollisionPolicy = {
    action: ['stop', 'forceStraight', 'forceStraightN', 'ignore', 'randomTurn', 'custom'].includes(scRaw.action) ? scRaw.action : 'stop',
    n: clamp(Math.round(num(scRaw.n, 2)), 1, 1000),
    maxConsecutive: clamp(Math.round(num(scRaw.maxConsecutive, 5)), 1, 100000),
  };

  const endRaw = raw.endConditions || {};
  const endConditions = { ...d.endConditions, ...endRaw };
  endConditions.priority = Array.isArray(endRaw.priority) && endRaw.priority.length
    ? endRaw.priority.filter((p) => END_PRIORITY_DEFAULT.includes(p)).concat(
      END_PRIORITY_DEFAULT.filter((p) => !endRaw.priority.includes(p)),
    )
    : [...END_PRIORITY_DEFAULT];
  for (const k of ['wall', 'outOfBounds', 'selfCollision', 'selfCollisionTotal', 'selfCollisionConsecutive', 'obstacle', 'lengthReached', 'coverage', 'noMove', 'maxTime', 'ruleEnd', 'caStable', 'allAgentsGone']) {
    endConditions[k] = bool(endConditions[k], d.endConditions[k]);
  }
  // maxSteps 同时承载「是否启用」与「步数上限」：显式 false 表示未启用，必须原样保留，
  // 否则会被当作 0 收敛成 1，导致取消勾选后只走一步就停止。
  endConditions.maxSteps = endRaw.maxSteps === false
    ? false
    : clamp(Math.round(num(endRaw.maxSteps, d.endConditions.maxSteps)), 1, MAX_STEPS_LIMIT);
  endConditions.maxTimeMs = clamp(num(endRaw.maxTimeMs, d.endConditions.maxTimeMs), 1, 3600000);
  endConditions.selfCollisionTotalN = clamp(Math.round(num(endRaw.selfCollisionTotalN, 3)), 1, 100000);
  endConditions.selfCollisionConsecutiveN = clamp(Math.round(num(endRaw.selfCollisionConsecutiveN, 3)), 1, 100000);
  endConditions.lengthTarget = clamp(Math.round(num(endRaw.lengthTarget, 50)), 1, 100000);
  endConditions.coveragePercent = clamp(num(endRaw.coveragePercent, 80), 1, 100);

  const caRaw = raw.caMode || {};
  const caMode = {
    enabled: bool(caRaw.enabled, false),
    states: normalizeStates(caRaw.states),
    neighborhood: normNeighborhood(caRaw.neighborhood),
    radius: clamp(Math.round(num(caRaw.radius, 1)), 1, 4),
    boundary: ['fixed', 'wrap', 'reflect'].includes(caRaw.boundary) ? caRaw.boundary : 'wrap',
    update: ['synchronous', 'asynchronous', 'random'].includes(caRaw.update) ? caRaw.update : 'synchronous',
    rules: normCaRules(caRaw.rules),
    initial: {
      mode: ['empty', 'random', 'pattern'].includes(caRaw.initial?.mode) ? caRaw.initial.mode : 'empty',
      density: clamp(num(caRaw.initial?.density, 0.3), 0, 1),
      state: str(caRaw.initial?.state, caRaw.states?.[1]?.name || 'obstacle'),
      pattern: str(caRaw.initial?.pattern, ''),
    },
    syncWithAgent: ['beforeMove', 'afterMove', 'interleaved', 'everyN'].includes(caRaw.syncWithAgent) ? caRaw.syncWithAgent : 'afterMove',
    every: clamp(Math.round(num(caRaw.every, 1)), 1, 1000),
    stopWhenAgentEnds: bool(caRaw.stopWhenAgentEnds, false),
    stopOnStable: bool(caRaw.stopOnStable, false),
    stableSteps: clamp(Math.round(num(caRaw.stableSteps, 3)), 1, 1000),
    markerInteraction: normCaMarkerInteraction(caRaw.markerInteraction),
  };

  // caMode.stopOnStable 是「CA 稳定即收尾」的快捷开关，开启时强制打开对应结束条件，
  // 保证它参与优先级排序（优先级表里没有的项不会触发）。
  if (caMode.stopOnStable) endConditions.caStable = true;

  const envRules = Array.isArray(raw.environmentRules) ? raw.environmentRules : [];
  const environmentRules = envRules.map(normalizeRule);

  const cfg = {
    version: CONFIG_VERSION,
    meta: { name: str(raw.meta?.name, d.meta.name), description: str(raw.meta?.description, d.meta.description) },
    grid,
    start,
    body,
    moveRules,
    safety: normSafety(raw.safety),
    multiSnake: normMultiSnake(raw.multiSnake),
    ruleExecution: raw.ruleExecution === 'sync' ? 'sync' : 'async',
    advancedRules: normAdvancedRules(raw.advancedRules),
    collision,
    selfCollisionPolicy,
    events: { logCrossings: bool((raw.events || {}).logCrossings, d.events.logCrossings) },
    environmentRules,
    caMode,
    endConditions,
    seed: Math.abs(Math.round(num(raw.seed, d.seed))) || 1,
    speed: clamp(num(raw.speed, d.speed), 0.5, 120),
    style: normalizeStyle(raw.style),
  };

  // 保证同一场景中状态集合一致（agent 感知需要 obstacles/markers 存在）
  ensureCoreStates(cfg);
  // 转化目标状态依赖最终的状态集合，因此在 ensureCoreStates 之后再解析
  cfg.transform = normTransform(raw.transform, cfg.caMode.states);
  // 生命机制的增减生命状态同样依赖最终状态集合
  cfg.life = normLife(raw.life, cfg.caMode.states);
  // 自撞规则互斥（自动关闭）：「自撞即判定死亡」与结束规则「撞到自身」语义相反——
  // 前者让自撞只令该移动体消失、整轮运行继续，后者让自撞立即终止整轮运行，两者不能同时生效。
  // 规范化时若前者已生效（transform.enabled && dieOnSelfCollision），就把后者关闭；
  // 用户在面板上勾选开关时的即时反向联动由界面完成（src/ui/app.js 的 syncSelfCollisionExclusive）。
  if (cfg.transform.enabled && cfg.transform.dieOnSelfCollision) cfg.endConditions.selfCollision = false;
  return cfg;
}

/** 若规则/CA 配置引用了不存在的基础状态，则补齐 empty/obstacle/marker */
function ensureCoreStates(cfg) {
  const names = new Set(cfg.caMode.states.map((s) => s.name));
  let changed = false;
  const need = [];
  if (!names.has('obstacle')) { need.push(DEFAULT_STATES[1]); names.add('obstacle'); changed = true; }
  if (!names.has('marker')) { need.push(DEFAULT_STATES[2]); names.add('marker'); changed = true; }
  if (changed) cfg.caMode.states = normalizeStates([...cfg.caMode.states, ...need]);
}

/* ------------------------------------------------------------------ */
/* 版本迁移                                                            */
/* ------------------------------------------------------------------ */

export function migrate(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const out = JSON.parse(JSON.stringify(raw));
  const v = String(out.version || '1.0');
  const notes = [];

  if (!out.version) {
    // 无版本号：视为最初的紧凑格式
    notes.push('缺少版本号，已按 1.0 兼容模式导入');
  }
  if (v.startsWith('1.0')) {
    // 1.0 -> 1.1：start.x/y -> col/row；rules -> moveRules；condition 简写
    if (out.rules && !out.moveRules) out.moveRules = out.rules;
    if (out.body?.lengthPolicy?.growth && out.body.lengthPolicy.growth.maxLength === undefined) {
      out.body.lengthPolicy.growth.maxLength = 50;
    }
    notes.push('配置已从 1.0 迁移到 ' + CONFIG_VERSION);
  }
  out.version = CONFIG_VERSION;
  if (notes.length) out.migrationNotes = notes;
  return out;
}

/* ------------------------------------------------------------------ */
/* 结构化诊断                                                          */
/* ------------------------------------------------------------------ */

/**
 * 诊断级别：
 *  - error   严重：当前配置在地图尺寸下不可能正确运行（蛇身放不下、起点被堵死等）
 *  - warning 警告：能运行，但结果很可能不符合预期
 *  - info    提示
 * 每条诊断附带 suggestions：[{ label, patch }]，patch 为可直接深合并回配置的部分配置，
 * 供界面「一键修复」，也便于脚本化修正。
 */

export const DIAG_LEVELS = ['error', 'warning', 'info'];

const GRID_MAX = 400;

/**
 * 蛇形实体是否启用。
 * 「完全禁用蛇形实体」支持两种等效写法：body.enabled = false，或 initialLength = 0。
 */
export function isBodyEnabled(cfg) {
  const c = cfg || {};
  const len = Math.round(Number(c.body?.initialLength) || 0);
  return c.body?.enabled !== false && len > 0;
}

/** 地图中心坐标 */
export function centerCoord(grid) {
  return {
    col: Math.min(grid.width - 1, Math.max(0, Math.floor(grid.width / 2))),
    row: Math.min(grid.height - 1, Math.max(0, Math.floor(grid.height / 2))),
  };
}

/** 容纳 cells 个格子所需的网格尺寸（尽量维持原宽高比，限制在 2..400） */
export function gridSizeFor(cells, width, height) {
  const w = clamp(Math.ceil(Math.sqrt((cells * Math.max(1, width)) / Math.max(1, height))), 2, GRID_MAX);
  const size = { width: w, height: clamp(Math.ceil(cells / w), 2, GRID_MAX) };
  while (size.width * size.height < cells) {
    if (size.width <= size.height && size.width < GRID_MAX) size.width++;
    else if (size.height < GRID_MAX) size.height++;
    else break;
  }
  return size;
}

/**
 * 方格图上扩大网格并（必要时）挪动起点，使长度 length 的身体能沿 dirs 的反方向完整铺开。
 * 返回 { width, height, start }，无法容纳（超过 400）时返回 null；六边形不做推算。
 */
export function expandGridForBody(grid, start, dirs, length) {
  if (grid.type !== 'square') return null;
  let width = grid.width;
  let height = grid.height;
  let col = start.col;
  let row = start.row;
  for (const d of dirs) {
    const name = grid.dirNames[d];
    if (name === 'up') height = Math.max(height, row + length);
    else if (name === 'down') { row = Math.max(row, length - 1); height = Math.max(height, row + 1); }
    else if (name === 'left') width = Math.max(width, col + length);
    else if (name === 'right') { col = Math.max(col, length - 1); width = Math.max(width, col + 1); }
  }
  if (width > GRID_MAX || height > GRID_MAX) return null;
  const probe = new Grid({ type: 'square', width, height });
  const bodyStart = { col, row };
  for (const d of dirs) {
    if (fittedBodyLength(probe, bodyStart, d, length) < length) return null;
  }
  return { width, height, start: bodyStart };
}

/** 从起点沿 dir 的反方向铺开 length 节时，实际落在界内的节数（与初始身体铺设方式一致） */
export function fittedBodyLength(grid, start, dir, length) {
  let cur = { ...start };
  let n = 1;
  const back = grid.opposite(dir);
  const wrap = grid.boundary === 'wrap';
  // 环绕边界下身体可以跨越接缝继续铺设，可用节数上限即整张地图（再多必然重叠）
  const cap = wrap ? Math.min(length, grid.size) : length;
  for (let i = 1; i < cap; i++) {
    cur = grid.step(cur, back);
    if (wrap) cur = grid.wrap(cur);
    else if (!grid.inBounds(cur)) break;
    n++;
  }
  return n;
}

function dirsOf(grid, direction) {
  if (direction === 'random') return Array.from({ length: grid.dirCount }, (_, i) => i);
  return [parseDir(direction, grid.type)];
}

function dirsLabel(grid, dirs) {
  if (dirs.length > 1) return '任意方向的最坏情况';
  return DIR_LABEL_CN[grid.dirNames[dirs[0]]] || grid.dirNames[dirs[0]];
}

/**
 * 检测「意外情况」并给出可执行的修复建议。
 * 覆盖：起点越界、蛇身长度超过地图尺寸、初始身体被边界截断、增长上限/目标长度超出总格数、
 *       起点被阻塞状态占据，以及权重与规则配置层面的常见空转。
 */
export function diagnoseConfig(rawInput = {}) {
  if (!rawInput || typeof rawInput !== 'object') {
    return [{ level: 'error', code: 'invalidConfig', title: '配置无效', message: '配置必须是一个 JSON 对象。', suggestions: [] }];
  }
  const raw = rawInput;
  const cfg = normalizeConfig(raw);
  const grid = new Grid(cfg.grid);
  const w = grid.width;
  const h = grid.height;
  const cells = grid.size;
  const center = centerCoord(grid);
  const out = [];

  /* 1. 起点越界：规范化会把起点收敛进网格，这里按原始值报告 */
  const startRaw = raw.start || {};
  const rawCol = Number(startRaw.col ?? startRaw.x);
  const rawRow = Number(startRaw.row ?? startRaw.y);
  const bodyOn = isBodyEnabled(cfg);
  const badCol = Number.isFinite(rawCol) && (rawCol < 0 || rawCol > w - 1);
  const badRow = Number.isFinite(rawRow) && (rawRow < 0 || rawRow > h - 1);
  if (bodyOn && (badCol || badRow)) {
    const dispCol = Number.isFinite(rawCol) ? Math.round(rawCol) : '?';
    const dispRow = Number.isFinite(rawRow) ? Math.round(rawRow) : '?';
    const fit = {
      width: clamp(Number.isFinite(rawCol) ? Math.max(w, Math.ceil(rawCol) + 1) : w, 2, GRID_MAX),
      height: clamp(Number.isFinite(rawRow) ? Math.max(h, Math.ceil(rawRow) + 1) : h, 2, GRID_MAX),
    };
    out.push({
      level: 'error',
      code: 'startOutOfBounds',
      title: '起点超出地图边界',
      message: `起点 (${dispCol}, ${dispRow}) 不在网格范围内（col 0..${w - 1}，row 0..${h - 1}），运行时已自动收敛到 (${cfg.start.col}, ${cfg.start.row})。`,
      suggestions: [
        { label: `起点移至地图中心 (${center.col}, ${center.row})`, patch: { start: { ...center } } },
        { label: `扩大地图到 ${fit.width}×${fit.height} 以包含原起点`, patch: { grid: fit } },
      ],
    });
  }

  /* 2. 蛇身长度与地图尺寸（蛇形实体被禁用时不再检查） */
  const length = Math.max(1, Math.round(Number(cfg.body.initialLength) || 1));
  const dirs = dirsOf(grid, cfg.start.direction);
  if (!bodyOn) {
    // 已完全禁用蛇形实体：只提示本次运行不会出现移动体
    out.push({
      level: 'info',
      code: 'bodyDisabled',
      title: '蛇形实体已完全禁用',
      message: '本次运行不会生成任何蛇形实体，画面只呈现环境状态（含元胞自动机）的演化。',
      suggestions: [
        { label: '恢复蛇形实体（初始长度 3）', patch: { body: { enabled: true, initialLength: 3 } } },
      ],
    });
  } else if (length > cells) {
    // 直线上排下 length 节，网格至少要在身体延伸方向上够长；expandGridForBody 会同时给出合适的起点
    const fitted = Math.min(...dirs.map((d) => fittedBodyLength(grid, cfg.start, d, length)));
    const expand = expandGridForBody(grid, cfg.start, dirs, length);
    const fit = expand ? { width: expand.width, height: expand.height } : gridSizeFor(length, w, h);
    const fitStart = expand ? { ...expand.start } : { ...centerCoord(new Grid({ type: cfg.grid.type, ...fit })) };
    out.push({
      level: 'error',
      code: 'bodyExceedsGrid',
      title: '蛇身长度超过地图尺寸',
      message: `初始长度 ${length} 节 > 地图总格数 ${cells}（${w}×${h}），蛇身不可能完整容纳，体节必然重叠。`,
      suggestions: [
        { label: `初始长度改为 ${fitted}（当前起点/方向可容纳的最大长度）`, patch: { body: { initialLength: fitted } } },
        {
          label: `地图扩大到 ${fit.width}×${fit.height} 并把起点移到 (${fitStart.col}, ${fitStart.row})`,
          patch: { grid: fit, start: fitStart },
        },
      ],
    });
  } else if (length > 1) {
    const fitted = Math.min(...dirs.map((d) => fittedBodyLength(grid, cfg.start, d, length)));
    if (fitted < length) {
      const centerFitted = Math.min(...dirs.map((d) => fittedBodyLength(grid, center, d, length)));
      const expand = expandGridForBody(grid, cfg.start, dirs, length);
      const suggestions = [];
      if (centerFitted > fitted) {
        suggestions.push({ label: `起点移至地图中心 (${center.col}, ${center.row})（可容纳 ${centerFitted} 节）`, patch: { start: { ...center } } });
      }
      suggestions.push({ label: `初始长度改为 ${fitted}`, patch: { body: { initialLength: fitted } } });
      if (expand) {
        suggestions.push({ label: `地图扩大到 ${expand.width}×${expand.height} 以容纳 ${length} 节`, patch: { grid: { width: expand.width, height: expand.height }, start: { ...expand.start } } });
      }
      out.push({
        level: 'error',
        code: 'bodyTruncatedByBoundary',
        title: '蛇的初始身体会被地图边界截断',
        message: `起点 (${cfg.start.col}, ${cfg.start.row}) 朝${dirsLabel(grid, dirs)}的反方向只能排下 ${fitted} 节，初始长度 ${length} 节会被截断为 ${fitted} 节。`,
        suggestions,
      });
    }
  }

  /* 3. 增长上限 / 结束条件的目标长度超过地图总格数 */
  const lp = cfg.body.lengthPolicy;
  if (lp.mode !== 'fixed' && lp.growth.enabled && lp.growth.maxLength > cells) {
    const fit = gridSizeFor(lp.growth.maxLength, w, h);
    out.push({
      level: 'warning',
      code: 'growthExceedsGrid',
      title: '增长上限超过地图尺寸',
      message: `增长上限 ${lp.growth.maxLength} 节 > 地图总格数 ${cells}，长度永远达不到该上限，超出的部分只会让体节互相重叠。`,
      suggestions: [
        { label: `增长上限改为 ${cells}`, patch: { body: { lengthPolicy: { growth: { maxLength: cells } } } } },
        { label: `地图扩大到 ${fit.width}×${fit.height}`, patch: { grid: fit } },
      ],
    });
  }
  if (cfg.endConditions.lengthReached && cfg.endConditions.lengthTarget > cells) {
    const fit = gridSizeFor(cfg.endConditions.lengthTarget, w, h);
    out.push({
      level: 'warning',
      code: 'lengthTargetExceedsGrid',
      title: '结束条件的目标长度超过地图尺寸',
      message: `结束条件「达到指定长度 ${cfg.endConditions.lengthTarget}」大于地图总格数 ${cells}，该条件永远不会触发，运行只能靠其它条件收尾。`,
      suggestions: [
        { label: `目标长度改为 ${cells}`, patch: { endConditions: { lengthTarget: cells } } },
        { label: `地图扩大到 ${fit.width}×${fit.height}`, patch: { grid: fit } },
      ],
    });
  }

  /* 4. 起点被阻塞状态占据（CA 初始环境） */
  if (cfg.caMode.enabled) {
    const states = cfg.caMode.states;
    const blocking = new Set(states.filter((s) => s.blocking).map((s) => s.name));
    const init = cfg.caMode.initial;
    if (init.mode === 'pattern') {
      const dim = parsePatternText(init.pattern);
      if (dim.width > w || dim.height > h) {
        const fit = { width: Math.max(w, dim.width), height: Math.max(h, dim.height) };
        out.push({
          level: 'warning',
          code: 'patternExceedsGrid',
          title: 'CA 初始图案大于地图尺寸',
          message: `初始图案为 ${dim.width}×${dim.height}，大于地图 ${w}×${h}，超出部分会被直接裁掉，图案也无法正常居中。`,
          suggestions: [
            { label: `地图扩大到 ${fit.width}×${fit.height}`, patch: { grid: fit } },
            { label: '改用随机填充（密度 30%）', patch: { caMode: { initial: { mode: 'random', density: 0.3 } } } },
          ],
        });
      }
      const name = patternStateNameAt(grid, states, init.pattern, { col: cfg.start.col, row: cfg.start.row });
      if (bodyOn && name && blocking.has(name)) {
        const cleared = clearPatternCell(grid, init.pattern, { col: cfg.start.col, row: cfg.start.row });
        const suggestions = [];
        if (cleared !== null) suggestions.push({ label: '把起点格从初始图案中清空', patch: { caMode: { initial: { pattern: cleared } } } });
        suggestions.push({ label: `起点移至地图中心 (${center.col}, ${center.row})`, patch: { start: { ...center } } });
        suggestions.push({ label: `初始长度改为 1（避免身体压在阻塞格上）`, patch: { body: { initialLength: 1 } } });
        out.push({
          level: 'error',
          code: 'startBlocked',
          title: '起点被阻塞状态占据',
          message: `起点 (${cfg.start.col}, ${cfg.start.row}) 在 CA 初始图案中是「${name}」（阻塞状态），运行时第一步就会判定为撞障碍物。`,
          suggestions,
        });
      }
    } else if (bodyOn && init.mode === 'random' && init.density > 0 && blocking.has(init.state)) {
      out.push({
        level: 'warning',
        code: 'startMayBeBlocked',
        title: '起点可能被随机填充的阻塞状态占据',
        message: `CA 初始以 ${(init.density * 100).toFixed(0)}% 密度随机填充「${init.state}」（阻塞状态），起点被阻塞的概率约为 ${(init.density * 100).toFixed(0)}%（同一种子结果可复现）。`,
        suggestions: [
          { label: '把初始密度降到 5%', patch: { caMode: { initial: { density: 0.05 } } } },
          { label: `起点移至地图中心 (${center.col}, ${center.row})`, patch: { start: { ...center } } },
        ],
      });
    }
  }

  /* 5. 常见「空转」配置 */
  const moves = cfg.moveRules;
  if (moves.left + moves.straight + moves.right <= 0) {
    out.push({
      level: 'warning',
      code: 'zeroMoveWeights',
      title: '左/直/右权重全为 0',
      message: '运行时会退化为均匀分布，实际并非「不转向」。',
      suggestions: [{ label: '恢复等概率（左 1 : 直 1 : 右 1）', patch: { moveRules: { left: 1, straight: 1, right: 1 } } }],
    });
  }
  for (const r of cfg.environmentRules) {
    if (!r.actions.length) {
      out.push({
        level: 'warning',
        code: 'ruleWithoutAction',
        title: `规则「${r.name}」没有后果动作`,
        message: '条件满足时不会产生任何变化，该规则会被忽略。',
        suggestions: [],
      });
    }
  }
  if (cfg.caMode.enabled && cfg.caMode.rules.length === 0 && cfg.caMode.initial.mode === 'empty') {
    out.push({
      level: 'warning',
      code: 'caNoEffect',
      title: '元胞自动机不会产生变化',
      message: '已启用 CA 但既没有转移规则，初始状态又全为空，环境将始终保持空白。',
      suggestions: [
        { label: '改为随机初始填充（密度 30%）', patch: { caMode: { initial: { mode: 'random', density: 0.3 } } } },
        { label: '关闭元胞自动机', patch: { caMode: { enabled: false } } },
      ],
    });
  }
  // 长度策略为「固定」时长度恒等于初始长度，标记物反馈中的长度变化会被丢弃
  if (bodyOn && cfg.caMode.markerInteraction.enabled && cfg.body.lengthPolicy.mode === 'fixed') {
    out.push({
      level: 'warning',
      code: 'markerEffectIgnored',
      title: '标记物反馈的长度变化不会生效',
      message: '「长度策略」为「固定」时长度恒等于初始长度，标记物反馈规则里的长度增减会被忽略（变色与消耗仍然生效）。',
      suggestions: [
        { label: '长度策略改为「可变」', patch: { body: { lengthPolicy: { mode: 'variable' } } } },
      ],
    });
  }
  // 「多蛇生成」开启但主移动体被禁用时没有任何基准蛇，生成出来的蛇会立刻成为唯一移动体
  if (!bodyOn && cfg.multiSnake.enabled) {
    out.push({
      level: 'info',
      code: 'multiSnakeWithoutMain',
      title: '多蛇系统在无主移动体时启用',
      message: '蛇形实体已禁用，不会生成初始的主移动体；按规则生成出来的蛇将成为场上唯一的移动体，主移动体相关的结束条件不会触发。',
      suggestions: [],
    });
  }
  // 蛇死亡转化：概率为 0 时流程永不启动；开启死亡判定时「撞到自身」结束规则让位
  if (cfg.transform.enabled && (cfg.transform.globalProbability <= 0 || cfg.transform.segmentProbability <= 0)) {
    out.push({
      level: 'warning',
      code: 'transformNoEffect',
      title: '蛇死亡转化不会产生任何节点',
      message: `已启用「蛇死亡转化」，但${cfg.transform.globalProbability <= 0 ? '全局触发概率' : '分段转化概率'}为 0，自撞致死后的身体节点不会被写入环境。`,
      suggestions: [
        { label: '两个概率都改为 0.5', patch: { transform: { globalProbability: 0.5, segmentProbability: 0.5 } } },
        { label: '关闭「蛇死亡转化」', patch: { transform: { enabled: false } } },
      ],
    });
  }
  // 互斥自动关闭：原始配置同时要求「自撞即判定死亡」与「撞到自身」时，后者被规范化关闭并在此说明
  const rawEndObj = (raw.endConditions && typeof raw.endConditions === 'object') ? raw.endConditions : {};
  if (cfg.transform.enabled && cfg.transform.dieOnSelfCollision && rawEndObj.selfCollision) {
    out.push({
      level: 'info',
      code: 'transformOverridesSelfCollisionEnd',
      title: '「撞到自身」已因互斥自动关闭',
      message: '「自撞即判定死亡」与结束规则「撞到自身」互斥：开启前者时后者会被自动取消勾选，自撞只会让该移动体消失（或按生命机制扣命重生），不会终止整轮运行。反向勾选「撞到自身」则自动关闭「自撞即判定死亡」。',
      suggestions: [
        { label: '改由「撞到自身」终止运行', patch: { transform: { dieOnSelfCollision: false }, endConditions: { selfCollision: true } } },
        { label: '保持互斥：改用「所有移动体均已消失」收尾', patch: { endConditions: { allAgentsGone: true } } },
      ],
    });
  }
  // 生命机制：数值越界钳制提示 / 无任何增减来源提示
  const lifeRaw = (raw.life && typeof raw.life === 'object') ? raw.life : {};
  const rawLives = Number(lifeRaw.initialLives);
  if (Number.isFinite(rawLives) && (rawLives < LIFE_MIN || rawLives > LIFE_MAX)) {
    out.push({
      level: 'warning',
      code: 'lifeInitialClamped',
      title: '初始生命数值超出合理区间',
      message: `初始生命 ${Math.round(rawLives)} 超出允许区间 [${LIFE_MIN}, ${LIFE_MAX}]，已收敛为 ${cfg.life.initialLives}。`,
      suggestions: [
        { label: `改为 ${LIFE_MAX}（上限）`, patch: { life: { initialLives: LIFE_MAX } } },
        { label: `改为 ${LIFE_MIN}（下限）`, patch: { life: { initialLives: LIFE_MIN } } },
      ],
    });
  }
  if (cfg.life.enabled && bodyOn
    && !cfg.life.items.gainStates.length && !cfg.life.items.lossStates.length
    && !cfg.transform.enabled) {
    out.push({
      level: 'info',
      code: 'lifeNoItemSource',
      title: '生命机制没有任何增减来源',
      message: '已启用生命机制，但既没有配置「增加生命的格子状态」也没有配置「扣除生命的格子状态」，生命值只会在致命判定时递减。',
      suggestions: [
        { label: '把「标记物」设为增加生命的格子', patch: { life: { items: { gainStates: ['marker'] } } } },
      ],
    });
  }
  if (cfg.life.enabled && cfg.life.keepMovingAfterDeath) {
    out.push({
      level: 'info',
      code: 'lifeKeepMovingAfterDeath',
      title: '已开启「死亡后仍可移动」',
      message: '该开关开启后蛇在判定死亡时不会立即停止与移除，可能出现「死亡后仍在移动」的表现；正式游玩建议保持关闭。',
      suggestions: [
        { label: '关闭「死亡后仍可移动」', patch: { life: { keepMovingAfterDeath: false } } },
      ],
    });
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* 校验                                                                */
/* ------------------------------------------------------------------ */

/**
 * 结构校验（ok 仅由结构性错误决定，诊断结果不会阻断导入）+ 诊断汇总。
 * diagnostics 为结构化诊断；errors/warnings 为供旧调用方直接展示的文本。
 */
export function validateConfig(raw) {
  const errors = [];
  const warnings = [];
  if (!raw || typeof raw !== 'object') {
    return { ok: false, errors: ['配置必须是一个 JSON 对象'], warnings, diagnostics: [] };
  }
  const v = String(raw.version || '');
  if (v && !v.startsWith('1.')) warnings.push(`未知版本号 "${v}"，将尝试兼容导入`);
  if (raw.grid && raw.grid.type && !['square', 'hex'].includes(raw.grid.type)) {
    warnings.push(`网格类型 "${raw.grid.type}" 暂不支持，已回退为 square`);
  }
  if (raw.grid) {
    const w = Number(raw.grid.width);
    const h = Number(raw.grid.height);
    if (raw.grid.width !== undefined && (!Number.isFinite(w) || w < 2)) errors.push('grid.width 必须是不小于 2 的数字');
    if (raw.grid.height !== undefined && (!Number.isFinite(h) || h < 2)) errors.push('grid.height 必须是不小于 2 的数字');
  }
  const diagnostics = diagnoseConfig(raw);
  for (const d of diagnostics) {
    warnings.push(d.level === 'error' ? `${d.title}：${d.message}` : d.message);
  }
  return { ok: errors.length === 0, errors, warnings, diagnostics };
}

/* ------------------------------------------------------------------ */
/* URL 分享                                                            */
/* ------------------------------------------------------------------ */

function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function base64ToUtf8(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export function encodeConfigToToken(cfg) {
  const compact = JSON.stringify(cfg);
  return utf8ToBase64(compact).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeConfigFromToken(token) {
  const b64 = String(token).replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
  return JSON.parse(base64ToUtf8(b64 + pad));
}

export function buildShareUrl(cfg) {
  // 本地单文件（file://）打开时 location.origin 为字面量 "null"，
  // 直接拼接会得到 "null/路径#c=…" 这种不可用的链接；
  // 此时退回去掉片段后的完整地址，链接仍可在本机重新打开。
  const origin = location.origin && location.origin !== 'null'
    ? `${location.origin}${location.pathname}`
    : String(location.href || '').split('#')[0];
  return `${origin}#c=${encodeConfigToToken(stripSkinAssets(cfg))}`;
}

/**
 * 剥离皮肤图片的配置副本。
 * 皮肤是体积可达数 MB 的 dataURL，直接编码进 URL 会远超浏览器 / 聊天工具的长度上限，
 * 因此分享链接一律不含皮肤图片；本地配置与「导出 JSON」仍然完整保留。
 */
export function stripSkinAssets(cfg) {
  if (!cfg || !cfg.body) return cfg;
  return { ...cfg, body: { ...cfg.body, skin: { head: '', body: '' } } };
}

export function readConfigFromLocation() {
  const hash = location.hash || '';
  const m = /[#&]c=([^&]+)/.exec(hash);
  if (!m) return null;
  try {
    return decodeConfigFromToken(m[1]);
  } catch (e) {
    console.warn('分享链接解析失败', e);
    return null;
  }
}
