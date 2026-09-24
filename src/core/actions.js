/**
 * 后果动作执行
 * 所有动作通过 ctx 修改世界/移动体，并把结果记录进事件列表
 */
import { parseDir } from './grid.js';
import { Agent } from './world.js';

export const ACTION_LABELS = {
  createObstacle: '产生障碍物',
  removeObstacle: '移除障碍物',
  createMarker: '产生标记物',
  removeMarker: '移除标记物',
  setCellState: '修改环境状态',
  clearState: '清空某状态',
  forceTurn: '强制转向',
  randomTurn: '概率转向',
  changeLength: '改变长度',
  setLength: '设定长度',
  changeSpeed: '改变速度',
  setColor: '改变颜色',
  spawnAgent: '生成新移动体',
  removeAgent: '移除移动体',
  modifyRule: '修改后续规则',
  endRun: '触发结束',
  log: '记录日志',
  paintTrail: '绘制轨迹状态',
};

export const TURN_LABELS = {
  left: '左转',
  right: '右转',
  straight: '直行',
  reverse: '掉头',
  random: '随机',
};

const POSITION_LABELS = {
  current: '当前格',
  front: '前方',
  back: '后方',
  left: '左侧',
  right: '右侧',
  randomNeighbor: '随机邻格',
  randomEmpty: '随机空格',
  random: '随机格',
};

export function resolveTurn(turnKey, agent, grid, rng) {
  const d = agent.dir;
  switch (String(turnKey)) {
    case 'left': return grid.leftOf(d);
    case 'right': return grid.rightOf(d);
    case 'straight': return d;
    case 'reverse': return grid.opposite(d);
    case 'random': return rng.int(grid.dirCount);
    default: {
      const parsed = parseDir(turnKey, grid.type);
      return parsed;
    }
  }
}

function resolvePosition(posKey, subject, ctx, exclude = []) {
  const { grid, world, rng } = ctx;
  const agent = subject.agent || ctx.agent;
  const coord = subject.coord;
  const pickRandom = (candidates) => {
    const filtered = candidates.filter((c) => grid.inBounds(c) && !exclude.some((e) => e.col === c.col && e.row === c.row));
    if (!filtered.length) return null;
    return rng.pick(filtered);
  };
  switch (posKey) {
    case 'current':
      return coord;
    case 'front':
    case 'left':
    case 'right':
    case 'back':
    case 'frontLeft':
    case 'frontRight':
    case 'backLeft':
    case 'backRight': {
      if (!agent) return null;
      const t = grid.relativeCoord(coord, agent.dir, posKey, 1);
      return t && grid.inBounds(t) ? t : null;
    }
    case 'randomNeighbor': {
      const ring = grid.ringNeighbors(coord);
      return pickRandom(ring);
    }
    case 'randomEmpty':
      return world.randomEmpty(rng);
    case 'random': {
      const c = { col: rng.int(grid.width), row: rng.int(grid.height) };
      return c;
    }
    default:
      return coord;
  }
}

function positionLabel(key) {
  return POSITION_LABELS[key] || key;
}

/** 某个坐标是否被存活的移动体占据（可排除指定移动体） */
export function occupiedByAgent(ctx, coord, exclude = null) {
  const { grid } = ctx;
  if (!grid.inBounds(coord)) return false;
  const index = grid.idx(coord.col, coord.row);
  for (const a of ctx.agents) {
    if (a === exclude || !a.alive) continue;
    for (let i = 0; i < a.segments.length; i++) {
      if (grid.idx(a.segments[i].col, a.segments[i].row) === index) return true;
    }
  }
  return false;
}

/**
 * 为新移动体挑选出生格：优先「空格且未被任何存活移动体占据」，
 * 其次退回任意空格。保证新蛇不会一出生就与别的蛇重叠。
 */
export function findSpawnCoord(ctx, exclude = null) {
  const { grid, world, rng } = ctx;
  const candidates = [];
  for (let i = 0; i < grid.size; i++) {
    if (world.cells[i] !== 0) continue; // 仅空格
    const c = grid.coord(i);
    if (occupiedByAgent(ctx, c, exclude)) continue;
    candidates.push(c);
  }
  if (candidates.length) return rng.pick(candidates);
  return world.randomEmpty(rng);
}

/**
 * 执行一个动作
 * @returns {{events: Array, text: string}}
 */
