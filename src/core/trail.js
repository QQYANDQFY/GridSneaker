/**
 * 轨迹模型与坐标筛选查询
 *
 * 轨迹定义：移动体头部随时间经过的格子序列（按经过时间升序）。
 * 渲染时按时间顺序依次绘制，后经过的轨迹天然压在先经过的轨迹之上，
 * 因此新生成的轨迹能够完全覆盖旧轨迹，不会出现旧轨迹遮挡新轨迹的问题。
 *
 * 同时输出逐格聚合信息（供坐标筛选查询）：
 *   order  经过次序（1 起，按首次经过时间排序）
 *   first  首次经过的步数
 *   last   末次经过的步数
 *   visits 经过次数（序数）
 *
 * 画面帧被抽样缓存（frameStride > 1）时，用当前帧的身体节补出未缓存的中间步，
 * 保证任意采样步长下轨迹都连续无缺口。
 */

/** 由格下标直接换算行列（避免逐点分配坐标对象） */
function colOf(grid, index) {
  return index % grid.width;
}
function rowOf(grid, index) {
  return Math.floor(index / grid.width);
}

/**
 * 构建轨迹模型。
 * @param {Grid} grid
 * @param {Array} frames Simulation.run() 输出的帧序列
 * @returns {{path: Array<{index:number,tick:number,agent:number}>, order: number[], info: Map<number, object>, maxTick: number, grid: Grid}}
 */
export function buildTrail(grid, frames) {
  const path = [];
  const order = [];
  const info = new Map();
  const lastTickOf = new Map();
  let maxTick = 0;

  const push = (index, tick, agentId) => {
    if (!Number.isInteger(index) || index < 0) return;
    path.push({ index, tick, agent: agentId });
    if (tick > maxTick) maxTick = tick;
    const cell = info.get(index);
    if (!cell) {
      order.push(index);
      info.set(index, {
        index,
        col: colOf(grid, index),
        row: rowOf(grid, index),
        order: order.length,
        first: tick,
        last: tick,
        visits: 1,
      });
      return;
    }
    if (tick < cell.first) cell.first = tick;
    if (tick > cell.last) cell.last = tick;
    cell.visits++;
  };

  for (const f of frames) {
    const agents = f.agents || [];
    // 1) 先补插各移动体在上次缓存帧与当前帧之间经过的格（抽样缓存时用身体节反推）
    for (const a of agents) {
      const segs = a.segments;
      if (!segs || !segs.length) continue;
      const from = lastTickOf.get(a.id);
      if (from === undefined || f.tick - from <= 1) continue;
      for (let t = from + 1; t < f.tick; t++) {
        const k = f.tick - t; // 第 t 步的头部 = 当前帧第 k 节
        if (k >= segs.length) break;
        push(grid.idx(segs[k][0], segs[k][1]), t, a.id);
      }
    }
    // 2) 再记录当前帧各移动体的头部位置（同一帧内步数相同，顺序稳定）
    for (const a of agents) {
      const segs = a.segments;
      if (!segs || !segs.length) continue;
      push(grid.idx(segs[0][0], segs[0][1]), f.tick, a.id);
      lastTickOf.set(a.id, f.tick);
    }
  }

  return { path, order, info, maxTick, grid };
}

/* ------------------------------------------------------------------ */
/* 坐标筛选查询                                                        */
/* ------------------------------------------------------------------ */

/**
 * 按步数截取轨迹模型：只保留 tick ≤ maxTick 的轨迹点，并重算逐格聚合信息。
 * 轨迹路径本身按经过时间升序，这里二分定位截断点后只遍历保留部分，
 * 供「实时统计」模式按当前播放位置统计轨迹数据（无需重跑模拟）。
 * @param {object} trail buildTrail 的输出
 * @param {number} tick 目标步数（含）
 * @returns {{path: Array, order: number[], info: Map<number, object>, maxTick: number}}
 */
export function sliceTrailUpToTick(trail, tick) {
  const path = (trail && trail.path) || [];
  const limit = Math.round(Number(tick));
  if (!Number.isFinite(limit) || limit < 0) return { path: [], order: [], info: new Map(), maxTick: 0 };
  let lo = 0;
  let hi = path.length - 1;
  let cut = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (path[mid].tick <= limit) { cut = mid; lo = mid + 1; } else hi = mid - 1;
  }
  const kept = path.slice(0, cut + 1);
  const order = [];
  const info = new Map();
  let maxTick = 0;
  for (const p of kept) {
    if (p.tick > maxTick) maxTick = p.tick;
    let cell = info.get(p.index);
    if (!cell) {
      order.push(p.index);
      cell = {
        index: p.index,
        col: colOf(trail.grid || { width: 1 }, p.index),
        row: rowOf(trail.grid || { width: 1 }, p.index),
        order: order.length,
        first: p.tick,
        last: p.tick,
        visits: 1,
      };
      info.set(p.index, cell);
      continue;
    }
    if (p.tick < cell.first) cell.first = p.tick;
    if (p.tick > cell.last) cell.last = p.tick;
    cell.visits++;
  }
  return { path: kept, order, info, maxTick };
}

