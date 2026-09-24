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
 * @returns {{path: Array<{index:number,tick:number,agent:number}>, order: number[], info: Map<number, object>, maxTick: number}}
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

  return { path, order, info, maxTick };
}

/* ------------------------------------------------------------------ */
/* 坐标筛选查询                                                        */
/* ------------------------------------------------------------------ */

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
 * @returns {{query: object, cells: object[], matched: number, total: number}}
 */
export function queryTrail(trail, rawQuery) {
  const q = normalizeTrailQuery(rawQuery);
  const checks = [];
  if (activeOrder(q)) checks.push((c) => inRange(c.order, q.orderMin, q.orderMax));
  if (activeVisits(q)) checks.push((c) => inRange(c.visits, q.visitsMin, q.visitsMax));
  if (activeSteps(q)) checks.push((c) => inRange(c.first, q.stepMin, q.stepMax));

  const cells = [];
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
