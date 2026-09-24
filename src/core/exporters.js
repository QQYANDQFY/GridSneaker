/**
 * 导出能力：配置 JSON、轨迹 CSV/JSON、规则日志、SVG 矢量图、PNG 截图
 */
import { dirNames } from './grid.js';
import { buildTrail } from './trail.js';

export function toJSON(obj, pretty = true) {
  return JSON.stringify(obj, null, pretty ? 2 : 0);
}

export function configToJSON(cfg) {
  return toJSON(cfg, true);
}

/* --------------------------- 轨迹导出 --------------------------- */

export function trailToCSV(result) {
  const rows = [['step', 'headCol', 'headRow', 'direction', 'turn', 'length', 'collisions', 'coverage', 'ruleTriggers', 'segments']];
  for (const f of result.frames) {
    const a = f.agents[0];
    if (!a) continue;
    rows.push([
      f.tick,
      a.segments[0][0],
      a.segments[0][1],
      dirNames(result.grid.type)[a.dir] || a.dir,
      f.turn || '',
      a.length,
      f.stats.collisions,
      f.stats.coverage.toFixed(2),
      f.stats.ruleTriggers,
      a.segments.map((s) => `${s[0]}:${s[1]}`).join(';'),
    ]);
  }
  return rows.map((r) => r.join(',')).join('\n');
}

export function trailToJSON(result) {
  return toJSON({
    version: result.config.version,
    seed: result.seed,
    grid: result.config.grid,
    endReason: result.endReason,
    summary: result.summary,
    frames: result.frames.map((f) => ({
      tick: f.tick,
      turn: f.turn,
      agents: f.agents.map((a) => ({ id: a.id, dir: a.dir, alive: a.alive, segments: a.segments })),
      stats: f.stats,
    })),
  });
}

/* --------------------------- 规则日志 --------------------------- */

export function logsToCSV(result) {
  const rows = [['tick', 'ruleId', 'ruleName', 'subject', 'col', 'row', 'condition', 'actions', 'note']];
  for (const l of result.logs) {
    rows.push([
      l.tick,
      l.ruleId,
      csvCell(l.ruleName),
      l.subject,
      l.coord ? l.coord.col : '',
      l.coord ? l.coord.row : '',
      csvCell(l.condition),
      csvCell(l.actions),
      csvCell(l.skipped ? '概率未命中' : ''),
    ]);
  }
  return rows.map((r) => r.join(',')).join('\n');
}

export function logsToJSON(result) {
  return toJSON({ version: result.config.version, seed: result.seed, logs: result.logs });
}

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/* --------------------------- SVG 矢量图 --------------------------- */

const SVG_DEFAULT = {
  cellSize: 22,
  gap: 2,
  darkMode: true,
  showGrid: true,
  showCoords: false,
  showTrail: true,
  showStartEnd: true,
};

