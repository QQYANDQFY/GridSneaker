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
};

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

  draw(frameIndex) {
    if (!this.result) return;
    const ctx = this.ctx;
    const s = this.style;
    const th = this.theme();
    const frame = this.result.frames[Math.max(0, Math.min(frameIndex, this.result.frames.length - 1))];
    if (!frame) return;

    ctx.save();
    ctx.clearRect(0, 0, this.size.width, this.size.height);
    ctx.fillStyle = th.bg;
    ctx.fillRect(0, 0, this.size.width, this.size.height);

    if (s.showGrid) this.drawGrid(th);
    this.drawCells(frame, th);
    if (s.showTrail) this.drawTrail(frame, th);
    if (s.highlightRules) this.drawHighlights(frame);
    if (s.showBody) this.drawAgents(frame);
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

  drawTrail(frame, th) {
    const ctx = this.ctx;
    const { cellSize, gap, trailFade } = this.style;
    const half = cellSize / 2 - gap / 2;
    const tick = frame.tick;
    const order = this.trailOrder;
    // 二分查找当前步之前已访问的格
    let lo = 0;
    let hi = order.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.trailInfo.get(order[mid]).first <= tick) lo = mid + 1;
      else hi = mid;
    }
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
    const colors = { wall: '#ff922b', collision: '#ff5d5d', turn: '#51cf66', cell: '#e5e9f0', spawn: '#c084fc' };
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

  drawAgents(frame) {
    const ctx = this.ctx;
    const cfgBody = this.body || this.result.config.body;
    const { cellSize } = this.style;
    const half = cellSize / 2;
    const scale = Math.max(0.1, Math.min(1.6, cfgBody?.segmentSize ?? 0.82));
    const colors = {
      head: frame.agents[0]?.color || cfgBody?.colors?.head || '#ff5d5d',
      tail: frame.agents[0]?.color || cfgBody?.colors?.tail || '#7a4dff',
      solid: frame.agents[0]?.color || cfgBody?.colors?.solid || '#ff5d5d',
    };
    const mode = cfgBody?.colorMode || 'gradient';
    const palette = (mode === 'custom' && Array.isArray(cfgBody?.colors?.custom)) ? cfgBody.colors.custom : null;
    const shape = cfgBody?.shape || 'round';

    for (let ai = frame.agents.length - 1; ai >= 0; ai--) {
      const a = frame.agents[ai];
      for (let i = a.segments.length - 1; i >= 0; i--) {
        const [col, row] = a.segments[i];
        const p = this.center({ col, row });
        const t = a.segments.length > 1 ? i / (a.segments.length - 1) : 0;
        const color = mode === 'solid'
          ? colors.solid
          : (palette && palette.length ? paletteColor(palette, t) : lerpColor(colors.head, colors.tail, t));
        const r = half * scale * (i === 0 ? 1 : 0.94);
        ctx.save();
        ctx.fillStyle = i === 0 ? colors.head : color;
        if (a.segments.length > 1) ctx.fillStyle = color;
        ctx.globalAlpha = a.alive ? 1 : 0.45;
        drawShape(ctx, p.x, p.y, r, this.grid.type, shape);
        ctx.fill();
        ctx.globalAlpha = 0.55;
        ctx.strokeStyle = 'rgba(0,0,0,0.35)';
        ctx.lineWidth = 1;
        drawShape(ctx, p.x, p.y, r, this.grid.type, shape);
        ctx.stroke();
        ctx.restore();
      }
      if (this.style.showArrows && a.segments.length) {
        this.drawArrow(a, cellSize);
      }
      if (a.segments.length) {
        const [hc, hr] = a.segments[0];
        const p = this.center({ col: hc, row: hr });
        ctx.save();
        ctx.fillStyle = 'rgba(255,255,255,0.92)';
        ctx.globalAlpha = 0.5;
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(1.2, half * 0.16), 0, Math.PI * 2);
        ctx.fill();
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
