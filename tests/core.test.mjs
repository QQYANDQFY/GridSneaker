/**
 * 核心引擎冒烟测试（Node 环境，无外部依赖）
 * 运行：node tests/core.test.mjs
 */
import { RNG, normalizeWeights } from '../src/core/rng.js';
import { Grid, parseDir } from '../src/core/grid.js';
import { Simulation, DEFAULT_FRAME_CAP, MAX_FRAME_CAP } from '../src/core/simulation.js';
import { normalizeConfig, defaultConfig, validateConfig, encodeConfigToToken, decodeConfigFromToken } from '../src/core/config.js';

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
