/**
 * 核心引擎冒烟测试（Node 环境，无外部依赖）
 * 运行：node tests/core.test.mjs
 */
import { readFileSync } from 'node:fs';
import { RNG, normalizeWeights } from '../src/core/rng.js';
import { Grid, parseDir } from '../src/core/grid.js';
import { Simulation, DEFAULT_FRAME_CAP, MAX_FRAME_CAP, MAX_STORED_FRAMES } from '../src/core/simulation.js';
import {
  normalizeConfig, defaultConfig, defaultRule, validateConfig, encodeConfigToToken, decodeConfigFromToken, diagnoseConfig,
  buildShareUrl, isBodyEnabled, isSkinImage, stripSkinAssets,
  JOIN_MODES, FADE_MODES, FADE_LENGTH_LIMIT, END_PRIORITY_DEFAULT, END_LABELS,
  LIFE_MIN, LIFE_MAX, TRAIL_COLOR_MODES,
} from '../src/core/config.js';
import {
  buildTrail, unwrapTrail, defaultTrailQuery, normalizeTrailQuery, queryTrail, trailQueryActive,
  trailQueryLabel, trailCellsToCSV, trailCellsToText,
  trailQueryBounds, validateTrailQuery, reconcileTrailQuery, sliceTrailUpToTick, TRAIL_RANGE_FIELDS,
  snapshotTrail, snapshotMatchesGrid, compareSnapshots, compareToCSV, compareToText,
} from '../src/core/trail.js';
import { trailToSVG } from '../src/core/exporters.js';
import { World, Agent } from '../src/core/world.js';
import { evaluateClause, describeClause } from '../src/core/conditions.js';
import { applyAction, ACTION_LABELS } from '../src/core/actions.js';
import { PRESETS, buildPresetConfig } from '../src/core/presets.js';
import { computeScore, formatScore, gradeFor } from '../src/core/score.js';
import { diffConfigs, summarizeConfigChanges, describeConfigValue } from '../src/core/config-diff.js';
import { crowdingOf, difficultyOf, adaptiveSpeedScale } from '../src/core/difficulty.js';
import { Renderer, STYLE_DEFAULTS } from '../src/ui/canvas.js';

let pass = 0;
let fail = 0;
const failures = [];

