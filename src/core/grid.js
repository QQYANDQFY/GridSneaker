/**
 * 统一网格抽象
 * - 方格：4 方向移动（up/right/down/left，顺时针），支持 4/8 邻域感知
 * - 六边形：尖顶（pointy-top）轴向坐标，6 方向移动（顺时针）
 *
 * 坐标统一使用「偏移坐标」{col, row}，索引 = row * width + col。
 * 六边形内部在需要时转换为轴向坐标 {q, r}。
 */

export const SQ_DIR_NAMES = ['up', 'right', 'down', 'left'];
export const SQ_DIR_VEC = [
  { dx: 0, dy: -1 },
  { dx: 1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: -1, dy: 0 },
];

/** 8 邻域方向（顺时针，从上方开始），用于 moore 感知 */
export const SQ_NEIGHBOR8 = [
  { dx: 0, dy: -1 },
  { dx: 1, dy: -1 },
  { dx: 1, dy: 0 },
  { dx: 1, dy: 1 },
  { dx: 0, dy: 1 },
  { dx: -1, dy: 1 },
  { dx: -1, dy: 0 },
  { dx: -1, dy: -1 },
];

export const HEX_DIR_NAMES = ['east', 'southEast', 'southWest', 'west', 'northWest', 'northEast'];
/** 轴向方向向量，顺时针（屏幕 y 向下） */
export const HEX_DIR_VEC = [
  { q: 1, r: 0 },
  { q: 0, r: 1 },
  { q: -1, r: 1 },
  { q: -1, r: 0 },
  { q: 0, r: -1 },
  { q: 1, r: -1 },
];

export function dirNames(type) {
  return type === 'hex' ? HEX_DIR_NAMES : SQ_DIR_NAMES;
}

/** 方向键名 → 规范中文显示名（供界面展示 / 提示文本使用，内部键名保持不变） */
export const DIR_LABEL_CN = {
  up: '上', right: '右', down: '下', left: '左',
  east: '东', southEast: '东南', southWest: '西南', west: '西', northWest: '西北', northEast: '东北',
};

/** 方向的中文显示名：dirLabel('square', 0) → '上' */
export function dirLabel(type, index) {
  const names = dirNames(type);
  if (typeof index !== 'number') return DIR_LABEL_CN[index] || String(index);
  const i = ((Math.round(index) % names.length) + names.length) % names.length;
  return DIR_LABEL_CN[names[i]] || names[i];
}

/** 解析方向：支持名称（含中文别名）、索引 */
export function parseDir(value, type) {
  const names = dirNames(type);
  if (typeof value === 'number') {
    const n = names.length;
    return ((Math.round(value) % n) + n) % n;
  }
  const key = String(value ?? '').trim();
  const idx = names.findIndex((n) => n.toLowerCase() === key.toLowerCase());
  if (idx >= 0) return idx;
  const alias = {
    up: 'up', north: 'up', 上: 'up',
    right: 'right', east: 'right', 右: 'right',
    down: 'down', south: 'down', 下: 'down',
    left: 'left', west: 'left', 左: 'left',
    东北: 'northEast', northeast: 'northEast', 东南: 'southEast', southeast: 'southEast',
    西北: 'northWest', northwest: 'northWest', 西南: 'southWest', southwest: 'southWest',
  };
  const mapped = alias[key.toLowerCase()] || alias[key];
  if (mapped) {
    const i = names.findIndex((n) => n.toLowerCase() === mapped.toLowerCase());
    if (i >= 0) return i;
  }
  return 0;
}

export class Grid {
  constructor(cfg = {}) {
    this.type = cfg.type === 'hex' ? 'hex' : 'square';
    this.width = Math.max(1, Math.floor(cfg.width ?? 20));
    this.height = Math.max(1, Math.floor(cfg.height ?? 20));
    this.boundary = cfg.boundary || 'stop';
    this.dirCount = this.type === 'hex' ? 6 : 4;
    this.size = this.width * this.height;
    this.dirNames = dirNames(this.type);
  }

  /* ---------------- 基本坐标操作 ---------------- */

  idx(col, row) {
    return row * this.width + col;
  }

  coord(index) {
    return { col: index % this.width, row: Math.floor(index / this.width) };
  }

  inBounds(c) {
    return !!c && c.col >= 0 && c.col < this.width && c.row >= 0 && c.row < this.height;
  }

  wrap(c) {
    const col = ((c.col % this.width) + this.width) % this.width;
    const row = ((c.row % this.height) + this.height) % this.height;
    return { col, row };
  }