/** 多条件组合方式 */
export const TRAIL_QUERY_LOGICS = ['and', 'or'];
export const TRAIL_QUERY_LOGIC_LABELS = { and: '全部满足', or: '任一满足' };

/** 上下限占位符：0 表示不限 */
export function defaultTrailQuery() {
  return {
    orderMin: 1,
    orderMax: 0,
    visitsMin: 1,
    visitsMax: 0,
    stepMin: 0,
    stepMax: 0,
    logic: 'and',
    invert: false,
  };
}

const intOr = (v, d) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? n : d;
};
const nonNeg = (v, d = 0) => Math.max(0, intOr(v, d));

export function normalizeTrailQuery(raw = {}) {
  const d = defaultTrailQuery();
  return {
    orderMin: Math.max(1, nonNeg(raw.orderMin, d.orderMin)),
    orderMax: nonNeg(raw.orderMax, d.orderMax),
    visitsMin: Math.max(1, nonNeg(raw.visitsMin, d.visitsMin)),
    visitsMax: nonNeg(raw.visitsMax, d.visitsMax),
    stepMin: nonNeg(raw.stepMin, d.stepMin),
    stepMax: nonNeg(raw.stepMax, d.stepMax),
    logic: raw.logic === 'or' ? 'or' : 'and',
    invert: !!raw.invert,
  };
}

/**
 * 三组范围条件的键与显示名。
 * minKey / maxKey 对应查询对象里的上下限字段，minDefault 为该侧「不限」时的取值，
 * 供界面的滑块边界与校验提示复用。
 */
export const TRAIL_RANGE_FIELDS = [
  { minKey: 'orderMin', maxKey: 'orderMax', label: '经过次序', minDefault: 1, bound: 'order' },
  { minKey: 'visitsMin', maxKey: 'visitsMax', label: '经过次数', minDefault: 1, bound: 'visits' },
  { minKey: 'stepMin', maxKey: 'stepMax', label: '首次步数', minDefault: 0, bound: 'step' },
];

/**
 * 校验上下限：上限为 0（不限）或 ≥ 下限时合法。
 * 上限小于下限属于非法配置，界面据此给出提示并自动纠正。
 * @returns {{ok:boolean, errors:Array<{key:string,fields:string[],message:string}>, query:object}}
 */
export function validateTrailQuery(raw = {}) {
  const q = normalizeTrailQuery(raw);
  const errors = [];
  for (const f of TRAIL_RANGE_FIELDS) {
    if (q[f.maxKey] > 0 && q[f.maxKey] < q[f.minKey]) {
      errors.push({
        key: f.maxKey,
        fields: [f.minKey, f.maxKey],
        message: `${f.label}上限（${q[f.maxKey]}）不能小于下限（${q[f.minKey]}）`,
      });
    }
  }
  return { ok: !errors.length, errors, query: q };
}

/**
 * 把非法上下限自动纠正为合法区间：`changed` 是刚被编辑的键，另一侧随之对齐，
 * 保证用户无论从下限还是上限下手，都留下一个「上限 ≥ 下限」的合法配置。
 */
export function reconcileTrailQuery(raw = {}, changed = '') {
  const q = normalizeTrailQuery(raw);
  for (const { minKey, maxKey, minDefault } of TRAIL_RANGE_FIELDS) {
    if (q[maxKey] > 0 && q[maxKey] < q[minKey]) {
      if (changed === maxKey) q[minKey] = Math.max(minDefault, q[maxKey]);
      else q[maxKey] = q[minKey];
    }
  }
  return q;
}

/**
 * 当前轨迹的可用取值范围（供界面配置滑块上下界）：
 * order 为轨迹点总数，visits 为最大经过次数，step 为最大经过步数。
 */
