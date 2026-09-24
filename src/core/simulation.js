/**
 * 模拟主循环
 * - 逻辑与渲染分离：run() 为纯计算，输出逐帧状态供渲染层使用
 * - 支持移动体规则、环境感知-条件-后果规则、元胞自动机（纯 CA / 混合模式）
 * - 随机全部来自种子化 RNG，保证可复现
 */
import { Grid, parseDir } from './grid.js';
import { RNG } from './rng.js';
import { World, Agent } from './world.js';
import { CAEngine } from './ca.js';
import { RuleEngine } from './rules.js';
import { normalizeConfig, END_LABELS, centerCoord, gridSizeFor } from './config.js';
import { resolveTurn } from './actions.js';
import { evaluateCondition } from './conditions.js';

/** 单次运行默认的安全帧上限（未启用「达到步数上限」时的保护值，可由界面「继续运行」递增） */
export const DEFAULT_FRAME_CAP = 20000;
/** 单次运行的绝对帧上限，防止无限运行拖垮浏览器 */
export const MAX_FRAME_CAP = 200000;
/**
 * 单次运行最多缓存的画面帧数。
 * 「达到步数上限」可设到 1e15，逐步全量缓存不可能（内存与时间都不允许），
 * 因此超过此数量时按步长抽样缓存：可回放的画面被抽样，统计量仍逐步精确累计。
 */
export const MAX_STORED_FRAMES = MAX_FRAME_CAP;
/** 单次运行最多缓存的环境规则日志条数，超出后只计数不留存，避免长跑时内存膨胀 */
export const MAX_LOGS = 50000;
/** 兼容旧名称 */
export const HARD_FRAME_CAP = DEFAULT_FRAME_CAP;

/** 原地保留每 2 项中的第 1 项（用于帧缓存降采样，始终保留首项） */
function halveInPlace(list) {
  for (let i = 0, j = 0; i < list.length; i += 2, j++) list[j] = list[i];
  list.length = Math.ceil(list.length / 2);
}

/** 把外部传入的帧上限收敛到 [1, MAX_FRAME_CAP] */
function clampFrameCap(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_FRAME_CAP;
  return Math.min(MAX_FRAME_CAP, Math.max(1, n));
}

export class Simulation {
  constructor(rawConfig, opts = {}) {
    this.config = normalizeConfig(rawConfig);
    this.grid = new Grid(this.config.grid);
    this.states = this.config.caMode.states;
    this.frameCap = clampFrameCap(opts.frameCap);
    /** 运行期诊断（与配置诊断同结构，供界面合并展示） */
    this.runtimeDiagnostics = [];
    this.diagCodes = new Set();
  }

  /** 记录一条运行期诊断：同一 code 只保留首次，避免长跑时重复刷屏 */
  noteDiagnostic(diag) {
    if (this.diagCodes.has(diag.code)) return;
    this.diagCodes.add(diag.code);
    this.runtimeDiagnostics.push(diag);
  }

  /** 起点被初始环境（CA 随机/图案填充）占据时的诊断 */
  checkStartBlocked(world) {
    const cfg = this.config;
    const start = { col: cfg.start.col, row: cfg.start.row };
    if (!world.isBlocking(start)) return;
    const center = centerCoord(this.grid);
    this.noteDiagnostic({
      level: 'error',
      code: 'startBlocked',
      title: '起点被阻塞状态占据',
      message: `起点 (${start.col}, ${start.row}) 在初始环境中是「${world.get(start)}」（阻塞状态），第一步就会判定为撞障碍物。`,
      suggestions: [
        { label: `起点移至地图中心 (${center.col}, ${center.row})`, patch: { start: { ...center } } },
        { label: '把 CA 初始密度降到 5%', patch: { caMode: { initial: { density: 0.05 } } } },
      ],
    });
  }

