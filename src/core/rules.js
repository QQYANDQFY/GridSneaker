/**
 * 规则引擎：主体解析 → 触发时机 → 概率/冷却/次数限制 → 条件判断 → 后果执行
 * 支持同步（条件基于本阶段开始时的环境快照）与异步（逐条即时生效）两种执行方式
 */
import { evaluateCondition, describeCondition } from './conditions.js';
import { applyAction, describeAction } from './actions.js';

export const SUBJECT_LABELS = {
  head: '蛇头',
  body: '蛇身',
  headAndBody: '蛇头与蛇身',
  anySegment: '任意体节',
  segment: '指定体节',
  allAgents: '全体移动体',
  cell: '环境单元',
};

export const TRIGGER_LABELS = {
  beforeStep: '每步移动前',
  afterStep: '每步移动后',
  onEnter: '进入新格时',
  onCollision: '发生碰撞时',
  onBoundary: '越界/撞墙时',
  timer: '定时触发',
  manual: '手动触发',
};

export class RuleEngine {
  constructor(config) {
    this.config = config;
    this.reset();
  }

  reset() {
    this.state = new Map();
    for (const rule of this.config.environmentRules) {
      this.state.set(rule.id, { triggers: 0, lastTick: -1e9 });
    }
  }

  ruleState(ruleId) {
    if (!this.state.has(ruleId)) this.state.set(ruleId, { triggers: 0, lastTick: -1e9 });
    return this.state.get(ruleId);
  }

  maxTriggers(rule) {
    if (rule.once) return 1;
    return rule.maxTriggers || 0; // 0 = 不限
  }

  available(rule, ctx) {
    const st = this.ruleState(rule.id);
    const max = this.maxTriggers(rule);
    if (max > 0 && st.triggers >= max) return false;
    if (rule.cooldown > 0 && ctx.tick - st.lastTick < rule.cooldown) return false;
    return true;
  }

  /** 收集某个规则在此刻匹配的主体（含主体复合语义） */
  matchingSubjects(rule, ctx) {
    const cond = rule.condition;
    const out = [];
    if (rule.subject === 'headAndBody') {
      for (const agent of ctx.agents) {
        if (!agent.alive) continue;
        const headSubject = { coord: agent.head, agent, kind: 'head', segmentIndex: 0, ruleId: rule.id };
        const headOk = evaluateCondition(cond, headSubject, this.makeEvalCtx(ctx));
        if (!headOk) continue;
        let matchedBody = null;
        for (let i = 1; i < agent.segments.length; i++) {
          const bs = { coord: agent.segments[i], agent, kind: 'body', segmentIndex: i, ruleId: rule.id };
          if (evaluateCondition(cond, bs, ctx)) { matchedBody = bs; break; }
        }
        if (matchedBody) out.push({ ...headSubject, matchedBody });
      }
      return out;
    }

    const subjects = [];
    for (const agent of ctx.agents) {
      if (!agent.alive) continue;
      switch (rule.subject) {
        case 'head':
          subjects.push({ coord: agent.head, agent, kind: 'head', segmentIndex: 0 });
          break;
        case 'body':
          for (let i = 1; i < agent.segments.length; i++) {
            subjects.push({ coord: agent.segments[i], agent, kind: 'body', segmentIndex: i });
          }
          break;
        case 'anySegment':
          for (let i = 0; i < agent.segments.length; i++) {
            subjects.push({ coord: agent.segments[i], agent, kind: i === 0 ? 'head' : 'body', segmentIndex: i });
          }
          break;
        case 'segment': {
          const seg = agent.segment(rule.segmentIndex);
          if (seg) subjects.push({ coord: seg, agent, kind: 'segment', segmentIndex: rule.segmentIndex });
          break;
        }
        case 'allAgents':
          subjects.push({ coord: agent.head, agent, kind: 'head', segmentIndex: 0 });
          break;
        default:
          break;
      }
    }
    if (rule.subject === 'cell') {
      const { grid } = ctx;
      for (let i = 0; i < grid.size; i++) {
        subjects.push({ coord: grid.coord(i), agent: ctx.agent, kind: 'cell', segmentIndex: -1 });
      }
    }
    for (const s of subjects) s.ruleId = rule.id;
    return subjects;
  }

  makeEvalCtx(ctx) {
    return ctx;
  }

  triggerMatches(rule, phase, ctx) {
    const t = rule.trigger;
    if (t === 'manual') return phase === 'manual';
    if (phase !== t) return false;
    if (t === 'timer') return ctx.tick % Math.max(1, rule.interval) === 0;
    return true;
  }

  /** 规则是否整体命中（含概率判定），返回命中的主体列表 */
  hit(rule, ctx) {
    if (!rule.enabled) return null;
    if (!rule.actions.length) return null;
    if (!this.available(rule, ctx)) return null;
    const subjects = this.matchingSubjects(rule, ctx);
    if (!subjects.length) return null;
    if (rule.probability <= 0) return null;
    if (rule.probability < 1 && ctx.rng.next() >= rule.probability) {
      ctx.logs.push({
        tick: ctx.tick,
        ruleId: rule.id,
        ruleName: rule.name,
        trigger: rule.trigger,
        subject: SUBJECT_LABELS[rule.subject] || rule.subject,
        coord: subjects[0].coord,
        priority: rule.priority,
        condition: describeCondition(rule.condition),
        actions: describeAction(rule.actions[0]),
        text: `条件满足但概率未命中（${Math.round(rule.probability * 100)}%）`,
        skipped: true,
      });
      return null;
    }
    return subjects;
  }