export function trailQueryBounds(trail) {
  const bounds = { order: { min: 1, max: 1 }, visits: { min: 1, max: 1 }, step: { min: 0, max: 1 } };
  if (!trail || !trail.info) return bounds;
  bounds.order.max = Math.max(1, trail.order.length);
  let visits = 1;
  let step = 0;
  for (const cell of trail.info.values()) {
    if (cell.visits > visits) visits = cell.visits;
    if (cell.first > step) step = cell.first;
    if (cell.last > step) step = cell.last;
  }
  bounds.visits.max = visits;
  bounds.step.max = Math.max(1, step);
  return bounds;
}

/** 某个范围条件是否真正生效（上下限都为「不限」时该条不参与判断） */
function activeOrder(q) {
  return q.orderMax > 0 || q.orderMin > 1;
}
function activeVisits(q) {
  return q.visitsMax > 0 || q.visitsMin > 1;
}
function activeSteps(q) {
  return q.stepMax > 0 || q.stepMin > 0;
}

function inRange(value, min, max) {
  if (max > 0 && value > max) return false;
  return value >= min;
}

/** 范围的可读描述，如「次序 5~20」 */
function rangeLabel(name, min, max, minDefault = 1) {
  const lo = min > minDefault ? String(min) : '';
  if (max > 0) return `${name} ${lo || minDefault}~${max}`;
  return lo ? `${name} ≥${lo}` : '';
}

/** 是否设置了有效筛选（三组范围都未启用且未反选时视为「不筛选」） */
export function trailQueryActive(rawQuery) {
  const q = normalizeTrailQuery(rawQuery);
  return q.invert || activeOrder(q) || activeVisits(q) || activeSteps(q);
}

export function trailQueryLabel(rawQuery) {
  const q = normalizeTrailQuery(rawQuery);
  const parts = [];
  if (activeOrder(q)) parts.push(rangeLabel('次序', q.orderMin, q.orderMax));
  if (activeVisits(q)) parts.push(rangeLabel('经过次数', q.visitsMin, q.visitsMax));
  if (activeSteps(q)) parts.push(rangeLabel('步数', q.stepMin, q.stepMax, 0));
  if (!parts.length) parts.push('全部轨迹点');
  const text = parts.join(` ${q.logic === 'or' ? '或' : '且'} `);
  return q.invert ? `反选（${text}）` : text;
}

/**
 * 按「经过次序 / 经过次数（序数）/ 首次经过步数」的上下限筛选坐标。
 * logic 为 and 时须满足全部已启用条件；or 时满足任一即可；invert 为反选。
 *
 * 性能：trail.order 本身即「按经过次序升序」的坐标下标数组，
 * 因此当次序范围生效且非反选时，可直接切出候选区间，只遍历区间内的轨迹点
 * （长跑产生的十万级轨迹点下，避免全量遍历）。
 *
 * @param {{order:number[], info:Map<number,object>}} trail
 * @returns {{query: object, cells: object[], matched: number, total: number}}
 */
export function queryTrail(trail, rawQuery) {
  const q = normalizeTrailQuery(rawQuery);
  const checks = [];
  if (activeOrder(q)) checks.push((c) => inRange(c.order, q.orderMin, q.orderMax));
  if (activeVisits(q)) checks.push((c) => inRange(c.visits, q.visitsMin, q.visitsMax));
  if (activeSteps(q)) checks.push((c) => inRange(c.first, q.stepMin, q.stepMax));

  const cells = [];
  const orderActive = activeOrder(q);
  // 次序切片快路径：反选需要对全量取补集，故仅在非反选时可用；
  // 「或」逻辑下只有次序条件单条生效时，切片结果同样成立。
  const sliceable = orderActive && !q.invert && (q.logic === 'and' || checks.length === 1);
  if (sliceable) {
    const from = Math.max(0, q.orderMin - 1);
    const to = q.orderMax > 0 ? Math.min(trail.order.length, q.orderMax) : trail.order.length;
    for (let i = from; i < to; i++) {
      const cell = trail.info.get(trail.order[i]);
      if (!cell) continue;
      if (checks.length > 1 && !checks.every((fn) => fn(cell))) continue;
      cells.push(cell);
    }
    return { query: q, cells, matched: cells.length, total: trail.order.length };
  }

  for (const index of trail.order) {
    const cell = trail.info.get(index);
    if (!cell) continue;
    let hit = true;
    if (checks.length) {
      hit = q.logic === 'or'
        ? checks.some((fn) => fn(cell))
        : checks.every((fn) => fn(cell));
    }
    if (q.invert) hit = !hit;
    if (hit) cells.push(cell);
  }
  return { query: q, cells, matched: cells.length, total: trail.order.length };
}