  /** 初始身体因越界被截断时的诊断 */
  checkBodyTruncated(agent) {
    const cfg = this.config;
    const requested = cfg.body.initialLength;
    if (agent.length >= requested) return;
    const center = centerCoord(this.grid);
    const fit = gridSizeFor(requested, this.grid.width, this.grid.height);
    this.noteDiagnostic({
      level: 'error',
      code: 'bodyTruncated',
      title: '初始身体被地图边界截断',
      message: `请求初始长度 ${requested} 节，但起点 (${cfg.start.col}, ${cfg.start.row}) 处只能容纳 ${agent.length} 节，实际身体被截断为 ${agent.length} 节。`,
      suggestions: [
        { label: `初始长度改为 ${agent.length}`, patch: { body: { initialLength: agent.length } } },
        { label: `起点移至地图中心 (${center.col}, ${center.row})`, patch: { start: { ...center } } },
        { label: `地图扩大到 ${fit.width}×${fit.height} 并把起点移到中心`, patch: { grid: fit, start: { ...centerCoord(new Grid({ type: cfg.grid.type, ...fit })) } } },
      ],
    });
  }

  /** 运行中身体长度超过地图总格数（体节必然重叠） */
  checkLengthOverflow(agent, tick) {
    const cells = this.grid.size;
    if (agent.length <= cells || this.diagCodes.has('lengthExceedsGrid')) return;
    const fit = gridSizeFor(agent.length, this.grid.width, this.grid.height);
    this.noteDiagnostic({
      level: 'warning',
      code: 'lengthExceedsGrid',
      title: '蛇身长度超过地图总格数',
      message: `第 ${tick} 步时长度已达 ${agent.length} 节 > 地图总格数 ${cells}，体节将互相重叠。`,
      suggestions: [
        { label: `增长上限改为 ${cells}`, patch: { body: { lengthPolicy: { growth: { maxLength: cells } } } } },
        { label: `地图扩大到 ${fit.width}×${fit.height}`, patch: { grid: fit } },
      ],
    });
  }

  createInitialAgent(rng, dir) {
    const cfg = this.config;
    const grid = this.grid;
    const head = { col: cfg.start.col, row: cfg.start.row };
    const segments = [{ ...head }];
    let cur = { ...head };
    for (let i = 1; i < cfg.body.initialLength; i++) {
      cur = grid.step(cur, grid.opposite(dir));
      if (!grid.inBounds(cur)) break;
      segments.push({ ...cur });
    }
    return new Agent('main', segments, dir, { label: '主移动体' });
  }