export function frameToSVG(result, frameIndex, styleOverride = {}) {
  const style = { ...SVG_DEFAULT, ...(result.config.style || {}), ...styleOverride };
  const grid = result.grid;
  const states = result.states;
  const frame = result.frames[Math.max(0, Math.min(frameIndex, result.frames.length - 1))];
  const size = grid.canvasSize(style.cellSize, style.gap, 16);
  const bg = style.darkMode ? '#0e1116' : '#f7f9fc';
  const fg = style.darkMode ? '#e6edf3' : '#1f2933';
  const gridLine = style.darkMode ? '#232b36' : '#d7dee7';

  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${size.width.toFixed(1)}" height="${size.height.toFixed(1)}" viewBox="0 0 ${size.width.toFixed(1)} ${size.height.toFixed(1)}" font-family="system-ui, sans-serif">`);
  parts.push(`<rect width="100%" height="100%" fill="${bg}"/>`);

  // 环境单元
  for (let row = 0; row < grid.height; row++) {
    for (let col = 0; col < grid.width; col++) {
      const index = grid.idx(col, row);
      const st = states[frame.cells[index]];
      const p = grid.toPixel({ col, row }, style.cellSize, style.gap, size.margin);
      const px = p.x + size.margin * 0;
      const cx = p.x;
      const cy = p.y;
      if (style.showGrid) {
        parts.push(cellShape(grid, style, cx, cy, gridLine, 'none', 1));
      }
      if (st && st.name !== 'empty' && st.color) {
        const opacity = st.render === 'dot' ? 0.95 : 1;
        parts.push(cellShape(grid, style, cx, cy, st.color, st.color, 1, opacity, st.render === 'dot' ? 0.45 : 1));
      }
    }
  }

  // 轨迹
  if (style.showTrail) {
    const visited = collectVisited(result, frameIndex);
    const total = Math.max(1, visited.length);
    visited.forEach((v, i) => {
      const p = grid.toPixel(grid.coord(v), style.cellSize, style.gap);
      const t = i / total;
      const color = lerpColor('#2b6cb0', '#63b3ed', t);
      parts.push(cellShape(grid, style, p.x, p.y, 'none', color, 1, 0.35, 1));
    });
  }

  // 移动体
  frame.agents.forEach((a) => {
    a.segments.forEach(([col, row], i) => {
      const p = grid.toPixel({ col, row }, style.cellSize, style.gap);
      const r = (style.cellSize / 2) * 0.78;
      const color = a.color || (i === 0 ? '#ff5d5d' : lerpColor('#ff5d5d', '#7a4dff', i / Math.max(1, a.segments.length - 1)));
      parts.push(cellShape(grid, style, p.x, p.y, color, color, 1, 1, i === 0 ? 1 : 0.9));
    });
  });

  // 起点 / 终点
  if (style.showStartEnd) {
    const first = result.frames[0].agents[0];
    if (first) {
      const p = grid.toPixel({ col: first.segments[0][0], row: first.segments[0][1] }, style.cellSize, style.gap);
      parts.push(`<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${(style.cellSize / 4).toFixed(1)}" fill="none" stroke="#51cf66" stroke-width="2"/>`);
    }
    const head = frame.agents[0] && frame.agents[0].segments[0];
    if (head) {
      const p = grid.toPixel({ col: head[0], row: head[1] }, style.cellSize, style.gap);
      parts.push(`<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${(style.cellSize / 4).toFixed(1)}" fill="none" stroke="#ffd43b" stroke-width="2"/>`);
    }
  }

  // 坐标标注
  if (style.showCoords) {
    parts.push(`<g fill="${fg}" font-size="${Math.max(8, style.cellSize * 0.34).toFixed(1)}" opacity="0.6">`);
    for (let col = 0; col < grid.width; col += Math.max(1, Math.round(60 / style.cellSize))) {
      const p = grid.toPixel({ col, row: 0 }, style.cellSize, style.gap);
      parts.push(`<text x="${p.x.toFixed(1)}" y="${(p.y - style.cellSize * 0.6).toFixed(1)}" text-anchor="middle">${col}</text>`);
    }
    for (let row = 0; row < grid.height; row += Math.max(1, Math.round(60 / style.cellSize))) {
      const p = grid.toPixel({ col: 0, row }, style.cellSize, style.gap);
      parts.push(`<text x="${(p.x - style.cellSize * 0.7).toFixed(1)}" y="${p.y.toFixed(1)}" text-anchor="middle">${row}</text>`);
    }
    parts.push('</g>');
  }

  parts.push(`<text x="${(size.width - size.margin).toFixed(1)}" y="${(size.margin * 0.9).toFixed(1)}" fill="${fg}" font-size="12" text-anchor="end" opacity="0.7">第 ${frame.tick} 步 · 种子 ${result.seed}</text>`);
  parts.push('</svg>');
  return parts.join('\n');
}

function cellShape(grid, style, cx, cy, stroke, fill, strokeWidth = 1, fillOpacity = 1, shape = 1) {
  const half = style.cellSize / 2 - style.gap / 2;
  const r = half * (typeof shape === 'number' ? 1 : 0.4);
  if (grid.type === 'hex') {
    const R = style.cellSize / 2 - style.gap / 2;
    const pts = [];
    for (let i = 0; i < 6; i++) {
      const ang = (Math.PI / 180) * (60 * i - 30);
      pts.push(`${(cx + R * Math.cos(ang)).toFixed(1)},${(cy + R * Math.sin(ang)).toFixed(1)}`);
    }
    return `<polygon points="${pts.join(' ')}" fill="${fill}" fill-opacity="${fillOpacity}" stroke="${stroke}" stroke-width="${strokeWidth}"/>`;
  }
  return `<rect x="${(cx - half).toFixed(1)}" y="${(cy - half).toFixed(1)}" width="${(half * 2).toFixed(1)}" height="${(half * 2).toFixed(1)}" rx="${(style.cellSize * 0.16).toFixed(1)}" fill="${fill}" fill-opacity="${fillOpacity}" stroke="${stroke}" stroke-width="${strokeWidth}"/>`;
}

