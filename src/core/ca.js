/**
 * 元胞自动机引擎
 * 支持：多状态、Von Neumann / Moore / 六边形邻域、半径、固定/循环/反射边界、
 *       同步 / 异步 / 随机顺序更新、状态转移规则表、方向性交通流规则、初始图案
 */

export const CA_UPDATE_LABELS = {
  synchronous: '同步更新',
  asynchronous: '异步更新',
  random: '随机顺序更新',
};

export const CA_BOUNDARY_LABELS = {
  fixed: '固定边界',
  wrap: '循环边界',
  reflect: '反射边界',
};

/**
 * 图案文本 → { rows, width, height }
 * 空行被忽略，width 取最长行；仅供 CA 初始图案与配置诊断共用。
 */
export function parsePatternText(text) {
  const rows = String(text ?? '').split('\n').map((r) => r.replace(/\r/g, '')).filter((r) => r.length);
  return { rows, width: rows.length ? Math.max(...rows.map((r) => r.length)) : 0, height: rows.length };
}

/**
 * 图案字符 → 状态索引的符号表。
 * 优先级：状态 symbol → 状态全名 → 非内置状态的首字母 → O/X/#/@ 别名（指向第一个非空状态）。
 */
export function buildSymbolMap(states) {
  const index = new Map();
  states.forEach((s, i) => index.set(s.name, i));
  const map = new Map();
  const builtin = new Set(['empty', 'obstacle', 'marker', 'trail']);
  for (const s of states) {
    const i = index.get(s.name);
    map.set(String(s.symbol).toUpperCase(), i);
    map.set(String(s.name).toUpperCase(), i);
    if (!builtin.has(s.name)) map.set(String(s.name)[0].toUpperCase(), i);
  }
  map.set('.', 0);
  map.set(' ', 0);
  const firstSolid = states.findIndex((s) => s.name !== 'empty');
  if (firstSolid > 0) {
    for (const alias of ['O', 'X', '#', '@']) {
      if (!map.has(alias)) map.set(alias, firstSolid);
    }
  }
  return map;
}

/** 图案文本在网格上的居中偏移 */
export function patternOffset(grid, text) {
  const { width, height } = parsePatternText(text);
  return { offCol: Math.floor((grid.width - width) / 2), offRow: Math.floor((grid.height - height) / 2) };
}

/**
 * 图案模式下某坐标对应的状态名。
 * 未被图案覆盖（'.'、空格、越界、未知字符）时返回 null。
 */
export function patternStateNameAt(grid, states, text, coord) {
  const { rows, width, height } = parsePatternText(text);
  if (!rows.length) return null;
  const { offCol, offRow } = patternOffset(grid, text);
  const r = coord.row - offRow;
  const c = coord.col - offCol;
  if (r < 0 || c < 0 || r >= height || c >= rows[r].length) return null;
  const ch = rows[r][c];
  if (ch === '.' || ch === ' ') return null;
  const si = buildSymbolMap(states).get(ch.toUpperCase());
  return si === undefined ? null : states[si].name;
}

/** 把图案中某坐标的字符清空为 '.'；坐标不在图案内时返回 null */
export function clearPatternCell(grid, text, coord) {
  const { rows, height } = parsePatternText(text);
  if (!rows.length) return null;
  const { offCol, offRow } = patternOffset(grid, text);
  const r = coord.row - offRow;
  const c = coord.col - offCol;
  if (r < 0 || c < 0 || r >= height || c >= rows[r].length) return null;
  rows[r] = rows[r].slice(0, c) + '.' + rows[r].slice(c + 1);
  return rows.join('\n');
}

export class CAEngine {
  constructor(grid, caMode, states) {
    this.grid = grid;
    this.cfg = caMode;
    this.states = states;
    this.index = new Map();
    states.forEach((s, i) => this.index.set(s.name, i));
  }

  stateIdx(name) {
    const i = this.index.get(name);
    return i === undefined ? 0 : i;
  }

  /** 映射邻域坐标（按边界策略）→ 返回 null 表示固定边界外的空格 */
  mapCoord(coord) {
    const { grid } = this;
    if (grid.inBounds(coord)) return coord;
    switch (this.cfg.boundary) {
      case 'wrap':
        return grid.wrap(coord);
      case 'reflect': {
        let col = coord.col;
        let row = coord.row;
        const w = grid.width;
        const h = grid.height;
        if (col < 0) col = -col - 1;
        if (col >= w) col = 2 * w - col - 1;
        if (row < 0) row = -row - 1;
        if (row >= h) row = 2 * h - row - 1;
        col = Math.min(w - 1, Math.max(0, col));
        row = Math.min(h - 1, Math.max(0, row));
        return { col, row };
      }
      default:
        return null; // fixed：界外视为 empty
    }
  }

  /** 邻域内某状态的数量（同步更新时读 cells 快照） */
  countInNeighborhood(cells, coord, stateIdx) {
    const { grid } = this;
    const raw = grid.neighborsRaw(coord, this.cfg.neighborhood, this.cfg.radius, false);
    let n = 0;
    for (const c of raw) {
      const m = this.mapCoord(c);
      if (!m) continue; // fixed：界外为 empty，不计入目标状态
      if (cells[grid.idx(m.col, m.row)] === stateIdx) n++;
    }
    return n;
  }

