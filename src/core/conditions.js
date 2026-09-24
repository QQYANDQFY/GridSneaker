/**
 * 环境条件求值：以规则主体为中心，检查周围环境是否满足条件
 *
 * 上下文 ctx 需要提供：
 *   grid, world, agents, agent(主体所属移动体), stats, rng, tick
 * 主体 subject = { coord, agent, kind, segmentIndex }
 */

export const OBJECT_LABELS = {
  empty: '空格',
  boundary: '边界',
  wall: '边界',
  head: '蛇头',
  body: '蛇身',
  self: '自身',
  agent: '任意移动体',
  other: '其他移动体',
  visited: '已走过',
  any: '任意对象',
  obstacle: '障碍物',
  marker: '标记物',
};

export function labelOfObject(name) {
  return OBJECT_LABELS[name] || name;
}

/** 判断某格是否含有指定对象标签 */
export function cellHasObject(coord, tag, ctx) {
  const { grid, world } = ctx;
  const inb = grid.inBounds(coord);
  if (tag === 'any') return true;
  if (tag === 'boundary' || tag === 'wall') return !inb;
  if (!inb) return false;

  const index = grid.idx(coord.col, coord.row);

  const isHead = ctx.agents.some((a) => a.alive && grid.idx(a.head.col, a.head.row) === index);
  const isBody = !isHead && ctx.agents.some((a) => {
    if (!a.alive) return false;
    for (let i = 1; i < a.segments.length; i++) {
      if (grid.idx(a.segments[i].col, a.segments[i].row) === index) return true;
    }
    return false;
  });

  switch (tag) {
    case 'head':
      return isHead;
    case 'body':
      return isBody;
    case 'self':
      return isHead || isBody;
    case 'agent':
      return isHead || isBody;
    case 'other':
      return (isHead || isBody) && !(ctx.agent && (ctx.agent.head && grid.idx(ctx.agent.head.col, ctx.agent.head.row) === index));
    case 'visited':
      return !!(ctx.stats && ctx.stats.visited && ctx.stats.visited.has(index));
    case 'empty':
      return !isHead && !isBody && world.getByIndex(index) === 'empty';
    case 'notEmpty':
      return isHead || isBody || world.getByIndex(index) !== 'empty';
    default:
      // 环境状态名（obstacle / marker / 自定义状态）
      return !isHead && !isBody && world.getByIndex(index) === tag;
  }
}

export function cellHasAnyObject(coord, objects, ctx) {
  const list = Array.isArray(objects) ? objects : [objects];
  for (const o of list) {
    if (cellHasObject(coord, o, ctx)) return true;
  }
  return false;
}

/** 图案匹配使用的单字符符号 */
export function cellSymbol(coord, ctx) {
  const { grid, world } = ctx;
  if (!grid.inBounds(coord)) return 'B';
  const index = grid.idx(coord.col, coord.row);
  for (const a of ctx.agents) {
    if (!a.alive) continue;
    if (grid.idx(a.head.col, a.head.row) === index) return 'H';
  }
  for (const a of ctx.agents) {
    if (!a.alive) continue;
    for (let i = 1; i < a.segments.length; i++) {
      if (grid.idx(a.segments[i].col, a.segments[i].row) === index) return 'S';
    }
  }
  const st = world.statesAt(index);
  if (!st || st.name === 'empty') return '.';
  return st.symbol || st.name[0].toUpperCase();
}

export function normalizePattern(pattern, length) {
  const chars = String(pattern ?? '').replace(/[\s|]/g, '').split('');
  while (chars.length < length) chars.push('*');
  return chars.slice(0, length).join('');
}

function compareValues(actual, comparator, value) {
  switch (comparator) {
    case '>=': return actual >= value;
    case '<=': return actual <= value;
    case '>': return actual > value;
    case '<': return actual < value;
    case '==': return Math.abs(actual - value) < 1e-9;
    case '!=': return Math.abs(actual - value) >= 1e-9;
    default: return false;
  }
}

function neighborhoodCells(clause, coord, ctx) {
  const { grid } = ctx;
  const kind = clause.kind || 'moore';
  const radius = clause.radius || 1;
  const objects = clause.objects || [];
  const needsBoundary = objects.includes('boundary') || objects.includes('wall');
  const raw = grid.neighborsRaw(coord, kind, radius, !!clause.includeSelf);
  return needsBoundary ? raw : raw.filter((c) => grid.inBounds(c));
}

function countMatches(clause, coord, ctx) {
  const cells = neighborhoodCells(clause, coord, ctx);
  let n = 0;
  for (const c of cells) if (cellHasAnyObject(c, clause.objects, ctx)) n++;
  return { count: n, total: cells.length };
}