export function applyAction(action, subject, ctx) {
  const events = [];
  const { grid, world, rng } = ctx;
  const agent = subject.agent || ctx.agent;
  const texts = [];

  switch (action.type) {
    case 'createObstacle':
    case 'createMarker': {
      const stateName = action.type === 'createObstacle' ? 'obstacle' : 'marker';
      const placed = [];
      for (let i = 0; i < (action.count || 1); i++) {
        const pos = resolvePosition(action.position, subject, ctx, placed);
        if (!pos) break;
        if (world.set(pos, stateName)) {
          placed.push(pos);
          events.push({ type: 'cell', coord: pos, state: stateName, highlight: true });
        }
      }
      texts.push(`在${positionLabel(action.position)}产生 ${placed.length} 个${stateName === 'obstacle' ? '障碍物' : '标记物'}`);
      break;
    }
    case 'removeObstacle':
    case 'removeMarker': {
      const stateName = action.type === 'removeObstacle' ? 'obstacle' : 'marker';
      const pos = resolvePosition(action.position, subject, ctx);
      if (pos && world.get(pos) === stateName && world.set(pos, 'empty')) {
        events.push({ type: 'cell', coord: pos, state: 'empty', highlight: true });
        texts.push(`移除${positionLabel(action.position)}的${stateName === 'obstacle' ? '障碍物' : '标记物'}`);
      } else {
        texts.push(`移除${positionLabel(action.position)}的${stateName}（无）`);
      }
      break;
    }
    case 'setCellState': {
      const pos = resolvePosition(action.position, subject, ctx);
      if (pos && world.set(pos, action.state)) {
        events.push({ type: 'cell', coord: pos, state: action.state, highlight: true });
        texts.push(`将${positionLabel(action.position)}设为 ${action.state}`);
      }
      break;
    }
    case 'clearState': {
      const si = world.stateIndexOf(action.state);
      let n = 0;
      for (let i = 0; i < world.cells.length; i++) {
        if (world.cells[i] === si) {
          world.cells[i] = 0;
          events.push({ type: 'cell', coord: grid.coord(i), state: 'empty', highlight: false });
          n++;
        }
      }
      texts.push(`清空全部 ${action.state}（${n} 格）`);
      break;
    }
    case 'paintTrail': {
      const pos = resolvePosition(action.position, subject, ctx);
      if (pos && world.set(pos, action.state)) {
        events.push({ type: 'cell', coord: pos, state: action.state, highlight: false });
        texts.push(`在${positionLabel(action.position)}绘制 ${action.state}`);
      }
      break;
    }
    case 'forceTurn': {
      if (!agent) break;
      const p = action.probability === undefined ? 1 : action.probability;
      if (p >= 1 || rng.next() < p) {
        ctx.pending.forcedTurns.push({ turn: action.turn, agent, source: 'rule', ruleId: subject.ruleId });
        const dir = resolveTurn(action.turn, agent, grid, rng);
        texts.push(`强制${TURN_LABELS[action.turn] || action.turn}（→ ${grid.dirNames[dir]}）`);
        events.push({ type: 'turn', dir, highlight: true });
      } else {
        texts.push(`强制${TURN_LABELS[action.turn] || action.turn}（概率未命中）`);
      }
      break;
    }
    case 'randomTurn': {
      if (!agent) break;
      const opts = [
        { key: 'left', weight: action.weights?.left ?? 1 },
        { key: 'straight', weight: action.weights?.straight ?? 1 },
        { key: 'right', weight: action.weights?.right ?? 1 },
      ];
      const { item } = rng.weighted(opts, (o) => o.weight);
      ctx.pending.forcedTurns.push({ turn: item.key, agent, source: 'rule', ruleId: subject.ruleId });
      texts.push(`按权重转向：${TURN_LABELS[item.key]}`);
      events.push({ type: 'turn', dir: resolveTurn(item.key, agent, grid, rng), highlight: true });
      break;
    }
    case 'changeLength': {
      if (!agent) break;
      ctx.pending.lengthDelta += action.amount;
      texts.push(`长度 ${action.amount >= 0 ? '+' : ''}${action.amount}`);
      break;
    }
    case 'setLength': {
      if (!agent) break;
      ctx.pending.setLength = action.value;
      texts.push(`长度设为 ${action.value}`);
      break;
    }
    case 'changeSpeed': {
      if (!agent) break;
      agent.speedMul = Math.max(0.05, Math.min(20, (agent.speedMul || 1) * action.factor));
      texts.push(`速度 ×${action.factor}（当前 ×${agent.speedMul.toFixed(2)}）`);
      break;
    }
    case 'setColor': {
      if (!agent) break;
      agent.color = action.color;
      texts.push(`颜色改为 ${action.color}`);
      break;
    }
    case 'spawnAgent': {
      if (ctx.agents.length >= 32) {
        texts.push('移动体数量已达上限，未生成新移动体');
        break;
      }
      const pos = findSpawnCoord(ctx, agent);
      if (!pos) {
        texts.push('没有可用空格，未生成新移动体');
        break;
      }
      const dir = action.direction === 'random' || action.direction === undefined
        ? rng.int(grid.dirCount)
        : parseDir(action.direction, grid.type);
      const segments = [{ ...pos }];
      let cur = { ...pos };
      for (let i = 1; i < action.length; i++) {
        cur = grid.step(cur, grid.opposite(dir));
        if (!grid.inBounds(cur)) break;
        segments.push({ ...cur });
      }
      if (ctx.stats) ctx.stats.spawns = (ctx.stats.spawns || 0) + 1;
      const n = ctx.stats ? ctx.stats.spawns : ctx.agents.length;
      const na = new Agent(`a${n}`, segments, dir, { label: `蛇${n}`, isMain: false, spawnTick: ctx.tick });
      ctx.agents.push(na);
      events.push({ type: 'spawn', coord: pos, highlight: true });
      texts.push(`生成新移动体（长度 ${segments.length}，位置 ${pos.col},${pos.row}）`);
      break;
    }
    case 'removeAgent': {
      const pool = ctx.agents.filter((a) => a.alive && a !== agent);
      if (!pool.length) {
        texts.push('没有可移除的其他移动体');
        break;
      }
      const origin = (agent && agent.head) || subject.coord;
      let victim = pool[0];
      if (action.target === 'random') {
        victim = rng.pick(pool);
      } else if (action.target === 'largest') {
        victim = pool.reduce((m, a) => (a.length > m.length ? a : m), pool[0]);
      } else if (action.target === 'oldest') {
        victim = pool.reduce((m, a) => (a.spawnTick < m.spawnTick ? a : m), pool[0]);
      } else if (origin) {
        victim = pool.reduce((m, a) => (grid.distance(origin, a.head) < grid.distance(origin, m.head) ? a : m), pool[0]);
      }
      victim.alive = false;
      victim.endReason = { code: 'removed', label: '被环境规则移除', tick: ctx.tick };
      if (ctx.stats) ctx.stats.agentDeaths = (ctx.stats.agentDeaths || 0) + 1;
      events.push({ type: 'agentRemoved', coord: { ...victim.head }, highlight: true });
      texts.push(`移除移动体「${victim.label}」（${action.target}）`);
      break;
    }
    case 'modifyRule': {
      const target = ctx.config.environmentRules.find((r) => r.id === action.ruleId);
      if (!target) {
        texts.push('未找到目标规则');
        break;
      }
      if (action.op === 'disable') target.enabled = false;
      else if (action.op === 'enable') target.enabled = true;
      else if (action.op === 'setProbability') target.probability = Math.max(0, Math.min(1, action.value));
      texts.push(`规则「${target.name}」→ ${action.op}${action.op === 'setProbability' ? ` ${action.value}` : ''}`);
      break;
    }
    case 'endRun': {
      ctx.pending.end = { reason: action.reason || '环境规则结束', code: 'ruleEnd' };
      texts.push(`触发结束：${action.reason}`);
      break;
    }
    case 'log': {
      texts.push(action.message || '记录日志');
      break;
    }
    default:
      texts.push(`未知动作 ${action.type}`);
  }

  return { events, text: texts.join('；') };
}