function collectVisited(result, frameIndex) {
  const grid = result.grid;
  const seen = new Set();
  const order = [];
  const maxTick = result.frames[Math.max(0, Math.min(frameIndex, result.frames.length - 1))].tick;
  for (const f of result.frames) {
    if (f.tick > maxTick) break;
    for (const a of f.agents) {
      for (const [col, row] of a.segments) {
        const i = grid.idx(col, row);
        if (!seen.has(i)) { seen.add(i); order.push(i); }
      }
    }
  }
  return order;
}

function lerpColor(a, b, t) {
  const pa = [1, 3, 5].map((i) => parseInt(a.substr(i, 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.substr(i, 2), 16));
  const p = pa.map((v, i) => Math.round(v + (pb[i] - v) * t));
  return `#${p.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/* --------------------------- 纯轨迹 SVG --------------------------- */

/**
 * 纯轨迹 SVG：网格轮廓 + 按亮度渐隐的轨迹折线 + 起点/终点/头部标记。
 * 与 frameToSVG（连环境单元、日志标注一起画）不同，这里只输出轨迹本身，
 * 适合直接放进论文 / 设计稿，且是矢量、可无损缩放。
 *
 * 渐隐规则与画面渲染保持一致：按「离开头部的步数」衰减，
 * fadeMode = linear 线性 · exponential 指数，走满 fadeLength 步后完全淡出。
 */
export function trailToSVG(result, styleOverride = {}) {
  const style = { ...SVG_DEFAULT, ...(result.config.style || {}), ...styleOverride };
  const grid = result.grid;
  const size = grid.canvasSize(style.cellSize, style.gap, 16);
  const bg = style.darkMode ? '#0e1116' : '#f7f9fc';
  const fg = style.darkMode ? '#e6e1f3' : '#1f2933';
  const gridLine = style.darkMode ? '#232b36' : '#d7dee7';
  const trailA = style.darkMode ? '#1d4e89' : '#a9c8e8';
  const trailB = style.darkMode ? '#63b3ed' : '#2b6cb0';
  const trail = buildTrail(grid, result.frames);
  const spec = svgFadeSpec(style);
  const pitch = style.cellSize + style.gap;

  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${size.width.toFixed(1)}" height="${size.height.toFixed(1)}" viewBox="0 0 ${size.width.toFixed(1)} ${size.height.toFixed(1)}" font-family="system-ui, sans-serif">`);
  parts.push(`<rect width="100%" height="100%" fill="${bg}"/>`);

  if (style.showGrid) {
    for (let row = 0; row < grid.height; row++) {
      for (let col = 0; col < grid.width; col++) {
        const p = grid.toPixel({ col, row }, style.cellSize, style.gap);
        parts.push(cellShape(grid, style, p.x, p.y, gridLine, 'none', 1));
      }
    }
  }

  // 轨迹：按「步数连续 + 同一移动体 + 像素间距」切段，段内按亮度分档合并成 polyline
  const baseWidth = Math.max(1.5, (style.cellSize - style.gap) * 0.4);
  for (const run of svgTrailRuns(grid, trail.path, trail.maxTick, style, pitch)) {
    if (!run.length) continue;
    if (run.length === 1) {
      const st = svgFadeStyle(run[0].t, trailA, trailB, baseWidth);
      parts.push(`<circle cx="${run[0].x.toFixed(1)}" cy="${run[0].y.toFixed(1)}" r="${(baseWidth * 0.5).toFixed(1)}" fill="${st.color}" fill-opacity="${st.alpha.toFixed(3)}"/>`);
      continue;
    }
    let start = 0;
    let bucket = svgFadeBucket((run[0].t + run[1].t) / 2);
    for (let k = 1; k < run.length; k++) {
      const next = k + 1 < run.length ? svgFadeBucket((run[k].t + run[k + 1].t) / 2) : -1;
      if (next === bucket) continue;
      const st = svgFadeStyle((run[start].t + run[k].t) / 2, trailA, trailB, baseWidth);
      const pts = [];
      for (let j = start; j <= k; j++) pts.push(`${run[j].x.toFixed(1)},${run[j].y.toFixed(1)}`);
      parts.push(`<polyline points="${pts.join(' ')}" fill="none" stroke="${st.color}" stroke-width="${st.width.toFixed(2)}" stroke-opacity="${st.alpha.toFixed(3)}" stroke-linecap="round" stroke-linejoin="round"/>`);
      start = k;
      bucket = next;
    }
  }

  // 起点 / 终点 / 头部
  const first = result.frames[0] && result.frames[0].agents[0];
  const last = result.frames[result.frames.length - 1];
  const head = last && last.agents[0] && last.agents[0].segments[0];
  const r = style.cellSize / 4;
  if (first) {
    const p = grid.toPixel({ col: first.segments[0][0], row: first.segments[0][1] }, style.cellSize, style.gap);
    parts.push(`<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r.toFixed(1)}" fill="none" stroke="#51cf66" stroke-width="2"/>`);
  }
  if (head) {
    const p = grid.toPixel({ col: head[0], row: head[1] }, style.cellSize, style.gap);
    parts.push(`<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${(r * 0.8).toFixed(1)}" fill="#ffd43b" fill-opacity="0.9"/>`);
  }

  const fadeLabel = style.trailFade ? `渐隐 ${spec.mode === 'exponential' ? '指数' : '线性'} / ${spec.len} 步` : '轨迹不渐隐';
  parts.push(`<text x="${size.margin.toFixed(1)}" y="${(size.margin * 0.9).toFixed(1)}" fill="${fg}" font-size="12" opacity="0.7">轨迹 ${trail.order.length} 格 · 第 ${trail.maxTick} 步 · ${fadeLabel} · 种子 ${result.seed}</text>`);
  parts.push('</svg>');
  return parts.join('\n');
}