  /** 规则匹配：返回目标状态索引，或 null 表示保持原状 */
  matchRule(cells, coord, currentIdx, rng) {
    const stateName = this.states[currentIdx].name;
    for (const rule of this.cfg.rules) {
      if (!rule.enabled) continue;
      if (rule.kind === 'traffic') continue;
      if (rule.from !== '*' && !rule.from.includes(stateName)) continue;
      let ok = true;
      for (const c of rule.counts) {
        const si = this.stateIdx(c.state);
        const n = this.countInNeighborhood(cells, coord, si);
        if (c.values && c.values.length) {
          if (!c.values.includes(n)) { ok = false; break; }
        } else {
          if (c.min !== null && c.min !== undefined && n < c.min) { ok = false; break; }
          if (c.max !== null && c.max !== undefined && n > c.max) { ok = false; break; }
        }
      }
      if (!ok) continue;
      if (rule.probability < 1 && rng.next() >= rule.probability) continue;
      return this.stateIdx(rule.to);
    }
    return null;
  }

  /** 方向性移动规则（如交通流），返回 { cells, moved } */
  applyTrafficRules(cells, rng) {
    const { grid } = this;
    const traffic = this.cfg.rules.filter((r) => r.enabled && r.kind === 'traffic');
    if (!traffic.length) return { cells, moved: false };
    const out = cells.slice();
    let moved = false;
    for (const rule of traffic) {
      const fromIdx = this.stateIdx(rule.from === '*' ? 'empty' : rule.from[0]);
      const toIdx = this.stateIdx(rule.to);
      const dir = this.parseDirIndex(rule.direction);
      const d = grid.step({ col: 0, row: 0 }, dir);
      const projected = grid.allCoords().sort((a, b) => (b.col * d.col + b.row * d.row) - (a.col * d.col + a.row * d.row));
      for (const c of projected) {
        const i = grid.idx(c.col, c.row);
        if (out[i] !== fromIdx) continue;
        let target = grid.step(c, dir);
        target = this.mapCoord(target);
        if (!target) continue;
        const ti = grid.idx(target.col, target.row);
        if (out[ti] !== toIdx) continue;
        out[ti] = fromIdx;
        out[i] = toIdx;
        moved = true;
      }
    }
    return { cells: out, moved };
  }

  parseDirIndex(name) {
    const { grid } = this;
    const keys = ['east', 'southEast', 'southWest', 'west', 'northWest', 'northEast'];
    if (grid.type === 'hex') {
      const i = keys.findIndex((k) => k.toLowerCase() === String(name).toLowerCase());
      return i >= 0 ? i : 0;
    }
    const alias = { east: 'right', west: 'left', north: 'up', south: 'down', right: 'right', left: 'left', up: 'up', down: 'down' };
    const key = alias[String(name).toLowerCase()] || 'right';
    return grid.dirNames.findIndex((n) => n === key);
  }

  /** 单次演化 */
  step(world, rng) {
    const { grid } = this;
    const mode = this.cfg.update;
    if (!this.cfg.rules.length) return false;
    const hadTraffic = this.cfg.rules.some((r) => r.enabled && r.kind === 'traffic');

    if (mode === 'synchronous') {
      const snapshot = world.cells.slice();
      const next = snapshot.slice();
      let changed = false;
      for (let i = 0; i < grid.size; i++) {
        const coord = grid.coord(i);
        const target = this.matchRule(snapshot, coord, snapshot[i], rng);
        if (target !== null && target !== snapshot[i]) {
          next[i] = target;
          changed = true;
        }
      }
      if (hadTraffic) {
        const res = this.applyTrafficRules(next, rng);
        world.cells = res.cells;
        if (res.moved) changed = true;
      } else {
        world.cells = next;
      }
      return changed;
    }

    // 异步 / 随机顺序：就地更新
    const order = grid.allCoords();
    if (mode === 'random') rng.shuffle(order);
    let changed = false;
    for (const coord of order) {
      const i = grid.idx(coord.col, coord.row);
      const target = this.matchRule(world.cells, coord, world.cells[i], rng);
      if (target !== null && target !== world.cells[i]) {
        world.cells[i] = target;
        changed = true;
      }
    }
    if (hadTraffic) {
      const res = this.applyTrafficRules(world.cells, rng);
      world.cells = res.cells;
      if (res.moved) changed = true;
    }
    return changed;
  }

  /** 应用初始图案 */
  init(world, rng) {
    const initCfg = this.cfg.initial || {};
    for (let i = 0; i < world.cells.length; i++) world.cells[i] = 0;
    if (initCfg.mode === 'random') {
      const si = this.stateIdx(initCfg.state || 'obstacle');
      for (let i = 0; i < world.cells.length; i++) {
        if (rng.next() < initCfg.density) world.cells[i] = si;
      }
    } else if (initCfg.mode === 'pattern') {
      this.applyPatternText(world, initCfg.pattern || '');
    }
    return world;
  }

  /** 图案文本：每行一个字符串，'.' 为空，其它字符按状态符号匹配 */
  applyPatternText(world, text) {
    const { grid } = this;
    const { rows, height: ph } = parsePatternText(text);
    if (!rows.length) return;
    const { offCol, offRow } = patternOffset(grid, text);
    const symbolMap = buildSymbolMap(this.states);
    for (let r = 0; r < ph; r++) {
      for (let c = 0; c < rows[r].length; c++) {
        const ch = rows[r][c];
        if (ch === '.' || ch === ' ') continue;
        const si = symbolMap.get(ch.toUpperCase());
        if (si === undefined) continue;
        const col = offCol + c;
        const row = offRow + r;
        if (col < 0 || row < 0 || col >= grid.width || row >= grid.height) continue;
        if (si !== 0) world.cells[grid.idx(col, row)] = si;
      }
    }
  }

  /** 状态直方图（用于统计面板） */
  histogram(world) {
    const hist = this.states.map(() => 0);
    for (let i = 0; i < world.cells.length; i++) hist[world.cells[i]]++;
    return hist;
  }
}
