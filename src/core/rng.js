/**
 * 可复现伪随机数生成器（mulberry32）
 * 相同种子 + 相同调用顺序 = 完全相同结果
 */

export function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export class RNG {
  constructor(seed = 12345) {
    this.setSeed(seed);
  }

  setSeed(seed) {
    if (typeof seed === 'string') seed = hashString(seed);
    if (!Number.isFinite(seed)) seed = 12345;
    this.seed = (Math.floor(Math.abs(seed)) % 4294967295) || 1;
    this.state = this.seed >>> 0;
    this.calls = 0;
  }

  /** 返回 [0,1) */
  next() {
    this.calls++;
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** 返回 [0, n) 的整数 */
  int(n) {
    if (n <= 0) return 0;
    return Math.floor(this.next() * n) % n;
  }

  /** 返回 [min, max] 的整数 */
  intRange(min, max) {
    if (max < min) return min;
    return min + this.int(max - min + 1);
  }

  float(min = 0, max = 1) {
    return min + this.next() * (max - min);
  }

  bool(probability = 0.5) {
    return this.next() < probability;
  }

  pick(arr) {
    if (!arr || arr.length === 0) return undefined;
    return arr[this.int(arr.length)];
  }

  /**
   * 按权重挑选：items 为 [{weight, ...}] 或 [w1, w2, ...]
   * 返回 { item, index, weights(归一化) }
   */
  weighted(items, weightOf = (it) => (typeof it === 'number' ? it : it.weight)) {
    const weights = [];
    let total = 0;
    for (const it of items) {
      const w = Math.max(0, Number(weightOf(it)) || 0);
      weights.push(w);
      total += w;
    }
    if (total <= 0) {
      // 全部为 0 时退化为均匀分布
      const idx = this.int(items.length);
      return { item: items[idx], index: idx, weights: weights.map(() => 1 / items.length) };
    }
    let r = this.next() * total;
    for (let i = 0; i < items.length; i++) {
      r -= weights[i];
      if (r < 0) {
        return { item: items[i], index: i, weights: weights.map((w) => w / total) };
      }
    }
    const last = items.length - 1;
    return { item: items[last], index: last, weights: weights.map((w) => w / total) };
  }

  /** 洗牌（原地） */
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  /** 复制当前状态，用于分支 */
  fork() {
    const r = new RNG(1);
    r.seed = this.seed;
    r.state = this.state;
    r.calls = this.calls;
    return r;
  }
}

/** 归一化权重数组，返回和为 1 的数组（全 0 时均匀分布） */
export function normalizeWeights(weights) {
  const ws = weights.map((w) => Math.max(0, Number(w) || 0));
  const total = ws.reduce((a, b) => a + b, 0);
  if (total <= 0) return ws.map(() => 1 / ws.length);
  return ws.map((w) => w / total);
}
