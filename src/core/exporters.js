/**
 * 导出能力：配置 JSON、轨迹 CSV/JSON、规则日志、SVG 矢量图、PNG 截图
 */
import { dirNames } from './grid.js';

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
