/**
 * Canvas 渲染器
 * 只负责绘制：消费 Simulation.run() 输出的 frames，不参与任何模拟逻辑
 * 支持方格 / 六边形、轨迹渐变、方向箭头、障碍物与标记物、规则高亮、起点终点、坐标轴、暗黑模式
 */
import { dirNames } from '../core/grid.js';

export const STYLE_DEFAULTS = {
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
  /** 蛇头眼睛默认隐藏，仅在用户主动开启「展示样式 → 蛇头眼睛」时按朝向绘制 */
  showEyes: false,
  /** 融合 / 排斥 / 生成 / 标记物反馈等交互特效波纹 */
  showEffects: true,
  /** 蛇身发光，突出移动体位置 */
  glow: false,
  /** 轨迹用贝塞尔曲线平滑连接，形成连续顺畅的运动轨迹 */
  smoothTrail: true,
  /** 蛇身用曲线连接各体节节点，替代逐格拼接的生硬效果 */
  smoothBody: true,
};

/** 交互特效在画面上保留的步数（越近越亮，形成脉冲感） */
const EFFECT_LOOKBACK = 6;

/** 交互特效类型（由模拟层写入 frame.highlights） */
const EFFECT_TYPES = new Set(['merge', 'repel', 'spawn', 'markerEffect', 'agentDeath']);

