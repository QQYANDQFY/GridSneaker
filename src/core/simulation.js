/**
 * 模拟主循环
 * - 逻辑与渲染分离：run() 为纯计算，输出逐帧状态供渲染层使用
 * - 支持移动体规则、环境感知-条件-后果规则、元胞自动机（纯 CA / 混合模式）
 * - 支持多蛇生成与交互（碰撞 / 融合 / 排斥 / 穿行）
 * - 随机全部来自种子化 RNG，保证可复现
 */
import { Grid, parseDir, dirNames } from './grid.js';
import { RNG } from './rng.js';
import { World, Agent } from './world.js';
import { CAEngine } from './ca.js';
import { RuleEngine } from './rules.js';
import { normalizeConfig, END_LABELS, centerCoord, gridSizeFor, isBodyEnabled, LIFE_MAX } from './config.js';
import { resolveTurn, occupiedByAgent, findSpawnCoord } from './actions.js';
import { evaluateCondition } from './conditions.js';
import { computeScore } from './score.js';

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
/**
 * 单次「蛇死亡转化」最多写入的过渡动画高亮条数。
 * 长蛇（可达成千上万节）转化为环境时，画面只需呈现可见范围内的过渡效果，
 * 因此对高亮条数设上限，避免逐帧携带超大高亮数组拖慢播放。
 */
export const MAX_TRANSFORM_HIGHLIGHTS = 4000;

