/**
 * 世界状态：环境单元（可为元胞自动机状态）与移动体（类贪吃蛇）
 */

const BUILTIN_STATES = {
  empty: { color: null, blocking: false, symbol: '.', render: 'fill' },
  obstacle: { color: '#5b6472', blocking: true, symbol: '#', render: 'cross' },
  marker: { color: '#ffd166', blocking: false, symbol: 'M', render: 'dot' },
  trail: { color: '#2f5f9e', blocking: false, symbol: 'T', render: 'fill' },
};

/** 把用户的 states 定义（字符串或对象）规范化为对象数组，empty 恒定在索引 0 */
export function normalizeStates(states) {
  const raw = Array.isArray(states) && states.length ? states : ['empty', 'obstacle', 'marker'];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const s = typeof item === 'string' ? { name: item } : { ...(item || {}) };
    if (!s.name || seen.has(s.name)) continue;
    seen.add(s.name);
    const base = BUILTIN_STATES[s.name] || {};
    out.push({
      name: s.name,
      color: s.color ?? base.color ?? '#8899aa',
      blocking: s.blocking ?? base.blocking ?? false,
      symbol: s.symbol ?? base.symbol ?? String(s.name)[0].toUpperCase(),
      render: s.render || base.render || 'fill',
    });
  }
  if (!seen.has('empty')) {
    out.unshift({ name: 'empty', color: null, blocking: false, symbol: '.', render: 'fill' });
  } else {
    // 确保 empty 在首位
    const i = out.findIndex((s) => s.name === 'empty');
    if (i > 0) out.unshift(out.splice(i, 1)[0]);
  }
  return out;
}

export function buildStateIndex(states) {
  const map = new Map();
  states.forEach((s, i) => map.set(s.name, i));
  return map;
}

export class World {
  constructor(grid, states) {
    this.grid = grid;
    this.states = states;
    this.stateIndex = buildStateIndex(states);
    this.cells = new Uint8Array(grid.size);
    this.blockingMask = states.map((s) => !!s.blocking);
  }

  clone() {
    const w = new World(this.grid, this.states);
    w.cells = this.cells.slice();
    return w;
  }

  /** 用已有 Uint8Array 替换（不复制） */
  static fromSnapshot(grid, states, cells) {
    const w = new World(grid, states);
    w.cells = cells;
    return w;
  }

  statesAt(index) {
    return this.states[this.cells[index]];
  }

  stateNameAt(index) {
    return this.states[this.cells[index]].name;
  }

  stateIndexOf(name) {
    const i = this.stateIndex.get(name);
    return i === undefined ? 0 : i;
  }

  get(coord) {
    if (!this.grid.inBounds(coord)) return null;
    return this.states[this.cells[this.grid.idx(coord.col, coord.row)]].name;
  }

  getByIndex(index) {
    return this.states[this.cells[index]].name;
  }

  set(coord, stateName) {
    if (!this.grid.inBounds(coord)) return false;
    const si = this.stateIndexOf(stateName);
    const i = this.grid.idx(coord.col, coord.row);
    if (this.cells[i] === si) return false;
    this.cells[i] = si;
    return true;
  }

  setByIndex(index, stateName) {
    const si = this.stateIndexOf(stateName);
    if (this.cells[index] === si) return false;
    this.cells[index] = si;
    return true;
  }

  isEmpty(coord) {
    return this.get(coord) === 'empty';
  }

  isBlocking(coord) {
    if (!this.grid.inBounds(coord)) return false;
    return this.blockingMask[this.cells[this.grid.idx(coord.col, coord.row)]];
  }

  countState(stateName) {
    const si = this.stateIndexOf(stateName);
    let n = 0;
    for (let i = 0; i < this.cells.length; i++) if (this.cells[i] === si) n++;
    return n;
  }

  /** 随机放置一个指定状态到空格，返回坐标或 null */
  randomEmpty(rng) {
    const empties = [];
    for (let i = 0; i < this.cells.length; i++) {
      if (this.states[this.cells[i]].name === 'empty') empties.push(i);
    }
    if (!empties.length) return null;
    return this.grid.coord(rng.pick(empties));
  }

  snapshot() {
    return this.cells;
  }
}

export class Agent {
  constructor(id, segments, dir, opts = {}) {
    this.id = id;
    this.segments = segments; // [{col,row}, ...] 0 为头部
    this.dir = dir;
    this.alive = true;
    this.color = opts.color || null;
    this.label = opts.label || id;
    this.pendingForcedStraights = 0;
    this.forcedNextTurn = null;
    this.endReason = null;
    this.speedMul = 1;
    this.state = opts.state || 'normal';
    this.tag = opts.tag || null;
    /** 是否为主移动体：主移动体触发结束条件时会终止整场运行，其它移动体只会自行消失 */
    this.isMain = opts.isMain !== undefined ? !!opts.isMain : true;
    /** 生成时刻（步数），用于「最老/最新」排序与运行日志 */
    this.spawnTick = Math.max(0, Math.round(Number(opts.spawnTick) || 0));
  }

  /** 头部坐标 */
  get head() {
    return this.segments[0];
  }

  get tail() {
    return this.segments[this.segments.length - 1];
  }

  get length() {
    return this.segments.length;
  }

  clone() {
    const a = new Agent(this.id, this.segments.map((s) => ({ ...s })), this.dir, {
      color: this.color,
      label: this.label,
      state: this.state,
      tag: this.tag,
      isMain: this.isMain,
      spawnTick: this.spawnTick,
    });
    a.alive = this.alive;
    a.pendingForcedStraights = this.pendingForcedStraights;
    a.forcedNextTurn = this.forcedNextTurn;
    a.endReason = this.endReason;
    a.speedMul = this.speedMul;
    return a;
  }

  bodyIndices(grid) {
    const set = new Set();
    for (let i = 1; i < this.segments.length; i++) {
      set.add(grid.idx(this.segments[i].col, this.segments[i].row));
    }
    return set;
  }

  occupiedIndices(grid) {
    const set = new Set();
    for (const s of this.segments) set.add(grid.idx(s.col, s.row));
    return set;
  }

  containsIndex(grid, index) {
    return this.occupiedIndices(grid).has(index);
  }

  /** 指定体节（0 = 头，-1 = 尾） */
  segment(index) {
    if (index < 0) return this.segments[this.segments.length + index];
    return this.segments[index];
  }
}
