/**
 * 轨迹渲染管线基准（无依赖，纯 Node 运行）
 *
 *   node tools/bench-trail.mjs [--json]
 *
 * 场景：宽 90 × 高 60 的环绕边界网格，固定种子跑一段随机游走，
 * 轨迹跨缝频繁，正好压在最容易出问题的边界路径上。
 *
 * 测量三件事：
 *   1) trail   —— 每帧「取可见轨迹段 + 描边」的吞吐（帧/秒）
 *   2) build   —— 轨迹模型 + 连续段缓存的整体重建耗时（毫秒）
 *   3) wrap    —— 环绕最短位移（边界计算热路径）的吞吐（次/毫秒）
 *
 * 基准只依赖渲染器的公开流程（ensureTrailPix / trailRunsUpTo / drawTrail），
 * 改造前后可直接对比，用于验证边界轨迹修复与性能优化没有带来退化。
 */
import { defaultConfig, normalizeConfig } from '../src/core/config.js';
import { Simulation } from '../src/core/simulation.js';
import { buildTrail } from '../src/core/trail.js';
import { Renderer, STYLE_DEFAULTS } from '../src/ui/canvas.js';

/** 无副作用的假 2D 上下文：只保证渲染流程能跑完，不做任何记录（记录会掩盖性能差异） */
function nullCtx() {
  const noop = () => {};
  const ctx = {
    canvas: { width: 1, height: 1 },
    save: noop, restore: noop, beginPath: noop, closePath: noop, clip: noop,
    moveTo: noop, lineTo: noop, bezierCurveTo: noop, quadraticCurveTo: noop,
    arc: noop, ellipse: noop, rect: noop, roundRect: noop,
    stroke: noop, fill: noop, clearRect: noop, fillRect: noop, drawImage: noop,
    setTransform: noop, translate: noop, scale: noop, rotate: noop,
    createLinearGradient: () => ({ addColorStop: noop }),
    globalAlpha: 1, globalCompositeOperation: 'source-over',
  };
  return ctx;
}

function headlessRenderer(style = {}) {
  const r = Object.create(Renderer.prototype);
  r.ctx = nullCtx();
  r.canvas = { width: 1, height: 1, style: {} };
  r.style = { ...STYLE_DEFAULTS, ...style };
  r.body = null;
  r.result = null;
  r.trail = { path: [], order: [], info: new Map(), maxTick: 0 };
  r.trailInfo = r.trail.info;
  r.trailPix = null;
  r.trailRuns = [];
  r.pixDirty = true;
  r.filterSet = null;
  r.filterLayer = null;
  r.compare = null;
  r.compareLayer = null;
  r.collisionPoints = [];
  r.startCoord = null;
  r.endCoord = null;
  r.skinSrc = { head: '', body: '' };
  r.skinImg = { head: null, body: null };
  r.onSkinLoad = null;
  r.skinLayer = null;
  r._scratchA = { x: 0, y: 0 };
  r._scratchB = { x: 0, y: 0 };
  r._scratchC = { x: 0, y: 0 };
  return r;
}

function makeResult(steps) {
  const cfg = normalizeConfig({
    ...defaultConfig(),
    seed: 20260923,
    grid: { type: 'square', width: 90, height: 60, boundary: 'wrap' },
    start: { col: 45, row: 30, direction: 'right' },
    moveRules: { left: 1, straight: 1, right: 1 },
    endConditions: { ...defaultConfig().endConditions, maxSteps: steps, wall: false },
    style: { ...defaultConfig().style, cellSize: 18, gap: 2, trailJoin: 'line', trailFade: true, fadeLength: 120 },
  });
  return new Simulation(cfg, { frameCap: steps + 10 }).run();
}

function attach(r, result) {
  const t0 = performance.now();
  r.result = result;
  r.grid = result.grid;
  r.states = result.states;
  r.body = result.config.body;
  r.trail = buildTrail(result.grid, result.frames);
  r.trailInfo = r.trail.info;
  r.pixDirty = true;
  r.size = result.grid.canvasSize(r.style.cellSize, r.style.gap, Math.max(16, Math.round(r.style.cellSize * 0.9)));
  return performance.now() - t0;
}

function benchTrail(r, result, frames) {
  const th = r.theme();
  const total = result.frames.length;
  const idx = [];
  for (let i = 0; i < frames; i++) idx.push(Math.floor((i / frames) * (total - 1)));
  // 预热：让 JIT 与惰性缓存都进入稳态
  for (let i = 0; i < Math.min(120, idx.length); i++) {
    const f = result.frames[idx[i]];
    r.drawTrail(f, th, f.tick + 0.5);
  }
  const t0 = performance.now();
  for (const i of idx) {
    const f = result.frames[i];
    r.drawTrail(f, th, f.tick + 0.5);
  }
  const ms = performance.now() - t0;
  return { ms, fps: (idx.length / ms) * 1000 };
}

function benchWrap(grid, n) {
  const a = { col: 0, row: 0 };
  const b = { col: grid.width - 1, row: grid.height - 1 };
  for (let i = 0; i < 20000; i++) grid.wrapDelta(a, b);
  const t0 = performance.now();
  for (let i = 0; i < n; i++) grid.wrapDelta(a, b);
  const ms = performance.now() - t0;
  return { ms, perMs: n / ms };
}

const steps = Number(process.env.BENCH_STEPS || 2400);
const result = makeResult(steps);
const r = headlessRenderer({ cellSize: 18, gap: 2, trailFade: true, fadeLength: 120, trailJoin: 'line' });
const buildMs = attach(r, result);
const crossings = result.frames.filter((f) => (f.highlights || []).some((h) => h.type === 'wrap')).length;
const trail = benchTrail(r, result, 900);
const wrap = benchWrap(result.grid, 400000);

const out = {
  steps: result.summary.steps,
  pathPoints: r.trail.path.length,
  crossingFrames: crossings,
  buildMs: Number(buildMs.toFixed(2)),
  trailFps: Math.round(trail.fps),
  trailMsPerFrame: Number((trail.ms / 900).toFixed(4)),
  wrapCallsPerMs: Math.round(wrap.perMs),
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(out));
} else {
  console.log('轨迹渲染基准（90×60 环绕网格）');
  console.log(`  步数 ${out.steps} · 轨迹点 ${out.pathPoints} · 含穿越帧 ${out.crossingFrames}`);
  console.log(`  轨迹模型重建 ${out.buildMs} ms`);
  console.log(`  轨迹渲染 ${out.trailFps} 帧/秒（每帧 ${out.trailMsPerFrame} ms）`);
  console.log(`  边界解算 ${out.wrapCallsPerMs} 次/毫秒`);
}
