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
    const rows = String(text).split('\n').map((r) => r.replace(/\r/g, '')).filter((r) => r.length);
    if (!rows.length) return;
    const pw = Math.max(...rows.map((r) => r.length));
    const ph = rows.length;
    const offCol = Math.floor((grid.width - pw) / 2);
    const offRow = Math.floor((grid.height - ph) / 2);
    const symbolMap = new Map();
    const builtin = new Set(['empty', 'obstacle', 'marker', 'trail']);
    for (const s of this.states) {
      const idx = this.stateIdx(s.name);
      symbolMap.set(String(s.symbol).toUpperCase(), idx);
      symbolMap.set(String(s.name).toUpperCase(), idx);
      if (!builtin.has(s.name)) symbolMap.set(String(s.name)[0].toUpperCase(), idx);
    }
    symbolMap.set('.', 0);
    symbolMap.set(' ', 0);
    // 常见别名：O / X / # 指向第一个非空状态
    const firstSolid = this.states.findIndex((s) => s.name !== 'empty');
    if (firstSolid > 0) {
      for (const alias of ['O', 'X', '#', '@']) {
        if (!symbolMap.has(alias)) symbolMap.set(alias, firstSolid);
      }
    }
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