const THEME = {
  dark: { bg: '#0e1116', gridLine: '#232b36', fg: '#e6edf3', axis: '#7d8b9c', trailA: '#1d4e89', trailB: '#63b3ed' },
  light: { bg: '#f7f9fc', gridLine: '#d7dee7', fg: '#1f2933', axis: '#8b98a8', trailA: '#a9c8e8', trailB: '#2b6cb0' },
};

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.result = null;
    this.style = { ...STYLE_DEFAULTS };
    this.body = null;
    this.hover = null;
    this.trailOrder = [];
    this.trailInfo = new Map();
    this.collisionPoints = [];
    this.startCoord = null;
    this.endCoord = null;
    this.size = { width: 0, height: 0, margin: 16 };
  }

  setResult(result) {
    this.result = result;
    this.grid = result.grid;
    this.states = result.states;
    this.body = result.config.body;
    this.prepare();
    this.resize();
  }

  /** style 为展示样式；body 为移动体外观（形状/尺寸/配色），传入后立即生效，无需重算 */
  setStyle(style, body) {
    this.style = { ...STYLE_DEFAULTS, ...(style || {}) };
    if (body) this.body = body;
    this.resize();
  }

  /** 预计算轨迹、碰撞点，避免每帧重复遍历 */
  prepare() {
    const grid = this.grid;
    this.trailOrder = [];
    this.trailInfo = new Map();
    this.collisionPoints = [];
    const frames = this.result.frames;

    for (const f of frames) {
      for (const a of f.agents) {
        for (const [col, row] of a.segments) {
          const i = grid.idx(col, row);
          let info = this.trailInfo.get(i);
          if (!info) {
            info = { first: f.tick, last: f.tick, visits: 0 };
            this.trailInfo.set(i, info);
            this.trailOrder.push(i);
          }
          info.last = f.tick;
          info.visits++;
        }
      }
      for (const [col, row] of f.collisions || []) {
        this.collisionPoints.push({ col, row, tick: f.tick });
      }
    }

    const firstFrame = frames[0];
    this.startCoord = firstFrame?.agents[0]?.segments?.[0] ? { col: firstFrame.agents[0].segments[0][0], row: firstFrame.agents[0].segments[0][1] } : null;
    const lastFrame = frames[frames.length - 1];
    this.endCoord = lastFrame?.agents[0]?.segments?.[0] ? { col: lastFrame.agents[0].segments[0][0], row: lastFrame.agents[0].segments[0][1] } : null;
  }

  resize() {
    if (!this.grid) return;
    const s = this.style;
    const margin = Math.max(16, Math.round(s.cellSize * 0.9));
    const size = this.grid.canvasSize(s.cellSize, s.gap, margin);
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    this.size = size;
    this.canvas.width = Math.max(1, Math.round(size.width * dpr));
    this.canvas.height = Math.max(1, Math.round(size.height * dpr));
    this.canvas.style.width = `${Math.round(size.width)}px`;
    this.canvas.style.height = `${Math.round(size.height)}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  theme() {
    return this.style.darkMode ? THEME.dark : THEME.light;
  }

  center(c) {
    const p = this.grid.toPixel(c, this.style.cellSize, this.style.gap);
    return { x: p.x + this.size.margin, y: p.y + this.size.margin };
  }

  /* ------------------------------------------------------------------ */

  /**
   * @param {number} frameIndex 帧下标（可为小数，用于帧间插值）
   * @param {number} alpha 帧间进度 [0,1)：0 表示正好停在该帧
   */
  draw(frameIndex, alpha = 0) {
    if (!this.result) return;
    const ctx = this.ctx;
    const s = this.style;
    const th = this.theme();
    const frames = this.result.frames;
    const i0 = Math.max(0, Math.min(frames.length - 1, Math.floor(frameIndex)));
    const frame = frames[i0];
    if (!frame) return;
    // 仅当相邻帧在时间轴上连续（步长 1）时才做插值；抽样缓存时按帧对齐，避免出现穿格直线
    const next = frames[i0 + 1];
    const t = next && next.tick - frame.tick === 1 ? Math.max(0, Math.min(0.999, alpha)) : 0;
    const tickF = frame.tick + (t > 0 && next ? next.tick - frame.tick : 0) * t;

    ctx.save();
    ctx.clearRect(0, 0, this.size.width, this.size.height);
    ctx.fillStyle = th.bg;
    ctx.fillRect(0, 0, this.size.width, this.size.height);

    if (s.showGrid) this.drawGrid(th);
    this.drawCells(frame, th);
    if (s.showTrail) this.drawTrail(frame, th, tickF);
    if (s.showEffects) this.drawEffects(i0);
    if (s.highlightRules) this.drawHighlights(frame);
    if (s.showBody) this.drawAgents(frame, t > 0 ? next : null, t);
    if (s.showStartEnd) this.drawStartEnd(frame);
    this.drawCollisions(frame);
    if (s.showCoords || s.axisLabels) this.drawAxis(th);
    if (this.hover) this.drawHover();
    ctx.restore();
  }

  drawGrid(th) {
    const ctx = this.ctx;
    const { cellSize, gap } = this.style;
    ctx.lineWidth = 1;
    ctx.strokeStyle = th.gridLine;
    for (const c of this.grid.allCoords()) {
      const p = this.center(c);
      if (this.grid.type === 'hex') {
        pathHex(ctx, p.x, p.y, cellSize / 2 - gap / 2);
      } else {
        const half = cellSize / 2 - gap / 2;
        roundRect(ctx, p.x - half, p.y - half, half * 2, half * 2, cellSize * 0.16);
      }
      ctx.stroke();
    }
  }

  drawCells(frame, th) {
    const ctx = this.ctx;
    const { cellSize, gap } = this.style;
    const s = this.style;
    const half = cellSize / 2 - gap / 2;
    for (let i = 0; i < frame.cells.length; i++) {
      const st = this.states[frame.cells[i]];
      if (!st || st.name === 'empty' || !st.color) continue;
      if (st.name === 'obstacle' && !s.showObstacles) continue;
      if (st.name === 'marker' && !s.showMarkers) continue;
      const c = this.grid.coord(i);
      const p = this.center(c);
      ctx.save();
      if (st.render === 'dot') {
        ctx.fillStyle = st.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, half * 0.52, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 0.35;
        ctx.strokeStyle = st.color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, half * 0.85, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        ctx.fillStyle = st.color;
        if (this.grid.type === 'hex') pathHex(ctx, p.x, p.y, half);
        else roundRect(ctx, p.x - half, p.y - half, half * 2, half * 2, cellSize * 0.16);
        ctx.fill();
        if (st.render === 'cross') {
          ctx.globalAlpha = 0.5;
          ctx.strokeStyle = th.darkMode ? '#0b0e12' : '#2b3440';
          ctx.lineWidth = Math.max(1, cellSize * 0.09);
          const k = half * 0.5;
          ctx.beginPath();
          ctx.moveTo(p.x - k, p.y - k);
          ctx.lineTo(p.x + k, p.y + k);
          ctx.moveTo(p.x + k, p.y - k);
          ctx.lineTo(p.x - k, p.y + k);
          ctx.stroke();
        }
      }
      ctx.restore();
    }
  }

  /**
   * 轨迹绘制：按行进顺序绘制访问过的格子。
   * 平滑模式下把所有格心用贝塞尔曲线串联成连续轨迹；关闭时退化为逐格色块。
   */
  drawTrail(frame, th, tickF) {
    const order = this.trailOrder;
    const tick = tickF === undefined ? frame.tick : tickF;
    // 二分查找当前步之前已访问的格
    let lo = 0;
    let hi = order.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.trailInfo.get(order[mid]).first <= tick) lo = mid + 1;
      else hi = mid;
    }
    if (this.style.smoothTrail) this.drawTrailCurve(th, lo, tick);
    else this.drawTrailCells(th, order, lo, frame.tick);
  }

  /** 轨迹平滑：把已访问格心按行进顺序用贝塞尔曲线串联，形成连续平滑的轨迹 */
  drawTrailCurve(th, lo, tick) {
    if (lo < 1) return;
    const ctx = this.ctx;
    const { cellSize, gap, trailFade } = this.style;
    const span = Math.max(1, tick);
    const pts = [];
    for (let k = 0; k < lo; k++) {
      const index = this.trailOrder[k];
      const info = this.trailInfo.get(index);
      const p = this.center(this.grid.coord(index));
      pts.push({ x: p.x, y: p.y, t: Math.max(0, Math.min(1, info ? info.first / span : 0)) });
    }
    const baseWidth = Math.max(1.5, (cellSize - gap) * 0.34);
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const run of splitRuns(pts, (cellSize + gap) * 1.7)) {
      if (run.length === 1) {
        ctx.globalAlpha = trailFade ? 0.16 + 0.38 * run[0].t : 0.34;
        ctx.fillStyle = trailFade ? lerpColor(th.trailA, th.trailB, run[0].t) : th.trailB;
        ctx.beginPath();
        ctx.arc(run[0].x, run[0].y, baseWidth * 0.5, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      const segs = bezierSegments(run);
      for (let k = 0; k < segs.length; k++) {
        const s = segs[k];
        const tt = (run[k].t + run[k + 1].t) / 2;
        ctx.globalAlpha = trailFade ? 0.16 + 0.38 * tt : 0.34;
        ctx.strokeStyle = trailFade ? lerpColor(th.trailA, th.trailB, tt) : th.trailB;
        ctx.lineWidth = baseWidth * (trailFade ? 0.7 + 0.5 * tt : 1);
        ctx.beginPath();
        ctx.moveTo(s.p0.x, s.p0.y);
        ctx.bezierCurveTo(s.c1.x, s.c1.y, s.c2.x, s.c2.y, s.p1.x, s.p1.y);
        ctx.stroke();
      }
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  /** 逐格色块轨迹（关闭「轨迹平滑曲线」时使用） */
  drawTrailCells(th, order, lo, tick) {
    const ctx = this.ctx;
    const { cellSize, gap, trailFade } = this.style;
    const half = cellSize / 2 - gap / 2;
    const span = Math.max(1, tick);
    for (let k = 0; k < lo; k++) {
      const index = order[k];
      const info = this.trailInfo.get(index);
      const c = this.grid.coord(index);
      const p = this.center(c);
      const t = info.first / span;
      ctx.globalAlpha = trailFade ? 0.16 + 0.34 * t : 0.34;
      ctx.fillStyle = trailFade ? lerpColor(th.trailA, th.trailB, t) : th.trailB;
      const r = half * 0.62;
      if (this.grid.type === 'hex') pathHex(ctx, p.x, p.y, r);
      else roundRect(ctx, p.x - r, p.y - r, r * 2, r * 2, cellSize * 0.14);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  drawHighlights(frame) {
    if (!frame.highlights || !frame.highlights.length) return;
    const ctx = this.ctx;
    const { cellSize } = this.style;
    const half = cellSize / 2;
    const colors = { wall: '#ff922b', collision: '#ff5d5d', turn: '#51cf66', cell: '#e5e9f0', spawn: '#c084fc', merge: '#c084fc', repel: '#ffd166', markerEffect: '#ffd166', agentDeath: '#ff5d5d' };
    for (const h of frame.highlights) {
      if (h.col === undefined || h.row === undefined) continue;
      const p = this.center({ col: h.col, row: h.row });
      const color = h.state ? (this.stateColor(h.state) || '#e5e9f0') : (colors[h.type] || '#e5e9f0');
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1.5, cellSize * 0.09);
      ctx.globalAlpha = 0.95;
      if (this.grid.type === 'hex') pathHex(ctx, p.x, p.y, half * 0.92);
      else roundRect(ctx, p.x - half * 0.92, p.y - half * 0.92, half * 1.84, half * 1.84, cellSize * 0.2);
      ctx.stroke();
      ctx.restore();
    }
  }

  /**
   * 蛇身绘制：
   *  1) 用相邻帧对体节位置做插值，得到亚步坐标，实现体节节点的流畅位移；
   *  2) 用贝塞尔曲线把相邻体节连成一条连续蛇身（带弧度的曲线连接，替代生硬的逐格拼接）。
   * 关闭「蛇身曲线连接」时退化为逐节圆/方块的拼接画法。
   */
  drawAgents(frame, nextFrame, alpha = 0) {
    const ctx = this.ctx;
    const cfgBody = this.body || this.result.config.body;
    const { cellSize, gap } = this.style;
    const half = cellSize / 2;
    const scale = Math.max(0.1, Math.min(1.6, cfgBody?.segmentSize ?? 0.82));
    const shape = cfgBody?.shape || 'round';

    for (let ai = frame.agents.length - 1; ai >= 0; ai--) {
      const a = frame.agents[ai];
      if (!a.segments.length) continue;
      const n = a.segments.length;
      const b = nextFrame ? nextFrame.agents.find((x) => x.id === a.id) : null;
      const pts = this.agentPoints(a, b, alpha);
      const colorAt = (i) => segmentColor(a, i, n, cfgBody);
      const radius = half * scale;

      if (this.style.smoothBody && pts.length > 1) {
        this.strokeRibbon(a, pts, colorAt, radius, cfgBody);
      } else {
        for (let i = n - 1; i >= 0; i--) {
          const p = pts[i];
          const r = radius * (i === 0 ? 1 : 0.94);
          ctx.save();
          ctx.fillStyle = colorAt(i);
          if (this.style.glow) {
            ctx.shadowColor = i === 0 ? (a.color || cfgBody?.colors?.head || '#ff5d5d') : colorAt(i);
            ctx.shadowBlur = cellSize * (i === 0 ? 0.9 : 0.5);
          }
          ctx.globalAlpha = a.alive ? 1 : 0.45;
          drawShape(ctx, p.x, p.y, r, this.grid.type, shape);
          ctx.fill();
          ctx.shadowBlur = 0;
          ctx.globalAlpha = 0.55;
          ctx.strokeStyle = 'rgba(0,0,0,0.35)';
          ctx.lineWidth = 1;
          drawShape(ctx, p.x, p.y, r, this.grid.type, shape);
          ctx.stroke();
          ctx.restore();
        }
      }
      if (this.style.showArrows) this.drawArrow(a, cellSize);
      const head = pts[0];
      if (this.style.showEyes) {
        this.drawEyes(head, this.headAngle(a, b, alpha), radius);
      } else {
        ctx.save();
        ctx.fillStyle = 'rgba(255,255,255,0.92)';
        ctx.globalAlpha = 0.5;
        ctx.beginPath();
        ctx.arc(head.x, head.y, Math.max(1.2, radius * 0.22), 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }
  }

  /** 体节中心坐标：b 为下一帧的同一移动体，alpha ∈ [0,1) 为帧间进度 */
  agentPoints(a, b, alpha) {
    const pts = [];
    const segsA = a.segments;
    const segsB = b && b.segments.length ? b.segments : null;
    for (let i = 0; i < segsA.length; i++) {
      const pa = this.center({ col: segsA[i][0], row: segsA[i][1] });
      let x = pa.x;
      let y = pa.y;
      if (segsB && alpha > 0) {
        const s = segsB[Math.min(i, segsB.length - 1)];
        const pb = this.center({ col: s[0], row: s[1] });
        x += (pb.x - x) * alpha;
        y += (pb.y - y) * alpha;
      }
      pts.push({ x, y, gi: i });
    }
    return pts;
  }

  /** 蛇头朝向角：播放时取真实位移方向，静止时取当前朝向的前方格方向 */
  headAngle(a, b, alpha) {
    const from = this.center({ col: a.segments[0][0], row: a.segments[0][1] });
    let to = null;
    if (b && b.segments.length && alpha > 0) {
      const h = this.center({ col: b.segments[0][0], row: b.segments[0][1] });
      if (Math.abs(h.x - from.x) > 0.01 || Math.abs(h.y - from.y) > 0.01) to = h;
    }
    if (!to) {
      const nxt = this.grid.step({ col: a.segments[0][0], row: a.segments[0][1] }, a.dir);
      const raw = this.grid.toPixel(nxt, this.style.cellSize, this.style.gap);
      to = { x: raw.x + this.size.margin, y: raw.y + this.size.margin };
    }
    return Math.atan2(to.y - from.y, to.x - from.x);
  }

  /** 指定移动体在指定帧的蛇头像素坐标（供「跟随移动体」滚动定位，坐标不含容器边距） */
  agentHeadPixel(frameIndex, agentIndex = 0) {
    if (!this.result) return null;
    const frames = this.result.frames;
    const f = frames[Math.max(0, Math.min(frames.length - 1, Math.round(frameIndex)))];
    const a = f?.agents?.[agentIndex];
    if (!a || !a.segments?.length) return null;
    return this.center({ col: a.segments[0][0], row: a.segments[0][1] });
  }

  /** 把插值后的体节中心连成一条平滑曲线带状蛇身 */
  strokeRibbon(a, pts, colorAt, radius, cfgBody) {
    const ctx = this.ctx;
    const { cellSize, gap } = this.style;
    const headColor = a.color || cfgBody?.colors?.head || '#ff5d5d';
    const alpha = a.alive ? 1 : 0.45;
    const last = Math.max(1, pts.length - 1);
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const run of splitRuns(pts, (cellSize + gap) * 1.7)) {
      if (run.length === 1) {
        ctx.globalAlpha = alpha;
        ctx.fillStyle = colorAt(run[0].gi);
        ctx.beginPath();
        ctx.arc(run[0].x, run[0].y, radius, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      const segs = bezierSegments(run);
      // 第一遍：深色轮廓，保证蛇身在任意背景上都清晰
      ctx.globalAlpha = alpha * 0.45;
      ctx.strokeStyle = 'rgba(0,0,0,0.4)';
      for (let k = 0; k < segs.length; k++) {
        ctx.lineWidth = Math.max(2, radius * 2 * (1 - 0.16 * (run[k].gi / last)) + 2);
        traceBezier(ctx, segs[k]);
        ctx.stroke();
      }
      // 第二遍：按体节配色描边，头粗尾细
      ctx.globalAlpha = alpha;
      for (let k = 0; k < segs.length; k++) {
        const gi = run[k].gi;
        const t = gi / last;
        ctx.strokeStyle = colorAt(gi);
        ctx.lineWidth = Math.max(1.5, radius * 2 * (1 - 0.16 * t));
        if (this.style.glow) {
          ctx.shadowColor = gi === 0 ? headColor : colorAt(gi);
          ctx.shadowBlur = cellSize * (gi === 0 ? 0.8 : 0.45);
        } else {
          ctx.shadowBlur = 0;
        }
        traceBezier(ctx, segs[k]);
        ctx.stroke();
      }
    }
    ctx.shadowBlur = 0;
    ctx.restore();
  }

  /** 蛇头双眼：ang 为前进方向角，双眼沿前进方向前移并左右分布 */
  drawEyes(p, ang, r) {
    const ctx = this.ctx;
    const fx = Math.cos(ang);
    const fy = Math.sin(ang);
    const px = -fy;
    const py = fx;
    const forward = r * 0.34;
    const side = r * 0.38;
    const eyeR = Math.max(1, r * 0.24);
    const cx = p.x + fx * forward;
    const cy = p.y + fy * forward;
    ctx.save();
    // 眼白 + 深色瞳孔，形成明确的朝向提示
    for (const s of [-1, 1]) {
      const ex = cx + px * side * s;
      const ey = cy + py * side * s;
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      ctx.beginPath();
      ctx.arc(ex, ey, eyeR, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(20,24,30,0.9)';
      ctx.beginPath();
      ctx.arc(ex + fx * eyeR * 0.35, ey + fy * eyeR * 0.35, eyeR * 0.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /**
   * 交互特效：把最近若干步内的融合 / 排斥 / 生成 / 标记物反馈绘制为渐隐波纹，
   * 让多蛇交互与标记物反馈在画面上有明确的视觉反馈。
   */
  drawEffects(frameIndex) {
    const frames = this.result.frames;
    const start = Math.max(0, frameIndex - EFFECT_LOOKBACK);
    const ctx = this.ctx;
    const { cellSize } = this.style;
    const half = cellSize / 2;
    const colors = { merge: '#c084fc', repel: '#ffd166', spawn: '#63e6be', markerEffect: '#ffd166', agentDeath: '#ff5d5d' };
    for (let fi = start; fi <= frameIndex; fi++) {
      const f = frames[fi];
      if (!f || !f.highlights) continue;
      const age = frameIndex - fi;
      const t = 1 - age / (EFFECT_LOOKBACK + 1);
      for (const h of f.highlights) {
        if (!EFFECT_TYPES.has(h.type)) continue;
        if (h.col === undefined || h.row === undefined) continue;
        const p = this.center({ col: h.col, row: h.row });
        const color = h.color || (h.state ? (this.stateColor(h.state) || colors[h.type]) : colors[h.type]) || '#e5e9f0';
        ctx.save();
        ctx.globalAlpha = 0.15 + 0.6 * t;
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(1.5, cellSize * 0.08);
        const grow = half * (0.55 + 0.6 * (1 - t));
        if (this.grid.type === 'hex') pathHex(ctx, p.x, p.y, grow);
        else roundRect(ctx, p.x - grow, p.y - grow, grow * 2, grow * 2, cellSize * 0.22);
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  drawArrow(a, cellSize) {
    const ctx = this.ctx;
    const [hc, hr] = a.segments[0];
    const p1 = this.center({ col: hc, row: hr });
    const nxt = this.grid.step({ col: hc, row: hr }, a.dir);
    const raw = this.grid.toPixel(nxt, cellSize, this.style.gap);
    const p2 = { x: raw.x + this.size.margin, y: raw.y + this.size.margin };
    const ang = Math.atan2(p2.y - p1.y, p2.x - p1.x);
    const r = (cellSize / 2) * 0.62;
    ctx.save();
    ctx.translate(p1.x + Math.cos(ang) * r * 0.55, p1.y + Math.sin(ang) * r * 0.55);
    ctx.rotate(ang);
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(r * 0.55, 0);
    ctx.lineTo(-r * 0.28, r * 0.4);
    ctx.lineTo(-r * 0.28, -r * 0.4);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  drawStartEnd(frame) {
    const ctx = this.ctx;
    const { cellSize } = this.style;
    const r = cellSize * 0.42;
    if (this.startCoord) {
      const p = this.center(this.startCoord);
      ctx.save();
      ctx.strokeStyle = '#51cf66';
      ctx.lineWidth = Math.max(1.5, cellSize * 0.1);
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    const isEnd = frame.tick === this.result.frames[this.result.frames.length - 1].tick;
    if (isEnd && this.result.endReason && this.endCoord) {
      const p = this.center(this.endCoord);
      ctx.save();
      ctx.strokeStyle = '#ffd43b';
      ctx.lineWidth = Math.max(1.5, cellSize * 0.1);
      ctx.setLineDash([cellSize * 0.2, cellSize * 0.16]);
      ctx.beginPath();
      ctx.arc(p.x, p.y, r * 1.2, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  drawCollisions(frame) {
    const ctx = this.ctx;
    const { cellSize } = this.style;
    const r = cellSize * 0.16;
    const seen = new Set();
    for (const cp of this.collisionPoints) {
      if (cp.tick > frame.tick) break;
      const key = `${cp.col}:${cp.row}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const p = this.center(cp);
      ctx.save();
      ctx.fillStyle = '#ff5d5d';
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(1.5, r), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  drawAxis(th) {
    const ctx = this.ctx;
    const s = this.style;
    const step = Math.max(1, Math.round(56 / s.cellSize));
    const font = Math.max(9, Math.round(s.cellSize * 0.34));
    ctx.save();
    ctx.fillStyle = th.axis;
    ctx.font = `${font}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let col = 0; col < this.grid.width; col += step) {
      const p = this.center({ col, row: 0 });
      if (this.grid.type === 'square') ctx.fillText(String(col), p.x, p.y - s.cellSize * 0.85);
      else ctx.fillText(String(col), p.x, p.y - s.cellSize * 0.75);
    }
    ctx.textAlign = 'right';
    for (let row = 0; row < this.grid.height; row += step) {
      const p = this.center({ col: 0, row });
      ctx.fillText(String(row), p.x - s.cellSize * 0.75, p.y);
    }
    ctx.restore();
  }

  drawHover() {
    const ctx = this.ctx;
    const { cellSize } = this.style;
    const p = this.center(this.hover);
    ctx.save();
    ctx.strokeStyle = '#4dabf7';
    ctx.lineWidth = 1.5;
    const half = cellSize / 2;
    if (this.grid.type === 'hex') pathHex(ctx, p.x, p.y, half * 0.9);
    else roundRect(ctx, p.x - half * 0.9, p.y - half * 0.9, half * 1.8, half * 1.8, cellSize * 0.2);
    ctx.stroke();
    ctx.restore();
  }

  stateColor(name) {
    const st = this.states.find((s) => s.name === name);
    return st ? st.color : null;
  }

  /* 坐标反查（用于鼠标悬停） */
  hitTest(clientX, clientY) {
    if (!this.grid) return null;
    const rect = this.canvas.getBoundingClientRect();
    const x = clientX - rect.left - this.size.margin;
    const y = clientY - rect.top - this.size.margin;
    const { cellSize, gap } = this.style;
    if (this.grid.type === 'square') {
      const pitch = cellSize + gap;
      const col = Math.floor(x / pitch);
      const row = Math.floor(y / pitch);
      const c = { col, row };
      return this.grid.inBounds(c) ? c : null;
    }
    const R = cellSize / 2;
    const w = Math.sqrt(3) * R;
    const approxRow = Math.floor(y / (1.5 * R));
    let best = null;
    let bestD = Infinity;
    for (let row = approxRow - 1; row <= approxRow + 1; row++) {
      const col = Math.round((x - w * 0.5 - w * 0.5 * (row & 1)) / w);
      for (const cand of [{ col, row }, { col: col - 1, row }, { col: col + 1, row }]) {
        if (!this.grid.inBounds(cand)) continue;
        const p = this.grid.toPixel(cand, cellSize, gap);
        const d = Math.hypot(p.x - x, p.y - y);
        if (d < bestD) { bestD = d; best = cand; }
      }
    }
    return best;
  }

  /** 当前帧的完整信息文本（用于悬停提示） */
  describe(frameIndex, coord) {
    const frame = this.result.frames[Math.max(0, Math.min(frameIndex, this.result.frames.length - 1))];
    if (!frame) return '';
    const lines = [`坐标 (${coord.col}, ${coord.row})`];
    const index = this.grid.idx(coord.col, coord.row);
    const st = this.states[frame.cells[index]];
    lines.push(`环境：${st ? st.name : '空'}`);
    for (const a of frame.agents) {
      const i = a.segments.findIndex(([c, r]) => c === coord.col && r === coord.row);
      if (i === 0) lines.push(`${a.label}：蛇头（方向 ${dirNames(this.grid.type)[a.dir]}）`);
      else if (i > 0) lines.push(`${a.label}：第 ${i} 节`);
    }
    const info = this.trailInfo.get(index);
    if (info) lines.push(`轨迹：首次第 ${info.first} 步，末次第 ${info.last} 步，共 ${info.visits} 次`);
    return lines.join('\n');
  }
}

/* ------------------------------ 绘制工具 ------------------------------ */

function drawShape(ctx, x, y, r, gridType, shape) {
  if (gridType === 'hex') {
    pathHex(ctx, x, y, r);
    return;
  }
  if (shape === 'square') {
    ctx.beginPath();
    ctx.rect(x - r, y - r, r * 2, r * 2);
    return;
  }
  if (shape === 'hexagon') {
    pathHex(ctx, x, y, r);
    return;
  }
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
}

function pathHex(ctx, x, y, r) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const ang = (Math.PI / 180) * (60 * i - 30);
    const px = x + r * Math.cos(ang);
    const py = y + r * Math.sin(ang);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

function roundRect(ctx, x, y, w, hh, r) {
  const rr = Math.min(r, w / 2, hh / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + hh - rr);
  ctx.quadraticCurveTo(x + w, y + hh, x + w - rr, y + hh);
  ctx.lineTo(x + rr, y + hh);
  ctx.quadraticCurveTo(x, y + hh, x, y + hh - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

export function lerpColor(a, b, t) {
  const pa = hexToRgb(a);
  const pb = hexToRgb(b);
  const k = Math.max(0, Math.min(1, t));
  const p = pa.map((v, i) => Math.round(v + (pb[i] - v) * k));
  return `rgb(${p[0]}, ${p[1]}, ${p[2]})`;
}

/** 按比例压暗颜色（t=0 原色，t=1 全黑） */
export function shadeColor(hex, t) {
  const p = hexToRgb(hex).map((v) => Math.round(v * (1 - Math.max(0, Math.min(1, t)))));
  return `rgb(${p[0]}, ${p[1]}, ${p[2]})`;
}

/** 多色色带取色：stops 为颜色序列，t ∈ [0,1] 表示在色带上的位置 */
export function paletteColor(stops, t) {
  if (!stops || !stops.length) return '#8899aa';
  if (stops.length === 1) return stops[0];
  const k = Math.max(0, Math.min(1, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(k));
  return lerpColor(stops[i], stops[i + 1], k - i);
}

function hexToRgb(hex) {
  const s = String(hex || '#888888').replace('#', '');
  const full = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
  return [0, 2, 4].map((i) => parseInt(full.substr(i, 2), 16) || 0);
}

/** 体节配色：逐个体配色优先，其次按配置的配色模式（渐变 / 单色 / 自定义多色） */
function segmentColor(a, i, n, cfgBody) {
  const own = a.color || null;
  const headColor = own || cfgBody?.colors?.head || '#ff5d5d';
  const tailColor = own || cfgBody?.colors?.tail || '#7a4dff';
  const solidColor = own || cfgBody?.colors?.solid || '#ff5d5d';
  const mode = cfgBody?.colorMode || 'gradient';
  const t = n > 1 ? i / (n - 1) : 0;
  if (own) {
    // 独立配色：单色 → 深色尾端渐变，便于区分不同个体
    return mode === 'solid' ? solidColor : lerpColor(headColor, shadeColor(headColor, 0.45), t);
  }
  if (mode === 'solid') return solidColor;
  const palette = (mode === 'custom' && Array.isArray(cfgBody?.colors?.custom)) ? cfgBody.colors.custom : null;
  return (palette && palette.length) ? paletteColor(palette, t) : lerpColor(headColor, tailColor, t);
}

/**
 * Catmull-Rom → 三次贝塞尔：把点列转成逐段贝塞尔控制点，
 * 使折线变成经过每个节点的平滑曲线（逐段返回，便于按段着色与断点切分）。
 */
function bezierSegments(pts) {
  const segs = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    segs.push({
      p0: p1,
      c1: { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 },
      c2: { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 },
      p1: p2,
    });
  }
  return segs;
}

function traceBezier(ctx, s) {
  ctx.beginPath();
  ctx.moveTo(s.p0.x, s.p0.y);
  ctx.bezierCurveTo(s.c1.x, s.c1.y, s.c2.x, s.c2.y, s.p1.x, s.p1.y);
}

/** 把点列按「相邻点距离 ≤ maxDist」切成若干连续段，避免在断点（如穿越边界）之间画出跨图直线 */
function splitRuns(pts, maxDist) {
  const runs = [];
  let cur = [];
  for (const p of pts) {
    const prev = cur[cur.length - 1];
    if (prev && Math.hypot(p.x - prev.x, p.y - prev.y) > maxDist) {
      runs.push(cur);
      cur = [];
    }
    cur.push(p);
  }
  if (cur.length) runs.push(cur);
  return runs;
}