  /**
   * 两格之间的「环绕最短位移」（格坐标差值）。
   * 相邻两帧的真实位移不超过 1 步，若差值接近整圈，说明发生了边界穿越，
   * 需要换算成穿越方向上的那一步；否则动画插值会让移动体贴着整张画面横穿（错误闪现）。
   */
  wrapDelta(a, b) {
    let dc = b.col - a.col;
    let dr = b.row - a.row;
    if (Math.abs(dc) > this.width / 2) dc += dc > 0 ? -this.width : this.width;
    if (Math.abs(dr) > this.height / 2) dr += dr > 0 ? -this.height : this.height;
    return { dc, dr };
  }

  /** 沿方向移动一步，可能越界（返回仍为偏移坐标） */
  step(c, dir) {
    const d = ((dir % this.dirCount) + this.dirCount) % this.dirCount;
    if (this.type === 'square') {
      const v = SQ_DIR_VEC[d];
      return { col: c.col + v.dx, row: c.row + v.dy };
    }
    const a = this.axial(c);
    const v = HEX_DIR_VEC[d];
    return this.offset({ q: a.q + v.q, r: a.r + v.r });
  }

  /** 越界后按边界策略处理，返回目标坐标；stop/custom 返回 null（表示无法移动） */
  resolveBoundary(c, dir, mode) {
    const target = this.step(c, dir);
    if (this.inBounds(target)) return target;
    switch (mode) {
      case 'wrap':
        return this.wrap(target);
      case 'bounce': {
        const back = this.opposite(dir);
        const t2 = this.step(c, back);
        return this.inBounds(t2) ? t2 : null;
      }
      default:
        return null;
    }
  }

  opposite(dir) {
    const d = ((dir % this.dirCount) + this.dirCount) % this.dirCount;
    return this.type === 'hex' ? (d + 3) % 6 : (d + 2) % 4;
  }

  leftOf(dir) {
    const d = ((dir % this.dirCount) + this.dirCount) % this.dirCount;
    return (d - 1 + this.dirCount) % this.dirCount;
  }

  rightOf(dir) {
    const d = ((dir % this.dirCount) + this.dirCount) % this.dirCount;
    return (d + 1) % this.dirCount;
  }

  /* ---------------- 六边形轴向坐标 ---------------- */

  axial(c) {
    if (this.type === 'square') return { q: c.col, r: c.row };
    // odd-r offset -> axial
    const row = c.row;
    return { q: c.col - (row - (row & 1)) / 2, r: row };
  }

  offset(a) {
    if (this.type === 'square') return { col: a.q, row: a.r };
    const r = a.r;
    return { col: a.q + (r - (r & 1)) / 2, row: r };
  }

  /* ---------------- 邻域 ---------------- */