  /**
   * 执行某一触发阶段的所有规则
   * @returns {number} 触发次数
   */
  run(phase, ctx, opts = {}) {
    const snapshot = opts.sync === true;
    let count = 0;
    const candidates = this.config.environmentRules
      .map((rule, index) => ({ rule, index }))
      .filter(({ rule }) => rule.enabled && rule.trigger !== 'manual' && this.triggerMatches(rule, phase, ctx))
      .sort((a, b) => (b.rule.priority - a.rule.priority) || (a.index - b.index));

    if (!snapshot) {
      for (const { rule } of candidates) {
        const subjects = this.hit(rule, ctx);
        if (!subjects) continue;
        count += this.fire(rule, subjects, ctx);
        if (ctx.pending.end) break;
      }
      this.commitForcedTurns(ctx, phase);
      return count;
    }

    // 同步执行：先基于快照求值全部规则，再依次执行后果
    const frozenWorld = ctx.world.clone();
    const frozenCtx = { ...ctx, world: frozenWorld };
    const plan = [];
    for (const { rule } of candidates) {
      const st = this.ruleState(rule.id);
      const max = this.maxTriggers(rule);
      if (max > 0 && st.triggers >= max) continue;
      if (rule.cooldown > 0 && ctx.tick - st.lastTick < rule.cooldown) continue;
      const subjects = this.hit(rule, frozenCtx);
      if (!subjects) continue;
      plan.push({ rule, subjects, prob: 1 });
    }
    for (const { rule, subjects } of plan) {
      count += this.fireFromPlan(rule, subjects, ctx);
      if (ctx.pending.end) break;
    }
    this.commitForcedTurns(ctx, phase);
    return count;
  }

  /**
   * 把本阶段收集到的强制转向写入移动体，供「下一次移动」使用
   * 高优先级规则（先入队）优先；onBoundary 阶段由移动逻辑即时消费
   */
  commitForcedTurns(ctx, phase) {
    if (phase === 'onBoundary' || phase === 'onCollision') return;
    for (const entry of ctx.pending.forcedTurns) {
      const target = entry.agent || ctx.agent;
      if (target && target.forcedNextTurn === null) target.forcedNextTurn = entry.turn;
    }
  }

  fireFromPlan(rule, subjects, ctx) {
    let fired = 0;
    for (const subject of subjects) {
      const actionTexts = [];
      const turnMark = ctx.pending.forcedTurns.length;
      for (const action of rule.actions) {
        const { events, text } = applyAction(action, subject, ctx);
        for (const ev of events) {
          ctx.highlights.push({ ...ev, ruleId: rule.id, tick: ctx.tick });
        }
        if (text) actionTexts.push(text);
        if (ctx.pending.end) break;
      }
      // 同一规则内多次转向动作时，仅保留最后一个；跨规则时高优先级规则优先
      if (ctx.pending.forcedTurns.length > turnMark + 1) {
        const last = ctx.pending.forcedTurns[ctx.pending.forcedTurns.length - 1];
        ctx.pending.forcedTurns.length = turnMark;
        ctx.pending.forcedTurns.push(last);
      }
      const st = this.ruleState(rule.id);
      st.triggers++;
      st.lastTick = ctx.tick;
      fired++;
      ctx.logs.push({
        tick: ctx.tick,
        ruleId: rule.id,
        ruleName: rule.name,
        trigger: rule.trigger,
        subject: SUBJECT_LABELS[rule.subject] || rule.subject,
        coord: subject.coord,
        priority: rule.priority,
        condition: describeCondition(rule.condition),
        actions: actionTexts.join('；'),
        text: `${describeCondition(rule.condition)} → ${actionTexts.join('；')}`,
      });
      if (ctx.pending.end) break;
    }
    return fired;
  }

  fire(rule, subjects, ctx) {
    return this.fireFromPlan(rule, subjects, ctx);
  }

  /** 手动触发指定规则（或全部 manual 规则） */
  runManual(ctx, ruleId = null) {
    let n = 0;
    for (const rule of this.config.environmentRules) {
      if (ruleId && rule.id !== ruleId) continue;
      if (rule.trigger !== 'manual') continue;
      if (!rule.enabled) continue;
      if (!this.available(rule, ctx)) continue;
      const subjects = this.matchingSubjects(rule, ctx);
      if (!subjects.length) continue;
      n += this.fire(rule, subjects, ctx);
    }
    this.commitForcedTurns(ctx, 'manual');
    return n;
  }

  /** 触发次数统计 */
  triggerCounts() {
    const out = {};
    for (const [id, st] of this.state) out[id] = st.triggers;
    return out;
  }
}