export function describeAction(action) {
  if (!action) return '';
  switch (action.type) {
    case 'createObstacle':
      return `${positionLabel(action.position)}产生障碍物×${action.count || 1}`;
    case 'removeObstacle':
      return `移除${positionLabel(action.position)}的障碍物`;
    case 'createMarker':
      return `${positionLabel(action.position)}产生标记物×${action.count || 1}`;
    case 'removeMarker':
      return `移除${positionLabel(action.position)}的标记物`;
    case 'setCellState':
      return `${positionLabel(action.position)} → ${action.state}`;
    case 'clearState':
      return `清空全部 ${action.state}`;
    case 'paintTrail':
      return `${positionLabel(action.position)}绘制 ${action.state}`;
    case 'forceTurn':
      return `强制${TURN_LABELS[action.turn] || action.turn}${action.probability < 1 ? `（${Math.round(action.probability * 100)}%）` : ''}`;
    case 'randomTurn':
      return `按权重转向 左${action.weights.left}/直${action.weights.straight}/右${action.weights.right}`;
    case 'changeLength':
      return `长度 ${action.amount >= 0 ? '+' : ''}${action.amount}`;
    case 'setLength':
      return `长度设为 ${action.value}`;
    case 'changeSpeed':
      return `速度 ×${action.factor}`;
    case 'setColor':
      return `颜色 → ${action.color}`;
    case 'spawnAgent':
      return `生成移动体（长度 ${action.length}）`;
    case 'removeAgent':
      return `移除移动体（${{ nearest: '最近', random: '随机', largest: '最长', oldest: '最早' }[action.target] || action.target}）`;
    case 'modifyRule':
      return `规则操作 ${action.op}`;
    case 'endRun':
      return `结束：${action.reason}`;
    case 'log':
      return `日志：${action.message}`;
    default:
      return action.type;
  }
}