  /**
   * 获取邻域坐标（包含越界坐标），按 kind 指定的度量筛选
   * kind: vonNeumann | moore | hex | radius
   */
  neighborsRaw(c, kind = 'moore', radius = 1, includeSelf = false) {
    const r = Math.max(1, Math.floor(radius || 1));
    const out = [];
    if (includeSelf) out.push(c);
    if (this.type === 'square') {
      const useManhattan = kind === 'vonNeumann';
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (dx === 0 && dy === 0) continue;
          const dist = useManhattan ? Math.abs(dx) + Math.abs(dy) : Math.max(Math.abs(dx), Math.abs(dy));
          if (dist > r) continue;
          out.push({ col: c.col + dx, row: c.row + dy });
        }
      }
    } else {
      const a = this.axial(c);
      for (let dq = -r; dq <= r; dq++) {
        for (let dr = -r; dr <= r; dr++) {
          if (dq === 0 && dr === 0) continue;
          if (this.hexDistanceAxial({ q: dq, r: dr }, { q: 0, r: 0 }) > r) continue;
          out.push(this.offset({ q: a.q + dq, r: a.r + dr }));
        }
      }
    }
    return out;
  }

  /**
   * 获取邻域内（在界内）的坐标列表
   * kind: vonNeumann | moore | hex | radius
   */
  neighbors(c, kind = 'moore', radius = 1, includeSelf = false) {
    return this.neighborsRaw(c, kind, radius, includeSelf).filter((n) => this.inBounds(n));
  }

  /** 邻域中「理论存在」的格子数（含越界与中心，用于比例计算） */
  neighborhoodCapacity(kind = 'moore', radius = 1, includeSelf = false) {
    const r = Math.max(1, Math.floor(radius || 1));
    let count = 0;
    if (this.type === 'square') {
      const useManhattan = kind === 'vonNeumann';
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (dx === 0 && dy === 0) continue;
          const dist = useManhattan ? Math.abs(dx) + Math.abs(dy) : Math.max(Math.abs(dx), Math.abs(dy));
          if (dist <= r) count++;
        }
      }
    } else {
      for (let dq = -r; dq <= r; dq++) {
        for (let dr = -r; dr <= r; dr++) {
          if (this.hexDistanceAxial({ q: dq, r: dr }, { q: 0, r: 0 }) <= r) count++;
        }
      }
    }
    return count + (includeSelf ? 1 : 0);
  }

  /** 6/8 个「探索方向」的邻居（用于感知方向关系与图案匹配） */
  ringNeighbors(c) {
    const out = [];
    if (this.type === 'square') {
      for (const v of SQ_NEIGHBOR8) out.push({ col: c.col + v.dx, row: c.row + v.dy });
    } else {
      const a = this.axial(c);
      for (const v of HEX_DIR_VEC) out.push(this.offset({ q: a.q + v.q, r: a.r + v.r }));
    }
    return out.filter((n) => this.inBounds(n));
  }

  /** 相对方向邻居：relDir 为 relNameToOffset */
  relativeCoord(c, baseDir, relKey, distance = 1) {
    const n = this.dirCount;
    const d = ((baseDir % n) + n) % n;
    const map4 = { front: 0, right: 1, back: 2, left: 3 };
    const map6 = { front: 0, frontRight: 1, backRight: 2, back: 3, backLeft: 4, frontLeft: 5 };
    const map = this.type === 'hex' ? map6 : map4;
    const off = map[relKey];
    if (off === undefined) return null;
    let target = c;
    for (let i = 0; i < Math.max(1, distance); i++) target = this.step(target, (d + off) % n);
    return target;
  }

  /* ---------------- 方向关系 ---------------- */

  /** 返回 b 相对 a 的方向索引（不相邻返回 -1） */
  dirBetween(a, b) {
    if (this.type === 'square') {
      const dx = b.col - a.col;
      const dy = b.row - a.row;
      return SQ_DIR_VEC.findIndex((v) => v.dx === dx && v.dy === dy);
    }
    const aa = this.axial(a);
    const ab = this.axial(b);
    const dq = ab.q - aa.q;
    const dr = ab.r - aa.r;
    return HEX_DIR_VEC.findIndex((v) => v.q === dq && v.r === dr);
  }

  /** 相对方位：front / right / back / left（六边形含 frontRight 等） */
  relative(baseDir, dir) {
    const n = this.dirCount;
    const delta = (((dir - baseDir) % n) + n) % n;
    const names4 = ['front', 'right', 'back', 'left'];
    const names6 = ['front', 'frontRight', 'backRight', 'back', 'backLeft', 'frontLeft'];
    return (this.type === 'hex' ? names6 : names4)[delta];
  }

  /* ---------------- 距离 ---------------- */

  hexDistanceAxial(a, b) {
    const dq = a.q - b.q;
    const dr = a.r - b.r;
    return (Math.abs(dq) + Math.abs(dq + dr) + Math.abs(dr)) / 2;
  }

  distance(a, b, metric) {
    if (this.type === 'hex') {
      return this.hexDistanceAxial(this.axial(a), this.axial(b));
    }
    const dx = Math.abs(a.col - b.col);
    const dy = Math.abs(a.row - b.row);
    if (metric === 'manhattan') return dx + dy;
    if (metric === 'euclidean') return Math.hypot(dx, dy);
    return Math.max(dx, dy);
  }

  /* ---------------- 渲染辅助 ---------------- */

  /** 单元格中心像素坐标 */
  toPixel(c, cellSize, gap = 0) {
    if (this.type === 'square') {
      const pitch = cellSize + gap;
      return { x: c.col * pitch + cellSize / 2, y: c.row * pitch + cellSize / 2, radius: cellSize / 2 };
    }
    const R = cellSize / 2;
    const width = Math.sqrt(3) * R;
    return {
      x: width * (c.col + 0.5 * (c.row & 1)) + width / 2,
      y: 1.5 * R * c.row + R,
      radius: R,
      width,
    };
  }

  canvasSize(cellSize, gap = 0, margin = 12) {
    if (this.type === 'square') {
      const pitch = cellSize + gap;
      return {
        width: this.width * pitch - gap + margin * 2,
        height: this.height * pitch - gap + margin * 2,
        margin,
      };
    }
    const R = cellSize / 2;
    const width = Math.sqrt(3) * R;
    return {
      width: width * (this.width + 0.5) + margin * 2,
      height: R * (1.5 * (this.height - 1) + 2) + margin * 2,
      margin,
    };
  }

  /** 图案匹配的格子顺序：方格 3x3 行优先，六边形 [中心, 6 方向] */
  patternSlots(c) {
    if (this.type === 'square') {
      const out = [];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) out.push({ col: c.col + dx, row: c.row + dy });
      }
      return out;
    }
    return [{ ...c }, ...this.ringNeighbors(c)];
  }

  /** 图案模板长度 */
  patternLength() {
    return this.type === 'square' ? 9 : 7;
  }

  /** 曼哈顿/六边形半径内的所有格（含中心），用于显示与统计 */
  allCoords() {
    const out = [];
    for (let row = 0; row < this.height; row++) {
      for (let col = 0; col < this.width; col++) out.push({ col, row });
    }
    return out;
  }
}