  run() {
    const cfg = this.config;
    const grid = this.grid;
    const states = this.states;
    const rng = new RNG(cfg.seed);
    const world = new World(grid, states);
    const ca = cfg.caMode.enabled ? new CAEngine(grid, cfg.caMode, states) : null;
    if (ca) ca.init(world, rng);
    this.runtimeDiagnostics = [];
    this.diagCodes.clear();
    this.checkStartBlocked(world);

    const engine = new RuleEngine(cfg);
    // 起始方向为「任意」时，由种子化 RNG 在网格的全部方向中随机挑选
    const dir = cfg.start.direction === 'random'
      ? rng.int(grid.dirCount)
      : parseDir(cfg.start.direction, grid.type);
    const mainAgent = this.createInitialAgent(rng, dir);
    this.checkBodyTruncated(mainAgent);
    const agents = [mainAgent];

    const stats = {
      steps: 0,
      collisions: 0,
      collisionsTotal: 0,
      collisionsConsecutive: 0,
      // 「自撞」专属计数：只统计头撞到自身身体/尾部的碰撞，
      // 供「累计/连续撞自身 N 次」结束规则与「连续自撞上限」使用。
      selfCollisions: 0,
      selfCollisionsConsecutive: 0,
      turnsLeft: 0,
      turnsStraight: 0,
      turnsRight: 0,
      turnsReverse: 0,
      length: mainAgent.length,
      maxLength: mainAgent.length,
      minLength: mainAgent.length,
      lengthHistory: [mainAgent.length],
      visited: new Set(),
      coverage: 0,
      ruleTriggers: 0,
      caSteps: 0,
      agents: 1,
      forcedStraights: 0,
      turnHistory: [],
      lengthOverTime: [mainAgent.length],
      obstacleCount: 0,
      markerCount: 0,
      logsDropped: 0,
    };

    const initStateIdx = new Set();
    for (const s of mainAgent.segments) initStateIdx.add(grid.idx(s.col, s.row));
    for (const i of initStateIdx) stats.visited.add(i);
    stats.coverage = (stats.visited.size / grid.size) * 100;

    const logs = [];
    const frames = [];
    /** 日志缓存上限保护：超限的日志不再留存，只累计条数 */
    const pushLog = (entry) => {
      if (logs.length < MAX_LOGS) logs.push(entry);
      else stats.logsDropped++;
    };
    // 「达到步数上限」结束条件启用时，实际步数上限就是用户设定值（不再被安全帧上限截断）；
    // 未启用时使用安全帧上限，达到后给出可「继续运行」的结束原因。
    const maxStepsEnabled = !!cfg.endConditions.maxSteps;
    const maxFrames = maxStepsEnabled
      ? Math.max(1, Math.round(cfg.endConditions.maxSteps))
      : this.frameCap;
    // 步数上限可设到 1e15，画面帧无法逐步全量缓存。这里按「帧数达到缓存上限即剔除一半并把采样步长加倍」
    // 的方式自适应降采样：短跑（不超过上限步数）仍是逐步全帧，长跑则自动降采样；
    // 统计量（步数 / 碰撞 / 长度 / 覆盖 / 转向等）始终逐步精确累计，不受采样影响。
    let frameStride = 1;
    let nextStoreTick = 1;
    let lastStoredTick = 0;
    let storedCells = world.cells.slice();
    let endReason = null;
    let tick = 0;

    frames.push(this.captureFrame(0, agents, storedCells, [], stats, logs, null, null));

    while (true) {
      if (tick >= maxFrames) {
        endReason = maxStepsEnabled
          ? { code: 'maxSteps', label: `${END_LABELS.maxSteps}（${maxFrames}）`, tick }
          : { code: 'frameLimit', label: `${END_LABELS.frameLimit}（${maxFrames} 步）`, tick, frameCap: maxFrames };
        break;
      }
      tick++;
      const ctx = {
        grid,
        world,
        agents,
        agent: mainAgent,
        rng,
        stats,
        config: cfg,
        tick,
        pending: { forcedTurns: [], lengthDelta: 0, setLength: null, end: null },
        logs,
        log: pushLog,
        highlights: [],
        events: [],
        cellsDirty: false,
        ca,
      };
      const logFrom = logs.length;
      const tickEvents = [];
      const outcome = this.stepOnce(ctx, engine, ca, tickEvents);
      stats.steps = tick;
      stats.length = mainAgent.length;
      stats.agents = agents.length;
      stats.obstacleCount = world.countState('obstacle');
      stats.markerCount = world.countState('marker');
      this.checkLengthOverflow(mainAgent, tick);

      if (ctx.cellsDirty) {
        storedCells = world.cells.slice();
      }
      // 首帧 / 结束帧必定缓存，其余按当前采样步长抽样
      const isLast = outcome.ended || tick === maxFrames;
      if ((isLast || tick >= nextStoreTick) && lastStoredTick !== tick) {
        if (!isLast && frames.length >= MAX_STORED_FRAMES) {
          frameStride *= 2;
          halveInPlace(frames);
          halveInPlace(stats.lengthHistory);
        }
        stats.lengthHistory.push(mainAgent.length);
        frames.push(this.captureFrame(
          tick,
          agents,
          storedCells,
          ctx.highlights,
          stats,
          logs,
          logFrom,
          logs.length,
          outcome.turn,
          tickEvents,
        ));
        lastStoredTick = tick;
        nextStoreTick = tick + frameStride;
      }

      if (outcome.ended) {
        endReason = outcome.reason;
        break;
      }
    }

    const frameStats = frames[frames.length - 1]?.stats || {};
    return {
      config: cfg,
      grid,
      states,
      frames,
      frameStride,
      logs,
      stats,
      endReason,
      diagnostics: this.runtimeDiagnostics,
      seed: cfg.seed,
      rngCalls: rng.calls,
      finalFrameIndex: frames.length - 1,
      summary: {
        steps: stats.steps,
        collisions: stats.collisions,
        selfCollisions: stats.selfCollisions,
        maxLength: stats.maxLength,
        coverage: stats.coverage,
        ruleTriggers: stats.ruleTriggers,
        caSteps: stats.caSteps,
        obstacleCount: stats.obstacleCount,
        markerCount: stats.markerCount,
        endReason: endReason ? endReason.label : '未结束（达到帧上限）',
        finalLength: frameStats.length ?? stats.length,
      },
    };
  }