/** 单调时钟：优先高精度计时（performance.now），环境不支持时退回 Date.now */
function clockNow() {
  return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
}

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
    if (!agent || agent.length <= cells || this.diagCodes.has('lengthExceedsGrid')) return;
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
    // 环绕边界（wrap）下身体要能跨越地图接缝继续铺设，否则起点靠近边界时
    // 初始身体会被截断（表现为「蛇身缺段 / 长度与设定不符」），因此这里按 wrap 环绕延伸。
    // 节数上限取整张地图格数：再多必然出现体节重叠。
    const wrap = cfg.grid.boundary === 'wrap';
    const requested = Math.max(1, Math.round(cfg.body.initialLength));
    const limit = wrap ? Math.min(requested, grid.size) : requested;
    let cur = { ...head };
    for (let i = 1; i < limit; i++) {
      cur = grid.step(cur, grid.opposite(dir));
      if (wrap) cur = grid.wrap(cur);
      else if (!grid.inBounds(cur)) break;
      segments.push({ ...cur });
    }
    return new Agent('main', segments, dir, {
      label: '主移动体',
      isMain: true,
      spawnTick: 0,
      // 生命机制：主移动体携带初始生命；未启用时为 0，致命判定的旧行为不变
      lives: cfg.life.enabled ? cfg.life.initialLives : 0,
    });
  }

  run() {
    const cfg = this.config;
    const grid = this.grid;
    const states = this.states;
    const rng = new RNG(cfg.seed);
    const startedAt = clockNow();
    const world = new World(grid, states);
    const ca = cfg.caMode.enabled ? new CAEngine(grid, cfg.caMode, states) : null;
    if (ca) ca.init(world, rng);
    this.runtimeDiagnostics = [];
    this.diagCodes.clear();
    // 蛇形实体总开关：body.enabled=false 或 initialLength=0 时不生成任何初始蛇
    const bodyOn = isBodyEnabled(cfg);
    if (bodyOn) this.checkStartBlocked(world);

    const engine = new RuleEngine(cfg);
    // 起始方向为「任意」时，由种子化 RNG 在网格的全部方向中随机挑选
    const dir = bodyOn
      ? (cfg.start.direction === 'random' ? rng.int(grid.dirCount) : parseDir(cfg.start.direction, grid.type))
      : 0;
    const mainAgent = bodyOn ? this.createInitialAgent(rng, dir) : null;
    if (mainAgent) this.checkBodyTruncated(mainAgent);
    const agents = mainAgent ? [mainAgent] : [];

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
      length: mainAgent ? mainAgent.length : 0,
      maxLength: mainAgent ? mainAgent.length : 0,
      minLength: mainAgent ? mainAgent.length : 0,
      lengthHistory: [mainAgent ? mainAgent.length : 0],
      visited: new Set(),
      coverage: 0,
      ruleTriggers: 0,
      caSteps: 0,
      caStableCount: 0,
      agents: agents.length,
      peakAgents: agents.length,
      // 多蛇系统统计
      spawns: 0,
      agentDeaths: 0,
      merges: 0,
      repels: 0,
      markerInteractions: 0,
      forcedStraights: 0,
      // 「蛇死亡转化」专属统计：自撞致死次数 / 成功并入环境的身体节点数 / 转化流程触发次数
      transformDeaths: 0,
      transformedCells: 0,
      transformTriggers: 0,
      // 「生命机制」专属统计
      lives: mainAgent ? mainAgent.lives : 0,
      maxLives: mainAgent ? mainAgent.lives : 0,
      lifeGains: 0,
      lifeLosses: 0,
      respawns: 0,
      lifeWarnings: 0,
      finalDeaths: 0,
      /** 碰撞预警：下一步会撞到自身身体的「危险朝向」计数（仅在开启预警时累计） */
      collisionWarnings: 0,
      turnHistory: [],
      lengthOverTime: [mainAgent ? mainAgent.length : 0],
      obstacleCount: 0,
      markerCount: 0,
      logsDropped: 0,
      /** 边界穿越次数（环绕边界下每穿越一次 +1，与穿越日志同步累计） */
      wrapCrossings: 0,
    };

    const initStateIdx = new Set();
    if (mainAgent) {
      for (const s of mainAgent.segments) initStateIdx.add(grid.idx(s.col, s.row));
      for (const i of initStateIdx) stats.visited.add(i);
      stats.coverage = (stats.visited.size / grid.size) * 100;
    }

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
    /** 多蛇「随机时间间隔」生成所需的调度状态 */
    const spawnCtl = { nextTick: null };

    stats.rngCalls = rng.calls; // 帧级快照需要「截至该帧」的随机调用次数
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
        spawnCtl,
      };
      const logFrom = logs.length;
      const tickEvents = [];
      const outcome = this.stepOnce(ctx, engine, ca, tickEvents);
      stats.steps = tick;
      stats.agents = agents.filter((a) => a.alive).length;
      stats.peakAgents = Math.max(stats.peakAgents, stats.agents);
      const primary = mainAgent && (mainAgent.alive || mainAgent.zombie)
        ? mainAgent
        : agents.find((a) => a.alive || a.zombie) || null;
      stats.length = primary ? primary.length : 0;
      if (primary) {
        stats.maxLength = Math.max(stats.maxLength, primary.length);
        stats.minLength = Math.min(stats.minLength, primary.length);
        stats.lives = mainAgent ? mainAgent.lives : 0;
        stats.maxLives = Math.max(stats.maxLives, primary.lives || 0);
      }
      stats.obstacleCount = world.countState('obstacle');
      stats.markerCount = world.countState('marker');
      this.checkLengthOverflow(primary, tick);

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
        stats.lengthHistory.push(stats.length);
        stats.rngCalls = rng.calls; // 帧级快照需要「截至该帧」的随机调用次数
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
      /** 本轮运行的实际耗时（毫秒），供统计面板展示性能信息 */
      elapsedMs: Math.max(0, clockNow() - startedAt),
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
        agents: stats.agents,
        peakAgents: stats.peakAgents,
        spawns: stats.spawns,
        agentDeaths: stats.agentDeaths,
        merges: stats.merges,
        transformDeaths: stats.transformDeaths,
        transformedCells: stats.transformedCells,
        collisionWarnings: stats.collisionWarnings,
        /** 边界穿越次数（环绕边界下「穿越到另一侧」的累计次数） */
        wrapCrossings: stats.wrapCrossings,
        // 生命机制：剩余 / 生命增减 / 重生 / 生命耗尽最终死亡 / 低生命预警
        lives: stats.lives,
        maxLives: stats.maxLives,
        lifeGains: stats.lifeGains,
        lifeLosses: stats.lifeLosses,
        respawns: stats.respawns,
        lifeWarnings: stats.lifeWarnings,
        finalDeaths: stats.finalDeaths,
        endReason: endReason ? endReason.label : '未结束（达到帧上限）',
        finalLength: frameStats.length ?? stats.length,
        /** 得分系统：总分 / 等级 / 分项，由 core/score.js 纯函数折算 */
        score: computeScore(stats, grid, endReason),
      },
    };
  }

  /* ------------------------------------------------------------------ */

  /**
   * 推进一帧：
   *   1. 移动前 CA → 2. 移动前规则 → 3. 逐个移动体推进 → 4. 多蛇交互
   *   → 5. 移动后/进入/定时规则 → 6. 生成新蛇 → 7. 移动后 CA → 8. 结束条件
   */
  stepOnce(ctx, engine, ca, tickEvents) {
    const cfg = ctx.config;
    const stats = ctx.stats;
    const agents = ctx.agents;
    const sync = cfg.ruleExecution === 'sync';
    // 主移动体优先；主移动体已消失（如自撞转入环境）时退回到仍在场的移动体，
    // 保证「撞到自身」不再终止运行后，规则主体与结束条件判定仍然有可用对象。
    const main = agents.find((a) => a.isMain && a.alive)
      || agents.find((a) => a.alive)
      || agents.find((a) => a.zombie)
      || agents[0]
      || null;
    ctx.agent = main;

    // 1. 元胞自动机（移动前）
    if (ca && cfg.caMode.syncWithAgent === 'beforeMove') this.runCA(ctx);

    // 2. 移动前规则
    stats.ruleTriggers += engine.run('beforeStep', ctx, { sync });
    if (ctx.pending.end) return { ended: true, reason: this.ruleEndReason(ctx) };

    // 3. 逐个移动体推进（单蛇运行时与旧行为完全一致）
    let fatal = null;
    for (const agent of agents.slice()) {
      // 死亡（含生命耗尽）的移动体立即停止一切移动逻辑；
      // 仅「死亡后仍可移动」开启时以僵尸态继续参与推进。
      if (!agent.alive && !agent.zombie) continue;
      // 记录移动前状态：排斥模式下发生重叠时用于回退
      agent.prevState = {
        segments: agent.segments.map((s) => ({ col: s.col, row: s.row })),
        dir: agent.dir,
      };
      const res = this.stepAgent(ctx, engine, agent, tickEvents);
      if (res && res.ended) {
        if (agent.isMain) { fatal = res.reason; break; }
      }
    }
    ctx.agent = main;
    if (fatal) return { ended: true, reason: fatal, turn: main ? main.lastTurn : null };

    // 3.5 碰撞预警：标出「下一步会撞到自身身体」的邻格（需在配置中显式开启，默认关闭）
    if (cfg.safety.warnSelfCollision) this.collectCollisionWarnings(ctx);

    // 4. 多蛇交互（碰撞 / 融合 / 排斥）
    const inter = this.resolveAgentInteractions(ctx, tickEvents);
    if (inter && inter.fatal) return { ended: true, reason: inter.reason };

    // 5. 移动后 / 进入新格 / 定时规则（每步一次，面向全体移动体）
    stats.ruleTriggers += engine.run('onEnter', ctx, { sync });
    stats.ruleTriggers += engine.run('afterStep', ctx, { sync });
    stats.ruleTriggers += engine.run('timer', ctx, { sync });
    if (ctx.pending.end) return { ended: true, reason: this.ruleEndReason(ctx), turn: main ? main.lastTurn : null };

    // 6. 多蛇生成
    this.maybeSpawn(ctx, tickEvents);

    // 7. 元胞自动机（移动后 / 每隔 N 步）
    if (ca && cfg.caMode.syncWithAgent === 'afterMove') this.runCA(ctx);
    if (ca && cfg.caMode.syncWithAgent === 'everyN' && ctx.tick % cfg.caMode.every === 0) this.runCA(ctx);

    // 8. 结束条件
    const endCheck = this.checkEndConditions(ctx, tickEvents);
    if (endCheck) return { ended: true, reason: endCheck, turn: main ? main.lastTurn : null };

    // 8.5 转化模式收尾：已经发生自撞死亡、场上不再有存活移动体，且没有元胞自动机
    // 需要继续演化时，没有必要空转到帧上限——给出明确的收尾原因；
    // 启用 CA 时则保持运行，让转化后的节点继续按 CA 规则演化（这正是「无缝接入」的语义）。
    if (cfg.transform.enabled && !ca && (stats.agentDeaths || 0) > 0
      && !agents.some((a) => a.alive || a.zombie)) {
      return {
        ended: true,
        reason: { code: 'transformDone', label: END_LABELS.transformDone, tick: ctx.tick, coord: null },
      };
    }

    // 清理已消失的移动体（保留死亡信息于统计与事件中）；僵尸态保留在场上
    for (let i = agents.length - 1; i >= 0; i--) {
      if (!agents[i].alive && !agents[i].zombie) agents.splice(i, 1);
    }

    return { ended: false, turn: main ? main.lastTurn : null };
  }

  /**
   * 推进单个移动体一步（原 stepOnce 主体）。
   * 主移动体的终止原因会终止整场运行；其它移动体只会自行消失。
   */
  stepAgent(ctx, engine, agent, tickEvents) {
    const cfg = ctx.config;
    const grid = ctx.grid;
    const rng = ctx.rng;
    const stats = ctx.stats;
    const sync = cfg.ruleExecution === 'sync';

    if (!agent.alive && !agent.zombie) return { ended: false };

    const life = cfg.life;
    // 「死亡后仍可移动」开启时致命判定整体不生效（保留旧的可移动表现）；
    // 重生无敌窗口内同样不触发致命判定，避免重生后立刻再次丢命。
    const immortal = life.enabled && life.keepMovingAfterDeath;
    const invincible = agent.invincibleUntil >= ctx.tick;
    const protectedAgent = immortal || invincible || !!agent.zombie;

    // 1. 决定方向
    const decision = this.decideDirection(ctx, engine, agent);
    let dir = decision.dir;
    const turnKey = decision.turnKey;
    agent.lastTurn = turnKey;

    // 2. 边界处理
    let target = grid.step(agent.head, dir);
    let wallHit = false;
    let outOfBounds = false;

    if (!grid.inBounds(target)) {
      outOfBounds = true;
      const mode = cfg.grid.boundary;
      if (mode === 'wrap') {
        // 记录穿越：起始格在网格外（滑出的一侧），落点格在对侧（滑入的一侧）。
        // 渲染层据此绘制「穿梭」特效，让边界穿越在画面上可见。
        const exit = { ...target };
        target = grid.wrap(target);
        ctx.highlights.push({
          col: target.col,
          row: target.row,
          type: 'wrap',
          fromCol: exit.col,
          fromRow: exit.row,
          dir,
          agentId: agent.id,
        });
        // 事件日志：穿越不是规则触发，但值得回溯（可由 cfg.events.logCrossings 关闭）
        if (cfg.events?.logCrossings) {
          ctx.stats.wrapCrossings = (ctx.stats.wrapCrossings || 0) + 1;
          ctx.log({
            tick: ctx.tick,
            ruleId: 'boundary',
            ruleName: '边界穿越',
            trigger: 'wrap',
            subject: agent.label || agent.id,
            coord: { col: target.col, row: target.row },
            priority: 0,
            condition: `从 (${exit.col}, ${exit.row}) 沿${dirNames(grid.type)[dir] || dir}滑出边界`,
            actions: `从对侧 (${target.col}, ${target.row}) 滑入`,
            text: `「${agent.label || agent.id}」第 ${ctx.tick} 步穿越边界：(${exit.col}, ${exit.row}) → (${target.col}, ${target.row})`,
          });
        }
      } else if (mode === 'bounce') {
        dir = grid.opposite(dir);
        const t2 = grid.step(agent.head, dir);
        if (grid.inBounds(t2) && !this.selfBlocks(ctx, agent, t2)) {
          target = t2;
        } else {
          // 边界反弹的安全避撞（仅「反弹」边界生效，穿越等其它边界逻辑不变）：
          // 反向落点压在自身身体上（贴边掉头正好撞到自己的脖子）或落在界外（贴角）时，
          // 改选一个「界内 + 不被阻塞 + 不撞自身」的方向，避免被误判为自撞死亡。
          const alt = this.bounceSafeOption(ctx, agent, dir);
          if (alt) {
            dir = alt.dir;
            target = alt.coord;
          } else if (grid.inBounds(t2)) {
            target = t2;
          } else {
            wallHit = true;
          }
        }
      } else if (mode === 'randomTurn') {
        const options = [];
        for (let d = 0; d < grid.dirCount; d++) {
          const c = this.resolveCandidate(ctx, grid.step(agent.head, d));
          if (c.ok && !this.isBlocked(ctx, c.coord)) options.push({ d, t: c.coord });
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
          const c = this.resolveCandidate(ctx, grid.step(agent.head, dir));
          if (c.ok) target = c.coord;
          else wallHit = true;
        } else {
          wallHit = true;
        }
        agent.forcedNextTurn = null;
      } else {
        wallHit = true;
      }
    }

    // 3. 撞墙/越界处理
    if (wallHit) {
      agent.dir = dir;
      stats.collisions++;
      stats.collisionsTotal++;
      tickEvents.push({ type: 'wall', coord: agent.head, outOfBounds });
      ctx.highlights.push({ col: agent.head.col, row: agent.head.row, type: 'wall', tick: ctx.tick });
      stats.selfCollisionsConsecutive = 0; // 撞墙不是自撞，打断连续自撞计数
      const cfgEnd = cfg.endConditions;
      const hitCode = cfgEnd.priority.find((c) => (c === 'wall' || c === 'outOfBounds') && cfgEnd[c]);
      if (hitCode && !protectedAgent) {
        // 生命机制：撞墙 / 越界先扣 1 条命并原地重生，生命耗尽才收尾
        if (life.enabled) {
          const r = this.consumeLifeOnDeath(ctx, agent, {
            code: hitCode,
            label: END_LABELS[hitCode],
            tick: ctx.tick,
            coord: { ...agent.head },
          }, tickEvents);
          if (r === 'alive') {
            this.absorbFatalEvent(tickEvents, 'wall');
            return { ended: false, turn: turnKey };
          }
        }
        return this.agentEnd(ctx, agent, {
          code: hitCode,
          label: END_LABELS[hitCode],
          tick: ctx.tick,
          coord: { ...agent.head },
        }, tickEvents);
      }
      // 无敌窗口 / 「死亡后仍可移动」下撞墙只作碰撞记录，不触发结束规则
      if (hitCode && life.enabled) this.absorbFatalEvent(tickEvents, 'wall');
      return { ended: false, turn: turnKey };
    }

    // 4. 障碍物处理
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
          const c = this.resolveCandidate(ctx, grid.step(agent.head, d));
          if (c.ok && !this.isBlocked(ctx, c.coord)) options.push({ d, t: c.coord });
        }
        if (options.length) {
          const pick = rng.pick(options);
          dir = pick.d;
          target = pick.t;
        } else {
          return this.agentEnd(ctx, agent, { code: 'noMove', label: END_LABELS.noMove, tick: ctx.tick, coord: { ...agent.head } }, tickEvents);
        }
      } else {
        stats.collisions++;
        stats.collisionsTotal++;
        stats.collisionsConsecutive++;
        stats.selfCollisionsConsecutive = 0; // 撞障碍物不是自撞，打断连续自撞计数
        tickEvents.push({ type: 'obstacle', coord: { ...target } });
        ctx.highlights.push({ col: target.col, row: target.row, type: 'collision', tick: ctx.tick });
        if (cfg.endConditions.obstacle && !protectedAgent) {
          if (life.enabled) {
            const r = this.consumeLifeOnDeath(ctx, agent, {
              code: 'obstacle',
              label: END_LABELS.obstacle,
              tick: ctx.tick,
              coord: { ...target },
            }, tickEvents);
            if (r === 'alive') {
              this.absorbFatalEvent(tickEvents, 'obstacle');
              return { ended: false, turn: turnKey };
            }
          }
          return this.agentEnd(ctx, agent, { code: 'obstacle', label: END_LABELS.obstacle, tick: ctx.tick, coord: { ...target } }, tickEvents);
        }
        // 无敌窗口 / 「死亡后仍可移动」下撞障碍物只作碰撞记录，不触发结束规则
        if (cfg.endConditions.obstacle && life.enabled) this.absorbFatalEvent(tickEvents, 'obstacle');
        return { ended: false, turn: turnKey };
      }
    }

    // 5. 交互标记物反馈（在长度策略之前结算，长度变化通过 ctx.pending 注入）
    const ateCell = ctx.world.get(target) === 'marker';
    this.applyMarkerInteraction(ctx, agent, target, tickEvents);

    // 5.5 生命机制的环境增减生命：拾取增益格子 +1 条命，踏入陷阱格子 -1 条命（非致命）
    const lifeHit = this.applyLifeItemInteraction(ctx, agent, target, tickEvents);
    if (lifeHit === 'loss' && life.enabled && !protectedAgent && (agent.lives || 0) <= 0) {
      // 陷阱扣完最后一条命 → 计入最终死亡并触发死亡判定（与其它致命判定口径一致）
      this.markLifeDepleted(ctx, target, 'lifeDepleted', tickEvents);
      return this.agentEnd(ctx, agent, {
        code: 'lifeDepleted',
        label: END_LABELS.lifeDepleted,
        tick: ctx.tick,
        coord: { ...target },
      }, tickEvents);
    }

    // 6. 长度变化需求（先算，决定尾巴是否腾出）
    const lengthPlan = this.planLength(ctx, agent, target, tickEvents, ateCell);
    const willGrow = lengthPlan.desired > agent.length;

    // 7. 碰撞检测（自撞 / 撞其他移动体）
    const collision = this.detectCollision(ctx, agent, target, willGrow);
    if (collision) {
      stats.collisions++;
      stats.collisionsTotal++;
      stats.collisionsConsecutive++;
      // 「蛇死亡转化」：自撞即判定死亡——只让该移动体从场上消失（主移动体也不例外），
      // 这里刻意不返回 ended，主循环与元胞自动机继续运行，随后按两个概率参数
      // 把身体节点并入环境状态集合。未开启该功能时完全沿用下方的原有自撞策略。
      const transformDeath = collision === 'self' && cfg.transform.enabled && cfg.transform.dieOnSelfCollision;
      if (collision === 'self') {
        // 转化死亡由「蛇死亡」流程接管，不计入自撞次数，避免触发自撞类结束规则
        if (transformDeath) stats.selfCollisionsConsecutive = 0;
        else {
          stats.selfCollisions++;
          stats.selfCollisionsConsecutive++;
        }
      } else {
        // 撞到其它移动体：不计入「自撞」统计，避免污染自撞结束规则
        stats.selfCollisionsConsecutive = 0;
      }
      tickEvents.push({ type: 'selfCollision', coord: { ...target }, kind: collision, transformed: transformDeath });
      ctx.highlights.push({ col: target.col, row: target.row, type: 'collision', tick: ctx.tick });
      stats.ruleTriggers += engine.run('onCollision', ctx, { sync });

      // 生命机制：自撞先扣 1 条命并原地重生（保留头部位置与得分，仅重置蛇身长度），
      // 生命耗尽才进入转化 / 结束流程。
      if (collision === 'self' && life.enabled && !protectedAgent) {
        const r = this.consumeLifeOnDeath(ctx, agent, {
          code: 'selfCollision',
          label: END_LABELS.selfCollision,
          tick: ctx.tick,
          coord: { ...target },
        }, tickEvents);
        if (r === 'alive') {
          this.absorbFatalEvent(tickEvents, 'selfCollision');
          return { ended: false, turn: turnKey };
        }
      }
      // 仍有剩余生命时（重生无敌窗口 / 「死亡后仍可移动」），自撞只作碰撞记录，
      // 不触发「撞到自身」结束规则——生命耗尽才是最终死亡。
      if (collision === 'self' && life.enabled && (agent.lives || 0) > 0) {
        this.absorbFatalEvent(tickEvents, 'selfCollision');
      }

      if (transformDeath) {
        this.transformAgent(ctx, agent, tickEvents);
        return { ended: false, turn: turnKey };
      }

      const policy = cfg.selfCollisionPolicy;
      // 「自撞是否结束运行」唯一由结束规则「撞到自身」决定：
      // 未勾选时，停止类策略（立即停止 / 自定义）退化为「忽略并继续」，
      // 且「连续自撞上限」也不再结束运行，避免蛇原地卡死。
      const endsRun = collision === 'self' && !!cfg.endConditions.selfCollision;
      const stopReason = { code: 'selfCollision', label: END_LABELS.selfCollision, tick: ctx.tick, coord: { ...target } };
      if (ctx.pending.forcedTurns.length) {
        dir = resolveTurn(ctx.pending.forcedTurns[0].turn, agent, grid, rng);
        const c = this.resolveCandidate(ctx, grid.step(agent.head, dir));
        if (c.ok && !this.detectCollision(ctx, agent, c.coord, false) && !ctx.world.isBlocking(c.coord)) {
          target = c.coord;
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
              const c = this.resolveCandidate(ctx, grid.step(agent.head, d));
              if (c.ok && !this.detectCollision(ctx, agent, c.coord, false) && !ctx.world.isBlocking(c.coord)) options.push({ d, t: c.coord });
            }
            if (options.length) {
              const pick = rng.pick(options);
              dir = pick.d;
              target = pick.t;
            } else if (endsRun) {
              return this.agentEnd(ctx, agent, stopReason, tickEvents);
            }
            break;
          }
          case 'custom':
            if (endsRun) return this.agentEnd(ctx, agent, stopReason, tickEvents);
            break;
          case 'stop':
          default: {
            if (endsRun) return this.agentEnd(ctx, agent, stopReason, tickEvents);
            break;
          }
        }
        if (endsRun && stats.selfCollisionsConsecutive >= policy.maxConsecutive) {
          return this.agentEnd(ctx, agent, { code: 'selfCollision', label: `连续撞到自身 ${stats.selfCollisionsConsecutive} 次`, tick: ctx.tick, coord: { ...target } }, tickEvents);
        }
      }
    } else {
      stats.collisionsConsecutive = 0;
      stats.selfCollisionsConsecutive = 0;
    }

    // 8. 执行移动与长度变化
    agent.dir = dir;
    this.applyMove(ctx, agent, target, lengthPlan);
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

    return { ended: false, turn: turnKey };
  }

  /**
   * 单个移动体的终止处理：
   * 主移动体终止 → 结束整场运行；其它移动体 → 从世界中消失（计入统计与事件）。
   */
  agentEnd(ctx, agent, reason, tickEvents) {
    if (agent.isMain) return { ended: true, reason };
    this.killAgent(ctx, agent, reason, tickEvents);
    return { ended: false };
  }

  /** 让某个移动体消失（死亡 / 被移除 / 被融合） */
  killAgent(ctx, agent, reason, tickEvents) {
    if (!agent.alive && !agent.zombie) return;
    const head = agent.head ? { ...agent.head } : null;
    const life = ctx.config.life;
    // 「死亡后仍可移动」：保留蛇头与蛇身，仅标记为已死亡（僵尸态），继续参与后续推进
    if (life.enabled && life.keepMovingAfterDeath && !agent.zombie) {
      agent.alive = false;
      agent.zombie = true;
      agent.endReason = { ...reason, tick: ctx.tick };
      ctx.stats.agentDeaths = (ctx.stats.agentDeaths || 0) + 1;
      if (tickEvents) tickEvents.push({ type: 'agentDeath', coord: head, highlight: true, reason: reason.code, zombie: true });
      if (head) ctx.highlights.push({ col: head.col, row: head.row, type: 'agentDeath', tick: ctx.tick });
      return;
    }
    if (!agent.alive) return;
    agent.alive = false;
    agent.endReason = { ...reason, tick: ctx.tick };
    ctx.stats.agentDeaths = (ctx.stats.agentDeaths || 0) + 1;
    if (tickEvents) {
      tickEvents.push({ type: 'agentDeath', coord: head, highlight: true, reason: reason.code });
    }
    // 高亮补齐：此前只写了 tickEvents，渲染层的 agentDeath 特效分支因此永远不会触发
    if (head) ctx.highlights.push({ col: head.col, row: head.row, type: 'agentDeath', tick: ctx.tick });
  }

  /**
   * 生命机制下的致命判定：扣除 1 条生命并判断是否原地重生。
   *
   * @returns {'alive'|'dead'} 'alive' 表示消耗 1 条命后已原地重生（调用方应立即结束本步、不再移动）；
   *          'dead' 表示生命耗尽，调用方按原有死亡流程收尾。
   */
  consumeLifeOnDeath(ctx, agent, reason, tickEvents) {
    const life = ctx.config.life;
    if (!life.enabled) return 'dead';
    const lives = Number(agent.lives) || 0;
    if (lives <= 0) return 'dead';
    const head = agent.head ? { ...agent.head } : null;
    agent.lives = lives - 1;
    ctx.stats.lifeLosses = (ctx.stats.lifeLosses || 0) + 1;
    tickEvents.push({ type: 'lifeLoss', coord: head, lives: agent.lives, reason: reason.code });
    if (agent.lives > 0) {
      this.respawnAgent(ctx, agent, reason, tickEvents);
      return 'alive';
    }
    this.markLifeDepleted(ctx, agent.head, reason.code, tickEvents);
    return 'dead';
  }

  /**
   * 生命耗尽的统一收尾：计入最终死亡统计，并写入 lifeDepleted 事件与高亮，
   * 让「自撞 / 撞墙 / 越界 / 障碍 / 陷阱」五条致命路径的统计口径保持一致。
   */
  markLifeDepleted(ctx, coord, reasonCode, tickEvents) {
    ctx.stats.finalDeaths = (ctx.stats.finalDeaths || 0) + 1;
    if (tickEvents) tickEvents.push({ type: 'lifeDepleted', coord: coord ? { ...coord } : null, reason: reasonCode });
    if (coord) ctx.highlights.push({ col: coord.col, row: coord.row, type: 'lifeDepleted', tick: ctx.tick });
  }

  /**
   * 生命机制下把本帧最新的一条致命事件标记为「已被生命机制吸收」：
   * 扣命重生（或处于无敌窗口 / 「死亡后仍可移动」）时，该事件只作碰撞记录，
   * 不再触发对应的结束规则——生命耗尽才是最终死亡。
   */
  absorbFatalEvent(tickEvents, type) {
    if (!tickEvents) return;
    for (let i = tickEvents.length - 1; i >= 0; i--) {
      if (tickEvents[i].type === type) {
        tickEvents[i].absorbed = true;
        return;
      }
    }
  }

  /**
   * 单条生命耗尽后的原地重生：
   * 保留蛇头位置、朝向与得分 / 步数等关键进度，仅把蛇身长度重置为 life.respawn.length，
   * 并给出重生高亮（渲染层据此播放重生动画）与一段无敌窗口，避免重生后立刻再次丢命。
   */
  respawnAgent(ctx, agent, reason, tickEvents) {
    const life = ctx.config.life;
    const grid = ctx.grid;
    const head = { ...agent.head };
    const dir = agent.dir;
    const wrap = ctx.config.grid.boundary === 'wrap';
    const requested = Math.max(1, Math.round(life.respawn.length));
    const limit = wrap ? Math.min(requested, grid.size) : requested;
    const segments = [{ ...head }];
    let cur = { ...head };
    for (let i = 1; i < limit; i++) {
      cur = grid.step(cur, grid.opposite(dir));
      if (wrap) cur = grid.wrap(cur);
      else if (!grid.inBounds(cur)) break;
      segments.push({ ...cur });
    }
    agent.segments = segments;
    agent.invincibleUntil = ctx.tick + Math.max(0, life.respawn.invincibleTicks);
    agent.respawnTick = ctx.tick;
    // 朝向改为一个安全方向，避免下一帧仍朝原致命方向前进而反复丢命
    const options = [];
    for (let d = 0; d < grid.dirCount; d++) {
      const c = this.resolveCandidate(ctx, grid.step(head, d));
      if (!c.ok) continue;
      if (this.isBlocked(ctx, c.coord)) continue;
      if (this.detectCollision(ctx, agent, c.coord, false)) continue;
      options.push(d);
    }
    agent.dir = options.length ? options[ctx.rng.int(options.length)] : grid.opposite(dir);
    ctx.stats.respawns = (ctx.stats.respawns || 0) + 1;
    tickEvents.push({ type: 'lifeRespawn', coord: { ...head }, lives: agent.lives, reason: reason.code });
    ctx.highlights.push({ col: head.col, row: head.row, type: 'respawn', tick: ctx.tick, lives: agent.lives });
    ctx.log({
      tick: ctx.tick,
      ruleId: 'life',
      ruleName: '生命机制',
      trigger: reason.code,
      subject: '移动体',
      coord: { ...head },
      priority: 0,
      condition: `剩余生命 ${agent.lives}`,
      actions: `原地重生（蛇身重置为 ${segments.length} 节）`,
      text: `「${agent.label}」${reason.label || reason.code}，消耗 1 条生命后原地重生（剩余 ${agent.lives}）`,
    });
    this.noteLifeWarning(ctx, agent, tickEvents);
  }

  /** 低生命预警：剩余生命降至阈值时写入一次高亮与事件，供界面提示 */
  noteLifeWarning(ctx, agent, tickEvents) {
    const life = ctx.config.life;
    if (!life.enabled || life.warnThreshold <= 0) return;
    const lives = Number(agent.lives) || 0;
    if (lives <= 0 || lives > life.warnThreshold) return;
    if (agent.warnedAtLives === lives) return;
    agent.warnedAtLives = lives;
    ctx.stats.lifeWarnings = (ctx.stats.lifeWarnings || 0) + 1;
    const head = agent.head;
    if (head) ctx.highlights.push({ col: head.col, row: head.row, type: 'lifeWarning', tick: ctx.tick, lives });
    if (tickEvents) tickEvents.push({ type: 'lifeWarning', coord: head ? { ...head } : null, lives });
  }

  /**
   * 生命机制的环境增减生命：踏入 gainStates 格子增加生命（可选消耗该格），
   * 踏入 lossStates 格子扣除生命（非致命陷阱，扣到 0 时由调用方触发最终死亡）。
   * @returns {'gain'|'loss'|null}
   */
  applyLifeItemInteraction(ctx, agent, target, tickEvents) {
    const life = ctx.config.life;
    if (!life.enabled) return null;
    const stateName = ctx.world.get(target);
    if (stateName === null || stateName === 'empty') return null;
    const it = life.items;
    if (it.gainStates.includes(stateName) && it.gainAmount > 0) {
      const before = Number(agent.lives) || 0;
      agent.lives = Math.min(LIFE_MAX, before + it.gainAmount);
      if (agent.lives !== before) {
        ctx.stats.lifeGains = (ctx.stats.lifeGains || 0) + 1;
        tickEvents.push({ type: 'lifeGain', coord: { ...target }, lives: agent.lives });
        ctx.highlights.push({ col: target.col, row: target.row, type: 'lifeGain', tick: ctx.tick });
        if (it.consumeGain) {
          ctx.world.set(target, 'empty');
          ctx.cellsDirty = true;
        }
      }
      return 'gain';
    }
    if (it.lossStates.includes(stateName) && it.lossAmount > 0) {
      agent.lives = Math.max(0, (Number(agent.lives) || 0) - it.lossAmount);
      ctx.stats.lifeLosses = (ctx.stats.lifeLosses || 0) + 1;
      tickEvents.push({ type: 'trapHit', coord: { ...target }, lives: agent.lives, state: stateName });
      ctx.highlights.push({ col: target.col, row: target.row, type: 'lifeLoss', tick: ctx.tick });
      if (agent.lives > 0) this.noteLifeWarning(ctx, agent, tickEvents);
      return 'loss';
    }
    return null;
  }

  /**
   * 蛇死亡 → 概率判定 → 身体节点并入元胞自动机。
   *
   * 流程（随机全部取自种子化 RNG，同种子结果可复现）：
   *   1) 先让移动体死亡消失，主循环与元胞自动机不受影响（不返回 ended）；
   *   2) 按「全局触发概率」决定是否启动转化流程，未命中则蛇只是消失、环境不变；
   *   3) 命中后逐个身体节点按「分段转化概率」独立判定，命中者写入 cfg.transform.state
   *      对应的环境状态，并置 cellsDirty 让元胞自动机与画面同步到同一份数据；
   *   4) 每个转化点写入 type='transform' 高亮，供渲染层播放「塌缩入环境」的过渡动画。
   *
   * @returns {number} 实际并入环境的身体节点数
   */
  transformAgent(ctx, agent, tickEvents) {
    const cfg = ctx.config;
    const t = cfg.transform;
    const grid = ctx.grid;
    const stats = ctx.stats;
    const head = agent.head ? { ...agent.head } : null;
    // 先抄下体节坐标：killAgent 之后该移动体会在本步结束时被移出 agents
    const nodes = agent.segments.map((s) => ({ col: s.col, row: s.row }));

    this.killAgent(ctx, agent, {
      code: 'selfCollision',
      label: '自撞死亡（身体转入环境）',
      tick: ctx.tick,
      coord: head,
    }, tickEvents);
    stats.transformDeaths = (stats.transformDeaths || 0) + 1;

    if (t.globalProbability <= 0) return 0;
    if (t.globalProbability < 1 && ctx.rng.next() >= t.globalProbability) {
      tickEvents.push({ type: 'transformSkipped', coord: head });
      return 0;
    }
    stats.transformTriggers = (stats.transformTriggers || 0) + 1;

    const stateName = t.state;
    const converted = [];
    for (const node of nodes) {
      if (t.segmentProbability <= 0) break;
      if (t.segmentProbability < 1 && ctx.rng.next() >= t.segmentProbability) continue;
      if (!grid.inBounds(node)) continue;
      if (ctx.world.set(node, stateName)) ctx.cellsDirty = true;
      converted.push(node);
    }
    stats.transformedCells = (stats.transformedCells || 0) + converted.length;
    // 过渡动画的高亮条数上限保护：蛇可以非常长，但可见动画只需覆盖有限范围
    const drawn = converted.length > MAX_TRANSFORM_HIGHLIGHTS ? converted.slice(0, MAX_TRANSFORM_HIGHLIGHTS) : converted;
    for (const node of drawn) {
      ctx.highlights.push({ col: node.col, row: node.row, type: 'transform', tick: ctx.tick, state: stateName });
    }
    tickEvents.push({ type: 'transform', coord: head, count: converted.length, state: stateName, highlight: true });
    ctx.log({
      tick: ctx.tick,
      ruleId: 'transform',
      ruleName: '蛇死亡转化',
      trigger: 'selfCollision',
      subject: '移动体身体',
      coord: head,
      priority: 0,
      condition: `全局概率 ${t.globalProbability} 命中`,
      actions: `${converted.length} 节并入环境状态「${stateName}」`,
      text: `「${agent.label}」自撞死亡，${converted.length} 个体节转化为「${stateName}」`,
    });
    return converted.length;
  }

  /**
   * 碰撞预警采集：对每个存活移动体检查各可行朝向的落点，
   * 若落点压在自身身体上（下一步必然自撞），就在该格写入 type='warning' 高亮。
   * 仅在 cfg.safety.warnSelfCollision 开启时调用，避免长蛇场景下的额外逐格开销。
   */
  collectCollisionWarnings(ctx) {
    const grid = ctx.grid;
    const stats = ctx.stats;
    for (const agent of ctx.agents) {
      if (!agent.alive || agent.segments.length < 3) continue;
      for (let d = 0; d < grid.dirCount; d++) {
        const c = this.resolveCandidate(ctx, grid.step(agent.head, d));
        if (!c.ok) continue;
        if (this.detectCollision(ctx, agent, c.coord, false) !== 'self') continue;
        stats.collisionWarnings = (stats.collisionWarnings || 0) + 1;
        ctx.highlights.push({
          col: c.coord.col,
          row: c.coord.row,
          type: 'warning',
          tick: ctx.tick,
          dir: d,
          agentId: agent.id,
        });
      }
    }
  }

  /** 元胞自动机单步演化 + 稳定态检测 */
  runCA(ctx) {
    if (!ctx.ca) return;
    const changed = ctx.ca.step(ctx.world, ctx.rng);
    if (changed) {
      ctx.cellsDirty = true;
      ctx.stats.caStableCount = 0;
    } else {
      ctx.stats.caStableCount = (ctx.stats.caStableCount || 0) + 1;
    }
    ctx.stats.caSteps++;
  }

  ruleEndReason(ctx) {
    const p = ctx.pending.end;
    return { code: p.code || 'ruleEnd', label: p.reason || END_LABELS.ruleEnd, tick: ctx.tick, coord: ctx.agent && ctx.agent.head ? { ...ctx.agent.head } : null };
  }

  isBlocked(ctx, coord) {
    return ctx.world.isBlocking(coord);
  }

  /**
   * 把「可能越界的候选落点」解析为可判定的有效格。
   *
   * 边界穿越（wrap）开启时，越界邻居应当环绕回网格另一侧再参与判定；
   * 否则蛇头位于画布四角等位置时，越界方向会被误判为「不可走」，
   * 进而错误触发「无路可走」（noMove）。
   *
   * @returns {{coord: object|null, ok: boolean, wrapped: boolean}}
   *          ok=false 表示该落点在当前边界策略下不可达（如撞墙 / 反弹无路）。
   */
  resolveCandidate(ctx, coord) {
    const grid = ctx.grid;
    if (grid.inBounds(coord)) return { coord, ok: true, wrapped: false };
    if (ctx.config.grid.boundary === 'wrap') {
      return { coord: grid.wrap(coord), ok: true, wrapped: true };
    }
    return { coord: null, ok: false, wrapped: false };
  }

  /** 目标格是否落在自身身体上（不含头部），兼容边界穿越 */
  selfBlocks(ctx, agent, target) {
    const grid = ctx.grid;
    const c = this.resolveCandidate(ctx, target);
    if (!c.ok) return false;
    const index = grid.idx(c.coord.col, c.coord.row);
    for (let i = 1; i < agent.segments.length; i++) {
      if (grid.idx(agent.segments[i].col, agent.segments[i].row) === index) return true;
    }
    return false;
  }

  /**
   * 「反弹」边界的安全落点：反向掉头不可用时，在其余方向中挑一个
   * 「界内 + 不被阻塞 + 不撞自身身体」的落点（随机择优，保持可复现）。
   *
   * 仅服务于边界反弹：贴边掉头时反向格往往正是自己的脖子，若不改道就会触发自撞结束。
   * 返回 null 表示所有方向都不可行，调用方回落到原始反弹逻辑。
   */
  bounceSafeOption(ctx, agent, backDir) {
    const grid = ctx.grid;
    const options = [];
    for (let d = 0; d < grid.dirCount; d++) {
      if (d === backDir) continue;
      const t = grid.step(agent.head, d);
      if (!grid.inBounds(t)) continue;
      if (ctx.world.isBlocking(t)) continue;
      if (this.selfBlocks(ctx, agent, t)) continue;
      options.push({ dir: d, coord: t });
    }
    if (!options.length) return null;
    return ctx.rng.pick(options);
  }

  /**
   * 安全避撞预设：剔除会撞上自身身体 / 障碍物 / 其它移动体的候选转向。
   * 返回空数组表示「所有方向都不可行」，调用方应回落到原始权重（从而触发原本的碰撞逻辑）。
   * 未启用任何规避项时返回 null，保持与旧版本完全一致的随机序列。
   */
  filterSafeOptions(ctx, agent, options) {
    const cfg = ctx.config;
    const s = cfg.safety;
    const repel = cfg.multiSnake.enabled && cfg.multiSnake.interaction.mode === 'repel';
    const avoidOthers = s.avoidOtherAgents || repel;
    if (!s.avoidBody && !s.avoidObstacle && !avoidOthers) return null;
    const grid = ctx.grid;
    const out = [];
    for (const o of options) {
      if (o.weight <= 0) continue;
      const dir = o.dir !== undefined ? o.dir : resolveTurn(o.key, agent, grid, ctx.rng);
      // 边界穿越开启时，越界候选先环绕回网格内再判定，避免四角位置被误剔；
      // 非穿越边界下越界候选仍照旧保留，交由后续撞墙 / 反弹逻辑处理。
      const c = this.resolveCandidate(ctx, grid.step(agent.head, dir));
      if (!c.ok) { out.push({ ...o, dir }); continue; }
      const target = c.coord;
      if (s.avoidObstacle && ctx.world.isBlocking(target)) continue;
      if (s.avoidBody && this.selfBlocks(ctx, agent, target)) continue;
      if (avoidOthers && occupiedByAgent(ctx, target, agent)) continue;
      out.push({ ...o, dir });
    }
    return out;
  }

  /** 决定下一步转向：规则强制 > 条件概率规则 > 基础左/直/右权重（含安全避撞预设） */
  decideDirection(ctx, engine, self) {
    const cfg = ctx.config;
    const grid = ctx.grid;
    // 多蛇运行时必须用「当前推进的移动体」而不是 ctx.agent（后者始终指向主移动体），
    // 否则生成出来的每条蛇都会沿用主移动体的转向。
    const agent = self || ctx.agent;
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
    const safe = this.filterSafeOptions(ctx, agent, options);
    const pool = safe && safe.length ? safe : options;
    const { item } = rng.weighted(pool, (o) => o.weight);
    return { dir: item.dir !== undefined ? item.dir : resolveTurn(item.key, agent, grid, rng), turnKey: item.key };
  }

  /**
   * 交互标记物反馈：移动体踏入被配置为「交互标记物」的元胞时，
   * 按反馈规则表产生长度变化（增量 / 指定值 / 百分比）与颜色反馈。
   * 长度变化写入 ctx.pending，随后由 planLength 统一结算与夹取。
   */
  applyMarkerInteraction(ctx, agent, target, tickEvents) {
    const mi = ctx.config.caMode.markerInteraction;
    if (!mi.enabled || !mi.states.length) return null;
    const stateName = ctx.world.get(target);
    if (stateName === null || !mi.states.includes(stateName)) return null;
    const applicable = mi.effects.filter((e) => e.enabled && (!e.state || e.state === stateName));
    if (!applicable.length) return null;

    let consumed = false;
    const applied = [];
    for (const fx of applicable) {
      if (fx.probability <= 0) continue;
      if (fx.probability < 1 && ctx.rng.next() >= fx.probability) continue;
      let delta = 0;
      if (fx.mode === 'set') {
        ctx.pending.setLength = fx.value;
        delta = fx.value - agent.length;
      } else if (fx.mode === 'percent') {
        delta = Math.round((agent.length * fx.value) / 100);
        ctx.pending.lengthDelta += delta;
      } else {
        delta = fx.value;
        ctx.pending.lengthDelta += delta;
      }
      if (fx.consume && !consumed) {
        ctx.world.set(target, fx.consumeTo);
        ctx.cellsDirty = true;
        consumed = true;
      }
      applied.push({ name: fx.name, delta });
      tickEvents.push({
        type: 'markerInteraction',
        coord: { ...target },
        state: stateName,
        effect: fx.name,
        delta,
        highlight: true,
        color: fx.color || '',
      });
      ctx.highlights.push({ col: target.col, row: target.row, type: 'markerEffect', state: stateName, tick: ctx.tick, color: fx.color || '' });
    }
    if (!applied.length) return null;
    ctx.stats.markerInteractions = (ctx.stats.markerInteractions || 0) + applied.length;
    return { state: stateName, consumed, applied };
  }

  /** 计算本步长度目标 */
  planLength(ctx, agent, target, tickEvents, ateOverride) {
    const cfg = ctx.config;
    const rng = ctx.rng;
    const lp = cfg.body.lengthPolicy;
    let delta = ctx.pending.lengthDelta;
    const ate = ateOverride === undefined ? ctx.world.get(target) === 'marker' : ateOverride;

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
      // 吃到标记物：移除并计入事件（若交互规则已消耗该格则不再重复移除）
      if (ctx.world.get(target) === 'marker') {
        ctx.world.set(target, 'empty');
        ctx.cellsDirty = true;
      }
      tickEvents.push({ type: 'eat', coord: { ...target } });
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

  /**
   * 多蛇交互结果：
   *  - collide 头对头相撞 → 双方消失（主移动体参与时结束运行）
   *  - merge   头对头 / 头进入他人身体 → 较长者（优先主移动体）吞并对方并合并长度
   *  - repel   发生重叠时回退后动一方的这一步移动，双方均生存
   *  - pass    互不影响
   * 所有结果都会写入 tickEvents 供渲染层做视觉反馈。
   */
  resolveAgentInteractions(ctx, tickEvents) {
    const cfg = ctx.config;
    const ms = cfg.multiSnake;
    if (!ms.enabled || ms.interaction.mode === 'pass') return null;
    const mode = ms.interaction.mode;
    const grid = ctx.grid;
    const alive = ctx.agents.filter((a) => a.alive);
    if (alive.length < 2) return null;

    const headAt = new Map();
    for (const a of alive) {
      const i = grid.idx(a.head.col, a.head.row);
      if (!headAt.has(i)) headAt.set(i, []);
      headAt.get(i).push(a);
    }
    const groups = [...headAt.values()].filter((l) => l.length > 1);

    if (mode === 'merge') {
      for (const list of groups) this.mergeAgents(ctx, list, tickEvents);
      // 头部进入他人身体也视为融合
      for (const a of alive) {
        if (!a.alive) continue;
        const hi = grid.idx(a.head.col, a.head.row);
        const host = alive.find((b) => b !== a && b.alive
          && b.segments.some((s, idx) => idx > 0 && grid.idx(s.col, s.row) === hi));
        if (host) this.mergeAgents(ctx, [host, a], tickEvents);
      }
      return null;
    }

    if (mode === 'repel') {
      for (const a of alive) {
        if (!a.alive || !a.prevState) continue;
        const hi = grid.idx(a.head.col, a.head.row);
        const clash = alive.some((b) => b !== a && b.alive
          && b.segments.some((s) => grid.idx(s.col, s.row) === hi));
        if (!clash) continue;
        // 回退这一步移动：保留双方生存，产生「排斥」视觉反馈
        a.segments = a.prevState.segments;
        a.dir = a.prevState.dir;
        ctx.stats.repels = (ctx.stats.repels || 0) + 1;
        tickEvents.push({ type: 'repel', coord: { ...a.head }, highlight: true });
        // 高亮补齐：此前只写了 tickEvents，渲染层的 repel 特效分支因此永远不会触发
        ctx.highlights.push({ col: a.head.col, row: a.head.row, type: 'repel', tick: ctx.tick });
      }
      return null;
    }

    // collide：头对头相撞
    let fatal = null;
    for (const list of groups) {
      for (const a of list) this.killAgent(ctx, a, { code: 'selfCollision', label: '与其他移动体相撞' }, tickEvents);
      tickEvents.push({ type: 'agentCollision', coord: { ...list[0].head }, highlight: true });
      if (list.some((a) => a.isMain)) {
        fatal = { code: 'selfCollision', label: '与其他移动体相撞', tick: ctx.tick, coord: { ...list[0].head } };
      }
    }
    return fatal ? { fatal: true, reason: fatal } : null;
  }

  /** 融合：较长者（优先主移动体）吞并其余移动体并合并身体长度 */
  mergeAgents(ctx, list, tickEvents) {
    const grid = ctx.grid;
    const parts = list.filter((a) => a.alive);
    if (parts.length < 2) return;
    const keeper = parts.find((a) => a.isMain)
      || parts.reduce((m, a) => (a.length > m.length ? a : m), parts[0]);
    const absorbed = parts.filter((a) => a !== keeper);
    let gained = 0;
    for (const v of absorbed) {
      gained += v.length;
      v.alive = false;
      v.endReason = { code: 'merged', label: `被「${keeper.label}」融合`, tick: ctx.tick };
      ctx.stats.agentDeaths = (ctx.stats.agentDeaths || 0) + 1;
      for (let i = v.segments.length - 1; i >= 0; i--) keeper.segments.push({ ...v.segments[i] });
    }
    // 长度受地图总格数限制
    while (keeper.segments.length > grid.size) keeper.segments.pop();
    ctx.stats.merges = (ctx.stats.merges || 0) + absorbed.length;
    tickEvents.push({ type: 'merge', coord: { ...keeper.head }, highlight: true, color: keeper.color || '' });
    ctx.highlights.push({ col: keeper.head.col, row: keeper.head.row, type: 'merge', tick: ctx.tick, color: keeper.color || '' });
    ctx.log({
      tick: ctx.tick,
      ruleId: 'multi_snake',
      ruleName: '多蛇交互',
      trigger: 'merge',
      subject: '移动体',
      coord: { ...keeper.head },
      priority: 0,
      condition: '头部相接触',
      actions: `融合 ${absorbed.length} 条（+${gained} 节）`,
      text: `「${keeper.label}」融合 ${absorbed.map((a) => a.label).join('、')}，长度 → ${keeper.segments.length}`,
    });
  }

  /**
   * 多蛇生成：按预定时间点 / 随机时间间隔 / 特殊事件触发。
   * 达到 maxAgents 上限后不再生成。
   */
  maybeSpawn(ctx, tickEvents) {
    const cfg = ctx.config;
    const ms = cfg.multiSnake;
    if (!ms.enabled) return;
    const sp = ms.spawn;
    const aliveCount = ctx.agents.filter((a) => a.alive).length;
    if (aliveCount >= sp.maxAgents) return;

    let trigger = false;
    if (sp.mode === 'time') {
      trigger = sp.times.includes(ctx.tick);
    } else if (sp.mode === 'interval') {
      const ctl = ctx.spawnCtl;
      if (ctl.nextTick === null) ctl.nextTick = ctx.tick + ctx.rng.intRange(sp.minInterval, sp.maxInterval);
      if (ctx.tick >= ctl.nextTick) {
        trigger = true;
        ctl.nextTick = ctx.tick + ctx.rng.intRange(sp.minInterval, sp.maxInterval);
      }
    } else if (sp.mode === 'event') {
      trigger = tickEvents.some((e) => sp.events.includes(e.type));
    }
    if (!trigger || sp.probability <= 0) return;
    if (sp.probability < 1 && ctx.rng.next() >= sp.probability) return;

    const agent = this.spawnSnake(ctx, sp);
    if (!agent) return;
    tickEvents.push({ type: 'spawn', coord: { ...agent.head }, highlight: true, color: agent.color || '' });
    ctx.highlights.push({ col: agent.head.col, row: agent.head.row, type: 'spawn', tick: ctx.tick, color: agent.color || '' });
    ctx.log({
      tick: ctx.tick,
      ruleId: 'multi_snake',
      ruleName: '多蛇系统',
      trigger: `spawn:${sp.mode}`,
      subject: '新移动体',
      coord: { ...agent.head },
      priority: 0,
      condition: '生成触发条件满足',
      actions: `生成「${agent.label}」（长度 ${agent.length}）`,
      text: `生成「${agent.label}」（长度 ${agent.length}，位置 ${agent.head.col},${agent.head.row}）`,
    });
  }

  /** 在空格生成一条新蛇（配色取自多蛇色板，循环取用） */
  spawnSnake(ctx, sp) {
    const grid = ctx.grid;
    const rng = ctx.rng;
    const dir = !sp.direction || sp.direction === 'random'
      ? rng.int(grid.dirCount)
      : parseDir(sp.direction, grid.type);
    const pos = findSpawnCoord(ctx);
    if (!pos) return null;
    const segments = [{ ...pos }];
    // 与主移动体一致：环绕边界下新蛇的身体同样按 wrap 环绕铺设，避免贴边生成时身体被截断
    const wrap = ctx.config.grid.boundary === 'wrap';
    const requested = Math.max(1, Math.round(sp.length));
    const limit = wrap ? Math.min(requested, grid.size) : requested;
    let cur = { ...pos };
    for (let i = 1; i < limit; i++) {
      cur = grid.step(cur, grid.opposite(dir));
      if (wrap) cur = grid.wrap(cur);
      else if (!grid.inBounds(cur)) break;
      if (occupiedByAgent(ctx, cur)) break;
      segments.push({ ...cur });
    }
    const n = (ctx.stats.spawns = (ctx.stats.spawns || 0) + 1);
    const palette = ctx.config.multiSnake.interaction.colorPalette;
    const color = palette.length ? palette[(n - 1) % palette.length] : null;
    const agent = new Agent(`a${n}`, segments, dir, { label: `蛇${n}`, color, isMain: false, spawnTick: ctx.tick });
    ctx.agents.push(agent);
    return agent;
  }

  applyMove(ctx, agent, target, lengthPlan) {
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
    const coord = () => (agent && agent.head ? { ...agent.head } : null);

    const triggered = {
      // absorbed：被生命机制吸收的致命事件（扣命重生 / 无敌窗口内）只作碰撞记录，
      // 不计入结束判定——生命耗尽时调用方已直接给出结束原因。
      wall: () => tickEvents.some((e) => e.type === 'wall' && !e.absorbed),
      outOfBounds: () => tickEvents.some((e) => e.type === 'wall' && e.outOfBounds && !e.absorbed),
      // 转化模式下的自撞属于「蛇死亡」而非「结束运行」：带 transformed 标志的事件不计入结束判定，
      // 否则一旦启用转化，主移动体自撞仍会按「撞到自身」结束规则终止整轮运行。
      // 互斥保证：「自撞即判定死亡」生效时，「撞到自身」已在配置规范化阶段被自动关闭。
      selfCollision: () => tickEvents.some((e) => e.type === 'selfCollision' && e.kind !== 'other' && !e.transformed && !e.absorbed),
      selfCollisionTotal: () => stats.selfCollisions >= ec.selfCollisionTotalN,
      selfCollisionConsecutive: () => stats.selfCollisionsConsecutive >= ec.selfCollisionConsecutiveN,
      obstacle: () => tickEvents.some((e) => e.type === 'obstacle' && !e.absorbed),
      maxSteps: () => ctx.tick >= ec.maxSteps,
      lengthReached: () => !!agent && agent.length >= ec.lengthTarget,
      coverage: () => stats.coverage >= ec.coveragePercent,
      caStable: () => !!cfg.caMode.enabled && (stats.caStableCount || 0) >= Math.max(1, cfg.caMode.stableSteps),
      allAgentsGone: () => ctx.agents.filter((a) => a.alive).length === 0 && (stats.agentDeaths || 0) > 0,
      noMove: () => {
        if (!agent || !agent.segments.length) return false;
        // 必须兼容边界穿越：越界邻居在 wrap 下应环绕回网格另一侧再判定，
        // 否则蛇头位于画布四角时所有方向都被跳过，会误判「无路可走」。
        for (let d = 0; d < grid.dirCount; d++) {
          const c = this.resolveCandidate(ctx, grid.step(agent.head, d));
          if (!c.ok) continue;
          const t = c.coord;
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
      if (code === 'maxSteps') return { code, label: `${END_LABELS.maxSteps}（${ec.maxSteps}）`, tick: ctx.tick, coord: coord() };
      if (code === 'lengthReached') return { code, label: `${END_LABELS.lengthReached}（${ec.lengthTarget}）`, tick: ctx.tick, coord: coord() };
      if (code === 'coverage') return { code, label: `${END_LABELS.coverage}（${ec.coveragePercent}%）`, tick: ctx.tick, coord: coord() };
      if (code === 'selfCollisionTotal') return { code, label: `${END_LABELS.selfCollisionTotal}（${ec.selfCollisionTotalN}）`, tick: ctx.tick, coord: coord() };
      if (code === 'selfCollisionConsecutive') return { code, label: `${END_LABELS.selfCollisionConsecutive}（${ec.selfCollisionConsecutiveN}）`, tick: ctx.tick, coord: coord() };
      if (code === 'caStable') return { code, label: `${END_LABELS.caStable}（连续 ${Math.max(1, cfg.caMode.stableSteps)} 次无变化）`, tick: ctx.tick, coord: coord() };
      if (code === 'noMove') return { code, label: END_LABELS.noMove, tick: ctx.tick, coord: coord() };
      if (code === 'maxTime') return { code, label: `${END_LABELS.maxTime}（${ec.maxTimeMs}ms）`, tick: ctx.tick, coord: coord() };
      return { code, label: END_LABELS[code] || code, tick: ctx.tick, coord: coord() };
    }
    return null;
  }

  captureFrame(tick, agents, cells, highlights, stats, logs, logFrom, logTo, turn = null, events = []) {
    return {
      tick,
      agents: agents.map((a) => {
        // 死亡（且非「死亡后仍可移动」）的移动体立即从画面数据中删去蛇头与蛇身
        const visible = a.alive || a.zombie;
        return {
          id: a.id,
          label: a.label,
          segments: visible ? a.segments.map((s) => [s.col, s.row]) : [],
          dir: a.dir,
          alive: a.alive,
          color: a.color,
          isMain: !!a.isMain,
          length: visible ? a.segments.length : 0,
          lives: a.lives || 0,
          zombie: !!a.zombie,
        };
      }),
      cells,
      highlights: highlights.map((h) => ({
        col: h.col ?? h.coord?.col,
        row: h.row ?? h.coord?.row,
        type: h.type,
        state: h.state,
        ruleId: h.ruleId,
        color: h.color,
        // 边界穿越特效需要「滑出侧坐标」，渲染层才能解出穿梭方向
        fromCol: h.fromCol,
        fromRow: h.fromRow,
        dir: h.dir,
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
        agents: agents.filter((a) => a.alive).length,
        spawns: stats.spawns || 0,
        merges: stats.merges || 0,
        agentDeaths: stats.agentDeaths || 0,
        // 以下为该帧的累计量快照，供界面「实时统计」模式与「总计统计」逐项对齐口径
        peakAgents: stats.peakAgents || 0,
        maxLength: stats.maxLength || 0,
        obstacleCount: stats.obstacleCount || 0,
        markerCount: stats.markerCount || 0,
        repels: stats.repels || 0,
        markerInteractions: stats.markerInteractions || 0,
        rngCalls: stats.rngCalls || 0,
        turnsLeft: stats.turnsLeft || 0,
        turnsStraight: stats.turnsStraight || 0,
        turnsRight: stats.turnsRight || 0,
        turnsReverse: stats.turnsReverse || 0,
        // 生命机制：帧级快照（剩余生命 / 增减 / 重生 / 预警 / 最终死亡）
        lives: stats.lives || 0,
        lifeGains: stats.lifeGains || 0,
        lifeLosses: stats.lifeLosses || 0,
        respawns: stats.respawns || 0,
        lifeWarnings: stats.lifeWarnings || 0,
        finalDeaths: stats.finalDeaths || 0,
      },
      logFrom: logFrom === null ? 0 : logFrom,
      logTo: logTo === null ? 0 : logTo,
    };
  }
}