export function evaluateClause(clause, subject, ctx) {
  if (!clause) return true;
  const { grid } = ctx;
  const coord = subject.coord;
  const agent = subject.agent || ctx.agent;
  let result = false;

  switch (clause.type) {
    case 'count': {
      const { count } = countMatches(clause, coord, ctx);
      result = compareValues(count, clause.comparator, clause.value);
      break;
    }
    case 'proportion': {
      const { count, total } = countMatches(clause, coord, ctx);
      const ratio = total > 0 ? count / total : 0;
      result = compareValues(ratio, clause.comparator, clause.value);
      break;
    }
    case 'exists': {
      const cells = neighborhoodCells(clause, coord, ctx);
      result = cells.some((c) => cellHasAnyObject(c, clause.objects, ctx));
      break;
    }
    case 'direction': {
      if (!agent) break;
      const target = grid.relativeCoord(coord, agent.dir, clause.rel, clause.distance || 1);
      result = !!target && cellHasAnyObject(target, clause.objects, ctx);
      break;
    }
    case 'pattern': {
      const slots = grid.patternSlots(coord);
      const pat = normalizePattern(clause.pattern, slots.length);
      result = true;
      for (let i = 0; i < slots.length; i++) {
        const sym = cellSymbol(slots[i], ctx);
        const want = pat[i];
        if (want === '*') continue;
        if (want === '#' && (sym === '#')) continue;
        if (want === 'S' && (sym === 'S' || sym === 'H')) continue;
        if (want.toUpperCase() !== sym.toUpperCase()) { result = false; break; }
      }
      break;
    }
    case 'distance': {
      let best = Infinity;
      const r = 12;
      for (const c of grid.neighborsRaw(coord, 'radius', r, false)) {
        if (!grid.inBounds(c)) continue;
        if (!cellHasAnyObject(c, clause.objects, ctx)) continue;
        const d = grid.distance(coord, c);
        if (d < best) best = d;
      }
      result = Number.isFinite(best) && compareValues(best, clause.comparator, clause.value);
      break;
    }
    case 'stat': {
      const v = ctx.stats ? Number(ctx.stats[clause.key] ?? 0) : 0;
      result = compareValues(v, clause.comparator, clause.value);
      break;
    }
    case 'selfLength': {
      const len = agent ? agent.length : 0;
      result = compareValues(len, clause.comparator, clause.value);
      break;
    }
    case 'cellState': {
      const target = clause.position === 'current'
        ? coord
        : (agent ? grid.relativeCoord(coord, agent.dir, clause.position, 1) : null);
      result = !!target && grid.inBounds(target) && ctx.world.get(target) === clause.state;
      break;
    }
    case 'random':
      result = ctx.rng.next() < clause.probability;
      break;
    case 'group': {
      const list = clause.clauses || [];
      if (!list.length) { result = true; break; }
      result = clause.logic === 'or'
        ? list.some((c) => evaluateClause(c, subject, ctx))
        : list.every((c) => evaluateClause(c, subject, ctx));
      break;
    }
    default:
      result = true;
  }
  return clause.invert ? !result : result;
}

export function evaluateCondition(condition, subject, ctx) {
  if (!condition || !condition.clauses || condition.clauses.length === 0) return true;
  const list = condition.clauses;
  return condition.logic === 'or'
    ? list.some((c) => evaluateClause(c, subject, ctx))
    : list.every((c) => evaluateClause(c, subject, ctx));
}

/* ------------------------------------------------------------------ */
/* 人类可读描述（用于日志与界面）                                       */
/* ------------------------------------------------------------------ */

const CMP_TEXT = { '>=': '≥', '<=': '≤', '==': '=', '>': '>', '<': '<', '!=': '≠' };

export function describeClause(clause) {
  if (!clause) return '';
  const not = clause.invert ? '非 ' : '';
  const objs = (clause.objects || []).map(labelOfObject).join('/');
  const nb = { vonNeumann: '4邻域', moore: '8邻域', hex: '6邻域', radius: `半径${clause.radius || 1}` }[clause.kind] || clause.kind;
  switch (clause.type) {
    case 'count':
      return `${not}${nb}内 ${objs} 数量 ${CMP_TEXT[clause.comparator] || clause.comparator} ${clause.value}`;
    case 'proportion':
      return `${not}${nb}内 ${objs} 比例 ${CMP_TEXT[clause.comparator] || clause.comparator} ${Math.round(clause.value * 100)}%`;
    case 'exists':
      return `${not}${nb}内存在 ${objs}`;
    case 'direction':
      return `${not}${relLabel(clause.rel)}${clause.distance > 1 ? clause.distance + '格' : ''}处存在 ${objs}`;
    case 'pattern':
      return `${not}邻域图案匹配 "${String(clause.pattern).replace(/\n/g, '/')}"`;
    case 'distance':
      return `${not}最近 ${objs} 距离 ${CMP_TEXT[clause.comparator] || clause.comparator} ${clause.value}`;
    case 'stat':
      return `${not}统计 ${STAT_LABELS[clause.key] || clause.key} ${CMP_TEXT[clause.comparator] || clause.comparator} ${clause.value}`;
    case 'selfLength':
      return `${not}自身长度 ${CMP_TEXT[clause.comparator] || clause.comparator} ${clause.value}`;
    case 'cellState':
      return `${not}${relLabel(clause.position)}为 ${clause.state}`;
    case 'random':
      return `${not}概率 ${Math.round(clause.probability * 100)}%`;
    case 'group':
      return `${not}(${(clause.clauses || []).map(describeClause).join(clause.logic === 'or' ? ' 或 ' : ' 且 ')})`;
    default:
      return clause.type;
  }
}

export const STAT_LABELS = {
  steps: '步数',
  collisions: '碰撞次数',
  collisionsTotal: '累计碰撞',
  collisionsConsecutive: '连续碰撞',
  selfCollisions: '自撞次数',
  selfCollisionsConsecutive: '连续自撞',
  length: '长度',
  turnsLeft: '左转次数',
  turnsStraight: '直行次数',
  turnsRight: '右转次数',
  ruleTriggers: '规则触发次数',
  coverage: '覆盖率(%)',
  agents: '移动体数量',
};

function relLabel(rel) {
  return {
    front: '前方',
    back: '后方',
    left: '左侧',
    right: '右侧',
    frontLeft: '左前',
    frontRight: '右前',
    backLeft: '左后',
    backRight: '右后',
    current: '当前格',
  }[rel] || rel;
}

export function describeCondition(condition) {
  if (!condition || !condition.clauses || !condition.clauses.length) return '无条件';
  const joiner = condition.logic === 'or' ? ' 或 ' : ' 且 ';
  return condition.clauses.map(describeClause).join(joiner);
}