  /* ------------------------------------------------------------------ */

  stepOnce(ctx, engine, ca, tickEvents) {
    const cfg = ctx.config;
    const grid = ctx.grid;
    const agent = ctx.agent;
    const rng = ctx.rng;
    const stats = ctx.stats;

    if (!agent.alive) return { ended: true, reason: agent.endReason || { code: 'manual', label: '已结束' } };

    // 1. 元胞自动机（移动前）
    if (ca && cfg.caMode.syncWithAgent === 'beforeMove') this.runCA(ctx);

    // 2. 移动前规则
    stats.ruleTriggers += engine.run('beforeStep', ctx, { sync: cfg.ruleExecution === 'sync' });
    if (ctx.pending.end) return { ended: true, reason: this.ruleEndReason(ctx) };

    // 3. 决定方向
    const decision = this.decideDirection(ctx, engine);
    let dir = decision.dir;
    const turnKey = decision.turnKey;

    // 4. 边界处理
    let target = grid.step(agent.head, dir);
    let wallHit = false;
    let outOfBounds = false;

    if (!grid.inBounds(target)) {
      outOfBounds = true;
      const mode = cfg.grid.boundary;
      if (mode === 'wrap') {
        target = grid.wrap(target);
      } else if (mode === 'bounce') {
        dir = grid.opposite(dir);
        const t2 = grid.step(agent.head, dir);
        if (grid.inBounds(t2)) target = t2;
        else wallHit = true;
      } else if (mode === 'randomTurn') {
        const options = [];
        for (let d = 0; d < grid.dirCount; d++) {
          const t = grid.step(agent.head, d);
          if (grid.inBounds(t) && !this.isBlocked(ctx, t)) options.push({ d, t });
        }
        if (options.length) {
          const pick = rng.pick(options);
          dir = pick.d;
          target = pick.t;
        } else {
          wallHit = true;
        }
      } else if (mode === 'custom') {
        ctx.pending.forcedTurns = [];
        engine.run('onBoundary', ctx, { sync: false });
        if (ctx.pending.forcedTurns.length) {
          dir = resolveTurn(ctx.pending.forcedTurns[0].turn, agent, grid, rng);
          const t2 = grid.step(agent.head, dir);
          if (grid.inBounds(t2)) target = t2;
          else wallHit = true;
        } else {
          wallHit = true;
        }
        agent.forcedNextTurn = null;
      } else {
        wallHit = true;
      }
    }

    // 5. 撞墙/越界处理
    if (wallHit) {
      agent.dir = dir;
      stats.collisions++;
      stats.collisionsTotal++;
      tickEvents.push({ type: 'wall', coord: agent.head, outOfBounds });
      ctx.highlights.push({ col: agent.head.col, row: agent.head.row, type: 'wall', tick: ctx.tick });
      stats.selfCollisionsConsecutive = 0; // 撞墙不是自撞，打断连续自撞计数
      const cfgEnd = cfg.endConditions;
      const hitCode = cfgEnd.priority.find((c) => (c === 'wall' || c === 'outOfBounds') && cfgEnd[c]);
      if (hitCode) {
        return {
          ended: true,
          reason: {
            code: hitCode,
            label: END_LABELS[hitCode],
            tick: ctx.tick,
            coord: { ...agent.head },
          },
        };
      }
      return { ended: false, turn: turnKey };
    }

    // 6. 障碍物处理
    if (ctx.world.isBlocking(target)) {
      const policy = cfg.collision.obstacle;
      if (policy === 'destroy') {
        ctx.world.set(target, 'empty');
        ctx.cellsDirty = true;
        tickEvents.push({ type: 'obstacleDestroyed', coord: { ...target } });
      } else if (policy === 'pass') {
        tickEvents.push({ type: 'obstaclePass', coord: { ...target } });
      } else if (policy === 'turn') {
        const options = [];
        for (let d = 0; d < grid.dirCount; d++) {
          const t = grid.step(agent.head, d);
          if (grid.inBounds(t) && !this.isBlocked(ctx, t)) options.push({ d, t });
        }
        if (options.length) {
          const pick = rng.pick(options);
          dir = pick.d;
          target = pick.t;
        } else {
          return { ended: true, reason: { code: 'noMove', label: END_LABELS.noMove, tick: ctx.tick, coord: { ...agent.head } } };
        }
      } else {
        stats.collisions++;
        stats.collisionsTotal++;
        stats.collisionsConsecutive++;
        stats.selfCollisionsConsecutive = 0; // 撞障碍物不是自撞，打断连续自撞计数
        tickEvents.push({ type: 'obstacle', coord: { ...target } });
        ctx.highlights.push({ col: target.col, row: target.row, type: 'collision', tick: ctx.tick });
        if (cfg.endConditions.obstacle) {
          return { ended: true, reason: { code: 'obstacle', label: END_LABELS.obstacle, tick: ctx.tick, coord: { ...target } } };
        }
        return { ended: false, turn: turnKey };
      }
    }

    // 7. 长度变化需求（先算，决定尾巴是否腾出）
    const lengthPlan = this.planLength(ctx, agent, target, tickEvents);
    const willGrow = lengthPlan.desired > agent.length;

    // 8. 碰撞检测（自撞 / 撞其他移动体）
    const collision = this.detectCollision(ctx, agent, target, willGrow);
    if (collision) {
      stats.collisions++;
      stats.collisionsTotal++;
      stats.collisionsConsecutive++;
      stats.selfCollisions++;
      stats.selfCollisionsConsecutive++;
      tickEvents.push({ type: 'selfCollision', coord: { ...target }, kind: collision });
      ctx.highlights.push({ col: target.col, row: target.row, type: 'collision', tick: ctx.tick });
      stats.ruleTriggers += engine.run('onCollision', ctx, { sync: cfg.ruleExecution === 'sync' });

      const policy = cfg.selfCollisionPolicy;
      // 「自撞是否结束运行」唯一由结束规则「撞到自身」决定：
      // 未勾选时，停止类策略（立即停止 / 自定义）退化为「忽略并继续」，
      // 且「连续自撞上限」也不再结束运行，避免蛇原地卡死。
      const endsRun = !!cfg.endConditions.selfCollision;
      const stopReason = { ended: true, reason: { code: 'selfCollision', label: END_LABELS.selfCollision, tick: ctx.tick, coord: { ...target } } };
      if (ctx.pending.forcedTurns.length) {
        dir = resolveTurn(ctx.pending.forcedTurns[0].turn, agent, grid, rng);
        const t2 = grid.step(agent.head, dir);
        if (grid.inBounds(t2) && !this.detectCollision(ctx, agent, t2, false) && !ctx.world.isBlocking(t2)) {
          target = t2;
        }
      } else {
        switch (policy.action) {
          case 'ignore':
            break;
          case 'forceStraight':
          case 'forceStraightN': {
            agent.pendingForcedStraights = policy.action === 'forceStraight' ? 1 : Math.max(1, policy.n);
            stats.forcedStraights += agent.pendingForcedStraights;
            break;
          }
          case 'randomTurn': {
            const options = [];
            for (let d = 0; d < grid.dirCount; d++) {
              if (d === grid.opposite(dir)) continue;
              const t = grid.step(agent.head, d);
              if (grid.inBounds(t) && !this.detectCollision(ctx, agent, t, false) && !ctx.world.isBlocking(t)) options.push({ d, t });
            }
            if (options.length) {
              const pick = rng.pick(options);
              dir = pick.d;
              target = pick.t;
            } else if (endsRun) {
              return stopReason;
            }
            break;
          }
          case 'custom':
            if (endsRun) return stopReason;
            break;
          case 'stop':
          default: {
            if (endsRun) return stopReason;
            break;
          }
        }
        if (endsRun && stats.selfCollisionsConsecutive >= policy.maxConsecutive) {
          return { ended: true, reason: { code: 'selfCollision', label: `连续撞到自身 ${stats.selfCollisionsConsecutive} 次`, tick: ctx.tick, coord: { ...target } } };
        }
      }
    } else {
      stats.collisionsConsecutive = 0;
      stats.selfCollisionsConsecutive = 0;
    }

    // 9. 执行移动与长度变化
    agent.dir = dir;
    this.applyMove(ctx, agent, target, lengthPlan);
    stats.length = agent.length;
    stats.maxLength = Math.max(stats.maxLength, agent.length);
    stats.minLength = Math.min(stats.minLength, agent.length);
    for (let i = 0; i < agent.segments.length; i++) {
      stats.visited.add(grid.idx(agent.segments[i].col, agent.segments[i].row));
    }
    stats.coverage = (stats.visited.size / grid.size) * 100;
    if (turnKey === 'left') stats.turnsLeft++;
    else if (turnKey === 'right') stats.turnsRight++;
    else if (turnKey === 'reverse') stats.turnsReverse++;
    else stats.turnsStraight++;

    // 10. 进入新格 / 移动后规则
    stats.ruleTriggers += engine.run('onEnter', ctx, { sync: cfg.ruleExecution === 'sync' });
    stats.ruleTriggers += engine.run('afterStep', ctx, { sync: cfg.ruleExecution === 'sync' });
    if (ctx.tick % 1 === 0) {
      stats.ruleTriggers += engine.run('timer', ctx, { sync: cfg.ruleExecution === 'sync' });
    }
    if (ctx.pending.end) return { ended: true, reason: this.ruleEndReason(ctx), turn: turnKey };

    // 11. 元胞自动机（移动后 / 交替）
    if (ca && cfg.caMode.syncWithAgent === 'afterMove') this.runCA(ctx);
    if (ca && cfg.caMode.syncWithAgent === 'everyN' && ctx.tick % cfg.caMode.every === 0) this.runCA(ctx);

    // 12. 结束条件
    const endCheck = this.checkEndConditions(ctx, tickEvents);
    if (endCheck) return { ended: true, reason: endCheck, turn: turnKey };

    return { ended: false, turn: turnKey };
  }