const SVG_FADE_BUCKETS = 16;
const SVG_EXP_K = 6;

function svgFadeSpec(style) {
  const len = Number.isFinite(style.fadeLength) ? Math.max(1, style.fadeLength) : 60;
  return { on: style.trailFade !== false, len, mode: style.fadeMode === 'exponential' ? 'exponential' : 'linear' };
}

function svgFadeProgress(age, spec) {
  const p = Math.max(0, Math.min(1, age / spec.len));
  if (spec.mode === 'exponential') {
    return (Math.exp(-SVG_EXP_K * p) - Math.exp(-SVG_EXP_K)) / (1 - Math.exp(-SVG_EXP_K));
  }
  return 1 - p;
}

function svgFadeBucket(t) {
  return Math.max(0, Math.min(SVG_FADE_BUCKETS - 1, Math.floor(Math.max(0, Math.min(1, t)) * SVG_FADE_BUCKETS)));
}

function svgFadeStyle(t, a, b, baseWidth) {
  const k = Math.max(0, Math.min(1, t));
  return {
    alpha: 0.62 * k,
    color: lerpColor(a, b, k),
    width: Math.max(0.5, baseWidth * (0.45 + 0.55 * k)),
  };
}

/** 轨迹路径 → 像素连续段（同一移动体、步数连续、像素间距不过大） */
function svgTrailRuns(grid, path, maxTick, style, pitch) {
  const spec = svgFadeSpec(style);
  const runs = [];
  let run = [];
  let prev = null;
  for (let i = 0; i < path.length; i++) {
    const p = path[i];
    const t = svgFadeProgress(maxTick - p.tick, spec);
    if (spec.on && t <= 0) {
      if (run.length) runs.push(run);
      run = [];
      prev = null;
      continue;
    }
    const px = grid.toPixel({ col: p.index % grid.width, row: Math.floor(p.index / grid.width) }, style.cellSize, style.gap);
    const brk = prev && (p.tick - prev.tick !== 1 || p.agent !== prev.agent
      || Math.hypot(px.x - prev.x, px.y - prev.y) > pitch * 1.7);
    if (brk && run.length) {
      runs.push(run);
      run = [];
    }
    run.push({ x: px.x, y: px.y, t: spec.on ? t : 1 });
    prev = { x: px.x, y: px.y, tick: p.tick, agent: p.agent };
  }
  if (run.length) runs.push(run);
  return runs;
}

/* --------------------------- 文件下载 --------------------------- */

export function downloadText(filename, text, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([text], { type: mime });
  downloadBlob(filename, blob);
}

export function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function downloadCanvasPNG(canvas, filename = 'screenshot.png') {
  canvas.toBlob((blob) => {
    if (blob) downloadBlob(filename, blob);
  }, 'image/png');
}

export function downloadSVG(svgText, filename = 'frame.svg') {
  downloadText(filename, svgText, 'image/svg+xml;charset=utf-8');
}
