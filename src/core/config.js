/**
 * 配置模型：默认值、规范化、版本迁移、校验、URL 分享
 */
import { normalizeStates } from './world.js';

export const CONFIG_VERSION = '1.1';

/** 「达到步数上限」允许设置的最大步数：远超 10^12，且仍在 Number 精确整数范围内（< 2^53） */
export const MAX_STEPS_LIMIT = 1e15;

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
  manual: '手动结束',
};

export const DEFAULT_STATES = [
  { name: 'empty', color: null, blocking: false, symbol: '.', render: 'fill' },
  { name: 'obstacle', color: '#5b6472', blocking: true, symbol: '#', render: 'cross' },
  { name: 'marker', color: '#ffd166', blocking: false, symbol: 'M', render: 'dot' },
];

export function defaultGrid() {
  return { type: 'square', width: 24, height: 24, boundary: 'stop' };
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
        growth: { enabled: false, trigger: 'step', amount: 1, probability: 0.1, maxLength: 50, interval: 1 },
        shrink: { enabled: false, trigger: 'step', amount: 1, probability: 0.05, minLength: 1, interval: 1 },
      },
    },
    moveRules: { left: 0.33, straight: 0.34, right: 0.33 },
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

function normalizeStyle(raw = {}) {
  const d = defaultConfig().style;
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
    axisLabels: bool(raw.axisLabels, d.axisLabels),
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
    initialLength: clamp(Math.round(num(bodyRaw.initialLength, d.body.initialLength)), 1, 100000),
    segmentSize: clamp(num(bodyRaw.segmentSize, d.body.segmentSize), 0.1, 1.6),
    shape: ['round', 'square', 'hexagon'].includes(bodyRaw.shape) ? bodyRaw.shape : d.body.shape,
    colorMode: ['gradient', 'solid', 'custom'].includes(bodyRaw.colorMode) ? bodyRaw.colorMode : d.body.colorMode,
    colors: {
      ...d.body.colors,
      ...(bodyRaw.colors || {}),
      custom: normColorList(bodyRaw.colors?.custom, d.body.colors.custom),
    },
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
  for (const k of ['wall', 'outOfBounds', 'selfCollision', 'selfCollisionTotal', 'selfCollisionConsecutive', 'obstacle', 'lengthReached', 'coverage', 'noMove', 'maxTime', 'ruleEnd']) {
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
  };

  const envRules = Array.isArray(raw.environmentRules) ? raw.environmentRules : [];
  const environmentRules = envRules.map(normalizeRule);

  const cfg = {
    version: CONFIG_VERSION,
    meta: { name: str(raw.meta?.name, d.meta.name), description: str(raw.meta?.description, d.meta.description) },
    grid,
    start,
    body,
    moveRules,
    ruleExecution: raw.ruleExecution === 'sync' ? 'sync' : 'async',
    advancedRules: normAdvancedRules(raw.advancedRules),
    collision,
    selfCollisionPolicy,
    environmentRules,
    caMode,
    endConditions,
    seed: Math.abs(Math.round(num(raw.seed, d.seed))) || 1,
    speed: clamp(num(raw.speed, d.speed), 0.5, 120),
    style: normalizeStyle(raw.style),
  };

  // 保证同一场景中状态集合一致（agent 感知需要 obstacles/markers 存在）
  ensureCoreStates(cfg);
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
/* 校验                                                                */
/* ------------------------------------------------------------------ */

export function validateConfig(raw) {
  const errors = [];
  const warnings = [];
  if (!raw || typeof raw !== 'object') {
    return { ok: false, errors: ['配置必须是一个 JSON 对象'], warnings };
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
  const cfg = normalizeConfig(raw);
  if (cfg.start.col >= cfg.grid.width || cfg.start.row >= cfg.grid.height) {
    errors.push('起点超出网格范围');
  }
  const moves = cfg.moveRules;
  if (moves.left + moves.straight + moves.right <= 0) {
    warnings.push('左/直/右权重全为 0，运行时会退化为均匀分布');
  }
  for (const r of cfg.environmentRules) {
    if (!r.actions.length) warnings.push(`规则「${r.name}」没有配置后果动作，将被忽略`);
  }
  if (cfg.caMode.enabled && cfg.caMode.rules.length === 0 && cfg.caMode.initial.mode === 'empty') {
    warnings.push('已启用元胞自动机但未定义任何转移规则，环境不会变化');
  }
  return { ok: errors.length === 0, errors, warnings };
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
  const base = `${location.origin}${location.pathname}`;
  return `${base}#c=${encodeConfigToToken(cfg)}`;
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