/** 筛选结果导出为 CSV */
export function trailCellsToCSV(cells) {
  const rows = [['col', 'row', 'order', 'visits', 'firstStep', 'lastStep']];
  for (const c of cells) rows.push([c.col, c.row, c.order, c.visits, c.first, c.last]);
  return rows.map((r) => r.join(',')).join('\n');
}

/** 筛选结果导出为可读文本（每行一个坐标） */
export function trailCellsToText(cells) {
  return cells
    .map((c) => `(${c.col}, ${c.row}) 次序 #${c.order} 首次第 ${c.first} 步 经过 ${c.visits} 次`)
    .join('\n');
}

/* ------------------------------------------------------------------ */
/* 轨迹快照与多轨迹对比                                                */
/* ------------------------------------------------------------------ */

/**
 * 把当前轨迹模型冻结成一份可长期保存的快照（纯数据，不持有渲染资源）。
 * 之后重跑模拟即可用 compareSnapshots 做「多轨迹对比」：
 * 同一坐标被两条轨迹同时经过 = 稳定路径；只被其中一条经过 = 差异路径。
 */
export function snapshotTrail(trail, grid, label = '') {
  return {
    label,
    grid: grid ? { type: grid.type, width: grid.width, height: grid.height } : null,
    takenAtTick: trail.maxTick,
    /** 头部行驶路径（按时间升序），用于叠加绘制虚线参考轨迹 */
    path: trail.path.map((p) => ({ index: p.index, tick: p.tick, agent: p.agent })),
    /** 逐格聚合信息，用于集合对比与导出 */
    cells: trail.order.map((index) => {
      const c = trail.info.get(index);
      return { index, col: c.col, row: c.row, order: c.order, visits: c.visits, first: c.first, last: c.last };
    }),
  };
}

/** 快照是否可用于当前网格（尺寸/类型不一致时对比无意义） */
export function snapshotMatchesGrid(snap, grid) {
  if (!snap || !snap.grid || !grid) return false;
  return snap.grid.type === grid.type && snap.grid.width === grid.width && snap.grid.height === grid.height;
}

/**
 * 两条轨迹的坐标集合对比。
 * @returns {{baseCount:number, otherCount:number, shared:number[], onlyBase:number[], onlyOther:number[],
 *            union:number, overlapRatio:number, maxTickBase:number, maxTickOther:number}}
 */
export function compareSnapshots(base, other) {
  const baseCells = (base && base.cells) || [];
  const otherCells = (other && other.cells) || [];
  const a = new Set(baseCells.map((c) => c.index));
  const b = new Set(otherCells.map((c) => c.index));
  const shared = [];
  const onlyBase = [];
  const onlyOther = [];
  for (const i of a) (b.has(i) ? shared : onlyBase).push(i);
  for (const i of b) if (!a.has(i)) onlyOther.push(i);
  const union = shared.length + onlyBase.length + onlyOther.length;
  return {
    baseCount: a.size,
    otherCount: b.size,
    shared,
    onlyBase,
    onlyOther,
    union,
    overlapRatio: union ? shared.length / union : 1,
    maxTickBase: (base && base.takenAtTick) || 0,
    maxTickOther: (other && other.takenAtTick) || 0,
  };
}

const COMPARE_STATUS = { shared: '共有', onlyBase: '仅基准', onlyOther: '仅当前' };

/** 对比结果导出为 CSV（逐格列出状态，便于在表格里进一步分析） */
export function compareToCSV(diff) {
  const rows = [['col', 'row', 'status']];
  const grid = diff.grid;
  const emit = (list, status) => {
    for (const index of list) {
      rows.push([index % grid.width, Math.floor(index / grid.width), COMPARE_STATUS[status]]);
    }
  };
  emit(diff.onlyBase, 'onlyBase');
  emit(diff.onlyOther, 'onlyOther');
  emit(diff.shared, 'shared');
  return rows.map((r) => r.join(',')).join('\n');
}

/** 对比结果的可读摘要 */
export function compareToText(diff) {
  const pct = (diff.overlapRatio * 100).toFixed(1);
  return [
    `基准轨迹：第 ${diff.maxTickBase} 步 · 覆盖 ${diff.baseCount} 格`,
    `当前轨迹：第 ${diff.maxTickOther} 步 · 覆盖 ${diff.otherCount} 格`,
    `重合 ${diff.shared.length} 格 · 仅基准 ${diff.onlyBase.length} 格 · 仅当前 ${diff.onlyOther.length} 格`,
    `重合率 ${pct}%（重合 / 并集，共 ${diff.union} 格）`,
  ].join('\n');
}