function ok(cond, name, extra = '') {
  if (cond) { pass++; } else { fail++; failures.push(`${name} ${extra}`); }
}
function eq(a, b, name) {
  ok(a === b, name, `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
}
function near(a, b, eps, name) {
  ok(Math.abs(a - b) <= eps, name, `期望 ≈${b}，实际 ${a}`);
}
function section(t) { console.log(`\n── ${t}`); }

/** 深合并补丁到目标对象（原地修改，与界面「一键修复」使用同样的语义） */
function applyPatch(target, patch) {
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if (!target[k] || typeof target[k] !== 'object') target[k] = {};
      applyPatch(target[k], v);
    } else {
      target[k] = v;
    }
  }
  return target;
}

/* ---------- RNG ---------- */
section('随机数与权重');
{
  const a = new RNG(42);
  const b = new RNG(42);
  const seqA = [a.next(), a.next(), a.next()];
  const seqB = [b.next(), b.next(), b.next()];
  ok(seqA.every((v, i) => v === seqB[i]), '相同种子产生相同序列');
  const c = new RNG(43);
  ok(c.next() !== seqA[0], '不同种子产生不同序列');
  const w = normalizeWeights([1, 2, 1]);
  near(w.reduce((x, y) => x + y, 0), 1, 1e-9, '权重归一化和为 1');
  near(w[1], 0.5, 1e-9, '权重比例正确');
  const z = normalizeWeights([0, 0, 0]);
  near(z[0], 1 / 3, 1e-9, '全 0 权重退化为均匀');
  const rng = new RNG(7);
  let sum = 0;
  for (let i = 0; i < 1000; i++) sum += rng.next();
  ok(sum / 1000 > 0.45 && sum / 1000 < 0.55, '随机数分布均匀');
}

/* ---------- 方格网格 ---------- */
section('方格网格');
{
  const g = new Grid({ type: 'square', width: 5, height: 5 });
  const p = { col: 2, row: 2 };
  eq(g.dirCount, 4, '方格有 4 个移动方向');
  eq(g.step(p, parseDir('up', 'square')).row, 1, '向上移动 row-1');
  eq(g.step(p, parseDir('right', 'square')).col, 3, '向右移动 col+1');
  ok(g.inBounds({ col: 4, row: 4 }), '界内判定');
  ok(!g.inBounds({ col: 5, row: 4 }), '越界判定');
  eq(g.neighbors(p, 'vonNeumann', 1).length, 4, '4 邻域数量');
  eq(g.neighbors(p, 'moore', 1).length, 8, '8 邻域数量');
  eq(g.neighbors({ col: 0, row: 0 }, 'moore', 1).length, 3, '角落 8 邻域只有 3 格');
  eq(g.dirBetween({ col: 1, row: 1 }, { col: 2, row: 1 }), parseDir('right', 'square'), '方向识别：右');
  eq(g.dirBetween({ col: 1, row: 1 }, { col: 2, row: 0 }), -1, '斜向不属于 4 移动方向');
  eq(g.relative(0, 1), 'right', '相对方向：右');
  eq(g.relative(0, 3), 'left', '相对方向：左');
  eq(g.distance({ col: 0, row: 0 }, { col: 2, row: 2 }), 2, '切比雪夫距离');
  const wrapped = g.wrap({ col: 5, row: -1 });
  eq(wrapped.col, 0, '循环边界 col');
  eq(wrapped.row, 4, '循环边界 row');
  eq(g.patternSlots(p).length, 9, '方格图案为 3x3');
}

/* ---------- 六边形网格 ---------- */
section('六边形网格');
{
  const g = new Grid({ type: 'hex', width: 7, height: 7 });
  eq(g.dirCount, 6, '六边形有 6 个移动方向');
  const p = { col: 3, row: 3 };
  eq(g.neighbors(p, 'hex', 1).length, 6, '6 邻域数量');
  const a = g.axial(p);
  const back = g.offset(a);
  ok(back.col === p.col && back.row === p.row, '轴向坐标往返一致');
  // 走 6 步回到原点
  let cur = { ...p };
  for (let d = 0; d < 6; d++) cur = g.step(cur, d);
  ok(cur.col === p.col && cur.row === p.row, '六个方向各走一步回到起点');
  eq(g.distance(p, g.step(p, 0)), 1, '六边形相邻距离为 1');
  eq(g.distance(p, { col: p.col + 2, row: p.row }), 2, '六边形距离（同排）');
  eq(g.patternSlots(p).length, 7, '六边形图案为 7 格');
  const right = g.step(p, 1);
  eq(g.dirBetween(p, right), 1, '六边形方向识别');
  ok(g.neighbors({ col: 0, row: 0 }, 'hex', 1).length < 6, '六边形角落邻域被裁剪');
}

/* ---------- 配置 ---------- */
section('配置规范化与分享');
{
  const specExample = {
    version: '1.1',
    grid: { type: 'square', width: 20, height: 20 },
    start: { x: 5, y: 5, direction: 'up' },
    body: { lengthPolicy: { mode: 'variable', initialLength: 3, growth: { trigger: 'step', amount: 1, probability: 0.1, maxLength: 50 } } },
    rules: { left: 0.33, straight: 0.34, right: 0.33 },
    environmentRules: [{
      subject: 'head',
      trigger: 'afterStep',
      condition: { neighborhood: 'moore', objects: ['obstacle'], count: { min: 2 } },
      actions: [{ type: 'createObstacle', position: 'current' }, { type: 'forceTurn', direction: 'right' }],
      priority: 1,
      probability: 1.0,
    }],
    caMode: { enabled: true, states: ['empty', 'obstacle', 'marker'], neighborhood: 'moore', update: 'synchronous' },
    endConditions: { selfCollision: true, maxSteps: 100 },
    seed: 12345,
  };
  const cfg = normalizeConfig(specExample);
  eq(cfg.start.col, 5, 'x 迁移为 col');
  eq(cfg.start.row, 5, 'y 迁移为 row');
  eq(cfg.moveRules.straight, 0.34, 'rules 迁移为 moveRules');
  eq(cfg.environmentRules.length, 1, '环境规则被解析');
  eq(cfg.environmentRules[0].condition.clauses[0].value, 2, 'count.min 迁移为 count 子句');
  eq(cfg.environmentRules[0].actions[1].turn, 'right', 'forceTurn.direction 迁移为 turn');
  eq(cfg.body.lengthPolicy.growth.maxLength, 50, 'growth.maxLength 保留');
  eq(cfg.endConditions.maxSteps, 100, '结束条件保留');
  ok(validateConfig(specExample).ok, '示例配置通过校验');
  const token = encodeConfigToToken(cfg);
  const back = normalizeConfig(decodeConfigFromToken(token));
  eq(JSON.stringify(back), JSON.stringify(cfg), 'URL 分享往返一致');
  const round = normalizeConfig(JSON.parse(JSON.stringify(cfg)));
  eq(JSON.stringify(round), JSON.stringify(cfg), 'JSON 往返一致');
  ok(validateConfig({ grid: { width: 1 } }).errors.length > 0, '非法配置被检出');
}

/* ---------- 模拟运行 ---------- */
section('模拟运行与复现性');
{
  const base = defaultConfig();
  base.grid.width = 12; base.grid.height = 12;
  base.start = { col: 6, row: 6, direction: 'up' };
  base.endConditions.maxSteps = 60;
  const r1 = new Simulation(base).run();
  const r2 = new Simulation(base).run();
  eq(r1.frames.length, r2.frames.length, '相同配置帧数一致');
  eq(JSON.stringify(r1.frames[r1.frames.length - 1].agents), JSON.stringify(r2.frames[r2.frames.length - 1].agents), '相同种子结果完全一致');
  base.seed = 999;
  const r3 = new Simulation(base).run();
  ok(JSON.stringify(r3.frames[r3.frames.length - 1].agents) !== JSON.stringify(r1.frames[r1.frames.length - 1].agents), '不同种子结果不同');
  ok(r1.frames[0].cells instanceof Uint8Array, '帧包含环境快照');
  ok(r1.frames.length > 10, '产生多帧动画数据');
  eq(r1.frames[0].agents[0].segments.length, 3, '初始长度为 3');
}

/* ---------- 固定长度 ---------- */
section('长度策略');
{
  eq(defaultConfig().body.lengthPolicy.growth.probability, 1, '默认配置：「吃到 / 达成条件后增长」概率为 1（必定增长）');
  eq(normalizeConfig({}).body.lengthPolicy.growth.probability, 1, '规范化后默认增长概率仍为 1（面板默认显示一致）');
  eq(normalizeConfig({ body: { lengthPolicy: { growth: {} } } }).body.lengthPolicy.growth.probability, 1, '仅部分填写增长策略时，概率回落到默认值 1');

  const cfg = defaultConfig();
  cfg.grid.width = 20; cfg.grid.height = 20;
  cfg.start = { col: 10, row: 10, direction: 'up' };
  cfg.endConditions.maxSteps = 40;
  cfg.endConditions.wall = false;
  cfg.grid.boundary = 'wrap';
  cfg.body.lengthPolicy.mode = 'fixed';
  const r = new Simulation(cfg).run();
  ok(r.frames.every((f) => f.agents[0].length === 3), '固定长度始终保持 3');
  ok(r.stats.steps === 40, '运行到步数上限');

  const growCfg = JSON.parse(JSON.stringify(cfg));
  growCfg.body.lengthPolicy.mode = 'variable';
  growCfg.body.lengthPolicy.growth = { enabled: true, trigger: 'step', amount: 1, probability: 1, interval: 1, maxLength: 12 };
  const rg = new Simulation(growCfg).run();
  const last = rg.frames[rg.frames.length - 1].agents[0].length;
  ok(last > 3, '增长策略使长度增加', `实际 ${last}`);
  ok(last <= 12, '长度不超过上限', `实际 ${last}`);

  const shrinkCfg = JSON.parse(JSON.stringify(cfg));
  shrinkCfg.body.lengthPolicy.mode = 'variable';
  shrinkCfg.body.initialLength = 8;
  shrinkCfg.body.lengthPolicy.shrink = { enabled: true, trigger: 'step', amount: 1, probability: 1, interval: 1, minLength: 2 };
  const rs = new Simulation(shrinkCfg).run();
  const l2 = rs.frames[rs.frames.length - 1].agents[0].length;
  ok(l2 < 8 && l2 >= 2, '缩短策略生效且不低于下限', `实际 ${l2}`);
}

/* ---------- 概率分布 ---------- */
section('转向概率分布');
{
  const cfg = defaultConfig();
  cfg.grid.width = 60; cfg.grid.height = 60;
  cfg.start = { col: 30, row: 30, direction: 'up' };
  cfg.moveRules = { left: 0, straight: 1, right: 0 };
  cfg.endConditions.maxSteps = 200;
  cfg.grid.boundary = 'wrap';
  const r = new Simulation(cfg).run();
  const straight = r.stats.turnsStraight;
  ok(straight >= 199, '权重 100% 直行时几乎全部直行', `直行 ${straight}`);

  cfg.moveRules = { left: 1, straight: 1, right: 1 };
  cfg.seed = 2024;
  const r2 = new Simulation(cfg).run();
  const total = r2.stats.turnsLeft + r2.stats.turnsStraight + r2.stats.turnsRight;
  near(r2.stats.turnsLeft / total, 1 / 3, 0.1, '三向均匀时左转比例接近 1/3');
  near(r2.stats.turnsRight / total, 1 / 3, 0.1, '三向均匀时右转比例接近 1/3');
}

/* ---------- 边界行为 ---------- */
section('边界行为');
{
  const mk = (boundary) => {
    const cfg = defaultConfig();
    cfg.grid = { type: 'square', width: 6, height: 6, boundary };
    cfg.start = { col: 5, row: 3, direction: 'right' };
    cfg.body.initialLength = 1;
    cfg.moveRules = { left: 0, straight: 1, right: 0 };
    cfg.endConditions.maxSteps = 10;
    return cfg;
  };
  const wrap = new Simulation(mk('wrap')).run();
  ok(wrap.frames.some((f) => f.agents[0].segments[0][0] === 0), '循环边界穿越到另一侧');
  const stop = new Simulation(mk('stop')).run();
  eq(stop.endReason.code, 'wall', '停止边界触发撞墙结束');
  const bounce = new Simulation(mk('bounce')).run();
  const dirs = bounce.frames.map((f) => f.agents[0].dir);
  ok(dirs.includes(3), '反弹边界产生掉头（向左）');
}

/* ---------- 默认边界行为：穿越到另一侧 ---------- */
section('默认配置：边界行为为「穿越到另一侧」');
{
  eq(defaultConfig().grid.boundary, 'wrap', 'defaultConfig 的边界行为默认为穿越到另一侧');

  const preset = buildPresetConfig('random-walk');
  eq(preset.grid.boundary, 'wrap', '默认场景「随机游走」的边界行为为穿越到另一侧');
  eq(preset.endConditions.wall, false, '默认场景不再以「撞墙」作为结束条件');

  const r = new Simulation(preset).run();
  ok(r.frames.some((f) => f.highlights.some((h) => h.type === 'wrap')), '默认场景运行中确实发生边界穿越');
  eq(r.endReason.code, 'maxSteps', '默认场景按步数上限正常收尾（不会因撞墙提前结束）');
}

/* ---------- 边界反弹的安全避撞 ---------- */
section('边界反弹的安全避撞（贴墙掉头不自撞）');
{
  /**
   * 6×6 网格、蛇头贴右墙朝右、身体横铺在同一行：
   * 反弹掉头时的反向格恰好是自己的脖子，不做规避就会被判为自撞并立即结束。
   */
  const mk = (boundary) => {
    const cfg = defaultConfig();
    cfg.grid = { type: 'square', width: 6, height: 6, boundary };
    cfg.start = { col: 5, row: 3, direction: 'right' };
    cfg.body.initialLength = 3;
    cfg.moveRules = { left: 0, straight: 1, right: 0 };
    cfg.endConditions = { ...cfg.endConditions, maxSteps: 8, wall: false, selfCollision: true };
    cfg.seed = 11;
    return cfg;
  };

  const bounce = new Simulation(mk('bounce')).run();
  eq(bounce.endReason.code, 'maxSteps', '反弹模式下贴墙掉头不会被误判为自撞，按步数上限收尾');
  eq(bounce.stats.selfCollisions, 0, '反弹模式全程未发生自撞');
  const rows = bounce.frames.map((f) => f.agents[0].segments[0][1]);
  ok(rows.some((row) => row !== 3), '反弹时改选竖直方向绕开自身身体（不再沿原行直接掉头）');
  ok(bounce.frames.every((f) => {
    const s = f.agents[0].segments;
    return s.length < 2 || s[0][0] !== s[1][0] || s[0][1] !== s[1][1];
  }), '反弹全程蛇头不会与紧邻的体节重叠');

  // 对照：穿越模式不启用该避撞，仍按原逻辑从对侧出现、保持直行
  const wrap = new Simulation(mk('wrap')).run();
  eq(wrap.frames[1].agents[0].segments[0][0], 0, '穿越模式仍按原逻辑从对侧出现（避撞不影响穿越）');
  ok(wrap.frames.every((f) => f.agents[0].segments[0][1] === 3), '穿越模式下始终沿原方向直行，未被反弹避撞改道');
}

/* ---------- 环境规则 ---------- */
section('环境感知-条件-后果规则');
{
  const cfg = defaultConfig();
  cfg.grid = { type: 'square', width: 14, height: 14, boundary: 'wrap' };
  cfg.start = { col: 7, row: 7, direction: 'up' };
  cfg.moveRules = { left: 0, straight: 1, right: 0 };
  cfg.endConditions.maxSteps = 30;
  cfg.environmentRules = [{
    id: 'r1',
    name: '撒障碍',
    enabled: true,
    subject: 'head',
    trigger: 'afterStep',
    condition: { logic: 'and', clauses: [{ type: 'random', probability: 1 }] },
    actions: [{ type: 'createObstacle', position: 'randomEmpty' }],
    priority: 1,
    probability: 1,
    cooldown: 0,
    maxTriggers: 0,
    once: false,
  }];
  const r = new Simulation(cfg).run();
  ok(r.stats.obstacleCount >= 5, '规则持续产生障碍物', `实际 ${r.stats.obstacleCount}`);
  ok(r.logs.length >= 5, '规则触发产生日志', `实际 ${r.logs.length}`);
  eq(r.logs[0].ruleName, '撒障碍', '日志记录规则名');

  const turnCfg = JSON.parse(JSON.stringify(cfg));
  turnCfg.environmentRules[0].actions = [{ type: 'forceTurn', turn: 'left' }];
  turnCfg.environmentRules[0].condition.clauses = [{ type: 'count', kind: 'moore', radius: 1, objects: ['boundary'], comparator: '>=', value: 1 }];
  const r2 = new Simulation(turnCfg).run();
  ok(r2.stats.turnsLeft > 0, '边界附近触发强制左转', `左转 ${r2.stats.turnsLeft}`);

  const onlyOnce = JSON.parse(JSON.stringify(cfg));
  onlyOnce.environmentRules[0].once = true;
  const r3 = new Simulation(onlyOnce).run();
  eq(r3.stats.obstacleCount, 1, '一次性规则只触发一次');
}

/* ---------- 元胞自动机 ---------- */
section('元胞自动机');
{
  const life = {
    version: '1.1',
    grid: { type: 'square', width: 20, height: 20, boundary: 'wrap' },
    start: { col: 2, row: 2, direction: 'up' },
    body: { initialLength: 1, lengthPolicy: { mode: 'fixed' } },
    caMode: {
      enabled: true,
      states: ['empty', 'alive'],
      neighborhood: 'moore',
      update: 'synchronous',
      boundary: 'fixed',
      initial: { mode: 'pattern', pattern: '....\n.OO.\n.OO.\n....' },
      rules: [
        { from: ['empty'], counts: [{ state: 'alive', values: [3] }], to: 'alive' },
        { from: ['alive'], counts: [{ state: 'alive', values: [0, 1, 4, 5, 6, 7, 8] }], to: 'empty' },
      ],
    },
    endConditions: { maxSteps: 3, wall: false, selfCollision: false, noMove: false, maxStepsEnabled: true },
    moveRules: { left: 0, straight: 1, right: 0 },
    seed: 1,
  };
  const r = new Simulation(life).run();
  const countAlive = (frame) => {
    let n = 0;
    for (const c of frame.cells) if (c === 1) n++;
    return n;
  };
  eq(countAlive(r.frames[0]), 4, '方块图案初始 4 个活细胞');
  eq(countAlive(r.frames[1]), 4, '生命游戏方块稳定（仍为 4）');
  eq(countAlive(r.frames[2]), 4, '方块持续稳定');
  ok(r.stats.caSteps >= 3, 'CA 随步推进', `caSteps ${r.stats.caSteps}`);

  // 同步 vs 异步差异
  const asyncCfg = JSON.parse(JSON.stringify(life));
  asyncCfg.caMode.update = 'asynchronous';
  asyncCfg.caMode.initial.pattern = '.O.\n..O\nOOO';
  const syncCfg = JSON.parse(JSON.stringify(asyncCfg));
  syncCfg.caMode.update = 'synchronous';
  const ra = new Simulation(asyncCfg).run();
  const rs = new Simulation(syncCfg).run();
  const sig = (r2) => Array.from(r2.frames[3].cells).join(',');
  ok(sig(ra) !== sig(rs), '同步与异步更新结果不同');

  // 六边形 CA
  const hex = JSON.parse(JSON.stringify(life));
  hex.grid.type = 'hex';
  hex.caMode.neighborhood = 'hex';
  hex.caMode.initial.pattern = 'OO';
  const rh = new Simulation(hex).run();
  ok(rh.stats.caSteps >= 1, '六边形邻域 CA 可运行');
  ok(rh.frames[0].agents[0].segments.length >= 1, '六边形网格上移动体正常初始化');
}

/* ---------- 混合模式 ---------- */
section('移动体 + 元胞自动机混合模式');
{
  const cfg = defaultConfig();
  cfg.grid = { type: 'square', width: 16, height: 16, boundary: 'wrap' };
  cfg.start = { col: 8, row: 8, direction: 'up' };
  cfg.body.initialLength = 2;
  cfg.body.lengthPolicy.mode = 'fixed';
  cfg.endConditions.maxSteps = 25;
  cfg.caMode = {
    enabled: true,
    states: ['empty', 'obstacle', 'marker'],
    neighborhood: 'moore',
    update: 'synchronous',
    boundary: 'wrap',
    initial: { mode: 'random', density: 0.15, state: 'marker' },
    rules: [],
    syncWithAgent: 'afterMove',
    every: 1,
  };
  // 头周围标记物 >= 2 时吃掉并增长
  cfg.environmentRules = [{
    id: 'eat',
    name: '进食',
    enabled: true,
    subject: 'head',
    trigger: 'afterStep',
    condition: { logic: 'and', clauses: [{ type: 'count', kind: 'moore', radius: 1, objects: ['marker'], comparator: '>=', value: 2 }] },
    actions: [{ type: 'changeLength', amount: 1 }, { type: 'removeMarker', position: 'current' }],
    priority: 1,
    probability: 1,
    cooldown: 0,
    maxTriggers: 0,
    once: false,
  }];
  const r = new Simulation(cfg).run();
  ok(r.stats.caSteps >= 20, '混合模式下 CA 与移动体同步推进', `caSteps ${r.stats.caSteps}`);
  ok(r.frames.length === 26, '帧数与步数一致', `实际 ${r.frames.length}`);
  ok(r.summary.finalLength >= 2, '混合模式下长度发生变化', `最终长度 ${r.summary.finalLength}`);
}

/* ---------- 步数上限 ---------- */
section('步数上限与安全帧上限');
{
  const mk = () => {
    const cfg = defaultConfig();
    cfg.grid = { type: 'square', width: 8, height: 8, boundary: 'wrap' };
    cfg.start = { col: 4, row: 4, direction: 'up' };
    cfg.body.initialLength = 1;
    cfg.moveRules = { left: 0, straight: 1, right: 0 };
    cfg.endConditions.maxSteps = false; // 取消勾选「达到步数上限」
    cfg.endConditions.wall = false;
    cfg.endConditions.outOfBounds = false;
    cfg.endConditions.noMove = false;
    cfg.endConditions.selfCollision = false;
    return cfg;
  };

  const unlimited = normalizeConfig(mk());
  eq(unlimited.endConditions.maxSteps, false, '取消勾选后 maxSteps 保持 false');
  const cap0 = new Simulation(unlimited, { frameCap: 300 }).run();
  ok(cap0.stats.steps > 1, '取消步数上限后不会只走一步', `实际 ${cap0.stats.steps}`);
  eq(cap0.stats.steps, 300, '停在当前安全帧上限');
  eq(cap0.endReason.code, 'frameLimit', '安全帧上限结束原因可继续运行');

  const cap1 = new Simulation(unlimited, { frameCap: 1200 }).run();
  eq(cap1.stats.steps, 1200, '「继续运行」提升上限后走得更远');

  ok(DEFAULT_FRAME_CAP >= 20000 && MAX_FRAME_CAP > DEFAULT_FRAME_CAP, '安全帧上限配置合理');

  const limited = mk();
  limited.endConditions.maxSteps = 25000; // 超过旧硬上限 20000
  const r = new Simulation(limited).run();
  eq(r.stats.steps, 25000, '启用步数上限时可超过 20000 步');
  eq(r.endReason.code, 'maxSteps', '启用时按用户设定步数结束');

  // 步数上限可远超帧缓存能力：画面帧自适应降采样，统计仍按真实步数累计
  eq(normalizeConfig({ endConditions: { maxSteps: 1e15 } }).endConditions.maxSteps, 1e15, '步数上限可设到 1e15 量级');
  const huge = mk();
  huge.endConditions.maxSteps = 500000;
  const rh = new Simulation(huge).run();
  eq(rh.stats.steps, 500000, '极大步数上限可跑满设定步数');
  eq(rh.frames[rh.frames.length - 1].tick, 500000, '末帧对应最后一步');
  ok(rh.frameStride > 1, '超出帧缓存上限后自动降采样', `实际步长 ${rh.frameStride}`);
  ok(rh.frames.length <= MAX_STORED_FRAMES + 2, '帧缓存被限制在安全范围内', `实际 ${rh.frames.length}`);
  ok(rh.stats.lengthHistory.length <= MAX_STORED_FRAMES + 2, '长度曲线同步降采样，不随步数膨胀', `实际 ${rh.stats.lengthHistory.length}`);

  // 步数上限极大但实际很快结束时，仍保留逐步全帧（不会因上限过大而丢掉画面）
  const early = mk();
  early.endConditions.maxSteps = 1e15;
  early.endConditions.wall = true;
  early.grid = { type: 'square', width: 8, height: 8, boundary: 'stop' };
  const re = new Simulation(early).run();
  ok(re.stats.steps < 10, '撞墙提前结束', `实际 ${re.stats.steps} 步`);
  ok(re.frameStride === 1 && re.frames.length === re.stats.steps + 1, '极大步数上限下的短跑仍逐步全帧', `步长 ${re.frameStride}，帧 ${re.frames.length} / 步 ${re.stats.steps}`);
}

/* ---------- 自撞结束规则 ---------- */
section('自撞计数与「连续自撞上限」归属');
{
  // 反向强制转向 1 次，让头在下一步撞上自己的身体
  const mk = () => {
    const cfg = defaultConfig();
    cfg.grid = { type: 'square', width: 12, height: 12, boundary: 'wrap' };
    cfg.start = { col: 6, row: 6, direction: 'up' };
    cfg.body.initialLength = 4;
    cfg.body.lengthPolicy.mode = 'fixed';
    cfg.moveRules = { left: 0, straight: 1, right: 0 };
    cfg.selfCollisionPolicy = { action: 'ignore', n: 2, maxConsecutive: 1 };
    cfg.endConditions.maxSteps = 200;
    cfg.endConditions.noMove = false;
    cfg.environmentRules = [{
      id: 'reverse',
      name: '掉头',
      enabled: true,
      subject: 'head',
      trigger: 'afterStep',
      condition: { logic: 'and', clauses: [{ type: 'random', probability: 1 }] },
      actions: [{ type: 'forceTurn', turn: 'reverse' }],
      priority: 1,
      probability: 1,
      cooldown: 0,
      maxTriggers: 1,
      once: true,
    }];
    return cfg;
  };

  // 勾选「结束规则 → 撞到自身」时，「连续自撞上限」才生效
  const on = mk();
  on.endConditions.selfCollision = true;
  const rOn = new Simulation(on).run();
  eq(rOn.stats.selfCollisions, 1, '自撞被计入独立的自撞计数');
  eq(rOn.endReason.code, 'selfCollision', '勾选「撞到自身」时「连续自撞上限」结束运行');
  ok(rOn.endReason.label.includes('连续撞到自身'), '结束原因说明为连续自撞', `实际 ${rOn.endReason.label}`);

  // 取消勾选后，同一份「连续自撞上限」不再结束运行
  const off = mk();
  off.endConditions.selfCollision = false;
  const rOff = new Simulation(off).run();
  ok(rOff.stats.selfCollisions > 0, '取消勾选后仍如实记录自撞次数', `实际 ${rOff.stats.selfCollisions}`);
  eq(rOff.endReason.code, 'maxSteps', '取消勾选后「连续自撞上限」不再结束运行');
  eq(rOff.stats.steps, 200, '取消勾选后按步数上限运行完', `实际 ${rOff.stats.steps} 步`);

  // 撞墙 / 撞障碍物不是自撞，不应计入自撞统计，也不应触发「累计撞自身 N 次」
  const wallOnly = defaultConfig();
  wallOnly.grid = { type: 'square', width: 6, height: 6, boundary: 'stop' };
  wallOnly.start = { col: 5, row: 3, direction: 'right' };
  wallOnly.body.initialLength = 1;
  wallOnly.moveRules = { left: 0, straight: 1, right: 0 };
  wallOnly.endConditions = {
    ...wallOnly.endConditions,
    wall: false,
    outOfBounds: false,
    selfCollision: false,
    selfCollisionTotal: true,
    selfCollisionTotalN: 1,
    noMove: false,
    maxSteps: 20,
  };
  const rw = new Simulation(wallOnly).run();
  eq(rw.stats.selfCollisions, 0, '撞墙不计入自撞次数');
  ok(rw.stats.collisionsTotal > 0, '撞墙仍计入累计碰撞', `实际 ${rw.stats.collisionsTotal}`);
  eq(rw.endReason.code, 'maxSteps', '撞墙不会误触发「累计撞自身 N 次」结束规则');
  eq(rw.frames[rw.frames.length - 1].stats.selfCollisions, 0, '逐帧统计同样只统计自撞');
}

/* ---------- 配置诊断 ---------- */
section('配置诊断：异常检测与修复建议');
{
  // 深合并补丁（与界面「一键修复」使用同样的语义）
  const mergePatch = (target, patch) => {
    const out = { ...target };
    for (const [k, v] of Object.entries(patch || {})) {
      out[k] = v && typeof v === 'object' && !Array.isArray(v) ? mergePatch(target[k] || {}, v) : v;
    }
    return out;
  };
  const byCode = (list, code) => list.find((d) => d.code === code);
  const applySuggestion = (raw, diag, pick) => mergePatch(raw, pick(diag).patch);

  /* 1. 起点超出地图边界（规范化会静默收敛，诊断按原始值报告） */
  const rawStart = { grid: { type: 'square', width: 10, height: 10 }, start: { col: 50, row: 5, direction: 'up' } };
  const dStart = byCode(diagnoseConfig(rawStart), 'startOutOfBounds');
  ok(!!dStart, '起点越界被检出');
  eq(dStart?.level, 'error', '起点越界为严重级别');
  ok(dStart?.message.includes('50'), '诊断信息包含原始越界坐标', `实际 ${dStart?.message}`);
  ok(dStart?.suggestions.length >= 2, '起点越界给出多种解决方案', `实际 ${dStart?.suggestions.length} 条`);
  ok(dStart?.suggestions.every((s) => s.label && s.patch), '每条建议都带可执行补丁');
  const startFix = diagnoseConfig(applySuggestion(rawStart, dStart, (d) => d.suggestions.find((s) => s.patch.grid)));
  ok(!byCode(startFix, 'startOutOfBounds'), '扩大地图以包含原起点后不再报起点越界');
  const startCenter = diagnoseConfig(applySuggestion(rawStart, dStart, (d) => d.suggestions[0]));
  ok(!byCode(startCenter, 'startOutOfBounds'), '起点移到地图中心后不再报起点越界');

  /* 2. 蛇身长度超过地图尺寸 */
  const rawBig = {
    grid: { type: 'square', width: 4, height: 4 },
    start: { col: 2, row: 2, direction: 'up' },
    body: { initialLength: 20 },
  };
  const dBig = byCode(diagnoseConfig(rawBig), 'bodyExceedsGrid');
  ok(!!dBig, '蛇身长度超过地图尺寸被检出');
  eq(dBig?.level, 'error', '蛇长超地图为严重级别');
  ok(dBig?.suggestions.some((s) => s.patch.grid), '给出扩大地图的方案');
  const bigFixed = diagnoseConfig(applySuggestion(rawBig, dBig, (d) => d.suggestions.find((s) => s.patch.grid)));
  ok(!bigFixed.some((d) => d.level === 'error'), '按建议扩大地图后不再有严重诊断', `实际 ${bigFixed.map((d) => d.code).join(',') || '无'}`);

  /* 3. 初始身体被地图边界截断（起点贴着上边界却朝下走） */
  const rawTrunc = {
    grid: { type: 'square', width: 10, height: 10, boundary: 'stop' },
    start: { col: 0, row: 0, direction: 'down' },
    body: { initialLength: 5, lengthPolicy: { mode: 'fixed' } },
  };
  const dTrunc = byCode(diagnoseConfig(rawTrunc), 'bodyTruncatedByBoundary');
  ok(!!dTrunc, '初始身体被边界截断被检出');
  eq(dTrunc?.level, 'error', '身体被截断为严重级别');
  ok(dTrunc?.message.includes('1 节'), '诊断信息说明实际只能排下 1 节', `实际 ${dTrunc?.message}`);
  ok(dTrunc?.suggestions.some((s) => s.patch.start?.col === 5), '给出「起点移至地图中心」方案');
  ok(dTrunc?.suggestions.some((s) => s.patch.grid), '给出「扩大地图以容纳完整身体」方案');
  ok(dTrunc?.suggestions.some((s) => s.patch.body?.initialLength === 1), '给出「修改初始身体长度」方案');
  const truncFixed = diagnoseConfig(applySuggestion(rawTrunc, dTrunc, (d) => d.suggestions.find((s) => s.patch.start)));
  ok(!byCode(truncFixed, 'bodyTruncatedByBoundary'), '起点移到地图中心后身体不再被截断');
  const truncShort = diagnoseConfig(applySuggestion(rawTrunc, dTrunc, (d) => d.suggestions.find((s) => s.patch.body)));
  ok(!byCode(truncShort, 'bodyTruncatedByBoundary'), '把初始长度改为可容纳值后不再被截断');
  // 环绕边界下身体可跨越接缝，同样的起点 / 长度不再构成截断
  const wrapTrunc = { ...rawTrunc, grid: { ...rawTrunc.grid, boundary: 'wrap' } };
  ok(!byCode(diagnoseConfig(wrapTrunc), 'bodyTruncatedByBoundary'), '环绕边界（wrap）下初始身体跨缝铺设，不再判定为截断');
  const wrapFullCfg = normalizeConfig(wrapTrunc);
  wrapFullCfg.endConditions.maxSteps = 3;
  const wrapFull = new Simulation(wrapFullCfg).run();
  eq(wrapFull.frames[0].agents[0].segments.length, 5, '环绕边界下实际生成的初始身体长度为完整的 5 节');

  /* 4. 增长上限 / 目标长度超过地图总格数 */
  const rawGrow = { grid: { type: 'square', width: 4, height: 4 }, body: { lengthPolicy: { mode: 'variable', growth: { enabled: true, maxLength: 50 } } } };
  ok(byCode(diagnoseConfig(rawGrow), 'growthExceedsGrid'), '增长上限超过地图尺寸被检出');
  const rawTarget = { grid: { type: 'square', width: 4, height: 4 }, endConditions: { lengthReached: true, lengthTarget: 100 } };
  ok(byCode(diagnoseConfig(rawTarget), 'lengthTargetExceedsGrid'), '目标长度超过地图尺寸被检出');
  eq(byCode(diagnoseConfig(rawGrow), 'growthExceedsGrid').level, 'warning', '增长上限超出为警告级别');

  /* 5. 起点被 CA 初始图案中的阻塞状态占据 */
  const rawBlocked = {
    grid: { type: 'square', width: 5, height: 5 },
    start: { col: 0, row: 2, direction: 'up' },
    caMode: { enabled: true, states: ['empty', 'obstacle', 'marker'], initial: { mode: 'pattern', pattern: '#####' } },
  };
  const dBlocked = byCode(diagnoseConfig(rawBlocked), 'startBlocked');
  ok(!!dBlocked, '起点被阻塞状态占据被检出');
  eq(dBlocked?.level, 'error', '起点被阻塞为严重级别');
  ok(dBlocked?.suggestions.some((s) => typeof s.patch.caMode?.initial?.pattern === 'string'), '给出「清空起点格图案」方案');
  const blockedFixed = diagnoseConfig(applySuggestion(rawBlocked, dBlocked, (d) => d.suggestions.find((s) => s.patch.caMode)));
  ok(!byCode(blockedFixed, 'startBlocked'), '清空起点格后不再报起点被阻塞');
  const rawMaybe = {
    grid: { type: 'square', width: 8, height: 8 },
    caMode: { enabled: true, states: ['empty', 'obstacle'], initial: { mode: 'random', density: 0.3, state: 'obstacle' } },
  };
  eq(byCode(diagnoseConfig(rawMaybe), 'startMayBeBlocked')?.level, 'warning', '随机填充阻塞状态时给出警告');

  /* 5.5 CA 初始图案大于地图（超出部分会被裁掉） */
  const rawPattern = {
    grid: { type: 'square', width: 4, height: 4 },
    caMode: { enabled: true, states: ['empty', 'obstacle'], initial: { mode: 'pattern', pattern: 'OOOOOO\nOOOOOO' } },
  };
  const dPattern = byCode(diagnoseConfig(rawPattern), 'patternExceedsGrid');
  ok(!!dPattern, 'CA 初始图案大于地图被检出');
  eq(dPattern?.level, 'warning', '图案超出地图为警告级别');
  const patternFixed = diagnoseConfig(applySuggestion(rawPattern, dPattern, (d) => d.suggestions[0]));
  ok(!byCode(patternFixed, 'patternExceedsGrid'), '扩大地图以容纳初始图案后不再警告');

  /* 6. 其它空转警告 */
  ok(byCode(diagnoseConfig({ moveRules: { left: 0, straight: 0, right: 0 } }), 'zeroMoveWeights'), '权重全 0 被提示');
  ok(byCode(diagnoseConfig({ caMode: { enabled: true, rules: [], initial: { mode: 'empty' } } }), 'caNoEffect'), 'CA 恒为空被提示');
  eq(diagnoseConfig({}).length, 0, '默认配置无任何诊断');

  /* 7. 运行期诊断：实际跑起来才暴露的截断 */
  const rt = defaultConfig();
  rt.grid = { type: 'square', width: 10, height: 10, boundary: 'stop' };
  rt.start = { col: 0, row: 0, direction: 'down' };
  rt.body.initialLength = 5;
  rt.body.lengthPolicy.mode = 'fixed';
  rt.endConditions.maxSteps = 5;
  const rRun = new Simulation(rt).run();
  ok(rRun.frames[0].agents[0].segments.length < 5, '运行时身体确实被截断', `实际 ${rRun.frames[0].agents[0].segments.length} 节`);
  const dRun = byCode(rRun.diagnostics, 'bodyTruncated');
  ok(!!dRun, '运行期结果携带身体截断诊断');
  ok(dRun?.suggestions.length >= 2, '运行期诊断同样附带可执行方案', `实际 ${dRun?.suggestions.length} 条`);
  const rtFixed = mergePatch(rt, dRun.suggestions.find((s) => s.patch.start).patch);
  eq(new Simulation(rtFixed).run().frames[0].agents[0].segments.length, 5, '按运行期建议修复后身体完整');
  // 同一配置换成环绕边界：身体跨缝铺设，运行期不再产生截断诊断
  const rtWrap = mergePatch(rt, { grid: { boundary: 'wrap' } });
  const rWrap = new Simulation(rtWrap).run();
  eq(rWrap.frames[0].agents[0].segments.length, 5, '环绕边界下运行期初始身体完整（5 节）');
  ok(!byCode(rWrap.diagnostics, 'bodyTruncated'), '环绕边界下运行期不再报身体截断');

  /* 8. 校验入口携带结构化诊断 */
  const v = validateConfig(rawTrunc);
  ok(v.ok, '诊断不阻断结构校验通过');
  ok(v.diagnostics.some((d) => d.code === 'bodyTruncatedByBoundary'), 'validateConfig 返回结构化诊断');
  ok(v.warnings.some((w) => w.includes('截断')), '诊断同时汇总进 warnings 文本');
}

/* ---------- 新增：完全禁用蛇形实体 ---------- */
section('核心开关：完全禁用蛇形实体');
{
  ok(!isBodyEnabled(normalizeConfig({ body: { enabled: false, initialLength: 5 } })), 'enabled=false 判定为不生成蛇形实体');
  ok(!isBodyEnabled(normalizeConfig({ body: { enabled: true, initialLength: 0 } })), 'initialLength=0 判定为不生成蛇形实体');
  ok(isBodyEnabled(normalizeConfig({ body: { initialLength: 1 } })), 'initialLength≥1 时正常生成');
  eq(normalizeConfig({ body: { initialLength: 0 } }).body.initialLength, 0, '初始长度允许为 0（不再被夹到 1）');

  const run = (setup) => {
    const cfg = defaultConfig();
    cfg.grid = { type: 'square', width: 12, height: 12, boundary: 'wrap' };
    cfg.start = { col: 6, row: 6, direction: 'up' };
    cfg.body.initialLength = 3;
    cfg.endConditions = {
      ...cfg.endConditions,
      maxSteps: 12, wall: false, outOfBounds: false, selfCollision: false, noMove: false,
    };
    setup(cfg);
    return new Simulation(cfg).run();
  };

  const rOff = run((c) => { c.body.enabled = false; });
  eq(rOff.frames[0].agents.length, 0, '关闭开关后首帧没有移动体');
  eq(rOff.frames[rOff.frames.length - 1].agents.length, 0, '整场运行都不出现移动体');
  eq(rOff.stats.steps, 12, '无移动体时仍按步数推进', `实际 ${rOff.stats.steps}`);
  eq(rOff.endReason.code, 'maxSteps', '无移动体时以步数上限收尾');
  eq(rOff.stats.agents, 0, '存活移动体统计为 0');

  const rZero = run((c) => { c.body.initialLength = 0; });
  eq(rZero.frames[rZero.frames.length - 1].agents.length, 0, 'initialLength=0 与关闭开关等效');
  eq(rZero.stats.steps, 12, '初始长度为 0 时同样正常推进', `实际 ${rZero.stats.steps}`);

  // 与元胞自动机同时启用：没有蛇，但环境照常演化
  const rCa = run((c) => {
    c.body.enabled = false;
    c.caMode.enabled = true;
    c.caMode.states = [
      { name: 'empty', color: null, symbol: '.', blocking: false },
      { name: 'alive', color: '#ffd43b', symbol: 'O', blocking: false },
    ];
    c.caMode.initial = { mode: 'pattern', pattern: '.O.\n..O\nOOO' };
    c.caMode.rules = [
      { from: ['empty'], counts: [{ state: 'alive', values: [3] }], to: 'alive' },
      { from: ['alive'], counts: [{ state: 'alive', values: [0, 1, 4, 5, 6, 7, 8] }], to: 'empty' },
    ];
  });
  eq(rCa.frames[0].agents.length, 0, '纯 CA 场景没有移动体');
  ok(rCa.stats.caSteps >= 12, '禁用蛇形实体后元胞自动机照常演化', `caSteps ${rCa.stats.caSteps}`);
  const sigOf = (f) => Array.from(f.cells).join(',');
  ok(rCa.frames.some((f, i) => i > 0 && sigOf(f) !== sigOf(rCa.frames[i - 1])), '环境状态确实在变化');

  // 诊断
  const dOff = diagnoseConfig({ body: { enabled: false, initialLength: 3 } }).find((d) => d.code === 'bodyDisabled');
  ok(!!dOff, '禁用蛇形实体时给出提示诊断');
  eq(dOff?.level, 'info', '禁用提示为「提示」级别');
  ok(dOff?.suggestions.some((s) => s.patch.body?.enabled === true), '给出「恢复蛇形实体」一键修复方案');
  ok(!diagnoseConfig({ body: { initialLength: 3 } }).some((d) => d.code === 'bodyDisabled'), '正常配置不报禁用提示');
  const dDisabledBad = diagnoseConfig({ grid: { width: 6, height: 6 }, start: { col: 99, row: 99 }, body: { enabled: false } });
  ok(!dDisabledBad.some((d) => d.code === 'startOutOfBounds'), '禁用蛇形实体后不再报起点越界');
  ok(!dDisabledBad.some((d) => d.level === 'error'), '禁用蛇形实体后没有严重诊断');
  // 无主移动体却启用多蛇系统时给出提示
  ok(diagnoseConfig({ body: { enabled: false }, multiSnake: { enabled: true } }).some((d) => d.code === 'multiSnakeWithoutMain'), '无主移动体时启用多蛇系统被提示');
}

/* ---------- 新增：交互标记物机制 ---------- */
section('交互标记物机制');
{
  const mkMarkerRun = (patch = {}) => {
    const cfg = defaultConfig();
    cfg.grid = { type: 'square', width: 10, height: 10, boundary: 'wrap' };
    cfg.start = { col: 2, row: 4, direction: 'right' };
    cfg.body.initialLength = 3;
    cfg.body.lengthPolicy.mode = 'variable';
    cfg.moveRules = { left: 0, straight: 1, right: 0 };
    cfg.endConditions = {
      ...cfg.endConditions,
      maxSteps: 5, wall: false, outOfBounds: false, selfCollision: false, noMove: false,
    };
    cfg.caMode.enabled = true;
    cfg.caMode.states = [
      { name: 'empty', color: null, symbol: '.', blocking: false },
      { name: 'marker', color: '#ffd166', symbol: 'M', blocking: false },
      { name: 'spike', color: '#ff6b6b', symbol: 'X', blocking: false },
    ];
    cfg.caMode.initial = { mode: 'pattern', pattern: 'MMMMM' };
    cfg.caMode.rules = [];
    cfg.caMode.markerInteraction = {
      enabled: true,
      states: ['marker'],
      effects: [{
        id: 'fx', name: '增长', enabled: true, state: 'marker', mode: 'delta',
        value: 2, probability: 1, consume: true, consumeTo: 'empty', color: '#51cf66',
      }],
    };
    applyPatch(cfg, patch);
    return new Simulation(cfg).run();
  };

  // 增量模式 + 消耗标记物
  const r = mkMarkerRun();
  eq(r.stats.markerInteractions, 4, '4 次标记物反馈被逐步统计');
  eq(r.stats.markerCount, 1, '被消耗的标记物从环境中移除');
  eq(r.frames[r.frames.length - 1].agents[0].length, 3 + 2 * 4, '每次反馈使长度 +2');
  const miEvents = r.frames.flatMap((f) => f.events).filter((e) => e.type === 'markerInteraction');
  eq(miEvents.length, 4, '每步都产生标记物交互事件');
  eq(miEvents[0].delta, 2, '事件携带长度变化量');
  eq(miEvents[0].highlight, true, '交互事件带高亮标记');
  eq(miEvents[0].color, '#51cf66', '交互事件携带反馈配色');
  ok(r.frames.some((f) => f.highlights.some((h) => h.type === 'markerEffect')), '画面高亮包含标记物反馈特效');

  // 百分比模式
  const rPct = mkMarkerRun({
    caMode: {
      enabled: true,
      markerInteraction: {
        enabled: true, states: ['marker'],
        effects: [{ id: 'fx', name: '翻倍', enabled: true, state: 'marker', mode: 'percent', value: 100, probability: 1, consume: true, consumeTo: 'empty' }],
      },
    },
  });
  eq(rPct.frames[rPct.frames.length - 1].agents[0].length, 3 * 2 ** 4, '百分比模式按当前长度比例增长');

  // 指定值模式
  const rSet = mkMarkerRun({
    caMode: {
      enabled: true,
      markerInteraction: {
        enabled: true, states: ['marker'],
        effects: [{ id: 'fx', name: '变短', enabled: true, state: 'marker', mode: 'set', value: 1, probability: 1, consume: true, consumeTo: 'empty' }],
      },
    },
  });
  eq(rSet.frames[rSet.frames.length - 1].agents[0].length, 1, '指定值模式把长度直接设为 1');
  eq(rSet.stats.markerInteractions, 4, '指定值模式同样统计反馈次数');

  // 概率为 0 时完全不触发
  const rZeroP = mkMarkerRun({
    caMode: {
      enabled: true,
      markerInteraction: {
        enabled: true, states: ['marker'],
        effects: [{ id: 'fx', name: '不触发', enabled: true, state: 'marker', mode: 'delta', value: 5, probability: 0, consume: true, consumeTo: 'empty' }],
      },
    },
  });
  eq(rZeroP.stats.markerInteractions, 0, '触发概率为 0 时不产生反馈');
  eq(rZeroP.frames[rZeroP.frames.length - 1].agents[0].length, 3, '未触发时长度不变');

  // 未列入「交互状态」的元胞不触发
  const rOther = mkMarkerRun({
    caMode: {
      enabled: true,
      markerInteraction: {
        enabled: true, states: ['spike'],
        effects: [{ id: 'fx', name: '增长', enabled: true, state: 'spike', mode: 'delta', value: 2, probability: 1, consume: true, consumeTo: 'empty' }],
      },
    },
  });
  eq(rOther.stats.markerInteractions, 0, '只有被声明为交互标记物的状态才触发反馈');

  // 关闭机制时完全退化回「吃到标记物」的原有行为
  const rDisabled = mkMarkerRun({
    caMode: { enabled: true, markerInteraction: { enabled: false } },
  });
  eq(rDisabled.stats.markerInteractions, 0, '机制关闭时不产生反馈');
  eq(rDisabled.frames[rDisabled.frames.length - 1].agents[0].length, 3, '机制关闭时不改变长度');

  // 诊断：固定长度策略下反馈的长度变化不会生效
  const fixedDiag = diagnoseConfig({
    body: { initialLength: 3, lengthPolicy: { mode: 'fixed' } },
    caMode: { enabled: true, markerInteraction: { enabled: true } },
  }).find((d) => d.code === 'markerEffectIgnored');
  ok(!!fixedDiag, '固定长度策略下提示标记物反馈长度变化无效');
  eq(fixedDiag?.level, 'warning', '该提示为警告级别');
  ok(fixedDiag?.suggestions.some((s) => s.patch.body?.lengthPolicy?.mode === 'variable'), '给出「长度策略改为可变」的一键修复');
  ok(!diagnoseConfig({
    body: { initialLength: 3, lengthPolicy: { mode: 'variable' } },
    caMode: { enabled: true, markerInteraction: { enabled: true } },
  }).some((d) => d.code === 'markerEffectIgnored'), '可变长度策略下不再提示');
}

/* ---------- 新增：安全避撞预设 ---------- */
section('安全避撞预设');
{
  const mkSim = (safety) => {
    const cfg = defaultConfig();
    cfg.grid = { type: 'square', width: 5, height: 5, boundary: 'wrap' };
    cfg.safety = safety;
    return new Simulation(cfg);
  };
  const sim = mkSim({ avoidBody: true, avoidObstacle: false, avoidOtherAgents: false });
  const grid = sim.grid;
  const agent = new Agent('main', [{ col: 2, row: 2 }, { col: 3, row: 2 }, { col: 3, row: 3 }], 1, { isMain: true });
  const ctx = { grid, world: new World(grid, sim.states), agents: [agent], config: sim.config, rng: new RNG(11), tick: 1 };

  eq(sim.selfBlocks(ctx, agent, { col: 3, row: 2 }), true, '识别出直行方向压在自身身体上');
  eq(sim.selfBlocks(ctx, agent, { col: 2, row: 1 }), false, '空格不被判定为自身身体');

  const options = [
    { key: 'left', weight: 1 },
    { key: 'straight', weight: 1 },
    { key: 'right', weight: 1 },
  ];
  const safe = sim.filterSafeOptions(ctx, agent, options);
  eq(safe.length, 2, '安全避撞剔除压在自身身体上的方向');
  ok(!safe.some((o) => o.dir === 1), '被剔除的正是压在身体上的直行方向');

  const simOff = mkSim({ avoidBody: false, avoidObstacle: false, avoidOtherAgents: false });
  eq(simOff.filterSafeOptions({ ...ctx, config: simOff.config }, agent, options), null, '规避项全部关闭时不做筛选（保持原随机序列）');

  // 所有方向都被自身阻塞时返回空数组，调用方回落到原始权重
  const boxed = new Agent('m2', [
    { col: 2, row: 2 }, { col: 1, row: 2 }, { col: 3, row: 2 }, { col: 2, row: 1 }, { col: 2, row: 3 },
  ], 1, { isMain: true });
  const ctxBoxed = { ...ctx, agents: [boxed] };
  eq(sim.filterSafeOptions(ctxBoxed, boxed, options).length, 0, '三个可行方向均被自身阻塞时返回空数组');

  // 运行级对比：开启「自身身体」规避后自撞显著减少
  // 8 列宽的环绕地图上放 8 节身体，蛇头正好填满最后一列，身体铺满整行：
  // 蛇头「直行」越过边界后会绕回自己的身体（尾巴），因此不规避时高频自撞；
  // 开启规避后该方向被剔除，只在三个方向都走不通时才会回落触发自撞。
  const runWalk = (avoidBody, seed) => {
    const cfg = defaultConfig();
    cfg.grid = { type: 'square', width: 8, height: 8, boundary: 'wrap' };
    cfg.start = { col: 7, row: 4, direction: 'right' };
    cfg.body.initialLength = 8;
    cfg.body.lengthPolicy.mode = 'fixed';
    // 头撞尾也算撞：否则尾巴同时腾空，绕回来的那格恰好是尾巴而被放行
    cfg.collision = { ...cfg.collision, headIntoTail: true };
    cfg.safety = { avoidBody, avoidObstacle: false, avoidOtherAgents: false };
    cfg.endConditions = {
      ...cfg.endConditions,
      maxSteps: 300, wall: false, outOfBounds: false, selfCollision: false, noMove: false,
    };
    cfg.seed = seed;
    return new Simulation(cfg).run();
  };
  const walkOff = runWalk(false, 2024);
  const walkOn = runWalk(true, 2024);
  ok(walkOff.stats.selfCollisions > 0, '关闭规避时随机游走会发生自撞', `实际 ${walkOff.stats.selfCollisions}`);
  ok(walkOn.stats.selfCollisions < walkOff.stats.selfCollisions, '开启自身身体规避后自撞显著减少', `开启 ${walkOn.stats.selfCollisions} / 关闭 ${walkOff.stats.selfCollisions}`);
  eq(walkOn.stats.steps, 300, '开启规避后仍能跑满步数上限');
}

/* ---------- 新增：多蛇生成系统 ---------- */
section('多蛇生成系统');
{
  const baseCfg = () => {
    const cfg = defaultConfig();
    cfg.grid = { type: 'square', width: 20, height: 20, boundary: 'wrap' };
    cfg.start = { col: 10, row: 10, direction: 'right' };
    cfg.body.initialLength = 3;
    cfg.endConditions = {
      ...cfg.endConditions,
      maxSteps: 30, wall: false, outOfBounds: false, selfCollision: false, noMove: false,
    };
    cfg.multiSnake.enabled = true;
    cfg.multiSnake.interaction.mode = 'pass';
    return cfg;
  };

  // 按预定时间点生成
  {
    const cfg = baseCfg();
    cfg.multiSnake.spawn = {
      mode: 'time', times: [5, 15], minInterval: 10, maxInterval: 20,
      maxAgents: 6, length: 3, direction: 'right', events: ['eat'], probability: 1,
    };
    const r = new Simulation(cfg).run();
    eq(r.stats.spawns, 2, '按预定时间点生成 2 条新蛇');
    eq(r.summary.agents, 3, '场上共 3 条移动体');
    eq(r.summary.peakAgents, 3, '峰值移动体数正确');
    eq(r.frames[0].agents.length, 1, '首帧只有主移动体');
    const last = r.frames[r.frames.length - 1].agents;
    eq(last.filter((a) => a.isMain).length, 1, '只有一条主移动体');
    eq(last.filter((a) => !a.isMain).length, 2, '生成出来的都是非主移动体');
    ok(last.filter((a) => !a.isMain).every((a) => !!a.color), '生成出来的蛇带独立配色');
    const spawnTicks = r.frames.filter((f) => f.events.some((e) => e.type === 'spawn')).map((f) => f.tick);
    eq(JSON.stringify(spawnTicks), JSON.stringify([5, 15]), '生成刚好发生在预定时间点 5 与 15');
    ok(r.frames.some((f) => f.highlights.some((h) => h.type === 'spawn')), '生成动作带视觉反馈高亮');
    ok(r.logs.some((l) => l.ruleId === 'multi_snake'), '生成写入运行日志');
  }

  // 按随机时间间隔生成
  {
    const cfg = baseCfg();
    cfg.multiSnake.spawn = {
      mode: 'interval', times: [], minInterval: 5, maxInterval: 5,
      maxAgents: 6, length: 2, direction: 'right', events: ['eat'], probability: 1,
    };
    const r = new Simulation(cfg).run();
    eq(r.stats.spawns, 5, '固定间隔每 5 步生成一条');
    eq(r.summary.agents, 6, '达到生成数量上限后停止生成');
  }

  // 按特殊事件生成（吃到标记物）
  {
    const cfg = defaultConfig();
    cfg.grid = { type: 'square', width: 10, height: 10, boundary: 'wrap' };
    cfg.start = { col: 2, row: 4, direction: 'right' };
    cfg.body.initialLength = 3;
    cfg.moveRules = { left: 0, straight: 1, right: 0 };
    cfg.endConditions = {
      ...cfg.endConditions,
      maxSteps: 6, wall: false, outOfBounds: false, selfCollision: false, noMove: false,
    };
    cfg.caMode.enabled = true;
    cfg.caMode.states = [
      { name: 'empty', color: null, symbol: '.', blocking: false },
      { name: 'marker', color: '#ffd166', symbol: 'M', blocking: false },
    ];
    cfg.caMode.initial = { mode: 'pattern', pattern: 'MMMMM' };
    cfg.caMode.rules = [];
    cfg.multiSnake.enabled = true;
    cfg.multiSnake.interaction.mode = 'pass';
    cfg.multiSnake.spawn = {
      mode: 'event', times: [], minInterval: 5, maxInterval: 5,
      maxAgents: 3, length: 1, direction: 'right', events: ['eat'], probability: 1,
    };
    const r = new Simulation(cfg).run();
    eq(r.stats.spawns, 2, '吃到标记物时触发生成，达到上限后停止');
    eq(r.summary.agents, 3, '事件触发下场上共 3 条移动体');
    const spawnTicks = r.frames.filter((f) => f.events.some((e) => e.type === 'spawn')).map((f) => f.tick);
    eq(JSON.stringify(spawnTicks), JSON.stringify([1, 2]), '生成发生在进食事件的当步');
  }

  // 生成出来的蛇独立选向（不会被主移动体的转向带着走）
  {
    const sim = new Simulation(defaultConfig());
    const a = new Agent('main', [{ col: 1, row: 1 }], 1, { label: '主移动体', isMain: true });
    const b = new Agent('a1', [{ col: 5, row: 5 }], 3, { label: '蛇1', isMain: false });
    const dctx = {
      grid: sim.grid, world: new World(sim.grid, sim.states), agents: [a, b],
      config: sim.config, rng: new RNG(3), tick: 1, agent: a,
    };
    a.forcedNextTurn = 'left';
    b.forcedNextTurn = 'reverse';
    eq(sim.decideDirection(dctx, null, b).turnKey, 'reverse', '转向由被推进的移动体自身决定，而不是 ctx.agent');
    eq(sim.decideDirection(dctx, null, a).turnKey, 'left', '主移动体自身的强制转向照常生效');
  }
}

/* ---------- 新增：多蛇交互 ---------- */
section('多蛇交互：碰撞 / 融合 / 排斥');
{
  const mkSim = (mode) => {
    const cfg = defaultConfig();
    cfg.grid = { type: 'square', width: 8, height: 8, boundary: 'wrap' };
    cfg.multiSnake.enabled = true;
    cfg.multiSnake.interaction.mode = mode;
    return new Simulation(cfg);
  };
  const mkCtx = (sim, agents) => ({
    grid: sim.grid,
    world: new World(sim.grid, sim.states),
    agents,
    config: sim.config,
    rng: new RNG(7),
    tick: 3,
    stats: { agentDeaths: 0, merges: 0, repels: 0, spawns: 0 },
    logs: [],
    log: (entry) => { /* 收集日志 */ },
    highlights: [],
    pending: { forcedTurns: [], lengthDelta: 0, setLength: null, end: null },
  });

  // 融合：头对头
  {
    const sim = mkSim('merge');
    const main = new Agent('main', [{ col: 3, row: 3 }], 1, { label: '主移动体', isMain: true });
    const other = new Agent('a1', [{ col: 3, row: 3 }], 3, { label: '蛇1', color: '#ff5d5d', isMain: false, spawnTick: 1 });
    const ctx = mkCtx(sim, [main, other]);
    const logs = [];
    ctx.log = (e) => logs.push(e);
    const evts = [];
    sim.resolveAgentInteractions(ctx, evts);
    eq(main.alive, true, '融合后主移动体保留');
    eq(other.alive, false, '融合后对方消失');
    eq(main.length, 2, '融合后长度叠加');
    eq(ctx.stats.merges, 1, '融合次数被统计');
    eq(ctx.stats.agentDeaths, 1, '被融合的一方计入消失数');
    ok(evts.some((e) => e.type === 'merge' && e.highlight), '融合产生带高亮的视觉反馈事件');
    ok(ctx.highlights.some((h) => h.type === 'merge'), '融合写入画面高亮');
    eq(logs.length, 1, '融合写入运行日志');
  }

  // 融合：头进入其它移动体的身体
  {
    const sim = mkSim('merge');
    const main = new Agent('main', [{ col: 3, row: 3 }], 1, { label: '主移动体', isMain: true });
    const other = new Agent('a1', [{ col: 4, row: 3 }, { col: 3, row: 3 }], 1, { label: '蛇1', isMain: false });
    const ctx = mkCtx(sim, [main, other]);
    sim.resolveAgentInteractions(ctx, []);
    eq(other.alive, false, '头进入其它移动体身体时同样视为融合');
    eq(ctx.stats.merges, 1, '该情形也被计入融合次数');
    eq(main.length, 3, '被融合方整条身体并入保留方');
  }

  // 碰撞：主移动体参与时结束运行
  {
    const sim = mkSim('collide');
    const main = new Agent('main', [{ col: 2, row: 2 }], 1, { label: '主移动体', isMain: true });
    const other = new Agent('a1', [{ col: 2, row: 2 }], 3, { label: '蛇1', isMain: false });
    const ctx = mkCtx(sim, [main, other]);
    const evts = [];
    const res = sim.resolveAgentInteractions(ctx, evts);
    ok(res && res.fatal, '主移动体参与的头对头碰撞判定为结束运行');
    eq(res?.reason.code, 'selfCollision', '相撞结束原因为碰撞');
    eq(ctx.stats.agentDeaths, 2, '相撞双方同时消失');
    ok(evts.some((e) => e.type === 'agentCollision' && e.highlight), '相撞产生视觉反馈事件');
  }

  // 碰撞：无主移动体参与时不结束运行
  {
    const sim = mkSim('collide');
    const a = new Agent('a1', [{ col: 2, row: 2 }], 1, { label: '蛇1', isMain: false });
    const b = new Agent('a2', [{ col: 2, row: 2 }], 3, { label: '蛇2', isMain: false });
    const ctx = mkCtx(sim, [a, b]);
    eq(sim.resolveAgentInteractions(ctx, []), null, '无主移动体参与时碰撞不结束运行');
    eq(ctx.stats.agentDeaths, 2, '两条新蛇相撞后都消失');
  }

  // 排斥：回退这一步移动，双方均生存
  {
    const sim = mkSim('repel');
    const main = new Agent('main', [{ col: 2, row: 2 }], 1, { label: '主移动体', isMain: true });
    main.prevState = { segments: [{ col: 2, row: 3 }], dir: 1 };
    const other = new Agent('a1', [{ col: 5, row: 5 }], 3, { label: '蛇1', isMain: false });
    other.prevState = { segments: [{ col: 5, row: 5 }], dir: 3 };
    const ctx = mkCtx(sim, [main, other]);
    // 让主移动体的头压在对方身体上
    other.segments = [{ col: 5, row: 5 }, { col: 2, row: 2 }];
    const evts = [];
    sim.resolveAgentInteractions(ctx, evts);
    eq(ctx.stats.repels, 1, '排斥被统计');
    eq(main.alive && other.alive, true, '排斥后双方都存活');
    eq(JSON.stringify(main.segments), JSON.stringify([{ col: 2, row: 3 }]), '被排斥的一方回退到上一步位置');
    ok(evts.some((e) => e.type === 'repel' && e.highlight), '排斥产生视觉反馈事件');
  }

  // 穿行 / 未启用多蛇时不介入
  {
    const simPass = mkSim('pass');
    const a = new Agent('a1', [{ col: 2, row: 2 }], 1, { isMain: false });
    const b = new Agent('a2', [{ col: 2, row: 2 }], 3, { isMain: false });
    eq(simPass.resolveAgentInteractions(mkCtx(simPass, [a, b]), []), null, '「穿行」模式下互不影响');
    const simOff = new Simulation(defaultConfig());
    eq(simOff.resolveAgentInteractions(mkCtx(simOff, [a, b]), []), null, '未启用多蛇系统时不进行交互结算');
  }
}

/* ---------- 新增：规则与结束条件扩展 ---------- */
section('规则与结束条件扩展');
{
  // 条件子句：移动体数量
  const agents = [
    { alive: true, segments: [{ col: 0, row: 0 }] },
    { alive: true, segments: [{ col: 1, row: 1 }] },
    { alive: false, segments: [{ col: 2, row: 2 }] },
  ];
  const cctx = { agents };
  const subject = { coord: { col: 0, row: 0 } };
  eq(evaluateClause({ type: 'agentCount', comparator: '>=', value: 2, invert: false }, subject, cctx), true, '存活 2 条时满足「≥2」');
  eq(evaluateClause({ type: 'agentCount', comparator: '>=', value: 3, invert: false }, subject, cctx), false, '存活 2 条时不满足「≥3」');
  eq(evaluateClause({ type: 'agentCount', comparator: '==', value: 1, invert: true }, subject, cctx), true, '取反后结果相反');
  ok(describeClause({ type: 'agentCount', comparator: '>=', value: 2 }).includes('移动体数量'), '条件可读描述包含「移动体数量」');

  // 后果动作：移除移动体
  eq(ACTION_LABELS.removeAgent, '移除移动体', '移除移动体动作有中文标签');
  const sim = new Simulation(defaultConfig());
  const grid = sim.grid;
  const world = new World(grid, sim.states);
  const main = new Agent('main', [{ col: 4, row: 4 }], 1, { label: '主移动体', isMain: true });
  const s1 = new Agent('a1', [{ col: 1, row: 1 }], 1, { label: '蛇1', isMain: false, spawnTick: 2 });
  const s2 = new Agent('a2', [{ col: 2, row: 2 }, { col: 2, row: 3 }, { col: 2, row: 4 }], 1, { label: '蛇2', isMain: false, spawnTick: 1 });
  const actx = {
    grid, world, rng: new RNG(5), agents: [main, s1, s2], stats: {}, tick: 3,
    pending: { forcedTurns: [], lengthDelta: 0, setLength: null, end: null },
  };
  const res = applyAction({ type: 'removeAgent', target: 'largest' }, { agent: main, coord: main.head }, actx);
  eq(s2.alive, false, '「移除最长」移除了最长的移动体');
  eq(s1.alive && main.alive, true, '其它移动体与主移动体不受影响');
  eq(actx.stats.agentDeaths, 1, '移除被计入消失统计');
  eq(res.events[0].type, 'agentRemoved', '移除动作产生视觉反馈事件');
  eq(res.events[0].highlight, true, '移除事件带高亮');
  const resNone = applyAction({ type: 'removeAgent', target: 'nearest' }, { agent: main, coord: main.head }, { ...actx, agents: [main] });
  ok(resNone.text.includes('没有可移除'), '场上没有其它移动体时不报错，只给出提示');

  // 结束条件：稳定即收尾
  eq(normalizeConfig({ caMode: { enabled: true, stopOnStable: true } }).endConditions.caStable, true, '「稳定即收尾」自动打开「元胞自动机稳定」结束条件');
  eq(normalizeConfig({ caMode: { enabled: true } }).endConditions.caStable, false, '默认不开启稳定结束');
  ok(END_PRIORITY_DEFAULT.includes('caStable') && END_PRIORITY_DEFAULT.includes('allAgentsGone'), '结束优先级表包含新增项');
  ok(!!END_LABELS.caStable && !!END_LABELS.allAgentsGone, '新增结束条件有中文标签');

  // 稳定态收尾实跑（方块静物：第 3 步即判定稳定）
  const life = {
    grid: { type: 'square', width: 20, height: 20, boundary: 'wrap' },
    body: { enabled: false, initialLength: 0 },
    caMode: {
      enabled: true,
      states: [
        { name: 'empty', color: null, symbol: '.', blocking: false },
        { name: 'alive', color: '#ffd43b', symbol: 'O', blocking: false },
      ],
      neighborhood: 'moore', update: 'synchronous', boundary: 'fixed',
      initial: { mode: 'pattern', pattern: '....\n.OO.\n.OO.\n....' },
      rules: [
        { from: ['empty'], counts: [{ state: 'alive', values: [3] }], to: 'alive' },
        { from: ['alive'], counts: [{ state: 'alive', values: [0, 1, 4, 5, 6, 7, 8] }], to: 'empty' },
      ],
      stopOnStable: true,
      stableSteps: 3,
    },
    endConditions: { maxSteps: 100, wall: false, outOfBounds: false, selfCollision: false, noMove: false, caStable: true },
    seed: 3,
  };
  const rStable = new Simulation(life).run();
  eq(rStable.endReason.code, 'caStable', 'CA 进入稳定态后自动结束运行');
  eq(rStable.stats.steps, 3, '连续 3 次无变化后立即收尾', `实际 ${rStable.stats.steps} 步`);
  eq(rStable.stats.caStableCount, 3, '稳定计数正确');
  ok(rStable.endReason.label.includes('元胞自动机稳定'), '结束原因说明为元胞自动机稳定', `实际 ${rStable.endReason.label}`);

  // 结束条件：所有移动体均已消失
  {
    const cfg = defaultConfig();
    cfg.endConditions = {
      ...cfg.endConditions,
      wall: false, outOfBounds: false, selfCollision: false, selfCollisionTotal: false,
      selfCollisionConsecutive: false, obstacle: false, maxSteps: false, lengthReached: false,
      coverage: false, noMove: false, maxTime: false, ruleEnd: false, caStable: false, allAgentsGone: true,
    };
    const rs = new Simulation(cfg);
    const ectx = {
      config: rs.config, grid: rs.grid, world: new World(rs.grid, rs.states), agents: [{ alive: false }],
      stats: { agentDeaths: 2 }, tick: 5, agent: null, pending: { end: null },
    };
    const reason = rs.checkEndConditions(ectx, []);
    ok(!!reason, '所有移动体消失时触发结束条件');
    eq(reason?.code, 'allAgentsGone', '结束原因为「所有移动体均已消失」');
    eq(rs.checkEndConditions({ ...ectx, stats: { agentDeaths: 0 } }, []), null, '没有消失记录时该条件不触发（避免开局即结束）');
  }
}

/* ---------- 新增：视觉与配色配置 ---------- */
section('视觉升级与配色配置');
{
  const st = normalizeConfig({ style: { showEyes: true, showEffects: false, glow: true } }).style;
  eq(st.showEyes, true, '蛇头眼睛可主动开启');
  eq(st.showEffects, false, '交互特效波纹可关闭');
  eq(st.glow, true, '蛇身发光可开启');
  const d = normalizeConfig({}).style;
  eq(d.showEyes, false, '默认隐藏蛇头眼睛');
  eq(d.showEffects, true, '默认开启交互特效');
  eq(d.glow, false, '默认不发光');
  eq(d.trailJoin, 'line', '默认轨迹连接方式为直线型');
  eq(d.bodyJoin, 'line', '默认蛇身连接方式为直线型');
  eq(d.smoothTrail, false, '直线型派生的 smoothTrail 为 false');
  eq(d.smoothBody, false, '直线型派生的 smoothBody 为 false');
  const st2 = normalizeConfig({ style: { smoothTrail: false, smoothBody: false } }).style;
  eq(st2.smoothTrail, false, '轨迹平滑可关闭');
  eq(st2.smoothBody, false, '蛇身曲线连接可关闭');

  const pal = normalizeConfig({ multiSnake: { interaction: { colorPalette: ['#112233', 'bad', '#445566'] } } }).multiSnake.interaction.colorPalette;
  eq(pal.length, 2, '非法配色被过滤');
  ok(pal.includes('#112233') && pal.includes('#445566'), '合法配色被保留');

  const multi = normalizeConfig({
    multiSnake: { enabled: true, spawn: { mode: 'nope', times: [0, -3, 7, 2], maxAgents: 999 }, interaction: { mode: 'nope' } },
  }).multiSnake;
  eq(multi.spawn.mode, 'time', '非法生成方式回退为默认值');
  eq(multi.interaction.mode, 'collide', '非法交互方式回退为默认值');
  eq(JSON.stringify(multi.spawn.times), JSON.stringify([2, 7]), '生成时间点过滤非正数并升序');
  eq(multi.spawn.maxAgents, 64, '生成数量上限被夹取到 64');
}

/* ---------- 新增：预设模板 ---------- */
section('新增预设模板');
{
  const ids = ['ca-only', 'marker-farm', 'multi-snake', 'avoid-lab'];
  for (const id of ids) {
    const p = PRESETS.find((x) => x.id === id);
    ok(!!p, `预设 ${id} 存在`);
    ok(!!p?.name && !!p?.description, `预设 ${id} 带名称与说明`);
    const cfg = buildPresetConfig(id);
    const v = validateConfig(cfg);
    ok(v.ok, `预设 ${id} 通过结构校验`, v.errors.join('；'));
    const diags = diagnoseConfig(cfg);
    ok(!diags.some((x) => x.level === 'error'), `预设 ${id} 无严重诊断`, diags.filter((x) => x.level === 'error').map((x) => x.code).join(','));
    const r = new Simulation(cfg).run();
    ok(r.frames.length > 1, `预设 ${id} 可正常运行`, `帧数 ${r.frames.length}`);
    ok(r.stats.steps > 0, `预设 ${id} 步数大于 0`);
  }

  const caOnly = new Simulation(buildPresetConfig('ca-only')).run();
  eq(caOnly.frames[0].agents.length, 0, '纯 CA 预设不生成蛇形实体');
  ok(caOnly.stats.caSteps > 0, '纯 CA 预设的元胞自动机在演化');
  eq(caOnly.endReason.code, 'caStable', '纯 CA 预设以「元胞自动机稳定」收尾', `实际 ${caOnly.endReason.code}`);

  const farm = new Simulation(buildPresetConfig('marker-farm')).run();
  ok(farm.stats.markerInteractions > 0, '标记物预设产生交互反馈', `实际 ${farm.stats.markerInteractions}`);

  const multi = new Simulation(buildPresetConfig('multi-snake')).run();
  ok(multi.stats.spawns > 0, '多蛇预设持续生成新蛇', `实际 ${multi.stats.spawns}`);
  ok(multi.summary.peakAgents >= 2, '多蛇预设场上出现多条移动体', `峰值 ${multi.summary.peakAgents}`);
  const avoid = new Simulation(buildPresetConfig('avoid-lab')).run();
  eq(avoid.frames[0].agents[0].segments.length, 22, '安全避撞预设的初始身体完整为 22 节');
  ok(avoid.stats.steps > 0, '安全避撞预设可运行');

  /* 生命游戏：无干涉版 / 交互版 */
  const lifePlain = PRESETS.find((p) => p.id === 'life');
  eq(lifePlain?.name, '生命游戏（无干涉版）', '原生命游戏模板已重命名为「生命游戏（无干涉版）」');
  const lifeInter = PRESETS.find((p) => p.id === 'life-interactive');
  eq(lifeInter?.name, '生命游戏（交互版）', '新增「生命游戏（交互版）」模板');

  const plainCfg = buildPresetConfig('life');
  ok(validateConfig(plainCfg).ok, '无干涉版通过结构校验');
  const plainRun = new Simulation(plainCfg).run();
  eq(plainRun.stats.markerInteractions, 0, '无干涉版不产生任何标记物交互（蛇与活细胞互不干涉）');

  const interCfg = buildPresetConfig('life-interactive');
  ok(validateConfig(interCfg).ok, '交互版通过结构校验', validateConfig(interCfg).errors.join('；'));
  const interDiags = diagnoseConfig(interCfg);
  ok(!interDiags.some((d) => d.level === 'error'), '交互版无严重诊断',
    interDiags.filter((d) => d.level === 'error').map((d) => d.code).join(','));
  ok(!interDiags.some((d) => d.code === 'markerEffectIgnored'), '交互版默认已启用「蛇长度可变」，不触发交互失效警告');
  eq(interCfg.body.lengthPolicy.mode, 'variable', '交互版默认「蛇长度可变」');
  ok(interCfg.caMode.markerInteraction.states.includes('alive'), '交互版把「活细胞」登记为交互标记物');
  const interRun = new Simulation(interCfg).run();
  ok(interRun.stats.markerInteractions > 0, '交互版蛇吞噬活细胞并累计交互次数', `实际 ${interRun.stats.markerInteractions}`);
  const interGrow = interRun.frames[interRun.frames.length - 1].agents[0].length;
  ok(interGrow > interCfg.body.initialLength, '交互版吞噬后长度增加', `初始 ${interCfg.body.initialLength} → 结束 ${interGrow}`);
  ok(interRun.frames.some((f) => f.events && f.events.some((e) => e.type === 'markerInteraction' && e.delta === 1)),
    '交互事件记录为「吞噬 +1」');

  // 状态校验：把「蛇长度可变」关回固定长度，诊断应立即给出醒目提示与一键修复
  const fixedCfg = buildPresetConfig('life-interactive');
  fixedCfg.body.lengthPolicy.mode = 'fixed';
  const fixedDiag = diagnoseConfig(fixedCfg).find((d) => d.code === 'markerEffectIgnored');
  ok(!!fixedDiag, '未启用「蛇长度可变」时检出交互失效警告');
  eq(fixedDiag?.level, 'warning', '交互失效警告为警告级别');
  ok(fixedDiag?.suggestions.some((s) => s.patch.body?.lengthPolicy?.mode === 'variable'), '给出「改为可变长度」的一键修复方案');
}

/* ---------- 新增：轨迹模型与坐标筛选查询 ---------- */
section('轨迹模型与坐标筛选查询');
{
  const r = new Simulation(buildPresetConfig('avoid-lab')).run();
  const trail = buildTrail(r.grid, r.frames);

  ok(trail.path.length > 0, '轨迹路径非空');
  eq(trail.order.length, trail.info.size, 'order 与 info 数量一致');
  eq(new Set(trail.order).size, trail.order.length, 'order 中每个坐标只出现一次');

  let sorted = true;
  for (let i = 1; i < trail.path.length; i++) {
    if (trail.path[i].tick < trail.path[i - 1].tick) { sorted = false; break; }
  }
  ok(sorted, '轨迹路径按经过时间升序（新轨迹绘制在后，可完全覆盖旧轨迹）');

  const cnt = new Map();
  const firstOf = new Map();
  const lastOf = new Map();
  for (const p of trail.path) {
    cnt.set(p.index, (cnt.get(p.index) || 0) + 1);
    if (!firstOf.has(p.index)) firstOf.set(p.index, p.tick);
    lastOf.set(p.index, p.tick);
  }
  let visitsOk = true;
  let firstOk = true;
  for (const [index, cell] of trail.info) {
    if (cell.visits !== cnt.get(index)) visitsOk = false;
    if (cell.first !== firstOf.get(index) || cell.last !== lastOf.get(index)) firstOk = false;
  }
  ok(visitsOk, 'info.visits 与路径经过次数一致');
  ok(firstOk, 'info 首末步与路径一致');

  const byFirst = [...trail.info.values()].sort((a, b) => a.first - b.first || a.order - b.order);
  let orderOk = true;
  byFirst.forEach((c, i) => { if (c.order !== i + 1) orderOk = false; });
  ok(orderOk, '经过次序按首次经过时间从 1 连续编号');

  const all = queryTrail(trail, defaultTrailQuery());
  eq(all.matched, trail.order.length, '默认查询匹配全部坐标');
  ok(!trailQueryActive(defaultTrailQuery()), '默认查询视为「未设置筛选」');
  ok(trailQueryActive({ orderMax: 3 }), '设置上限即视为有效筛选');

  const head5 = queryTrail(trail, { ...defaultTrailQuery(), orderMax: 5 });
  eq(head5.matched, Math.min(5, trail.order.length), '按次序上限筛选');
  ok(head5.cells.every((c) => c.order <= 5), '次序筛选结果均不超过上限');

  const andRes = queryTrail(trail, { orderMin: 2, orderMax: 4, visitsMin: 2, logic: 'and' });
  ok(andRes.cells.every((c) => c.order >= 2 && c.order <= 4 && c.visits >= 2), '「且」逻辑同时满足全部范围条件');

  const orRes = queryTrail(trail, { orderMax: 1, visitsMin: 100, logic: 'or' });
  ok(orRes.cells.every((c) => c.order <= 1 || c.visits >= 100), '「或」逻辑满足任一范围条件');

  const inv = queryTrail(trail, { orderMax: 3, invert: true });
  eq(inv.matched, trail.order.length - Math.min(3, trail.order.length), '反选结果为匹配集合的补集');
  ok(inv.cells.every((c) => c.order > 3), '反选排除已匹配坐标');

  const stepRes = queryTrail(trail, { stepMin: 3, stepMax: 10 });
  ok(stepRes.cells.every((c) => c.first >= 3 && c.first <= 10), '按首次经过步数范围筛选');

  const norm = normalizeTrailQuery({ orderMin: -3, orderMax: -1, visitsMin: 0, logic: 'xor', invert: 1 });
  eq(norm.orderMin, 1, '次序下限至少为 1');
  eq(norm.orderMax, 0, '负数上限视为不限');
  eq(norm.visitsMin, 1, '经过次数下限至少为 1');
  eq(norm.logic, 'and', '非法逻辑回退为 and');
  eq(norm.invert, true, '反选按布尔规范化');

  const csv = trailCellsToCSV(all.cells.slice(0, 3));
  eq(csv.split('\n').length, 4, '筛选结果 CSV 为表头 + 3 行');
  ok(csv.startsWith('col,row,order,visits,firstStep,lastStep'), '筛选结果 CSV 表头正确');
  ok(trailCellsToText(all.cells.slice(0, 2)).includes('次序 #'), '筛选结果文本包含次序信息');
  ok(trailQueryLabel({ orderMin: 2, orderMax: 6 }).includes('次序'), '筛选条件可读描述包含次序');
  ok(trailQueryLabel({ invert: true }).startsWith('反选'), '反选条件描述带反选前缀');
}

/* ---------- 新增：序数范围筛选的上下限校验、可选范围与查询快路径 ---------- */
section('序数范围筛选：上下限校验 / 可选范围 / 快路径等价性');
{
  const r = new Simulation(buildPresetConfig('avoid-lab')).run();
  const trail = buildTrail(r.grid, r.frames);
  const cells = [...trail.info.values()];

  eq(TRAIL_RANGE_FIELDS.length, 3, '三组序数范围条件（次序 / 次数 / 步数）');
  const bounds = trailQueryBounds(trail);
  eq(bounds.order.max, trail.order.length, '次序上界 = 轨迹点总数');
  eq(bounds.visits.max, Math.max(...cells.map((c) => c.visits)), '次数上界 = 最大经过次数');
  eq(bounds.step.max, Math.max(...cells.map((c) => c.last)), '步数上界 = 最大经过步数');
  eq(bounds.order.min, 1, '次序下界从 1 起算');
  eq(trailQueryBounds(null).order.max, 1, '无轨迹时返回安全边界');

  ok(validateTrailQuery({ orderMin: 2, orderMax: 5 }).ok, '上限大于下限时校验通过');
  ok(validateTrailQuery({ orderMin: 5, orderMax: 5 }).ok, '上下限相等（单点区间）校验通过');
  ok(validateTrailQuery({ orderMin: 5, orderMax: 0 }).ok, '上限为 0（不限）时校验通过');
  ok(validateTrailQuery({ stepMin: 0, stepMax: 0 }).ok, '步数区间全不限时校验通过');
  const bad = validateTrailQuery({ orderMin: 8, orderMax: 3 });
  ok(!bad.ok, '上限小于下限时校验失败');
  ok(bad.errors[0].message.includes('经过次序'), '校验信息包含条件名称');
  ok(!validateTrailQuery({ visitsMin: 4, visitsMax: 2, stepMin: 9, stepMax: 1 }).ok, '多组非法区间可同时检出');

  eq(reconcileTrailQuery({ orderMin: 8, orderMax: 3 }, 'orderMin').orderMax, 8, '编辑下限时自动抬高上限');
  eq(reconcileTrailQuery({ orderMin: 8, orderMax: 3 }, 'orderMax').orderMin, 3, '编辑上限时自动下调下限');
  eq(reconcileTrailQuery({ stepMin: 6, stepMax: 2 }, 'stepMax').stepMin, 2, '步数区间按同样规则纠正');
  eq(reconcileTrailQuery({ visitsMin: 1, visitsMax: 0 }).visitsMax, 0, '上限为 0（不限）不参与纠正');
  eq(reconcileTrailQuery({ orderMin: 2, orderMax: 6 }).orderMax, 6, '合法区间不被改动');

  /** 全量遍历的朴素实现：用于验证次序切片快路径的结果一致性 */
  const brute = (query) => {
    const q = normalizeTrailQuery(query);
    return trail.order.filter((index) => {
      const c = trail.info.get(index);
      const checks = [];
      if (q.orderMax > 0 || q.orderMin > 1) checks.push(c.order >= q.orderMin && (q.orderMax === 0 || c.order <= q.orderMax));
      if (q.visitsMax > 0 || q.visitsMin > 1) checks.push(c.visits >= q.visitsMin && (q.visitsMax === 0 || c.visits <= q.visitsMax));
      if (q.stepMax > 0 || q.stepMin > 0) checks.push(c.first >= q.stepMin && (q.stepMax === 0 || c.first <= q.stepMax));
      const hit = checks.length ? (q.logic === 'or' ? checks.some(Boolean) : checks.every(Boolean)) : true;
      return q.invert ? !hit : hit;
    });
  };
  const cases = [
    { orderMin: 1, orderMax: 1 },
    { orderMin: 2, orderMax: 9 },
    { orderMin: 3, orderMax: 0 },
    { orderMin: 1, orderMax: 5, visitsMin: 2, logic: 'and' },
    { orderMin: 2, orderMax: 6, visitsMin: 2, logic: 'or' },
    { orderMin: 2, orderMax: 5, stepMin: 10, logic: 'or' },
    { visitsMin: 3, visitsMax: 5 },
    { orderMin: 1, orderMax: 4, invert: true },
    { orderMin: 2, orderMax: 6, invert: true, logic: 'or' },
  ];
  let same = true;
  for (const query of cases) {
    const fast = queryTrail(trail, query).cells.map((c) => c.index).join(',');
    if (fast !== brute(query).join(',')) same = false;
  }
  ok(same, '次序切片快路径与全量遍历结果一致（含反选与「或」组合）');

  const matchedOrder = queryTrail(trail, { orderMin: 3, orderMax: 12 }).matched;
  eq(queryTrail(trail, { orderMin: 3, orderMax: 12, invert: true }).matched,
    trail.order.length - matchedOrder, '反选结果 = 全量坐标 - 区间内坐标');

  // 实时口径：按当前播放步数截取轨迹（不重跑模拟）
  const midTick = r.frames[Math.floor(r.frames.length / 2)].tick;
  const live = sliceTrailUpToTick(trail, midTick);
  ok(live.path.length > 0 && live.path.length < trail.path.length, '中途截取得到的轨迹点子集非空且小于全量');
  ok(live.path.every((p) => p.tick <= midTick), '截取后仅保留不超过目标步数的轨迹点');
  eq(new Set(live.order).size, live.order.length, '截取后坐标不重复');
  ok(live.order.every((index, k) => live.info.get(index).order === k + 1), '截取后经过次序从 1 连续编号');
  const liveVisits = [...live.info.values()].reduce((sum, c) => sum + c.visits, 0);
  eq(liveVisits, live.path.length, '截取后逐格经过次数之和 = 轨迹点数');
  eq(sliceTrailUpToTick(trail, trail.maxTick).order.length, trail.order.length, '截取到末步时与全量轨迹一致');
  eq(sliceTrailUpToTick(trail, -1).order.length, 0, '目标步数为负时返回空轨迹');
}

/* ---------- 新增：轨迹 / 蛇身连接方式 ---------- */
section('轨迹 / 蛇身连接方式');
{
  eq(JOIN_MODES.join(','), 'curve,line,angle', '连接方式枚举为 曲线 / 直线 / 预设角度');

  const d = defaultConfig();
  eq(d.style.trailJoin, 'line', '默认轨迹连接方式为直线型');
  eq(d.style.bodyJoin, 'line', '默认蛇身连接方式为直线型');

  const line = normalizeConfig({ ...d, style: { ...d.style, trailJoin: 'line' } });
  eq(line.style.trailJoin, 'line', '轨迹可配置为直线连接');
  eq(line.style.smoothTrail, false, '直线连接派生的 smoothTrail 为 false');

  const angle = normalizeConfig({ ...d, style: { ...d.style, trailJoin: 'angle', bodyJoin: 'angle', trailAngle: 30 } });
  eq(angle.style.trailJoin, 'angle', '轨迹可配置为预设角度切角连接');
  eq(angle.style.bodyJoin, 'angle', '蛇身可配置为预设角度切角连接');
  eq(angle.style.trailAngle, 30, '保留预设角度');
  eq(normalizeConfig({ ...d, style: { ...d.style, trailAngle: 200 } }).style.trailAngle, 85, '预设角度上限收敛到 85');
  eq(normalizeConfig({ ...d, style: { ...d.style, trailAngle: 1 } }).style.trailAngle, 5, '预设角度下限收敛到 5');
  eq(normalizeConfig({ ...d, style: { ...d.style, trailJoin: 'zigzag' } }).style.trailJoin, 'line', '非法连接方式回退为默认直线');

  // 旧配置兼容：只有布尔 smoothTrail / smoothBody 时按「开=曲线，关=直线」换算
  const legacy = normalizeConfig({
    ...d,
    style: { ...d.style, trailJoin: undefined, bodyJoin: undefined, smoothTrail: false, smoothBody: true },
  });
  eq(legacy.style.trailJoin, 'line', '旧配置 smoothTrail=false 兼容为直线连接');
  eq(legacy.style.bodyJoin, 'curve', '旧配置 smoothBody=true 兼容为曲线连接');
}

section('边界穿越的环绕最短位移（动画不闪现）');
{
  const g = new Grid({ type: 'square', width: 10, height: 8, boundary: 'wrap' });
  const d1 = g.wrapDelta({ col: 0, row: 0 }, { col: 9, row: 0 });
  eq(`${d1.dc},${d1.dr}`, '-1,0', '向左穿越边界解算为 -1 步，而不是横穿 9 格');
  const d2 = g.wrapDelta({ col: 9, row: 0 }, { col: 0, row: 0 });
  eq(`${d2.dc},${d2.dr}`, '1,0', '向右穿越边界解算为 +1 步');
  const d3 = g.wrapDelta({ col: 0, row: 0 }, { col: 0, row: 7 });
  eq(`${d3.dc},${d3.dr}`, '0,-1', '向上穿越边界解算为 -1 步');
  const d4 = g.wrapDelta({ col: 0, row: 7 }, { col: 0, row: 0 });
  eq(`${d4.dc},${d4.dr}`, '0,1', '向下穿越边界解算为 +1 步');

  const d5 = g.wrapDelta({ col: 3, row: 3 }, { col: 4, row: 4 });
  eq(`${d5.dc},${d5.dr}`, '1,1', '普通一步位移保持不变');
  const d6 = g.wrapDelta({ col: 3, row: 3 }, { col: 3, row: 3 });
  eq(`${d6.dc},${d6.dr}`, '0,0', '静止时位移为 0');
  const d7 = g.wrapDelta({ col: 0, row: 0 }, { col: 5, row: 0 });
  eq(d7.dc, 5, '恰好半圈的位移不做环绕换算，避免误判');

  // 环绕落点必须仍然落在界外（供插值滑出边界），且与 wrap() 结果一致
  const unwrapped = { col: 0 + d1.dc, row: 0 + d1.dr };
  eq(unwrapped.col, -1, '未环绕落点在界外，插值时体节滑出边界而不是横穿画面');
  const back = g.wrap({ col: 9 + d2.dc, row: 0 + d2.dr });
  eq(back.col, 0, '未环绕落点经 wrap() 后回到真实落点');

  const hex = new Grid({ type: 'hex', width: 6, height: 4, boundary: 'wrap' });
  eq(hex.wrapDelta({ col: 0, row: 0 }, { col: 5, row: 0 }).dc, -1, '六边形向左穿越解算为 -1 步');
  eq(hex.wrapDelta({ col: 5, row: 0 }, { col: 0, row: 0 }).dc, 1, '六边形向右穿越解算为 +1 步');
  eq(hex.wrapDelta({ col: 0, row: 0 }, { col: 0, row: 3 }).dr, -1, '六边形向上穿越解算为 -1 步');
  eq(hex.wrapDelta({ col: 2, row: 1 }, { col: 2, row: 2 }).dr, 1, '六边形普通一步位移保持不变');
}

section('边界穿越：初始身体环绕铺设与全程体节连续（上 / 下 / 左 / 右）');
{
  const W = 8;
  const H = 6;
  const dirVec = { up: [0, -1], right: [1, 0], down: [0, 1], left: [-1, 0] };
  // 四种起始方向都让「身体延伸方向」指向最近的边界，强制初始身体跨越地图接缝铺设
  const cases = [
    { name: '向右（身体向左跨缝）', dir: 'right', start: { col: 1, row: 3 } },
    { name: '向左（身体向右跨缝）', dir: 'left', start: { col: W - 2, row: 3 } },
    { name: '向下（身体向上跨缝）', dir: 'down', start: { col: 4, row: 1 } },
    { name: '向上（身体向下跨缝）', dir: 'up', start: { col: 4, row: H - 2 } },
  ];
  const minDelta = (d, size) => Math.min(Math.abs(d), size - Math.abs(d));
  const adjacent = (a, b) => {
    const dc = minDelta(a[0] - b[0], W);
    const dr = minDelta(a[1] - b[1], H);
    return (dc === 1 && dr === 0) || (dc === 0 && dr === 1);
  };

  for (const c of cases) {
    const cfg = defaultConfig();
    cfg.grid = { type: 'square', width: W, height: H, boundary: 'wrap' };
    cfg.start = { ...c.start, direction: c.dir };
    cfg.body.initialLength = 4;
    cfg.moveRules = { left: 0, straight: 1, right: 0 };
    cfg.endConditions.maxSteps = 40;
    const res = new Simulation(cfg).run();
    ok(res.frames.length > 20, `${c.name}：产生足够帧数用于连续性校验`);

    const first = res.frames[0].agents[0].segments;
    eq(first.length, 4, `${c.name}：初始身体跨缝铺设后长度仍为 4（不被边界截断）`);
    ok(first.every((s) => s[0] >= 0 && s[0] < W && s[1] >= 0 && s[1] < H),
      `${c.name}：初始体节坐标全部规范化到网格内`);
    let broken = 0;
    for (let i = 1; i < first.length; i++) if (!adjacent(first[i - 1], first[i])) broken++;
    eq(broken, 0, `${c.name}：初始体节按环绕最短位移相邻（跨缝处不断开）`);

    const [dx, dy] = dirVec[c.dir];
    let wraps = 0;
    let stepBad = 0;
    let lenBad = 0;
    let chainBad = 0;
    for (let i = 0; i < res.frames.length; i++) {
      const segs = res.frames[i].agents[0].segments;
      if (segs.length !== 4) lenBad++;
      for (let k = 1; k < segs.length; k++) {
        if (!adjacent(segs[k - 1], segs[k])) { chainBad++; break; }
      }
      if (i === 0) continue;
      const p = res.frames[i - 1].agents[0].segments[0];
      const q = segs[0];
      const expCol = (p[0] + dx + W) % W;
      const expRow = (p[1] + dy + H) % H;
      if (q[0] !== expCol || q[1] !== expRow) stepBad++;
      if (p[0] + dx < 0 || p[0] + dx >= W || p[1] + dy < 0 || p[1] + dy >= H) wraps++;
    }
    ok(wraps > 0, `${c.name}：运行过程中确实执行了边界穿越`, `穿越次数 ${wraps}`);
    eq(stepBad, 0, `${c.name}：每一步蛇头都落在环绕后的格点上（不出现越界坐标）`);
    eq(lenBad, 0, `${c.name}：全程每帧长度恒为 4（穿越不造成体节丢失 / 增生）`);
    eq(chainBad, 0, `${c.name}：全程每帧体节链保持连续，穿越后无分离异常`);
  }

  // 环绕边界下初始长度超过总格数时按格数封顶，避免体节必然重叠
  const capped = defaultConfig();
  capped.grid = { type: 'square', width: 4, height: 3, boundary: 'wrap' };
  capped.start = { col: 0, row: 0, direction: 'right' };
  capped.body.initialLength = 40;
  capped.endConditions.maxSteps = 1;
  const cappedRes = new Simulation(capped).run();
  eq(cappedRes.frames[0].agents[0].segments.length, 12, '环绕边界下初始长度按地图总格数封顶（不再无限重叠）');
}

section('边界穿越的体节插值（不横扫画面）');
{
  // 借用 Renderer 原型构造无 DOM 的渲染上下文，只验证插值几何
  const r = Object.create(Renderer.prototype);
  r.style = { ...STYLE_DEFAULTS, cellSize: 20, gap: 2 };
  const pitch = r.style.cellSize + r.style.gap;
  const setup = (grid) => {
    r.grid = grid;
    r.size = grid.canvasSize(r.style.cellSize, r.style.gap, 18);
  };
  const cx = (col, row) => r.center({ col, row });
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  setup(new Grid({ type: 'square', width: 10, height: 8, boundary: 'wrap' }));
  // 蛇头在第 3 行向左穿越边界，身体跟在后面（正常情况下只有蛇头跨缝）
  const a = { segments: [[0, 3], [0, 4], [0, 5]] };
  const b = { segments: [[9, 3], [0, 3], [0, 4]] };
  const m = r.agentPoints(a, b, 0.5);
  const headMoved = Math.abs(m.pts[0].x - cx(0, 3).x);
  ok(headMoved <= pitch * 0.6, '穿越边界时蛇头只做一格内的位移，不会横穿整张画面',
    `实际位移 ${headMoved.toFixed(1)}px，一格 ${pitch}px`);
  ok(m.pts[0].gx !== undefined, '穿越边界的体节附带对侧镜像坐标');
  near(m.pts[0].gx, cx(9, 3).x + pitch * 0.5, 0.01, '镜像体节在对侧同步滑入');
  ok(dist(m.pts[0], m.pts[1]) <= pitch * 1.6, '穿越边界时蛇头与相邻体节仍然相邻（体节链不断开）',
    `实际间距 ${dist(m.pts[0], m.pts[1]).toFixed(1)}px`);

  const nw = r.agentPoints({ segments: [[3, 3]] }, { segments: [[4, 3]] }, 0.5);
  eq(nw.pts[0].gx, undefined, '未穿越边界时不产生镜像体节');
  near(nw.pts[0].x, cx(3.5, 3).x, 0.01, '未穿越边界时按半格平滑插值');

  setup(new Grid({ type: 'hex', width: 6, height: 4, boundary: 'wrap' }));
  const hm = r.agentPoints({ segments: [[0, 3]] }, { segments: [[5, 3]] }, 0.5);
  const hexMoved = Math.abs(hm.pts[0].x - cx(0, 3).x);
  ok(hexMoved <= pitch * 0.85, '六边形穿越边界时同样只做一格内的位移',
    `实际位移 ${hexMoved.toFixed(1)}px，一格 ${pitch}px`);
  ok(hm.pts[0].gx !== undefined, '六边形穿越边界时同样附带对侧镜像');

  // 跨缝全过程：本体（滑出的一侧）与镜像（滑入的一侧）各自都要与网格区域相交，
  // 于是任意进度下画面上都至少留着半个体节，不会出现整段消失的闪现
  setup(new Grid({ type: 'square', width: 10, height: 8, boundary: 'wrap' }));
  const rect = r.gridRect();
  const radius = (r.style.cellSize / 2) * 0.82;
  const onStage = (p) => p.x + radius > rect.left && p.x - radius < rect.right
    && p.y + radius > rect.top && p.y - radius < rect.bottom;
  const across = { segments: [[9, 3]] };
  const landed = { segments: [[0, 3]] };
  let blank = -1;
  for (let k = 0; k <= 100; k++) {
    const al = k / 100;
    const mm = r.agentPoints(across, landed, al);
    const gh = (mm.ghosts[0] || [])[0];
    if (!onStage(mm.pts[0]) && !(gh && onStage(gh))) { blank = al; break; }
  }
  eq(blank, -1, '穿越边界全过程始终有半个体节留在画面内（不出现整段消失的闪现）');
  const mid = r.agentPoints(across, landed, 0.5);
  const midGhost = (mid.ghosts[0] || [])[0];
  ok(onStage(mid.pts[0]) && !!midGhost && onStage(midGhost),
    '跨缝正中间：滑出的一侧与滑入的一侧同时各有半个体节，过渡连续无跳变');
}

section('跨缝渲染调用（裁剪到网格区域，两侧分段绘制）');
{
  // 用记录型假 ctx 跑真实的 drawAgents，核对裁剪矩形、两侧分段与状态配对
  const calls = [];
  const fakeCtx = new Proxy({}, {
    get(target, key) {
      if (key in target) return target[key];
      return function (...args) { calls.push({ name: String(key), args }); };
    },
    set(target, key, value) { target[key] = value; return true; },
  });
  const r = Object.create(Renderer.prototype);
  r.ctx = fakeCtx;
  r.canvas = { width: 268, height: 212, style: {} };
  r.style = { ...STYLE_DEFAULTS, cellSize: 26, gap: 2 };
  r.body = { segmentSize: 0.82, shape: 'round', colorMode: 'gradient', colors: { head: '#ff5d5d', tail: '#7a4dff' } };
  r.skinImg = { head: null, body: null };
  r.grid = new Grid({ type: 'square', width: 8, height: 6, boundary: 'wrap' });
  r.size = r.grid.canvasSize(r.style.cellSize, r.style.gap, 23);
  const pitch = r.style.cellSize + r.style.gap;
  const before = { id: 1, alive: true, dir: 1, color: '', segments: [[7, 3], [6, 3], [5, 3], [4, 3], [3, 3], [2, 3]] };
  const after = { id: 1, alive: true, dir: 1, color: '', segments: [[0, 3], [7, 3], [6, 3], [5, 3], [4, 3], [3, 3]] };
  r.drawAgents({ agents: [before] }, { agents: [after] }, 0.5);

  const rect = r.gridRect();
  const clipCall = calls.find((c) => c.name === 'rect');
  ok(!!clipCall, '绘制体节前先按网格区域裁剪，越界部分不会画到留白区');
  if (clipCall) {
    near(clipCall.args[0], rect.left, 0.01, '裁剪矩形左边界等于网格区域左边界');
    near(clipCall.args[1], rect.top, 0.01, '裁剪矩形上边界等于网格区域上边界');
    near(clipCall.args[2], rect.right - rect.left, 0.01, '裁剪矩形宽度等于网格区域宽度');
    near(clipCall.args[3], rect.bottom - rect.top, 0.01, '裁剪矩形高度等于网格区域高度');
  }

  // 按 beginPath → stroke/fill 归并成一条条路径，检查几何分布（裁剪用的矩形路径不计入）
  const paths = [];
  const geometry = new Set(['moveTo', 'lineTo', 'bezierCurveTo', 'quadraticCurveTo', 'arc', 'ellipse', 'rect', 'roundRect']);
  let cur = null;
  for (const c of calls) {
    if (c.name === 'beginPath') { cur = { xs: [], clip: false }; paths.push(cur); continue; }
    if (c.name === 'clip') { if (cur) cur.clip = true; continue; }
    if (c.name === 'stroke' || c.name === 'fill') { cur = null; continue; }
    if (!cur || !geometry.has(c.name)) continue;
    if (c.name === 'arc' || c.name === 'ellipse') cur.xs.push(c.args[0]);
    else if (c.name === 'rect' || c.name === 'roundRect') cur.xs.push(c.args[0], c.args[0] + c.args[2]);
    else if (c.name === 'bezierCurveTo') cur.xs.push(c.args[0], c.args[4]);
    else if (c.name === 'quadraticCurveTo') cur.xs.push(c.args[0], c.args[2]);
    else cur.xs.push(c.args[0]);
  }
  const drawn = paths.filter((p) => !p.clip);
  const leftBand = rect.left + pitch;
  const rightBand = rect.right - pitch;
  ok(drawn.some((p) => p.xs.some((x) => x <= leftBand)), '跨缝时滑入的一侧（左边界附近）确实被绘制');
  ok(drawn.some((p) => p.xs.some((x) => x >= rightBand)), '跨缝时滑出的一侧（右边界附近）确实被绘制');
  const streak = drawn.find((p) => p.xs.some((x) => x <= leftBand) && p.xs.some((x) => x >= rightBand));
  eq(streak, undefined, '没有任何一条路径同时跨到两侧，不会连出穿图长条');

  const saves = calls.filter((c) => c.name === 'save').length;
  const restores = calls.filter((c) => c.name === 'restore').length;
  ok(saves > 0 && saves === restores, 'save / restore 配对，裁剪状态不会泄漏到后续绘制',
    `save ${saves} 次，restore ${restores} 次`);
}

/* ---------- 轨迹亮度衰减 ---------- */

/** 记录型假 ctx：把每次方法调用与属性赋值都记下来，用于无头环境断言绘制行为 */
function recordingCtx() {
  const calls = [];
  const sets = [];
  const ctx = new Proxy({}, {
    get(target, key) {
      if (key in target) return target[key];
      return (...args) => { calls.push({ name: String(key), args }); };
    },
    set(target, key, value) { target[key] = value; sets.push({ name: String(key), value }); return true; },
  });
  return { ctx, calls, sets };
}

/** 不依赖 DOM 的渲染上下文（跳过 resize 中对 window 的访问） */
function headlessRenderer(style = {}) {
  const { ctx, calls, sets } = recordingCtx();
  const r = Object.create(Renderer.prototype);
  r.ctx = ctx;
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
  // 自定义皮肤缓存（无头环境下不加载图片，保持未设置状态 → 走纯色绘制分支）
  r.skinSrc = { head: '', body: '' };
  r.skinImg = { head: null, body: null };
  r.onSkinLoad = null;
  r.skinLayer = null;
  r._scratchA = { x: 0, y: 0 };
  r._scratchB = { x: 0, y: 0 };
  r._scratchC = { x: 0, y: 0 };
  return { r, calls, sets };
}

/** 用真实模拟结果装配无头渲染器 */
function attachResult(r, result) {
  r.result = result;
  r.grid = result.grid;
  r.states = result.states;
  r.body = result.config.body;
  r.trail = buildTrail(result.grid, result.frames);
  r.trailInfo = r.trail.info;
  r.pixDirty = true;
  r.size = result.grid.canvasSize(r.style.cellSize, r.style.gap, Math.max(16, Math.round(r.style.cellSize * 0.9)));
  return r;
}

section('轨迹亮度衰减（按步长衰减并完全淡出）');
{
  const { r } = headlessRenderer({ cellSize: 20, gap: 2 });
  r.grid = new Grid({ type: 'square', width: 60, height: 4, boundary: 'wrap' });
  r.size = r.grid.canvasSize(r.style.cellSize, r.style.gap, 18);

  const linear = { on: true, len: 40, mode: 'linear' };
  near(r.fadeProgress(0, linear), 1, 1e-9, '线性衰减：刚离开头部时亮度为 1');
  near(r.fadeProgress(20, linear), 0.5, 1e-9, '线性衰减：走满一半步长时亮度为 0.5');
  eq(r.fadeProgress(40, linear), 0, '线性衰减：走满衰减步长后精确归零（完全淡出）');
  eq(r.fadeProgress(9999, linear), 0, '线性衰减：远超衰减步长后仍为 0，不会回升');
  ok(r.fadeProgress(10, linear) > r.fadeProgress(30, linear), '线性衰减：越老的轨迹越暗（单调递减）');

  const exp = { on: true, len: 40, mode: 'exponential' };
  near(r.fadeProgress(0, exp), 1, 1e-9, '指数衰减：新点亮度为 1');
  eq(r.fadeProgress(40, exp), 0, '指数衰减：走满衰减步长后精确归零');
  ok(r.fadeProgress(10, exp) < r.fadeProgress(10, linear), '指数衰减在前期比线性更快变暗（先急后缓）');
  ok(r.fadeProgress(38, exp) < r.fadeProgress(38, linear), '指数衰减在尾端比线性更暗，尾巴收得更干净');

  const th = r.theme();
  eq(r.fadeAt(th, 0, 6).alpha, 0, '亮度进度为 0 时不透明度为 0（彻底淡出，不再保留恒亮的长尾）');
  near(r.fadeAt(th, 1, 6).alpha, 0.62, 1e-9, '亮度进度为 1 时达到最亮不透明度');
  ok(r.fadeAt(th, 1, 6).alpha > r.fadeAt(th, 0.5, 6).alpha, '不透明度随亮度进度递增');
  ok(r.fadeAt(th, 1, 6).width > r.fadeAt(th, 0.2, 6).width, '越新的轨迹越粗');
  ok(r.fadeAt(th, 0.2, 6).width >= 0.5, '描边宽度有下限，细线段仍可见');
  near(r.fadeAt({ trailA: '#000000', trailB: '#ffffff' }, 0.5, 4).alpha, 0.31, 1e-9, '线性中段不透明度为最亮值的一半');
}

section('高步数场景：衰减窗口裁剪（100 步以上不再整条常亮）');
{
  const runFor = (steps) => {
    const cfg = defaultConfig();
    cfg.grid = { ...cfg.grid, type: 'square', width: 120, height: 30, boundary: 'wrap' };
    cfg.start = { col: 60, row: 15, direction: 'right' };
    cfg.endConditions.maxSteps = steps;
    cfg.endConditions.wall = false;
    cfg.style = { ...cfg.style, cellSize: 10, gap: 1, trailFade: true, fadeMode: 'linear', fadeLength: 40, trailJoin: 'line' };
    return new Simulation(cfg, { frameCap: 20000 }).run();
  };
  const measure = (steps) => {
    const result = runFor(steps);
    const { r, calls, sets } = headlessRenderer({ cellSize: 10, gap: 1, trailFade: true, fadeMode: 'linear', fadeLength: 40, trailJoin: 'line' });
    attachResult(r, result);
    const last = result.frames[result.frames.length - 1];
    r.drawTrail(last, r.theme(), last.tick);
    const pts = calls.filter((c) => c.name === 'moveTo' || c.name === 'lineTo');
    // 分桶会把相邻段拆成多条折线，折线衔接处会重复传一次坐标，因此另取去重点数作为「窗口内真实轨迹点数」
    const unique = new Set(pts.map((c) => `${Math.round(c.args[0])},${Math.round(c.args[1])}`)).size;
    // drawTrailLine 结尾会把 globalAlpha 复位为 1，这里排除掉，只看真正用于描边的亮度
    const alphas = sets.filter((s) => s.name === 'globalAlpha' && s.value !== 1).map((s) => s.value);
    // 衰减窗口内的轨迹点数（真实应绘制上限，与总步数无关）
    const win = r.trail.path.filter((p) => p.tick >= last.tick - 40 && p.tick <= last.tick).length;
    return { tick: last.tick, trailTick: r.trail.maxTick, segments: pts.length, unique, alphas, win, pathLen: r.trail.path.length };
  };

  const small = measure(120);
  const large = measure(600);
  ok(small.tick >= 100, `多步数场景确实跑到 100 步以上（实际 ${small.tick} 步）`);
  ok(large.tick >= 500, `对照场景步数更高（实际 ${large.tick} 步）`);
  ok(small.pathLen > 40, `轨迹总点数远大于衰减窗口（${small.pathLen} 个点）`);
  ok(small.win === 41 && large.win === 41, `衰减窗口固定为 41 个点，不随总步数变化（${small.win} / ${large.win}）`);
  ok(small.unique <= small.win && large.unique <= large.win,
    `只绘制衰减窗口内的点，不再整条常亮（120 步 ${small.unique} 个 / 600 步 ${large.unique} 个真实点）`);
  ok(small.segments <= small.win * 2 && large.segments <= large.win * 2,
    `分桶拆段只带来常数级开销（${small.segments} / ${large.segments} 次描点，窗口 ${small.win} 点）`);
  ok(large.segments * 6 < large.pathLen,
    `高步数下绘制量远小于轨迹总长（${large.segments} 次描点 vs ${large.pathLen} 个轨迹点）`);

  const minAlpha = Math.min(...small.alphas);
  const maxAlpha = Math.max(...small.alphas);
  ok(minAlpha < 0.05, `最老的轨迹点不透明度已接近 0（实际 ${minAlpha.toFixed(4)}），尾巴能完全淡出`);
  // 分桶描边取的是「档内两端点的平均亮度」，因此最亮档略低于理论峰值 0.62，但仍应明显亮于中段
  ok(maxAlpha > 0.55, `紧贴头部的轨迹点保持最亮（实际 ${maxAlpha.toFixed(4)}，峰值须明显高于阈值）`);
  ok(maxAlpha - minAlpha > 0.5, `同一帧内存在明显的亮度落差（${maxAlpha.toFixed(4)} → ${minAlpha.toFixed(4)}），不再是一片常亮`);
  ok(!small.alphas.includes(0), '不绘制不透明度为 0 的线段（已淡出的点直接跳过）');

  // 关闭渐隐时不做裁剪，且整条轨迹亮度一致
  const { r, calls, sets } = headlessRenderer({ cellSize: 10, gap: 1, trailFade: false, trailJoin: 'line' });
  const result = runFor(120);
  attachResult(r, result);
  const last = result.frames[result.frames.length - 1];
  r.drawTrail(last, r.theme(), last.tick);
  const points = calls.filter((c) => c.name === 'moveTo' || c.name === 'lineTo').length;
  const alphas = sets.filter((s) => s.name === 'globalAlpha' && s.value !== 1).map((s) => s.value);
  ok(points > 41, `关闭「轨迹渐隐」时保留完整轨迹（${points} 个点）`);
  ok(alphas.length > 0 && alphas.every((a) => Math.abs(a - 0.34) < 1e-9), `关闭渐隐时全部轨迹点使用同一不透明度（${alphas.length} 段）`);
}

section('自定义衰减参数（模式 / 步长）');
{
  eq(FADE_MODES.join(','), 'linear,exponential', '衰减模式枚举为 线性 / 指数');
  const d = defaultConfig();
  eq(d.style.fadeMode, 'linear', '默认衰减模式为线性');
  eq(d.style.fadeLength, 60, '默认衰减步长为 60 步');

  const n1 = normalizeConfig({ ...d, style: { ...d.style, fadeMode: 'exponential', fadeLength: 300 } });
  eq(n1.style.fadeMode, 'exponential', '可配置为指数衰减');
  eq(n1.style.fadeLength, 300, '可自定义衰减步长');

  eq(normalizeConfig({ ...d, style: { ...d.style, fadeMode: 'zigzag' } }).style.fadeMode, 'linear', '非法衰减模式回退为线性');
  eq(normalizeConfig({ ...d, style: { ...d.style, fadeLength: 99999 } }).style.fadeLength, FADE_LENGTH_LIMIT.max, '衰减步长上限收敛');
  eq(normalizeConfig({ ...d, style: { ...d.style, fadeLength: 0 } }).style.fadeLength, FADE_LENGTH_LIMIT.min, '衰减步长下限收敛');
  eq(normalizeConfig({ ...d, style: { ...d.style, fadeLength: -5 } }).style.fadeLength, FADE_LENGTH_LIMIT.min, '负数衰减步长收敛到下限');

  // 分享链接需要完整保留衰减参数
  const round = decodeConfigFromToken(encodeConfigToToken(n1));
  eq(round.style.fadeMode, 'exponential', '分享链接保留衰减模式');
  eq(round.style.fadeLength, 300, '分享链接保留衰减步长');

  // 预设模板跟随默认直线型配置
  const preset = buildPresetConfig('random-walk');
  eq(preset.style.trailJoin, 'line', '预设模板继承默认直线型轨迹');
  eq(preset.style.bodyJoin, 'line', '预设模板继承默认直线型蛇身');
}

section('轨迹快照与多轨迹对比');
{
  const cfg = defaultConfig();
  cfg.grid = { ...cfg.grid, type: 'square', width: 24, height: 18, boundary: 'wrap' };
  cfg.start = { col: 12, row: 9, direction: 'up' };
  cfg.endConditions.maxSteps = 80;
  cfg.endConditions.wall = false;
  const r1 = new Simulation(JSON.parse(JSON.stringify(cfg)), { frameCap: 20000 }).run();
  const cfg2 = JSON.parse(JSON.stringify(cfg));
  cfg2.seed = cfg.seed + 7;
  const r2 = new Simulation(cfg2, { frameCap: 20000 }).run();

  const t1 = buildTrail(r1.grid, r1.frames);
  const t2 = buildTrail(r2.grid, r2.frames);
  const s1 = snapshotTrail(t1, r1.grid, '基准');
  const s2 = snapshotTrail(t2, r2.grid, '当前');

  eq(s1.cells.length, t1.order.length, '快照保存全部轨迹格');
  eq(s1.path.length, t1.path.length, '快照保存完整头部路径（供叠加虚线轨迹）');
  eq(s1.cells[0].order, 1, '快照保留经过次序');
  eq(s1.takenAtTick, t1.maxTick, '快照记录冻结时的步数');
  ok(snapshotMatchesGrid(s1, r2.grid), '同类型同尺寸网格可对比');
  ok(!snapshotMatchesGrid(s1, new Grid({ type: 'hex', width: 24, height: 18 })), '网格类型不同时不可对比');
  ok(!snapshotMatchesGrid(s1, new Grid({ type: 'square', width: 25, height: 18 })), '网格尺寸不同时不可对比');
  ok(!snapshotMatchesGrid(null, r2.grid), '空快照判定为不可对比');

  const self = compareSnapshots(s1, s1);
  eq(self.shared.length, s1.cells.length, '同一轨迹自比：全部格都在交集');
  eq(self.onlyBase.length, 0, '同一轨迹自比：没有仅基准的格');
  eq(self.onlyOther.length, 0, '同一轨迹自比：没有仅当前的格');
  eq(self.overlapRatio, 1, '同一轨迹自比：重合率为 1');
  eq(compareSnapshots(null, null).overlapRatio, 1, '空输入不产生 NaN 重合率');

  const diff = compareSnapshots(s1, s2);
  eq(diff.shared.length + diff.onlyBase.length + diff.onlyOther.length, diff.union, '三类格子之和等于并集格数');
  eq(diff.baseCount, s1.cells.length, '基准覆盖格数取自快照');
  eq(diff.otherCount, s2.cells.length, '当前覆盖格数取自当前轨迹');
  ok(diff.overlapRatio > 0 && diff.overlapRatio < 1, '不同种子下既有重合路径也有差异路径');
  ok(diff.maxTickBase === t1.maxTick && diff.maxTickOther === t2.maxTick, '对比结果带上两条轨迹各自的步数');

  const csv = compareToCSV({ ...diff, grid: r1.grid });
  const lines = csv.split('\n');
  eq(lines.length, diff.union + 1, '对比 CSV 行数 = 并集格数 + 表头');
  eq(lines[0], 'col,row,status', '对比 CSV 带表头');
  ok(lines.slice(1).every((l) => /^\d+,\d+,(共有|仅基准|仅当前)$/.test(l)), '对比 CSV 每行是坐标 + 状态');

  const text = compareToText(diff);
  ok(text.includes('重合率'), '对比摘要包含重合率');
  ok(text.includes('仅基准') && text.includes('仅当前'), '对比摘要分别给出两类差异格数');
}

section('纯轨迹 SVG 导出');
{
  const cfg = defaultConfig();
  cfg.grid = { ...cfg.grid, type: 'square', width: 20, height: 14, boundary: 'wrap' };
  cfg.start = { col: 10, row: 7, direction: 'right' };
  cfg.endConditions.maxSteps = 120;
  cfg.endConditions.wall = false;
  cfg.style = { ...cfg.style, cellSize: 16, gap: 2, showGrid: true, trailFade: true, fadeMode: 'linear', fadeLength: 40 };
  const result = new Simulation(cfg, { frameCap: 20000 }).run();

  const svg = trailToSVG(result, cfg.style);
  ok(svg.startsWith('<svg'), 'SVG 以 <svg 开头');
  ok(svg.trimEnd().endsWith('</svg>'), 'SVG 正常闭合');
  ok(!svg.includes('NaN'), 'SVG 中不含 NaN 坐标');
  ok(!svg.includes('undefined'), 'SVG 中不含 undefined');
  const polys = svg.match(/<polyline /g) || [];
  ok(polys.length > 0, 'SVG 含轨迹折线');
  ok(polys.length <= 64, `折线数量受衰减窗口与色阶限制，高步数下不爆炸（${polys.length} 条）`);
  const opacities = [...svg.matchAll(/stroke-opacity="([\d.]+)"/g)].map((m) => Number(m[1]));
  ok(new Set(opacities).size >= 3, '轨迹折线带多档渐变不透明度');
  ok(Math.min(...opacities) < 0.05, '最老的轨迹段接近完全透明（尾巴淡出）');
  ok(Math.max(...opacities) > 0.6, '最亮的轨迹段保持清晰');
  ok(svg.includes('线性'), '标注当前衰减模式');
  ok(svg.includes('渐隐'), '标注渐隐参数');
  ok(/<circle[^>]*#51cf66/.test(svg), '标出起点');
  ok(/<circle[^>]*#ffd43b/.test(svg), '标出头部位置');
  eq((svg.match(/<rect /g) || []).length, 1 + cfg.grid.width * cfg.grid.height, '网格轮廓为每格一个 rect（外加背景）');

  const noFade = trailToSVG(result, { ...cfg.style, trailFade: false });
  const opacities2 = [...noFade.matchAll(/stroke-opacity="([\d.]+)"/g)].map((m) => Number(m[1]));
  ok(opacities2.length > 0 && opacities2.every((o) => Math.abs(o - 0.62) < 1e-9), '关闭渐隐时所有轨迹段亮度一致');
  ok(noFade.includes('轨迹不渐隐'), '关闭渐隐时标注为不渐隐');

  const expSvg = trailToSVG(result, { ...cfg.style, fadeMode: 'exponential' });
  ok(expSvg.includes('指数'), '可导出指数衰减模式');
}

/* ---------- 迭代优化：运行计时 / 分享链接兼容 ---------- */
section('运行计时与分享链接的本地兼容');
{
  const cfg = defaultConfig();
  cfg.grid = { ...cfg.grid, width: 10, height: 10 };
  cfg.endConditions.maxSteps = 30;
  const r = new Simulation(cfg).run();
  ok(Number.isFinite(r.elapsedMs), '运行结果包含耗时字段（毫秒）');
  ok(r.elapsedMs >= 0, `耗时为非负数（${r.elapsedMs.toFixed(2)} ms）`);

  // file:// 本地单文件打开时 location.origin 为字面量 "null"，
  // 分享链接必须退回到去掉片段后的完整地址，不能生成 "null/…" 这种不可用链接
  const saved = globalThis.location;
  try {
    globalThis.location = {
      origin: 'null',
      pathname: '/D:/Trae/qqyoutput/0922/GridSneaker.html',
      href: 'file:///D:/Trae/qqyoutput/0922/GridSneaker.html#c=stale',
    };
    const localUrl = buildShareUrl(cfg);
    ok(localUrl.startsWith('file:///') && localUrl.includes('#c='), '本地打开时分享链接保留完整文件地址与配置片段');
    ok(!localUrl.includes('null'), '本地打开时分享链接不含 "null" 前缀');
    ok(localUrl.indexOf('#') === localUrl.lastIndexOf('#'), '分享链接只保留一个片段分隔符');

    globalThis.location = { origin: 'https://example.com', pathname: '/snake/', href: 'https://example.com/snake/' };
    const webUrl = buildShareUrl(cfg);
    eq(webUrl.slice(0, 'https://example.com/snake/#c='.length), 'https://example.com/snake/#c=', 'http(s) 打开时分享链接格式不变');
    const token = webUrl.split('#c=')[1];
    ok(!!decodeConfigFromToken(token), '分享链接中的配置片段可正常解码');
  } finally {
    if (saved === undefined) delete globalThis.location;
    else globalThis.location = saved;
  }
}

/* ---------- 迭代优化：得分系统 / 动态难度 / 边界穿越修复 ---------- */

section('得分系统（总分 / 等级 / 分项）');
{
  eq(formatScore(0), '0', '千分位格式：0');
  eq(formatScore(999), '999', '千分位格式：不足千位不加分隔符');
  eq(formatScore(1234567), '1,234,567', '千分位格式：百万级正确分组');
  eq(formatScore(-5), '-5', '千分位格式：负数不产生异常分组');

  const grid = new Grid({ type: 'square', width: 20, height: 20 }); // size = 400
  const stats = {
    maxLength: 10, coverage: 25, steps: 100,
    markerInteractions: 2, merges: 1, repels: 3, spawns: 1,
    collisionsTotal: 4, selfCollisions: 2,
  };
  const s = computeScore(stats, grid, { code: 'coverage' });
  // growth 10×12=120 + explore 25×6=150 + endurance 100×0.8=80
  // + interaction 2×15+1×25+3×5+1×10=80 + bonus(coverage)=350 - penalty (4×3+2×8)=28 → 752
  eq(s.total, 752, '总分按分项权重精确折算');
  eq(s.parts.length, 6, '得分包含 6 个分项（成长 / 探索 / 存活 / 交互 / 收尾奖励 / 碰撞罚分）');
  eq(s.parts.find((p) => p.key === 'penalty').value, -28, '碰撞罚分以负值计入');
  eq(s.endCode, 'coverage', '记录结束原因代码用于收尾奖励');

  const zero = computeScore(
    { maxLength: 0, coverage: 0, steps: 0, collisionsTotal: 100, selfCollisions: 100 },
    grid,
    { code: 'wall' },
  );
  eq(zero.total, 0, '罚分超过收益时总分下限为 0，不出现负分');

  eq(gradeFor(760, grid).grade, 'S', '相对分 ≥1.9 判为 S');
  eq(gradeFor(500, grid).grade, 'A', '相对分 ≥1.25 判为 A');
  eq(gradeFor(300, grid).grade, 'B', '相对分 ≥0.75 判为 B');
  eq(gradeFor(160, grid).grade, 'C', '相对分 ≥0.4 判为 C');
  eq(gradeFor(10, grid).grade, 'D', '低相对分判为 D');
  ok(gradeFor(760, grid).ratio > gradeFor(500, grid).ratio, '等级判定基于与网格尺寸无关的相对分');

  // 集成：运行结果必须携带结算得分
  const cfg = defaultConfig();
  cfg.grid = { ...cfg.grid, type: 'square', width: 16, height: 12, boundary: 'wrap' };
  cfg.endConditions.maxSteps = 60;
  cfg.endConditions.wall = false;
  const r = new Simulation(cfg).run();
  ok(!!r.summary.score, '运行结果携带结算得分对象');
  ok(Number.isFinite(r.summary.score.total) && r.summary.score.total >= 0, '结算总分是非负有限数');
  ok(typeof r.summary.score.gradeLabel === 'string' && r.summary.score.gradeLabel.length > 0, '结算结果携带评分等级标签');
  ok(computeScore(r.stats, r.grid, r.endReason).total === r.summary.score.total, '同一统计量重复计算得分结果一致（纯函数）');
}

section('动态难度评估（拥挤度 / 等级 / 自适应倍率）');
{
  const grid = new Grid({ type: 'square', width: 20, height: 20 }); // size = 400
  eq(crowdingOf({ coverage: 0, length: 0, agents: 1 }, grid), 0, '空旷场景拥挤度为 0');
  near(crowdingOf({ coverage: 100, length: 400, agents: 1 }, grid), 0.9, 1e-9, '单个移动体占满地图时拥挤度为 0.9');
  eq(crowdingOf({ coverage: 100, length: 400, agents: 7 }, grid), 1, '多移动体同时占满时拥挤度达到上限 1');
  eq(crowdingOf({ coverage: 999, length: 99999, agents: 99 }, grid), 1, '异常输入被夹取到上限 1');
  eq(crowdingOf({ coverage: -5, length: -5, agents: 0 }, grid), 0, '异常输入被夹取到下限 0');

  eq(difficultyOf({ coverage: 0, length: 1, agents: 1 }, grid).label, '轻松', '低拥挤度为「轻松」');
  eq(difficultyOf({ coverage: 100, length: 400, agents: 1 }, grid).label, '绝境', '高拥挤度为「绝境」');
  eq(difficultyOf({ coverage: 0, length: 0, agents: 1 }, grid).level, 1, '难度等级为 1~5 的整数');
  eq(difficultyOf({ coverage: 100, length: 400, agents: 1 }, grid).level, 5, '最高难度等级为 5');

  eq(adaptiveSpeedScale({ coverage: 0, length: 0, agents: 1 }, grid), 1, '轻松时不放慢播放');
  ok(adaptiveSpeedScale({ coverage: 100, length: 400, agents: 1 }, grid) < 0.5, '绝境时显著放慢播放');
  const scales = [0, 20, 40, 60, 80, 100].map((c) => adaptiveSpeedScale({ coverage: c, length: 0, agents: 1 }, grid));
  ok(scales.every((v, i) => i === 0 || v <= scales[i - 1]), '播放倍率随拥挤度单调不增（不会越拥挤越快）');

  // 网格为空时不应抛错（界面在尚未运行时也会取一次难度）
  const empty = difficultyOf({}, null);
  eq(empty.level, 1, '无网格 / 无统计时回退到最低难度');
  ok(Number.isFinite(empty.crowding), '无网格时拥挤度为有限数');
}

section('边界穿越：四角不误判「无路可走」');
{
  /** 构造只含边界判定所需字段的上下文（不依赖 World 状态表） */
  const mkCtx = (sim, segments, blocked) => {
    const agent = new Agent('main', segments, 1, { label: '主移动体', isMain: true });
    return {
      grid: sim.grid,
      world: {
        isBlocking: (c) => blocked.has(`${c.col},${c.row}`),
        get: () => 'empty',
      },
      agents: [agent],
      agent,
      config: sim.config,
      rng: new RNG(11),
      tick: 5,
      stats: { selfCollisions: 0, selfCollisionsConsecutive: 0, coverage: 0, caStableCount: 0, agentDeaths: 0 },
      logs: [],
      log: () => { /* 不收集日志 */ },
      highlights: [],
      pending: { forcedTurns: [], lengthDelta: 0, setLength: null, end: null },
    };
  };

  // 四角蛇头：界内两个方向被占，越界的两个方向在 wrap 下应环绕到对侧
  const wrapCfg = defaultConfig();
  wrapCfg.grid = { type: 'square', width: 4, height: 4, boundary: 'wrap' };
  wrapCfg.endConditions.noMove = true;
  const wrapSim = new Simulation(wrapCfg);
  const cornerBlocked = new Set(['1,0', '0,1']);

  // resolveCandidate：wrap 下越界坐标环绕回网格内并被判定为可达
  const probe = { grid: wrapSim.grid, config: wrapSim.config };
  const up = wrapSim.resolveCandidate(probe, { col: -1, row: 0 });
  eq(`${up.ok}:${up.coord.col},${up.coord.row}:${up.wrapped}`, 'true:3,0:true', 'wrap：越界坐标环绕回对侧且标记为环绕');
  const left = wrapSim.resolveCandidate(probe, { col: 0, row: -1 });
  eq(`${left.coord.col},${left.coord.row}`, '0,3', 'wrap：向上越界环绕到同行对侧边界');
  const inside = wrapSim.resolveCandidate(probe, { col: 1, row: 0 });
  eq(`${inside.ok}:${inside.wrapped}`, 'true:false', 'wrap：界内坐标不标记为环绕');

  eq(
    wrapSim.checkEndConditions(mkCtx(wrapSim, [{ col: 0, row: 0 }], cornerBlocked), []),
    null,
    '四角 + 边界穿越：环绕方向可走，不判定「无路可走」',
  );

  // 对照：非穿越边界下同样局面确实无路可走（保证判定未被放宽）
  const stopCfg = defaultConfig();
  stopCfg.grid = { type: 'square', width: 4, height: 4, boundary: 'stop' };
  stopCfg.endConditions.noMove = true;
  const stopSim = new Simulation(stopCfg);
  const stopProbe = { grid: stopSim.grid, config: stopSim.config };
  eq(stopSim.resolveCandidate(stopProbe, { col: -1, row: 0 }).ok, false, '非穿越边界：越界坐标判定为不可达');
  const stopEnd = stopSim.checkEndConditions(mkCtx(stopSim, [{ col: 0, row: 0 }], cornerBlocked), []);
  ok(stopEnd && stopEnd.code === 'noMove', '非穿越边界：四角被围住时正确判定「无路可走」');

  // 环绕落点也被占据时，四角同样应判为无路可走
  const sealed = new Set(['1,0', '0,1', '3,0', '0,3']);
  const sealedEnd = wrapSim.checkEndConditions(mkCtx(wrapSim, [{ col: 0, row: 0 }], sealed), []);
  ok(sealedEnd && sealedEnd.code === 'noMove', '四角 + 边界穿越：环绕落点也被占满时正确判定「无路可走」');
}

section('边界穿越：穿梭特效与跨缝渲染连续性');
{
  const cfg = defaultConfig();
  cfg.grid = { type: 'square', width: 10, height: 8, boundary: 'wrap' };
  cfg.start = { col: 0, row: 4, direction: 'left' };
  cfg.body.initialLength = 8;
  cfg.moveRules = { left: 0, straight: 1, right: 0 }; // 固定直行，保证每步都跨缝
  cfg.endConditions.maxSteps = 60;
  cfg.endConditions.wall = false;
  const result = new Simulation(cfg).run();

  // 1) 模拟层：穿越写入 'wrap' 高亮，并记录滑出侧坐标（位于网格外）
  const wrapFrames = result.frames.filter((f) => f.highlights.some((h) => h.type === 'wrap'));
  ok(wrapFrames.length > 0, '开启边界穿越后画面高亮包含穿梭特效');
  const h = wrapFrames[0].highlights.find((x) => x.type === 'wrap');
  ok(
    h.fromCol < 0 || h.fromCol >= cfg.grid.width || h.fromRow < 0 || h.fromRow >= cfg.grid.height,
    '穿梭特效记录滑出侧坐标（位于网格外）',
  );
  ok(result.grid.inBounds({ col: h.col, row: h.row }), '穿梭特效落点位于网格内（滑入侧）');

  // 2) 渲染层：无头渲染器能正常绘制穿梭光带并裁剪到网格区域
  const { r: fx, calls: fxCalls } = headlessRenderer({ showEffects: true });
  attachResult(fx, result);
  const fxIndex = result.frames.findIndex((f) => f === wrapFrames[0]);
  fx.drawEffects(fxIndex);
  ok(fxCalls.some((c) => c.name === 'clip'), '穿梭光带按网格区域裁剪绘制');
  ok(fxCalls.filter((c) => c.name === 'stroke').length > 0, '穿梭光带产生描边绘制调用');

  // 3) 渲染层：任意插值进度下，本体链与镜像链都保持连续（无孤立副本）
  const { r: rend } = headlessRenderer();
  attachResult(rend, result);
  const pitch = rend.center({ col: 1, row: 0 }).x - rend.center({ col: 0, row: 0 }).x;
  const maxGap = pitch * 1.6;
  let gapViolations = 0;
  let shapeViolations = 0;
  let crossingSamples = 0;
  const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
  for (let i = 1; i < result.frames.length; i++) {
    const a = result.frames[i - 1].agents[0];
    const b = result.frames[i].agents[0];
    if (!a.segments.length || !b.segments.length) continue;
    for (const alpha of [0.1, 0.35, 0.5, 0.75, 0.95]) {
      const model = rend.agentPoints(a, b, alpha);
      for (let k = 1; k < model.pts.length; k++) {
        if (dist(model.pts[k], model.pts[k - 1]) > maxGap) gapViolations++;
      }
      // 镜像副本取自同一条连续展开链，长度必须与本体一致、且自身同样连续
      for (const run of model.ghosts) {
        if (run.length !== model.pts.length) shapeViolations++;
        for (let k = 1; k < run.length; k++) {
          if (dist(run[k], run[k - 1]) > maxGap) shapeViolations++;
        }
      }
      if (model.ghosts.length) crossingSamples++;
    }
  }
  eq(gapViolations, 0, '本体链在任意插值进度下相邻体节间距均不超过 1.6 格（无视觉断层）');
  eq(shapeViolations, 0, '镜像链与本体链形状一致（不出现孤立单节副本）');
  ok(crossingSamples > 0, '测试确实覆盖了跨缝插值场景');
}

/* ---------- 配置差异比对（模板载入改动检测） ---------- */
section('配置差异比对（模板载入改动检测）');
{
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const base = defaultConfig();

  // 1) 未改动：不应产生任何差异条目
  eq(diffConfigs(base, clone(base)).length, 0, '完全相同的配置不产生差异条目');
  eq(diffConfigs(base, clone(base)).length, 0, '重复调用结果稳定（纯函数无副作用）');
  ok(base.grid.width === 24, '基准配置网格宽度为默认值 24（后续断言依赖）');

  // 2) 标量字段：输出中文化的「字段：旧 → 新」文本
  {
    const next = clone(base);
    next.grid.width = 40;
    const changes = diffConfigs(base, next);
    eq(changes.length, 1, '仅改动一个标量字段时只产生一条差异');
    eq(changes[0].section, 'grid', '差异条目归属配置分组 grid');
    eq(changes[0].path, 'grid.width', '差异条目带有完整字段路径');
    eq(changes[0].label, '宽', '字段名中文化为「宽」');
    eq(changes[0].kind, 'value', '标量差异 kind 为 value');
    eq(changes[0].text, '宽：24 → 40', '标量差异文本形如「宽：24 → 40」');
  }

  // 3) 枚举字段：取值中文化，而不是直接暴露英文键名
  {
    const next = clone(base);
    next.grid.boundary = 'stop';
    next.collision.obstacle = 'pass';
    next.caMode.neighborhood = 'vonNeumann';
    const changes = diffConfigs(base, next);
    const byPath = new Map(changes.map((c) => [c.path, c]));
    eq(byPath.size, 3, '三处枚举改动各产生一条差异');
    eq(byPath.get('grid.boundary').text, '边界行为：穿越到另一侧 → 停止（撞墙即停）', '边界行为枚举取中文文案');
    eq(byPath.get('collision.obstacle').text, '撞障碍物：停止 → 直接穿过', '碰撞处理枚举取中文文案');
    eq(byPath.get('caMode.neighborhood').text, '邻域：8 邻域（Moore） → 4 邻域（Von Neumann）', '元胞邻域枚举取中文文案');
  }

  // 4) 布尔字段：以「开 / 关」呈现
  {
    const next = clone(base);
    next.multiSnake.enabled = true;
    const change = diffConfigs(base, next).find((c) => c.path === 'multiSnake.enabled');
    ok(!!change, '布尔字段改动会被识别');
    eq(change.text, '启用：关 → 开', '布尔差异以「开 / 关」呈现');
  }

  // 5) 数组（规则表 / 状态表）：整体内容变化只报告一条，不递归展开
  {
    const next = clone(base);
    next.environmentRules = [defaultRule({ name: '新规则' })];
    next.caMode.states = [...next.caMode.states, { name: 'sand', color: '#e8c07d', blocking: false, symbol: 'S', render: 'fill' }];
    const changes = diffConfigs(base, next);
    eq(changes.length, 2, '两个数组字段各产生一条差异（不逐元素展开）');
    const rules = changes.find((c) => c.path === 'environmentRules');
    const states = changes.find((c) => c.path === 'caMode.states');
    eq(rules.kind, 'list', '规则表差异 kind 为 list');
    eq(rules.label, '环境规则表', '顶层规则表字段名中文化');
    ok(/内容已改动/.test(rules.text) && /0 项 → 1 项/.test(rules.text), '规则表差异文本给出规模变化');
    eq(states.text, '状态表：内容已改动（3 项 → 4 项）', '状态表差异文本给出规模变化');
  }

  // 6) 派生 / 内部字段不参与比对，避免产生噪声
  {
    const next = clone(base);
    next.version = '9.9';
    next.style.smoothTrail = !next.style.smoothTrail;
    next.style.smoothBody = !next.style.smoothBody;
    eq(diffConfigs(base, next).length, 0, '版本号与平滑派生字段改动不计入差异');
  }

  // 7) 值描述：空值 / 数组 / 布尔 / 超长文本
  eq(describeConfigValue(undefined), '（空）', 'undefined 描述为「（空）」');
  eq(describeConfigValue(null), '（空）', 'null 描述为「（空）」');
  eq(describeConfigValue([]), '0 项', '空数组描述为「0 项」');
  eq(describeConfigValue([1, 2]), '2 项', '数组描述为元素个数');
  eq(describeConfigValue(true), '开', 'true 描述为「开」');
  eq(describeConfigValue(false), '关', 'false 描述为「关」');
  eq(describeConfigValue('x'.repeat(40)).length, 29, '超长文本截断为 28 字 + 省略号');
  ok(describeConfigValue('x'.repeat(40)).endsWith('…'), '超长文本以省略号结尾');

  // 8) 分组聚合：标题使用中文分组名，且保持首次出现顺序
  {
    const next = clone(base);
    next.meta.name = '我的场景';
    next.grid.width = 40;
    next.grid.height = 30;
    next.style.cellSize = 18;
    const changes = diffConfigs(base, next);
    eq(changes.length, 4, '四处改动共产生四条差异');
    const groups = summarizeConfigChanges(changes);
    eq(groups.length, 3, '聚合为 3 个分组');
    eq(groups.map((g) => g.title).join('|'), '场景信息|网格与坐标|展示样式', '分组标题为中文且顺序与配置结构一致');
    eq(groups[1].items.length, 2, '同一分组的多个改动归入同一节');
    eq(groups[0].items[0], '名称：默认场景 → 我的场景', '分组条目沿用差异文本');

    // 分组顺序由传入顺序决定（界面按配置结构顺序传入）
    const reordered = summarizeConfigChanges([...changes].reverse());
    eq(reordered[0].title, '展示样式', '分组顺序跟随传入的差异顺序');
  }

  // 9) 容错：空值与缺字段不应抛错
  {
    eq(diffConfigs(null, null).length, 0, '两边均为空时不抛错');
    eq(diffConfigs(base, null).length > 0, true, '一侧为空时按「字段被移除」报告差异');
    eq(summarizeConfigChanges(null).length, 0, '空差异列表聚合结果为空');
    ok(diffConfigs(base, clone(base)).every((c) => typeof c.text === 'string'), '差异条目均带可展示文本');
  }

  // 10) 回归：基准经 JSON 往返后的「空值」不应产生幻影改动
  //     界面上的空白数字输入曾把 NaN 写进配置，而 snapshotConfig 的 JSON 往返会把 NaN 变成 null，
  //     导致「（空） → NaN」这类假差异，进而出现「用户什么都没改却提示有改动」。
  {
    const next = clone(base);
    next.body.lengthPolicy.growth.minLength = NaN;
    next.body.lengthPolicy.shrink.maxLength = NaN;
    const baseline = clone(next); // JSON 往返：NaN → null
    eq(diffConfigs(baseline, next).length, 0, 'NaN 与 JSON 往返后的 null 不产生假差异');
    eq(diffConfigs(next, baseline).length, 0, '反向比对同样不产生假差异');
    eq(describeConfigValue(NaN), '（空）', 'NaN 描述为「（空）」而非「NaN」');
    eq(describeConfigValue(Infinity), '（空）', 'Infinity 描述为「（空）」');
  }

  // 11) 回归：归一化后的长度策略必须是有限数值，且与自身 JSON 快照零差异
  {
    const cfg = normalizeConfig(defaultConfig());
    ok(Number.isFinite(cfg.body.lengthPolicy.growth.minLength), '增长策略的最小长度归一化后为有限数值');
    ok(Number.isFinite(cfg.body.lengthPolicy.shrink.maxLength), '缩短策略的最大长度归一化后为有限数值');
    eq(diffConfigs(clone(cfg), cfg).length, 0, '归一化配置与自身 JSON 快照零差异（对模板基准不产生幻影改动）');
  }
}

/* ---------- 自定义皮肤（上传图片） ---------- */
section('自定义皮肤：格式校验 / 规范化 / 分享链接剥离');
{
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

  const d = defaultConfig();
  eq(d.body.skin.head, '', '默认不设置蛇头皮肤');
  eq(d.body.skin.body, '', '默认不设置蛇身皮肤');

  // 1) 格式校验：仅接受 JPG / PNG / WebP 的 base64 dataURL
  ok(isSkinImage(PNG), '识别 PNG base64 dataURL 为合法皮肤');
  ok(isSkinImage('data:image/jpeg;base64,AAAA'), '支持 JPG（image/jpeg）');
  ok(isSkinImage('data:image/jpg;base64,AAAA'), '支持 JPG（image/jpg）');
  ok(isSkinImage('data:image/webp;base64,AAAA'), '支持 WebP');
  eq(isSkinImage('data:image/gif;base64,AAAA'), false, '拒绝不支持的 GIF 格式');
  eq(isSkinImage('data:image/svg+xml;base64,AAAA'), false, '拒绝 SVG（可能携带脚本）');
  eq(isSkinImage('https://example.com/a.png'), false, '拒绝外链地址');
  eq(isSkinImage('javascript:alert(1)'), false, '拒绝非图片协议');
  eq(isSkinImage(''), false, '空字符串视为未设置');
  eq(isSkinImage(null), false, 'null 视为未设置');
  eq(isSkinImage({}), false, '非字符串视为未设置');

  // 2) 规范化：非法值一律回退为「未设置」，不影响其它字段
  const n = normalizeConfig({ ...d, body: { ...d.body, skin: { head: PNG, body: 'data:image/gif;base64,AAAA' } } });
  eq(n.body.skin.head, PNG, '规范化保留合法的蛇头皮肤');
  eq(n.body.skin.body, '', '非法格式的蛇身皮肤回退为未设置');
  eq(n.body.segmentSize, d.body.segmentSize, '皮肤规范化不影响其它身体字段');
  eq(normalizeConfig({ ...d, body: { ...d.body, skin: 'oops' } }).body.skin.head, '', '皮肤字段结构非法时整体回退为未设置');
  eq(normalizeConfig({ ...d, body: { ...d.body, skin: undefined } }).body.skin.body, '', '缺少皮肤字段时补全为未设置');

  // 3) 分享链接剥离皮肤图片（dataURL 体积可达数 MB，直接编码会超出链接长度上限）
  const stripped = stripSkinAssets(n);
  eq(stripped.body.skin.head, '', 'stripSkinAssets 清空皮肤图片');
  eq(n.body.skin.head, PNG, 'stripSkinAssets 不修改原配置（纯函数）');
  ok(!encodeConfigToToken(stripped).includes('iVBORw0KGgo'), '剥离后的配置编码不再包含皮肤图片数据');

  const saved = globalThis.location;
  try {
    globalThis.location = { origin: 'https://example.com', pathname: '/snake/', href: 'https://example.com/snake/' };
    const url = buildShareUrl(n);
    ok(url.includes('#c='), '分享链接正常生成');
    ok(!url.includes('iVBORw0KGgo'), '分享链接不含皮肤图片（避免超长链接）');
    eq(decodeConfigFromToken(url.split('#c=')[1]).body.skin.head, '', '从链接载入时皮肤为空（未被截断的图片污染）');
  } finally {
    if (saved === undefined) delete globalThis.location;
    else globalThis.location = saved;
  }
}

/* ---------- 自碰撞死亡与蛇转化为元胞自动机 ---------- */
section('自碰撞死亡与转化为元胞自动机');
{
  /**
   * 构造必定自撞的场景：只允许左转的蛇在方格上绕 2×2 小循环，
   * 身体长度 6 > 循环周长 4，第 3 步必然压到自身身体。
   */
  const loopCfg = (over = {}) => {
    const cfg = defaultConfig();
    cfg.grid = { type: 'square', width: 20, height: 20, boundary: 'wrap' };
    cfg.start = { col: 10, row: 10, direction: 'up' };
    cfg.body.initialLength = 6;
    cfg.moveRules = { left: 1, straight: 0, right: 0 };
    cfg.endConditions.maxSteps = 20;
    cfg.endConditions.wall = false;
    cfg.endConditions.outOfBounds = false;
    cfg.endConditions.noMove = false;
    cfg.endConditions.ruleEnd = false;
    cfg.transform = { enabled: true, dieOnSelfCollision: true, globalProbability: 1, segmentProbability: 1, state: 'obstacle' };
    return applyPatch(cfg, over);
  };

  // 1) 规范化：两个概率夹取到 [0,1]，非法目标状态回退到首个非空状态
  {
    const n = normalizeConfig({ transform: { enabled: true, globalProbability: 5, segmentProbability: -1, state: 'nope' } });
    eq(n.transform.globalProbability, 1, '全局触发概率上溢夹取到 1');
    eq(n.transform.segmentProbability, 0, '分段转化概率下溢夹取到 0');
    eq(n.transform.state, 'obstacle', '非法目标状态回退到首个非空状态');
    eq(normalizeConfig({ transform: { state: 'empty' } }).transform.state, 'obstacle', '目标状态不允许为 empty（回退到非空状态）');
    eq(normalizeConfig({}).transform.enabled, false, '默认关闭「蛇死亡转化」（旧场景零变化）');
    ok(END_LABELS.transformDone && END_LABELS.transformDone.length > 0, '结束原因表包含「蛇已全部转化为环境」标签');
  }

  // 2) 自撞即死亡：不终止运行，身体节点按两个概率并入环境
  {
    const r = new Simulation(loopCfg()).run();
    eq(r.stats.transformDeaths, 1, '自撞触发一次蛇死亡');
    eq(r.stats.transformTriggers, 1, '全局概率为 1 时转化流程必定启动');
    eq(r.stats.transformedCells, 6, '分段概率为 1 时全部 6 节身体并入环境');
    ok(r.endReason.code !== 'selfCollision', '转化模式下自撞不会以「撞到自身」收尾');
    eq(r.endReason.code, 'transformDone', '场上无存活移动体后以「全部转化为环境」收尾');
    ok(r.stats.obstacleCount >= 6, '转化后的节点确实成为环境的一部分', `实际 ${r.stats.obstacleCount}`);
    ok(r.frames.some((f) => f.highlights.some((h) => h.type === 'transform')), '转化过程写入 transform 过渡高亮');
    ok(r.frames.some((f) => f.highlights.some((h) => h.type === 'transform' && h.state === 'obstacle')), '过渡高亮携带目标状态色');
    ok(r.frames.some((f) => (f.events || []).some((e) => e.type === 'transform' && e.count === 6)), '转化事件进入帧事件流并带节点数');
    ok(r.summary.transformedCells === 6 && r.summary.transformDeaths === 1, '运行摘要同步转化统计');
    ok(r.logs.some((l) => l.ruleName === '蛇死亡转化'), '转化写入环境规则日志');
  }

  // 3) 全局触发概率为 0：仍判定死亡，但不启动转化
  {
    const r = new Simulation(loopCfg({ transform: { globalProbability: 0 } })).run();
    eq(r.stats.transformDeaths, 1, '全局概率为 0 时仍然判定蛇死亡');
    eq(r.stats.transformTriggers, 0, '全局概率为 0 时不启动转化流程');
    eq(r.stats.transformedCells, 0, '全局概率为 0 时没有节点并入环境');
    eq(r.endReason.code, 'transformDone', '未转化时运行仍在死亡后正常收尾');
  }

  // 4) 分段转化概率为 0：不影响全局触发，但不写入任何节点
  {
    const r = new Simulation(loopCfg({ transform: { segmentProbability: 0 } })).run();
    eq(r.stats.transformTriggers, 1, '分段概率为 0 不影响全局触发次数');
    eq(r.stats.transformedCells, 0, '分段概率为 0 时没有节点被转化');
  }

  // 5) 关闭「自撞即判定死亡」：完全恢复原有的「撞到自身」结束行为
  {
    const r = new Simulation(loopCfg({ transform: { dieOnSelfCollision: false } })).run();
    eq(r.stats.transformDeaths, 0, '关闭「自撞即判定死亡」时不进入转化流程');
    eq(r.endReason.code, 'selfCollision', '关闭后自撞仍按原有结束规则收尾');
  }

  // 6) 未启用「蛇死亡转化」：行为与旧版完全一致
  {
    const r = new Simulation(loopCfg({ transform: { enabled: false } })).run();
    eq(r.stats.transformDeaths, 0, '未启用转化时不会记录转化死亡');
    eq(r.endReason.code, 'selfCollision', '未启用转化时自撞仍按结束规则收尾');
  }

  // 7) 启用元胞自动机：转化后并入环境的节点继续演化，运行不提前收尾
  {
    const r = new Simulation(loopCfg({ caMode: { enabled: true } })).run();
    eq(r.stats.transformDeaths, 1, '启用元胞自动机时同样判定自撞死亡');
    eq(r.stats.transformedCells, 6, '启用元胞自动机时节点同样并入环境');
    ok(r.endReason.code !== 'transformDone' && r.endReason.code !== 'selfCollision', '有元胞自动机继续演化时不会在死亡处收尾');
    eq(r.stats.steps, 20, '转化后元胞自动机继续运行到步数上限');
  }

  // 8) 碰撞预警：标出「下一步会撞到自身身体」的危险落点
  {
    const r = new Simulation(loopCfg({ safety: { warnSelfCollision: true } })).run();
    ok(r.stats.collisionWarnings >= 1, '开启碰撞预警后统计到危险落点', `实际 ${r.stats.collisionWarnings}`);
    ok(r.frames.some((f) => f.highlights.some((h) => h.type === 'warning')), '危险落点写入 warning 高亮');
    ok(r.summary.collisionWarnings === r.stats.collisionWarnings, '运行摘要同步预警统计');
    const off = new Simulation(loopCfg()).run();
    eq(off.stats.collisionWarnings, 0, '默认关闭时不产生预警开销与统计');
  }

  // 9) 配置诊断：概率为 0 与「撞到自身」结束规则让位
  {
    const noEff = diagnoseConfig({ transform: { enabled: true, globalProbability: 0 } });
    ok(noEff.some((d) => d.code === 'transformNoEffect'), '诊断：概率为 0 时提示转化不会产生节点');
    const override = diagnoseConfig({ transform: { enabled: true, dieOnSelfCollision: true }, endConditions: { selfCollision: true } });
    ok(override.some((d) => d.code === 'transformOverridesSelfCollisionEnd'), '诊断：「撞到自身」结束规则在转化模式下让位');
  }
}

/* ---------- 生命机制（多生命系统）与「死亡即停」 ---------- */
section('生命机制：多生命 / 扣命重生 / 生命耗尽 / 死亡即停 / 自撞互斥');
{
  /**
   * 必自撞 + 生命机制场景：只允许左转的蛇在 2×2 小循环上绕圈，
   * 身体长度 6 > 循环周长 4，第 3 步必然压到自身身体。
   * 重生长度同样设为 6、无敌步数设为 0，保证每次重生后下一步必定再次致命——
   * 这样「扣命 → 重生 → 生命耗尽」的整条链路在少数几步内可完整验证。
   */
  const loopLife = (patch = {}) => {
    const cfg = defaultConfig();
    cfg.grid = { type: 'square', width: 20, height: 20, boundary: 'wrap' };
    cfg.start = { col: 10, row: 10, direction: 'up' };
    cfg.body.initialLength = 6;
    cfg.moveRules = { left: 1, straight: 0, right: 0 };
    cfg.endConditions = { ...cfg.endConditions, maxSteps: 30, wall: false, outOfBounds: false, noMove: false, ruleEnd: false };
    cfg.life = {
      ...cfg.life, enabled: true, initialLives: 3,
      respawn: { ...cfg.life.respawn, length: 6, invincibleTicks: 0 },
    };
    return applyPatch(cfg, patch);
  };

  /**
   * 环境增减生命场景：10×10 网格、图案居中放置（居中行 = 第 4 行，列 2~6），
   * 蛇从 (1,4) 只向右直行，第 1~5 步依次踏入第 2~6 列。
   */
  const itemLife = (pattern, patch = {}) => {
    const cfg = defaultConfig();
    cfg.grid = { type: 'square', width: 10, height: 10, boundary: 'wrap' };
    cfg.start = { col: 1, row: 4, direction: 'right' };
    cfg.body.initialLength = 3;
    cfg.moveRules = { left: 0, straight: 1, right: 0 };
    cfg.endConditions = { ...cfg.endConditions, maxSteps: 8, wall: false, outOfBounds: false, selfCollision: false, noMove: false, ruleEnd: false };
    cfg.caMode = {
      ...cfg.caMode,
      enabled: true,
      states: [
        { name: 'empty', color: null, symbol: '.', blocking: false },
        { name: 'marker', color: '#ffd166', symbol: 'M', blocking: false },
        { name: 'spike', color: '#ff6b6b', symbol: 'X', blocking: false },
      ],
      initial: { mode: 'pattern', pattern },
      rules: [],
    };
    cfg.life = { ...cfg.life, enabled: true };
    return applyPatch(cfg, patch);
  };

  // 1) 规范化：初始生命夹取到 [1,9]，「死亡后仍可移动」默认关闭
  {
    eq(defaultConfig().life.enabled, false, '生命机制默认关闭（旧场景零变化）');
    eq(defaultConfig().life.keepMovingAfterDeath, false, '「死亡后仍可移动」默认关闭');
    eq(defaultConfig().life.initialLives, 3, '初始生命默认 3 条');
    eq(LIFE_MIN, 1, '初始生命下限为 1');
    eq(LIFE_MAX, 9, '初始生命上限为 9');
    eq(normalizeConfig({ life: { initialLives: 99 } }).life.initialLives, LIFE_MAX, '初始生命上溢夹取到上限');
    eq(normalizeConfig({ life: { initialLives: 0 } }).life.initialLives, LIFE_MIN, '初始生命下溢夹取到下限');
    eq(normalizeConfig({ life: { initialLives: -5 } }).life.initialLives, LIFE_MIN, '负初始生命夹取到下限');
    eq(normalizeConfig({ life: { initialLives: 4.6 } }).life.initialLives, 5, '初始生命取整');
    eq(normalizeConfig({ life: { warnThreshold: 99 } }).life.warnThreshold, LIFE_MAX, '预警阈值夹取到上限');
    eq(normalizeConfig({ life: { warnThreshold: -1 } }).life.warnThreshold, 0, '预警阈值可为 0（表示不预警）');
    eq(normalizeConfig({ life: { respawn: { length: 0 } } }).life.respawn.length, 1, '重生长度至少 1 节');
    eq(normalizeConfig({ life: { items: { lossAmount: 0 } } }).life.items.lossAmount, 1, '每次扣除生命至少 1 条');
    eq(normalizeConfig({ life: { items: { gainAmount: 99 } } }).life.items.gainAmount, LIFE_MAX, '每次增加生命不超过上限');
    eq(normalizeConfig({ life: { items: { gainStates: ['marker', 'nope', 'empty'] } } }).life.items.gainStates.join(','), 'marker',
      '增减生命的状态名过滤：未定义状态与 empty 被丢弃');
    ok(END_LABELS.lifeDepleted && END_LABELS.lifeDepleted.length > 0, '结束原因表包含「生命耗尽」标签');
  }

  // 2) 配置诊断：数值越界 / 无增减来源 / 开启「死亡后仍可移动」
  {
    ok(diagnoseConfig({ life: { initialLives: 99 } }).some((d) => d.code === 'lifeInitialClamped'), '诊断：初始生命越界被提示');
    eq(diagnoseConfig({ life: { initialLives: 5 } }).some((d) => d.code === 'lifeInitialClamped'), false, '诊断：合法初始生命不提示');
    ok(diagnoseConfig({ life: { enabled: true, keepMovingAfterDeath: true } }).some((d) => d.code === 'lifeKeepMovingAfterDeath'),
      '诊断：开启「死亡后仍可移动」时提示可能出现的异常表现');
    ok(diagnoseConfig({ life: { enabled: true, items: { gainStates: [], lossStates: [] } } }).some((d) => d.code === 'lifeNoItemSource'),
      '诊断：生命机制没有任何增减来源时提示');
    eq(diagnoseConfig({ life: { enabled: false, items: { gainStates: [], lossStates: [] } } }).some((d) => d.code === 'lifeNoItemSource'), false,
      '诊断：未启用生命机制时不提示增减来源缺失');
  }

  // 3) 自撞规则互斥（自动关闭）：两项同时开启时，规范化由「自撞即判定死亡」胜出并关闭「撞到自身」
  {
    ok(!('selfCollisionLocked' in normalizeConfig({}).endConditions),
      '旧的「互斥锁定」派生字段已移除，改由自动关闭机制实现互斥');
    eq(normalizeConfig({}).endConditions.selfCollision, true,
      '未启用「蛇死亡转化」时不关闭「撞到自身」（默认行为零变化）');
    const on = normalizeConfig({ transform: { enabled: true, dieOnSelfCollision: true }, endConditions: { selfCollision: true } });
    eq(on.endConditions.selfCollision, false, '「自撞即判定死亡」生效时「撞到自身」被自动关闭');
    eq(on.transform.dieOnSelfCollision, true, '互斥关闭是单向的：不会反过来改动「自撞即判定死亡」');
    const off = normalizeConfig({ transform: { enabled: true, dieOnSelfCollision: false }, endConditions: { selfCollision: true } });
    eq(off.endConditions.selfCollision, true, '关闭「自撞即判定死亡」后「撞到自身」保持原值');
    eq(normalizeConfig({ transform: { enabled: false, dieOnSelfCollision: true }, endConditions: { selfCollision: true } }).endConditions.selfCollision,
      true, '「蛇死亡转化」总开关未启用时不触发互斥关闭');
    const diag = diagnoseConfig({ transform: { enabled: true, dieOnSelfCollision: true }, endConditions: { selfCollision: true } });
    ok(diag.some((d) => d.code === 'transformOverridesSelfCollisionEnd'), '诊断：互斥自动关闭有对应提示');
    const fix = diag.find((d) => d.code === 'transformOverridesSelfCollisionEnd');
    ok(fix.suggestions.some((s) => s.patch.transform?.dieOnSelfCollision === false && s.patch.endConditions?.selfCollision === true),
      '诊断：给出「改由撞到自身结束运行」的一键方案');

    // 行为验证：互斥生效时自撞按生命机制扣命，而不是以「撞到自身」收尾
    const r = new Simulation(loopLife({
      transform: { enabled: true, dieOnSelfCollision: true, globalProbability: 0, segmentProbability: 0 },
      life: { initialLives: 2 },
    })).run();
    eq(r.stats.lifeLosses, 2, '互斥生效时自撞按生命机制逐次扣命');
    eq(r.stats.respawns, 1, '还有剩余生命时原地重生');
    eq(r.stats.finalDeaths, 1, '生命耗尽才记录最终死亡');
    ok(r.endReason.code !== 'selfCollision', '互斥生效时自撞不以「撞到自身」收尾', `实际 ${r.endReason.code}`);
    eq(r.stats.transformDeaths, 1, '生命耗尽后转入「蛇死亡转化」流程');
  }

  // 4) 扣命重生：保留蛇头位置与进度，仅重置蛇身长度并播放重生动画
  {
    const r = new Simulation(loopLife({ life: { initialLives: 3 } })).run();
    eq(r.stats.lifeLosses, 3, '每次致命判定扣 1 条命');
    eq(r.stats.respawns, 2, '还有剩余生命时原地重生');
    eq(r.stats.finalDeaths, 1, '生命耗尽才记录最终死亡');
    eq(r.endReason.code, 'selfCollision', '生命耗尽后按原有结束规则收尾');
    eq(r.stats.lifeWarnings, 1, '剩余生命降至预警阈值时给出一次预警');
    eq(r.summary.lifeLosses, 3, '运行摘要同步生命扣减统计');
    eq(r.summary.respawns, 2, '运行摘要同步重生统计');
    eq(r.summary.finalDeaths, 1, '运行摘要同步最终死亡统计');

    const respawnFrames = r.frames.filter((f) => (f.events || []).some((e) => e.type === 'lifeRespawn'));
    eq(respawnFrames.length, 2, '每次重生所在帧都写入 lifeRespawn 事件');
    const first = respawnFrames[0];
    const ev = first.events.find((e) => e.type === 'lifeRespawn');
    eq(ev.lives, 2, '重生事件携带扣除后的剩余生命');
    eq(first.agents[0].alive, true, '重生后移动体仍然存活');
    eq(first.agents[0].length, 6, '重生后蛇身长度重置为「重生长度」配置值');
    eq(first.agents[0].segments[0][0], ev.coord.col, '重生保留蛇头列坐标（核心位置不丢失）');
    eq(first.agents[0].segments[0][1], ev.coord.row, '重生保留蛇头行坐标（核心位置不丢失）');
    ok(r.frames.some((f) => f.highlights.some((h) => h.type === 'respawn')), '重生写入 respawn 高亮（渲染层据此播放重生动画）');
    ok(r.frames.some((f) => f.highlights.some((h) => h.type === 'lifeWarning')), '低生命预警写入 lifeWarning 高亮');
    ok(r.frames.flatMap((f) => f.events).some((e) => e.type === 'lifeLoss' && e.lives === 2), '扣命事件携带剩余生命与致命原因');
    ok(r.logs.some((l) => l.ruleName === '生命机制'), '重生写入「生命机制」规则日志');
  }

  // 5) 死亡即停：默认关闭「死亡后仍可移动」时，死亡帧起蛇头蛇身被删去、不再推进
  {
    const dead = new Simulation(loopLife({
      transform: { enabled: true, dieOnSelfCollision: true, globalProbability: 0, segmentProbability: 0 },
      caMode: { enabled: true },
      life: { initialLives: 1, keepMovingAfterDeath: false },
    })).run();
    const deathFrame = dead.frames.find((f) => (f.events || []).some((e) => e.type === 'lifeDepleted'));
    ok(!!deathFrame, '生命耗尽写入 lifeDepleted 事件');
    eq(dead.stats.finalDeaths, 1, '生命耗尽记录最终死亡');
    eq(dead.stats.respawns, 0, '生命耗尽时不再重生');
    eq(deathFrame.agents.length, 0, '死亡所在帧已删去蛇头与蛇身');
    ok(dead.frames.filter((f) => f.tick >= deathFrame.tick).every((f) => f.agents.length === 0),
      '死亡后所有帧都不再出现该移动体（移动逻辑立即停止）');
    ok(dead.frames.some((f) => f.tick < deathFrame.tick && f.agents[0] && f.agents[0].segments.length > 0), '死亡前正常推进');
    eq(dead.stats.steps, 30, '死亡不会误终止整轮运行：元胞自动机继续运行到步数上限');

    const zombie = new Simulation(loopLife({
      transform: { enabled: true, dieOnSelfCollision: true, globalProbability: 0, segmentProbability: 0 },
      life: { initialLives: 1, keepMovingAfterDeath: true },
    })).run();
    const zLast = zombie.frames[zombie.frames.length - 1];
    eq(zLast.agents.length, 1, '开启「死亡后仍可移动」时移动体保留在场上');
    eq(zLast.agents[0].zombie, true, '以僵尸态保留的移动体带 zombie 标记');
    eq(zLast.agents[0].alive, false, '僵尸态的存活标记为 false');
    ok(zLast.agents[0].segments.length > 0, '僵尸态保留蛇头与蛇身（与默认关闭形成对比）');
    eq(zombie.stats.lifeLosses, 0, '「死亡后仍可移动」时致命判定整体不生效');
    eq(zombie.stats.finalDeaths, 0, '「死亡后仍可移动」时不会真正扣命 / 最终死亡');
  }

  // 6) 环境动态增减生命：拾取道具 +1 条命、触发陷阱 -1 条命
  {
    const gain = new Simulation(itemLife('MMMMM', { life: { initialLives: 2, items: { gainAmount: 1 } } })).run();
    eq(gain.stats.lifeGains, 5, '5 个增益格子各增加 1 条命');
    eq(gain.frames[gain.frames.length - 1].stats.lives, 7, '剩余生命 = 初始 2 条 + 拾取 5 条');
    eq(gain.stats.maxLives, 7, '峰值生命同步更新');
    eq(gain.stats.markerCount, 0, '默认拾取后清除该格');
    ok(gain.frames.some((f) => f.highlights.some((h) => h.type === 'lifeGain')), '拾取写入 lifeGain 高亮');
    ok(gain.frames.flatMap((f) => f.events).some((e) => e.type === 'lifeGain' && e.lives === 3), '拾取事件携带增加后的剩余生命');

    const cap = new Simulation(itemLife('MMMMM', { life: { initialLives: LIFE_MAX, items: { gainAmount: 2 } } })).run();
    eq(cap.stats.maxLives, LIFE_MAX, '生命不会超过上限');
    eq(cap.stats.lifeGains, 0, '已在上限时拾取不再累计');
    // 增益格子本身仍会被长度策略的「吃到即增长」逻辑消耗（与生命机制无关），
    // 因此这里只断言生命机制未生效，而不去断言格子是否被消耗。
    ok(!cap.frames.flatMap((f) => f.events).some((e) => e.type === 'lifeGain'),
      '已在上限时不写入 lifeGain 事件（生命机制未消耗增益格子）');

    const gainOff = new Simulation(itemLife('MMMMM', { life: { enabled: false } })).run();
    eq(gainOff.stats.lifeGains, 0, '未启用生命机制时增益格子不生效');

    const trap = new Simulation(itemLife('XXXXX', {
      life: { initialLives: 2, items: { lossStates: ['spike'], lossAmount: 1 } },
    })).run();
    eq(trap.stats.lifeLosses, 2, '踏入陷阱各扣 1 条命');
    eq(trap.stats.finalDeaths, 1, '扣到 0 条触发最终死亡');
    eq(trap.stats.respawns, 0, '陷阱扣命不触发重生');
    eq(trap.stats.lifeWarnings, 1, '剩余 1 条命时给出一次低生命预警');
    eq(trap.endReason.code, 'lifeDepleted', '生命耗尽以「生命耗尽」收尾');
    eq(trap.endReason.label, END_LABELS.lifeDepleted, '结束原因标签为「生命耗尽」');
    eq(trap.stats.steps, 2, '生命耗尽后立即停止推进');
    eq(trap.frames[trap.frames.length - 1].agents[0].lives, 0, '最终帧的剩余生命为 0');
    ok(trap.frames.flatMap((f) => f.events).some((e) => e.type === 'trapHit' && e.state === 'spike'), '陷阱命中事件携带触发状态名');
    ok(trap.frames.some((f) => f.highlights.some((h) => h.type === 'lifeLoss')), '陷阱命中写入 lifeLoss 高亮');

    const trapOff = new Simulation(itemLife('XXXXX', { life: { enabled: false, items: { lossStates: ['spike'] } } })).run();
    eq(trapOff.stats.lifeLosses, 0, '未启用生命机制时陷阱格子不生效');
    eq(trapOff.endReason.code, 'maxSteps', '未启用生命机制时蛇正常走完全程');
  }

  // 7) 回归：未启用生命机制时，致命判定的旧行为与统计数据完全不变
  {
    const r = new Simulation(loopLife({ life: { enabled: false } })).run();
    eq(r.stats.lifeLosses, 0, '未启用生命机制时不自撞扣命');
    eq(r.stats.respawns, 0, '未启用生命机制时不重生');
    eq(r.stats.finalDeaths, 0, '未启用生命机制时不记录最终死亡');
    eq(r.endReason.code, 'selfCollision', '未启用生命机制时自撞仍按原有结束规则收尾');
    eq(r.frames[r.frames.length - 1].agents[0].lives, 0, '未启用生命机制时移动体不携带生命');
    eq(r.stats.transformDeaths, 0, '未启用生命机制时也不会进入转化流程');
  }

  // 8) 致命事件吸收：撞墙扣命重生后不再触发「撞墙」结束规则（生命耗尽才收尾）
  {
    const wallLife = (patch) => {
      const c = defaultConfig();
      c.grid = { type: 'square', width: 6, height: 6, boundary: 'fixed' };
      c.start = { col: 1, row: 1, direction: 'up' };
      c.body.initialLength = 1;
      c.moveRules = { left: 0, straight: 1, right: 0 };
      c.endConditions = { ...c.endConditions, maxSteps: 50, wall: true, noMove: false, ruleEnd: false };
      c.life = { ...c.life, enabled: true, initialLives: 2, respawn: { length: 1, invincibleTicks: 0 } };
      return applyPatch(c, patch);
    };

    const r = new Simulation(wallLife({})).run();
    eq(r.stats.lifeLosses, 2, '两次撞墙各扣 1 条命');
    eq(r.stats.respawns, 1, '第 1 次撞墙后原地重生');
    eq(r.stats.finalDeaths, 1, '第 2 次撞墙耗尽生命，记录最终死亡');
    eq(r.endReason.code, 'wall', '生命耗尽后才按「撞墙」收尾');
    ok(r.stats.steps > 2, '扣命重生所在帧不会因「撞墙」结束规则误终止整轮运行');

    const r0 = new Simulation(wallLife({ life: { enabled: false } })).run();
    eq(r0.stats.lifeLosses, 0, '未启用生命机制时不扣命');
    eq(r0.stats.steps, 2, '未启用生命机制时第 1 次撞墙即结束运行（对照）');
    eq(r0.endReason.code, 'wall', '未启用生命机制时按「撞墙」结束');
  }
}

/* ---------- 本轮：边界穿越轨迹缺陷修复 ---------- */

/** 固定直行的环绕场景：每走满一圈（width 步）必然穿越一次边界 */
function wrapRun(patch = {}) {
  const c = defaultConfig();
  c.grid = { type: 'square', width: 10, height: 8, boundary: 'wrap' };
  c.start = { col: 0, row: 4, direction: 'left' };
  c.body.initialLength = 8;
  c.moveRules = { left: 0, straight: 1, right: 0 };
  c.endConditions = { ...c.endConditions, maxSteps: 90, wall: false, noMove: false, ruleEnd: false };
  return applyPatch(c, patch);
}

section('边界网格轨迹覆盖率（100%）与跨缝段连续性');
{
  const result = new Simulation(wrapRun()).run();
  const trail = buildTrail(result.grid, result.frames);
  const path = trail.path;
  const n = path.length;
  ok(n > 40, '穿越场景产生了足够长的轨迹（后续断言才有意义）', `轨迹点数 ${n}`);

  // 1) 解算层：展开坐标把「瞬移到对侧」的两点接成相邻一步，接缝处用整圈平移量衔接
  const { col, row, runs, crossings } = unwrapTrail(result.grid, path);
  eq(col.length, n, '展开列坐标与轨迹点数一致');
  eq(runs.length, crossings.length + 1, '段数 = 穿越次数 + 1（每次跨缝切成一段）');
  ok(crossings.length >= 8, '固定直行 90 步至少跨缝 8 次', `实际 ${crossings.length}`);

  let stepViolations = 0;
  for (const run of runs) {
    for (let i = run.from + 1; i <= run.to; i++) {
      const dc = Math.abs(col[i] - col[i - 1]);
      const dr = Math.abs(row[i] - row[i - 1]);
      if (dc + dr !== 1) stepViolations++;
    }
  }
  eq(stepViolations, 0, '段内相邻两点在展开坐标下恒差 1 步（跨缝处不再出现整图瞬移）');

  let seamViolations = 0;
  for (let k = 0; k < crossings.length; k++) {
    const cr = crossings[k];
    const outSide = runs[k];      // 滑出侧：带上跨缝点，一直画到边界
    const inSide = runs[k + 1];   // 滑入侧：与上一段重叠一个点，从对侧接着画
    if (!outSide || !inSide || outSide.to !== cr.i || inSide.from !== cr.i - 1) seamViolations++;
  }
  eq(seamViolations, 0, '每个跨缝点都被滑出侧与滑入侧两段同时覆盖（接缝两侧都有轨迹）');

  // 2) 渲染层：每个轨迹点都能折回网格区域内，且段内像素间距不超过一格
  const { r } = headlessRenderer({ cellSize: 20, gap: 2, trailFade: false });
  attachResult(r, result);
  r.pixDirty = true;
  r.ensureTrailPix();
  const rect = r.gridRect();
  const pitch = r.center({ col: 1, row: 0 }).x - r.center({ col: 0, row: 0 }).x;
  const un = r.trailUn;
  const segs = r.trailRuns;
  eq(segs.length, runs.length, '渲染段的切分与解算层完全一致');
  eq(r.trailCrossings.length, crossings.length, '穿越标记与解算层的穿越次数一致');

  const inRect = (x, y) => x >= rect.left - 1e-6 && x <= rect.right + 1e-6 && y >= rect.top - 1e-6 && y <= rect.bottom + 1e-6;
  // 每个轨迹点至少要有一段能把它画在网格区域内（跨缝点在滑出侧是界外虚拟点、滑入侧才是网格内真实位置）
  const covered = new Uint8Array(n);
  for (let s = 0; s < segs.length; s++) {
    const sg = segs[s];
    for (let i = sg.from; i <= sg.to; i++) {
      if (covered[i]) continue;
      if (inRect(un[i * 2] + sg.ox, un[i * 2 + 1] + sg.oy)) covered[i] = 1;
    }
  }

  let uncovered = 0;
  for (let i = 0; i < n; i++) if (!covered[i]) uncovered++;
  eq(uncovered, 0, '全部轨迹点都能折回网格区域内绘制（不再有落到留白区的点）');

  let edgePoints = 0;
  let edgeCovered = 0;
  for (let i = 0; i < n; i++) {
    const c = result.grid.coord(path[i].index);
    const onEdge = c.col === 0 || c.col === result.grid.width - 1 || c.row === 0 || c.row === result.grid.height - 1;
    if (!onEdge) continue;
    edgePoints++;
    if (covered[i]) edgeCovered++;
  }
  ok(edgePoints > 0, '轨迹确实走过边界网格（覆盖率断言才有意义）', `边界网格轨迹点 ${edgePoints}`);
  eq(edgeCovered, edgePoints, '边界网格的轨迹显示覆盖率达到 100%（每个边缘点都被绘制）');

  // 跨缝点在两段里的位置相差整圈，正是「滑出侧画到边界、滑入侧从对侧接着画」的平移量
  let circleViolations = 0;
  for (let k = 0; k < crossings.length; k++) {
    const cr = crossings[k];
    const outRun = segs[k];
    const inRun = segs[k + 1];
    const gap = Math.hypot((un[cr.i * 2] + inRun.ox) - (un[cr.i * 2] + outRun.ox),
      (un[cr.i * 2 + 1] + inRun.oy) - (un[cr.i * 2 + 1] + outRun.oy));
    if (Math.abs(gap - pitch * result.grid.width) > 0.01) circleViolations++;
  }
  eq(circleViolations, 0, '跨缝点在两段中的位置恰相差整圈（接缝两侧完美衔接）');

  let drawnMaxGap = 0;
  for (const sg of segs) {
    for (let i = sg.from + 1; i <= sg.to; i++) {
      const d = Math.hypot(un[i * 2] - un[(i - 1) * 2], un[i * 2 + 1] - un[(i - 1) * 2 + 1]);
      if (d > drawnMaxGap) drawnMaxGap = d;
    }
  }
  ok(drawnMaxGap <= pitch * 1.05, '任意段内相邻两点的像素间距不超过一格（不会连出横穿画面的长条）',
    `最大间距 ${drawnMaxGap.toFixed(2)} / 一步 ${pitch}`);

  // 3) 端到端：真实 draw() 下轨迹描边连续且完整
  const { r: rr, calls } = headlessRenderer({
    cellSize: 20, gap: 2, trailFade: false, showGrid: false, showBody: false, showEffects: false,
    highlightRules: false, showStartEnd: false, showCrossings: false,
  });
  attachResult(rr, result);
  rr.draw(result.frames.length - 1, 0);

  const paths = [];
  let cur = null;
  for (const c of calls) {
    if (c.name === 'beginPath') { cur = { xs: [], ys: [] }; paths.push(cur); continue; }
    if (c.name === 'stroke' || c.name === 'fill') { cur = null; continue; }
    if (!cur) continue;
    if (c.name === 'moveTo' || c.name === 'lineTo') { cur.xs.push(c.args[0]); cur.ys.push(c.args[1]); }
  }
  const lines = paths.filter((p) => p.xs.length >= 2);
  ok(lines.length > 0, 'draw() 实际产生了轨迹折线描边');
  let drawnPoints = 0;
  let worstSeg = 0;
  for (const p of lines) {
    drawnPoints += p.xs.length;
    for (let k = 1; k < p.xs.length; k++) {
      worstSeg = Math.max(worstSeg, Math.hypot(p.xs[k] - p.xs[k - 1], p.ys[k] - p.ys[k - 1]));
    }
  }
  ok(drawnPoints >= n, '实际绘制的轨迹点数覆盖全部轨迹点（没有缺失的轨迹段）', `已绘制 ${drawnPoints} / 共 ${n}`);
  ok(worstSeg <= pitch * 1.05, '实际绘制中不存在跨越整图的线段（跨缝轨迹连续、无横穿长条）',
    `最大线段 ${worstSeg.toFixed(2)}`);
}

/* ---------- 本轮新增：轨迹颜色分级映射 ---------- */

section('新增：轨迹颜色分级映射（渐隐 / 热度 / 次序）');
{
  eq(TRAIL_COLOR_MODES.join(','), 'fade,visit,order', '颜色分级枚举为 渐隐 / 热度 / 次序');
  const d = defaultConfig();
  eq(d.style.trailColorMode, 'fade', '默认按新旧渐隐取色（与旧版本视觉一致）');
  eq(normalizeConfig({ ...d, style: { ...d.style, trailColorMode: 'visit' } }).style.trailColorMode, 'visit', '可切换为按经过次数（热度）取色');
  eq(normalizeConfig({ ...d, style: { ...d.style, trailColorMode: 'order' } }).style.trailColorMode, 'order', '可切换为按经过次序取色');
  eq(normalizeConfig({ ...d, style: { ...d.style, trailColorMode: 'rainbow' } }).style.trailColorMode, 'fade', '非法取色模式回退为默认渐隐');
  eq(decodeConfigFromToken(encodeConfigToToken(normalizeConfig({ ...d, style: { ...d.style, trailColorMode: 'order' } }))).style.trailColorMode,
    'order', '分享链接保留颜色分级设置');

  const result = new Simulation(wrapRun({ endConditions: { ...defaultConfig().endConditions, maxSteps: 60 } })).run();
  const mk = (style) => {
    const { r } = headlessRenderer({ cellSize: 20, gap: 2, ...style });
    attachResult(r, result);
    r.pixDirty = true;
    r.ensureTrailPix();
    return r;
  };

  // 渐隐模式：不引入色带，样式表只有亮度一维
  const rf = mk({ trailColorMode: 'fade' });
  eq(rf.ensureTrailCv(), null, '渐隐模式不额外构建分级取值缓冲');
  eq(rf.colorRamp(), null, '渐隐模式不启用色带');
  eq(rf.fadeStyleTable(rf.theme(), 6).cols, 1, '渐隐模式的样式表只按亮度分档（cols = 1）');

  // 热度模式：取值 = (经过次数 - 1) / (最大次数 - 1)
  const rv = mk({ trailColorMode: 'visit' });
  const cvv = rv.ensureTrailCv();
  ok(cvv instanceof Float32Array && cvv.length === rv.trail.path.length, '热度模式为每个轨迹点构建分级取值');
  let maxVisits = 1;
  for (const cell of rv.trail.info.values()) if (cell.visits > maxVisits) maxVisits = cell.visits;
  const vDen = Math.max(1, maxVisits - 1);
  let vMismatch = 0;
  for (let i = 0; i < rv.trail.path.length; i++) {
    const cell = rv.trail.info.get(rv.trail.path[i].index);
    const expect = (cell.visits - 1) / vDen;
    if (Math.abs(cvv[i] - expect) > 1e-6) vMismatch++;
  }
  eq(vMismatch, 0, '热度取值与「(经过次数-1)/最大次数」严格一致');
  ok(cvv.every((v) => v >= 0 && v <= 1), '热度取值归一化到 [0,1]');
  const tv = rv.fadeStyleTable(rv.theme(), 6);
  ok(tv.cols > 1, '热度模式样式表扩展出颜色维度（亮度档 × 颜色档）');
  ok(new Set(tv.colors).size > 4, '色带为不同颜色档给出不同颜色');

  // 次序模式：取值 = (经过次序 - 1) / (格数 - 1)，且与热度使用不同色带
  const ro = mk({ trailColorMode: 'order' });
  const cvo = ro.ensureTrailCv();
  const oDen = Math.max(1, ro.trail.order.length - 1);
  let oMismatch = 0;
  for (let i = 0; i < ro.trail.path.length; i++) {
    const cell = ro.trail.info.get(ro.trail.path[i].index);
    const expect = (cell.order - 1) / oDen;
    if (Math.abs(cvo[i] - expect) > 1e-6) oMismatch++;
  }
  eq(oMismatch, 0, '次序取值与「(经过次序-1)/(格数-1)」严格一致');
  ok(oMismatch === 0 && cvo[0] === 0, '第一个经过的格取色档为 0');
  ok(ro.fadeStyleTable(ro.theme(), 6).colors.join() !== tv.colors.join(), '次序与热度使用不同色带');
  ok(ro.ensureTrailCv() === cvo, '分级取值按模式与长度缓存复用（不逐帧重建）');
  ro.pixDirty = true;
  ro.ensureTrailPix();
  eq(ro.trailCv, null, '轨迹更新后分级取值缓存失效，下一帧按新轨迹重建');
}

/* ---------- 本轮新增：轨迹尖端平滑过渡 ---------- */

section('新增：轨迹尖端平滑过渡（帧间插值补画头部）');
{
  const d = defaultConfig();
  eq(d.style.trailSmooth, true, '默认开启轨迹尖端平滑过渡');
  eq(normalizeConfig({ ...d, style: { ...d.style, trailSmooth: false } }).style.trailSmooth, false, '可关闭平滑过渡');
  eq(normalizeConfig({ ...d, style: { ...d.style, trailSmooth: 0 } }).style.trailSmooth, false, '兼容 0 / 1 形式的布尔值');
  eq(normalizeConfig({ ...d, style: { ...d.style, trailSmooth: undefined } }).style.trailSmooth, true, '缺省时回退为开启');

  const result = new Simulation(wrapRun({ endConditions: { ...defaultConfig().endConditions, maxSteps: 40 } })).run();
  const mk = (style) => {
    const { r, calls } = headlessRenderer({ cellSize: 20, gap: 2, trailFade: false, ...style });
    attachResult(r, result);
    r.pixDirty = true;
    r.ensureTrailPix();
    r.ensureTrailCv();
    return { r, calls };
  };
  const { r: on } = mk({ trailSmooth: true });
  const { r: off } = mk({ trailSmooth: false });
  const pitch = on.center({ col: 1, row: 0 }).x - on.center({ col: 0, row: 0 }).x;
  const path = on.trail.path;

  let paired = 0;
  let missing = 0;
  let tooLong = 0;
  let firstPair = -1;
  for (let i = 1; i < path.length - 1; i++) {
    if (path[i].tick - path[i - 1].tick !== 1 || path[i].agent !== path[i - 1].agent) continue;
    paired++;
    if (firstPair < 0) firstPair = i;
    const tip = on.smoothHead(i + 1, path[i].tick + 0.5);
    if (!tip) { missing++; continue; }
    if (Math.hypot(tip.x1 - tip.x0, tip.y1 - tip.y0) > pitch * 1.05) tooLong++;
  }
  ok(paired > 20, '存在大量可补画的相邻步', `可补画 ${paired} 处`);
  eq(missing, 0, '所有相邻步之间都能补出平滑尖端（含跨缝的两步）');
  eq(tooLong, 0, '补画的尖端长度不超过一格（永远不会横穿画面）');
  eq(on.smoothHead(2, path[1].tick), null, '步内进度为 0 时不补画（避免与已绘制的头部重复）');
  eq(off.smoothHead(2, path[1].tick + 0.5), null, '关闭平滑后不再补画尖端');

  // 直接检查描边：步内进度 0.5 时补出的长度应恰为半格
  const { r: tipR, calls: tipCalls } = mk({ trailSmooth: true });
  tipCalls.length = 0;
  tipR.strokeSmoothTip(tipR.theme(), firstPair + 1, path[firstPair].tick + 0.5, 6);
  const mv = tipCalls.find((c) => c.name === 'moveTo');
  const ln = tipCalls.find((c) => c.name === 'lineTo');
  ok(!!mv && !!ln && tipCalls.some((c) => c.name === 'stroke'), '尖端平滑确实追加了一段描边');
  if (mv && ln) {
    near(Math.hypot(ln.args[0] - mv.args[0], ln.args[1] - mv.args[1]), pitch / 2, 0.01,
      '尖端长度恰为半格（与体节的帧间插值同步）');
  }
}

/* ---------- 本轮新增：边界穿越标记与事件日志 ---------- */

section('新增：边界穿越标记与事件日志');
{
  const d = defaultConfig();
  eq(d.style.showCrossings, true, '默认在轨迹接缝处标出边界穿越点');
  eq(normalizeConfig({ ...d, style: { ...d.style, showCrossings: false } }).style.showCrossings, false, '可关闭穿越标记');
  eq(d.events.logCrossings, true, '默认记录边界穿越事件日志');
  eq(normalizeConfig({ ...d, events: { logCrossings: false } }).events.logCrossings, false, '穿越日志开关可关闭');
  eq(normalizeConfig({ ...d, events: {} }).events.logCrossings, true, '缺省时穿越日志回退为开启');
  eq(decodeConfigFromToken(encodeConfigToToken(normalizeConfig({ ...d, events: { logCrossings: false } }))).events.logCrossings,
    false, '分享链接保留穿越日志开关');

  const on = new Simulation(wrapRun({ endConditions: { ...defaultConfig().endConditions, maxSteps: 40 } })).run();
  const off = new Simulation(wrapRun({
    endConditions: { ...defaultConfig().endConditions, maxSteps: 40 },
    events: { logCrossings: false },
  })).run();

  ok(on.stats.wrapCrossings > 0, '开启日志时统计到边界穿越次数');
  const wrapLogs = on.logs.filter((l) => l.ruleId === 'boundary');
  eq(wrapLogs.length, on.stats.wrapCrossings, '穿越日志条数与统计的穿越次数一致');
  eq(on.summary.wrapCrossings, on.stats.wrapCrossings, '摘要中的穿越次数与统计一致');
  const e0 = wrapLogs[0];
  ok(!!e0, '产生了可回溯的边界穿越日志');
  if (e0) {
    eq(e0.ruleName, '边界穿越', '穿越日志归属「边界穿越」事件');
    eq(e0.trigger, 'wrap', '穿越日志标记触发方式为 wrap');
    ok(/穿越边界/.test(e0.text || ''), '穿越日志文本可直接阅读');
    ok(/滑出边界/.test(e0.condition || '') && /滑入/.test(e0.actions || ''), '穿越日志说明「从何处滑出、从何处滑入」');
    ok(on.grid.inBounds(e0.coord), '穿越日志落点为网格内坐标（滑入侧）');
  }

  eq(off.logs.filter((l) => l.ruleId === 'boundary').length, 0, '关闭开关后不再产生穿越日志');
  eq(off.stats.wrapCrossings, 0, '关闭开关后不再累计穿越次数');
  eq(off.stats.steps, on.stats.steps, '关闭穿越日志不影响运行步数');
  eq(off.frames.length, on.frames.length, '关闭穿越日志不影响帧序列');

  // 渲染层：接缝两侧各画一个标记（滑出侧空心环 + 滑入侧实心点）
  const base = {
    cellSize: 20, gap: 2, trailFade: false, showGrid: false, showBody: false, showEffects: false,
    highlightRules: false, showStartEnd: false, showObstacles: false, showMarkers: false,
  };
  const { r, calls } = headlessRenderer({ ...base, showCrossings: true });
  attachResult(r, on);
  r.draw(on.frames.length - 1, 0);
  const { r: r2, calls: calls2 } = headlessRenderer({ ...base, showCrossings: false });
  attachResult(r2, on);
  r2.draw(on.frames.length - 1, 0);

  const rect = r.gridRect();
  const pitch = r.center({ col: 1, row: 0 }).x - r.center({ col: 0, row: 0 }).x;
  const marks = r.trailCrossings;
  ok(marks.length > 0, '渲染层解算出边界穿越标记');
  const inRect = (x, y) => x >= rect.left - 1e-6 && x <= rect.right + 1e-6 && y >= rect.top - 1e-6 && y <= rect.bottom + 1e-6;
  let outside = 0;
  let tooClose = 0;
  for (const m of marks) {
    if (!inRect(m.outX, m.outY) || !inRect(m.inX, m.inY)) outside++;
    if (Math.hypot(m.inX - m.outX, m.inY - m.outY) < pitch * 3) tooClose++;
  }
  eq(outside, 0, '穿越标记都落在网格区域内（不会画到留白区）');
  eq(tooClose, 0, '穿越标记分处接缝两侧（滑出侧与滑入侧各一个）');
  const arcsWith = calls.filter((c) => c.name === 'arc').length;
  const arcsWithout = calls2.filter((c) => c.name === 'arc').length;
  eq(arcsWith - arcsWithout, marks.length * 2, '每个穿越点在接缝两侧各绘制一个标记（关闭时完全不画）');
  ok(calls2.some((c) => c.name === 'stroke'), '关闭穿越标记后轨迹仍正常描边');
}

/* ---------- 本轮：默认配置与界面措辞 ---------- */

section('默认关闭：排行榜第 1 名提示（保留开关）；界面措辞与存档分组');
{
  const app = readFileSync(new URL('../src/ui/app.js', import.meta.url), 'utf8');
  ok(/showRankToast:\s*false/.test(app), '排行榜第 1 名提示默认关闭（state.showRankToast 初始为 false）');
  ok(/state\.showRankToast\s*\)\s*toast\(/.test(app), '弹出提示前检查开关，关闭时不弹出');
  ok(/RANK_TOAST_KEY/.test(app), '保留本地开关持久化键');
  ok(/setShowRankToast/.test(app), '保留开关的读写与设置入口');
  ok(/排行榜第 1 名提示/.test(app), '「界面配置」中保留可开启该提示的开关项');

  ok(/group\('配置 \/ 状态存档'/.test(app), '配置自动存档与状态存档整合在同一分组');
  ok(/sub-title' \}, '配置自动存档'/.test(app) && /sub-title' \}, '状态存档'/.test(app), '同一分组内两块内容各有小标题区分');
  ok(!/\bsavesGroup\(/.test(app) && !/\bautosaveGroup\(/.test(app), '旧的独立存档分组入口已全部移除');

  ok(/自适应速度/.test(app), '「自适应难度」已更正为「自适应速度」');
  ok(!/自适应难度/.test(app), '界面代码中不再残留「自适应难度」措辞');
  const diff = readFileSync(new URL('../src/core/difficulty.js', import.meta.url), 'utf8');
  ok(!/自适应难度/.test(diff), '动态难度模块注释同样使用「自适应速度」措辞');
}

/* ---------- 自撞规则互斥：自动关闭联动（源码级回归） ---------- */
section('自撞规则互斥：勾选即时自动关闭（源码级回归）');
{
  const app = readFileSync(new URL('../src/ui/app.js', import.meta.url), 'utf8');
  const cfgSrc = readFileSync(new URL('../src/core/config.js', import.meta.url), 'utf8');
  const simSrc = readFileSync(new URL('../src/core/simulation.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

  ok(/function syncSelfCollisionExclusive\(source\)/.test(app), '存在统一的互斥联动函数 syncSelfCollisionExclusive');
  ok(/syncSelfCollisionExclusive\('selfCollision'\)/.test(app), '勾选「撞到自身」时即时关闭「自撞即判定死亡」');
  ok(/syncExclusive\('die'\)/.test(app) && /syncExclusive\('enable'\)/.test(app),
    '「自撞即判定死亡」与「蛇死亡转化」总开关都接入互斥联动');
  ok(/syncSelfCollisionExclusive\('enable'\);\s*\n\s*syncControlBar/.test(app),
    '重建面板前兜底收敛互斥状态（载入模板 / 导入配置同样生效）');
  ok(!/selfCollisionLocked/.test(app) && !/selfCollisionLocked/.test(simSrc) && !/selfCollisionLocked/.test(cfgSrc),
    '「强制锁定」实现已彻底移除');
  ok(!/\.end-row\.locked/.test(css) && !/互斥禁用/.test(css), '锁定态样式已移除');
  ok(/已自动关闭结束规则「撞到自身」|已自动关闭「自撞即判定死亡」/.test(app), '互斥自动关闭时给出即时提示');
  ok(/一键改为「撞到自身」结束/.test(app), '结束规则分组内提供反手一键切换，无需跳到其它配置页');
  ok(/已启用 \$\{enabledCount\} 项/.test(app), '结束规则分组徽标显示当前启用条数');
  ok(/END_REASON_GROUP/.test(app) && /生命机制（多生命）/.test(app),
    '「生命耗尽」「全部转化为环境」等原因可定位到真正控制它的分组');
}

/* ---------- 结果 ---------- */
console.log(`\n${'='.repeat(48)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail) {
  console.log('\n失败明细：');
  for (const f of failures) console.log('  ✗ ' + f);
  process.exitCode = 1;
} else {
  console.log('全部通过 ✓');
}