  runCA(ctx) {
    if (!ctx.ca) return;
    const changed = ctx.ca.step(ctx.world, ctx.rng);
    if (changed) ctx.cellsDirty = true;
    ctx.stats.caSteps++;
  }

  ruleEndReason(ctx) {
    const p = ctx.pending.end;
    return { code: p.code || 'ruleEnd', label: p.reason || END_LABELS.ruleEnd, tick: ctx.tick, coord: ctx.agent ? { ...ctx.agent.head } : null };
  }

  isBlocked(ctx, coord) {
    return ctx.world.isBlocking(coord);
  }

  /** 决定下一步转向：规则强制 > 条件概率规则 > 基础左/直/右权重 */
  decideDirection(ctx, engine) {
    const cfg = ctx.config;
    const grid = ctx.grid;
    const agent = ctx.agent;
    const rng = ctx.rng;

    if (agent.forcedNextTurn) {
      const turn = agent.forcedNextTurn;
      agent.forcedNextTurn = null;
      return { dir: resolveTurn(turn, agent, grid, rng), turnKey: turn };
    }
    if (agent.pendingForcedStraights > 0) {
      agent.pendingForcedStraights--;
      return { dir: agent.dir, turnKey: 'straight' };
    }
    const adv = cfg.advancedRules
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => r.enabled && r.condition)
      .sort((a, b) => (b.r.priority - a.r.priority) || (a.i - b.i));
    let weights = cfg.moveRules;
    for (const { r } of adv) {
      const subject = { coord: agent.head, agent, kind: 'head', segmentIndex: 0, ruleId: r.id };
      if (evaluateCondition(r.condition, subject, ctx)) {
        weights = r.moves;
        break;
      }
    }
    const options = [
      { key: 'left', weight: Math.max(0, weights.left) },
      { key: 'straight', weight: Math.max(0, weights.straight) },
      { key: 'right', weight: Math.max(0, weights.right) },
    ];
    const { item } = rng.weighted(options, (o) => o.weight);
    return { dir: resolveTurn(item.key, agent, grid, rng), turnKey: item.key };
  }

  /** 计算本步长度目标 */
  planLength(ctx, agent, target, tickEvents) {
    const cfg = ctx.config;
    const rng = ctx.rng;
    const lp = cfg.body.lengthPolicy;
    let delta = ctx.pending.lengthDelta;
    const ate = ctx.world.get(target) === 'marker';

    if (lp.mode !== 'fixed') {
      const triggerOk = (sub) => {
        if (!sub.enabled) return false;
        switch (sub.trigger) {
          case 'step':
          case 'timer':
            return ctx.tick % Math.max(1, sub.interval) === 0;
          case 'eat':
            return ate;
          case 'collision':
            return tickEvents.some((e) => e.type === 'selfCollision');
          default:
            return false;
        }
      };
      if (triggerOk(lp.growth) && rng.next() < lp.growth.probability) {
        delta += lp.growth.amount;
        tickEvents.push({ type: 'grow', amount: lp.growth.amount });
      }
      if (triggerOk(lp.shrink) && rng.next() < lp.shrink.probability) {
        delta -= lp.shrink.amount;
        tickEvents.push({ type: 'shrink', amount: lp.shrink.amount });
      }
    }

    if (ate) {
      // 吃到标记物：移除并计入事件
      ctx.world.set(target, 'empty');
      ctx.cellsDirty = true;
      tickEvents.push({ type: 'eat', coord: { ...target } });
      if (lp.growth.enabled && lp.growth.trigger === 'eat') {
        // 已在上方按 trigger 处理
      }
    }

    let desired = ctx.pending.setLength !== null
      ? ctx.pending.setLength
      : agent.length + delta;
    const maxLen = lp.mode === 'fixed' ? agent.length : (lp.growth.enabled ? lp.growth.maxLength : 100000);
    const minLen = lp.mode === 'fixed' ? agent.length : (lp.shrink.enabled ? lp.shrink.minLength : 1);
    desired = Math.max(Math.min(desired, maxLen), Math.max(1, minLen));
    if (lp.mode === 'fixed' && ctx.pending.setLength === null) desired = agent.length;
    ctx.pending.lengthDelta = 0;
    ctx.pending.setLength = null;
    return { desired, delta };
  }

  /** 头撞身体/其他移动体检测 */
  detectCollision(ctx, agent, target, willGrow) {
    const cfg = ctx.config;
    const grid = ctx.grid;
    const index = grid.idx(target.col, target.row);
    const skipTail = !willGrow && !cfg.collision.headIntoTail;
    const tailIndex = agent.segments.length > 1
      ? grid.idx(agent.tail.col, agent.tail.row)
      : -1;

    for (let i = 0; i < agent.segments.length; i++) {
      const seg = agent.segments[i];
      if (grid.idx(seg.col, seg.row) !== index) continue;
      if (i === 0) continue;
      if (i === agent.segments.length - 1 && skipTail) continue;
      if (i > 0 && !cfg.collision.headIntoBody) continue;
      return 'self';
    }
    if (!cfg.collision.headIntoBody) return null;
    for (const other of ctx.agents) {
      if (other === agent || !other.alive) continue;
      for (let i = 0; i < other.segments.length; i++) {
        const seg = other.segments[i];
        if (grid.idx(seg.col, seg.row) !== index) continue;
        if (i === other.segments.length - 1 && skipTail && other.length > 1) continue;
        return 'other';
      }
    }
    return null;
  }

  applyMove(ctx, agent, target, lengthPlan) {
    const grid = ctx.grid;
    agent.segments.unshift({ ...target });
    const desired = lengthPlan.desired;
    while (agent.segments.length > desired) agent.segments.pop();
    while (agent.segments.length < desired) {
      const tail = agent.segments[agent.segments.length - 1];
      agent.segments.push({ ...tail });
    }
    if (agent.segments.length === 0) agent.segments.push({ ...target });
  }

  /** 结束条件判定（按优先级返回首个命中项） */
  checkEndConditions(ctx, tickEvents) {
    const cfg = ctx.config;
    const ec = cfg.endConditions;
    const stats = ctx.stats;
    const agent = ctx.agent;
    const grid = ctx.grid;

    const triggered = {
      wall: () => tickEvents.some((e) => e.type === 'wall'),
      outOfBounds: () => tickEvents.some((e) => e.type === 'wall' && e.outOfBounds),
      selfCollision: () => tickEvents.some((e) => e.type === 'selfCollision'),
      selfCollisionTotal: () => stats.selfCollisions >= ec.selfCollisionTotalN,
      selfCollisionConsecutive: () => stats.selfCollisionsConsecutive >= ec.selfCollisionConsecutiveN,
      obstacle: () => tickEvents.some((e) => e.type === 'obstacle'),
      maxSteps: () => ctx.tick >= ec.maxSteps,
      lengthReached: () => agent.length >= ec.lengthTarget,
      coverage: () => stats.coverage >= ec.coveragePercent,
      noMove: () => {
        for (let d = 0; d < grid.dirCount; d++) {
          const t = grid.step(agent.head, d);
          if (!grid.inBounds(t)) continue;
          if (this.isBlocked(ctx, t)) continue;
          if (this.detectCollision(ctx, agent, t, false)) continue;
          return false;
        }
        return true;
      },
      maxTime: () => (ctx.tick / Math.max(0.001, cfg.speed)) * 1000 >= ec.maxTimeMs,
      ruleEnd: () => !!ctx.pending.end,
    };

    for (const code of ec.priority) {
      if (!ec[code]) continue;
      if (!triggered[code]) continue;
      if (!triggered[code]()) continue;
      if (code === 'maxSteps') return { code, label: `${END_LABELS.maxSteps}（${ec.maxSteps}）`, tick: ctx.tick, coord: { ...agent.head } };
      if (code === 'lengthReached') return { code, label: `${END_LABELS.lengthReached}（${ec.lengthTarget}）`, tick: ctx.tick, coord: { ...agent.head } };
      if (code === 'coverage') return { code, label: `${END_LABELS.coverage}（${ec.coveragePercent}%）`, tick: ctx.tick, coord: { ...agent.head } };
      if (code === 'selfCollisionTotal') return { code, label: `${END_LABELS.selfCollisionTotal}（${ec.selfCollisionTotalN}）`, tick: ctx.tick, coord: { ...agent.head } };
      if (code === 'selfCollisionConsecutive') return { code, label: `${END_LABELS.selfCollisionConsecutive}（${ec.selfCollisionConsecutiveN}）`, tick: ctx.tick, coord: { ...agent.head } };
      if (code === 'noMove') return { code, label: END_LABELS.noMove, tick: ctx.tick, coord: { ...agent.head } };
      if (code === 'maxTime') return { code, label: `${END_LABELS.maxTime}（${ec.maxTimeMs}ms）`, tick: ctx.tick, coord: { ...agent.head } };
      return { code, label: END_LABELS[code] || code, tick: ctx.tick, coord: { ...agent.head } };
    }
    return null;
  }

  captureFrame(tick, agents, cells, highlights, stats, logs, logFrom, logTo, turn = null, events = []) {
    return {
      tick,
      agents: agents.map((a) => ({
        id: a.id,
        label: a.label,
        segments: a.segments.map((s) => [s.col, s.row]),
        dir: a.dir,
        alive: a.alive,
        color: a.color,
        length: a.segments.length,
      })),
      cells,
      highlights: highlights.map((h) => ({
        col: h.col ?? h.coord?.col,
        row: h.row ?? h.coord?.row,
        type: h.type,
        state: h.state,
        ruleId: h.ruleId,
      })),
      collisions: events.filter((e) => ['selfCollision', 'wall', 'obstacle'].includes(e.type)).map((e) => [e.coord.col, e.coord.row]),
      turn,
      events,
      stats: {
        steps: stats.steps,
        collisions: stats.collisions,
        selfCollisions: stats.selfCollisions,
        length: agents[0] ? agents[0].length : 0,
        coverage: stats.coverage,
        ruleTriggers: stats.ruleTriggers,
        caSteps: stats.caSteps,
        agents: agents.length,
      },
      logFrom: logFrom === null ? 0 : logFrom,
      logTo: logTo === null ? 0 : logTo,
    };
  }
}
