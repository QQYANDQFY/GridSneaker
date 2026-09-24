/**
 * 预设模板：覆盖移动体、环境规则、元胞自动机与混合模式的典型场景
 */
import { defaultConfig, defaultRule, defaultClause } from './config.js';

function base(overrides = {}) {
  const cfg = defaultConfig();
  return deepMerge(cfg, overrides);
}

function deepMerge(a, b) {
  const out = Array.isArray(a) ? [...a] : { ...a };
  for (const [k, v] of Object.entries(b || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof out[k] === 'object' && out[k] !== null && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** 由参数生成「条件-后果」规则 */
function rule(id, name, opts = {}) {
  return defaultRule({
    id,
    name,
    subject: opts.subject || 'head',
    trigger: opts.trigger || 'afterStep',
    condition: { logic: 'and', clauses: opts.clauses || [] },
    actions: opts.actions || [],
    priority: opts.priority ?? 1,
    probability: opts.probability ?? 1,
    cooldown: opts.cooldown ?? 0,
    maxTriggers: opts.maxTriggers ?? 0,
    once: opts.once ?? false,
  });
}

export const PRESETS = [
  {
    id: 'random-walk',
    name: '随机游走',
    description: '方形网格上的等概率左/直/右随机游走，撞墙即停。',
    build: () => base({
      meta: { name: '随机游走', description: '等概率转向的经典随机游走' },
      grid: { type: 'square', width: 28, height: 20, boundary: 'stop' },
      start: { col: 14, row: 10, direction: 'up' },
      body: { initialLength: 4, colorMode: 'gradient' },
      moveRules: { left: 1, straight: 1, right: 1 },
      endConditions: { maxSteps: 300, wall: true },
      style: { cellSize: 22, showTrail: true, trailFade: true },
    }),
  },
  {
    id: 'straight-bias',
    name: '偏好直行',
    description: '直行权重极高（70%），偶尔转向，展示条件概率与转向分布统计。',
    build: () => base({
      meta: { name: '偏好直行', description: '带直行偏好的游走' },
      grid: { type: 'square', width: 40, height: 28, boundary: 'wrap' },
      start: { col: 20, row: 14, direction: 'right' },
      body: { initialLength: 6 },
      moveRules: { left: 0.15, straight: 0.7, right: 0.15 },
      endConditions: { maxSteps: 400, wall: false },
      style: { cellSize: 18 },
    }),
  },
  {
    id: 'bounce',
    name: '撞墙反弹',
    description: '边界反弹模式：撞到墙后掉头，永不越界。',
    build: () => base({
      meta: { name: '撞墙反弹', description: '边界行为 = 反弹' },
      grid: { type: 'square', width: 24, height: 18, boundary: 'bounce' },
      start: { col: 12, row: 9, direction: 'up' },
      body: { initialLength: 8 },
      moveRules: { left: 0.2, straight: 0.6, right: 0.2 },
      endConditions: { maxSteps: 500, wall: false },
      style: { cellSize: 24 },
    }),
  },
  {
    id: 'hex-explore',
    name: '六边形探索',
    description: '六边形网格（轴向坐标）上的 6 方向探索，邻域为六边形 6 邻域。',
    build: () => base({
      meta: { name: '六边形探索', description: '六边形网格 + 6 方向移动' },
      grid: { type: 'hex', width: 22, height: 18, boundary: 'wrap' },
      start: { col: 11, row: 9, direction: 'east' },
      body: { initialLength: 5, shape: 'hexagon' },
      moveRules: { left: 1, straight: 1.5, right: 1 },
      endConditions: { maxSteps: 400, wall: false },
      style: { cellSize: 26, showArrows: true },
    }),
  },
  {
    id: 'growing-snake',
    name: '增长型贪吃蛇',
    description: '每步以 20% 概率增长，吃到标记物必定增长；标记物被吃掉后消失。',
    build: () => base({
      meta: { name: '增长型贪吃蛇', description: '可变长度 + 标记物进食' },
      grid: { type: 'square', width: 26, height: 20, boundary: 'stop' },
      start: { col: 12, row: 16, direction: 'up' },
      body: {
        initialLength: 3,
        lengthPolicy: {
          mode: 'variable',
          growth: { enabled: true, trigger: 'step', amount: 1, probability: 0.2, interval: 1, maxLength: 60 },
          shrink: { enabled: false },
        },
      },
      moveRules: { left: 0.5, straight: 0.34, right: 0.16 },
      environmentRules: [
        rule('grow-eat', '吃到标记物', {
          actions: [{ type: 'changeLength', amount: 1 }],
          clauses: [defaultClause('cellState')],
        }),
      ],
      caMode: {
        enabled: true,
        states: ['empty', 'obstacle', 'marker'],
        neighborhood: 'moore',
        update: 'synchronous',
        boundary: 'fixed',
        initial: { mode: 'random', density: 0.06, state: 'marker' },
        rules: [],
      },
      endConditions: { maxSteps: 300, selfCollision: true },
      style: { cellSize: 24 },
    }),
  },
  {
    id: 'collision-lab',
    name: '碰撞停止实验',
    description: '撞到自身立即停止，统计碰撞点与存活步数，适合策略对比实验。',
    build: () => base({
      meta: { name: '碰撞停止实验', description: '自撞即停' },
      grid: { type: 'square', width: 20, height: 20, boundary: 'wrap' },
      start: { col: 10, row: 10, direction: 'up' },
      body: { initialLength: 12 },
      moveRules: { left: 1, straight: 1, right: 1 },
      selfCollisionPolicy: { action: 'stop', n: 2, maxConsecutive: 5 },
      endConditions: { maxSteps: 2000, selfCollision: true, wall: false },
      style: { cellSize: 24 },
    }),
  },
  {
    id: 'obstacle-ecology',
    name: '障碍物生态',
    description: '蛇头周围障碍物过多时强制转向并生成标记物，展示环境感知—条件—后果闭环。',
    build: () => base({
      meta: { name: '障碍物生态', description: '环境感知规则 + 障碍物生成' },
      grid: { type: 'square', width: 30, height: 22, boundary: 'stop' },
      start: { col: 15, row: 11, direction: 'up' },
      body: { initialLength: 4 },
      moveRules: { left: 1, straight: 1.2, right: 1 },
      collision: { obstacle: 'stop' },
      environmentRules: [
        rule('spawn-wall', '前方障碍则右转', {
          clauses: [{ type: 'direction', objects: ['obstacle'], rel: 'front', distance: 1 }],
          actions: [{ type: 'forceTurn', turn: 'right' }],
          priority: 5,
        }),
        rule('blocked', '周围拥挤则标记', {
          clauses: [{ type: 'count', kind: 'moore', radius: 2, objects: ['obstacle'], comparator: '>=', value: 6 }],
          actions: [{ type: 'createMarker', position: 'current' }, { type: 'createObstacle', position: 'randomNeighbor' }],
          priority: 3,
          probability: 0.5,
        }),
        rule('sprinkle', '低概率撒障碍', {
          clauses: [defaultClause('random')],
          actions: [{ type: 'createObstacle', position: 'randomEmpty' }],
          priority: 1,
          probability: 0.15,
        }),
      ],
      endConditions: { maxSteps: 250, obstacle: true, selfCollision: true },
      style: { cellSize: 22 },
    }),
  },
  {
    id: 'life',
    name: '生命游戏（Conway\'s Life）',
    description: 'B3/S23 同步更新，Moore 邻域，滑翔机图案；移动体按规则在其上穿行。',
    build: () => base({
      meta: { name: '生命游戏', description: 'Conway B3/S23' },
      grid: { type: 'square', width: 40, height: 30, boundary: 'wrap' },
      start: { col: 2, row: 2, direction: 'right' },
      body: { initialLength: 3, colors: { head: '#ff9f43' } },
      moveRules: { left: 0.25, straight: 0.5, right: 0.25 },
      caMode: {
        enabled: true,
        states: ['empty', 'alive'],
        neighborhood: 'moore',
        radius: 1,
        boundary: 'wrap',
        update: 'synchronous',
        initial: {
          mode: 'pattern',
          pattern: [
            '..........',
            '.O........',
            '..OO......',
            '.OO.......',
            '..........',
          ].join('\n'),
        },
        rules: [
          { id: 'birth', name: '出生', from: ['empty'], counts: [{ state: 'alive', values: [3] }], to: 'alive', probability: 1 },
          { id: 'death', name: '死亡', from: ['alive'], counts: [{ state: 'alive', values: [0, 1, 4, 5, 6, 7, 8] }], to: 'empty', probability: 1 },
        ],
        syncWithAgent: 'afterMove',
      },
      endConditions: { maxSteps: 300, wall: false },
      style: { cellSize: 16, showTrail: false, showBody: true },
    }),
  },
  {
    id: 'hex-ca',
    name: '六边形元胞自动机',
    description: '六边形 6 邻域 CA（B2/S34），环形边界，展示非方格邻域的状态演化。',
    build: () => base({
      meta: { name: '六边形 CA', description: '六边形邻域元胞自动机' },
      grid: { type: 'hex', width: 26, height: 20, boundary: 'wrap' },
      start: { col: 13, row: 10, direction: 'east' },
      body: { initialLength: 1 },
      caMode: {
        enabled: true,
        states: ['empty', 'alive'],
        neighborhood: 'hex',
        radius: 1,
        boundary: 'wrap',
        update: 'synchronous',
        initial: { mode: 'random', density: 0.35, state: 'alive' },
        rules: [
          { id: 'b', name: '出生', from: ['empty'], counts: [{ state: 'alive', values: [2] }], to: 'alive', probability: 1 },
          { id: 's', name: '存活', from: ['alive'], counts: [{ state: 'alive', min: 3, max: 4 }], to: 'alive', probability: 1 },
          { id: 'd', name: '死亡', from: ['alive'], counts: [{ state: 'alive', values: [0, 1, 2, 5, 6] }], to: 'empty', probability: 1 },
        ],
        syncWithAgent: 'afterMove',
      },
      endConditions: { maxSteps: 200, wall: false },
      style: { cellSize: 20, showTrail: false },
    }),
  },
  {
    id: 'hybrid-life',
    name: '移动体 + CA 混合',
    description: '每步移动后环境按 CA 演化；蛇头被活细胞包围时转向、长度随环境变化。',
    build: () => base({
      meta: { name: '移动体+CA 混合', description: '移动体与环境双向耦合' },
      grid: { type: 'square', width: 36, height: 26, boundary: 'wrap' },
      start: { col: 18, row: 13, direction: 'right' },
      body: {
        initialLength: 4,
        lengthPolicy: { mode: 'variable', growth: { enabled: false } },
      },
      moveRules: { left: 0.3, straight: 0.4, right: 0.3 },
      caMode: {
        enabled: true,
        states: ['empty', 'alive', 'marker'],
        neighborhood: 'moore',
        radius: 1,
        boundary: 'wrap',
        update: 'synchronous',
        initial: { mode: 'random', density: 0.25, state: 'alive' },
        rules: [
          { id: 'b', name: '出生', from: ['empty'], counts: [{ state: 'alive', values: [3] }], to: 'alive', probability: 1 },
          { id: 'd', name: '死亡', from: ['alive'], counts: [{ state: 'alive', values: [0, 1, 4, 5, 6, 7, 8] }], to: 'empty', probability: 1 },
        ],
        syncWithAgent: 'afterMove',
      },
      environmentRules: [
        rule('crowd', '被活细胞包围则改造环境', {
          clauses: [{ type: 'count', kind: 'moore', radius: 1, objects: ['alive'], comparator: '>=', value: 6 }],
          actions: [{ type: 'forceTurn', turn: 'left' }, { type: 'createMarker', position: 'current' }],
          priority: 4,
          probability: 0.8,
        }),
        rule('clear', '清除前方活细胞', {
          clauses: [{ type: 'cellState', position: 'front', state: 'alive' }],
          actions: [{ type: 'setCellState', position: 'front', state: 'empty' }, { type: 'changeLength', amount: 1 }],
          priority: 2,
        }),
      ],
      endConditions: { maxSteps: 300, wall: false },
      style: { cellSize: 18 },
    }),
  },
  {
    id: 'forest-fire',
    name: '森林火灾',
    description: '元胞自动机：树 → 火（邻域有火）→ 空地 → 新树，异步概率更新。',
    build: () => base({
      meta: { name: '森林火灾', description: '三状态概率 CA' },
      grid: { type: 'square', width: 44, height: 32, boundary: 'wrap' },
      start: { col: 22, row: 16, direction: 'down' },
      body: { initialLength: 1 },
      moveRules: { left: 1, straight: 1, right: 1 },
      caMode: {
        enabled: true,
        states: [
          { name: 'empty', color: null, symbol: '.', blocking: false },
          { name: 'tree', color: '#2f9e44', symbol: 'T', blocking: true },
          { name: 'fire', color: '#ff6b35', symbol: 'F', blocking: false },
        ],
        neighborhood: 'vonNeumann',
        radius: 1,
        boundary: 'wrap',
        update: 'asynchronous',
        initial: { mode: 'random', density: 0.65, state: 'tree' },
        rules: [
          { id: 'burn', name: '燃烧', from: ['tree'], counts: [{ state: 'fire', min: 1 }], to: 'fire', probability: 0.7 },
          { id: 'ash', name: '化为灰烬', from: ['fire'], counts: [], to: 'empty', probability: 1 },
          { id: 'grow', name: '生长', from: ['empty'], counts: [], to: 'tree', probability: 0.02 },
        ],
        syncWithAgent: 'afterMove',
      },
      endConditions: { maxSteps: 400, wall: false, obstacle: false },
      collision: { obstacle: 'pass' },
      style: { cellSize: 14, showTrail: false },
    }),
  },
  {
    id: 'traffic',
    name: '交通流（Rule 184）',
    description: '方向性移动规则：车辆沿指定方向前进，前车阻挡则等待。',
    build: () => base({
      meta: { name: '交通流', description: 'Rule 184 车流模型' },
      grid: { type: 'square', width: 48, height: 16, boundary: 'wrap' },
      start: { col: 24, row: 8, direction: 'right' },
      body: { initialLength: 2 },
      moveRules: { left: 0.1, straight: 0.8, right: 0.1 },
      caMode: {
        enabled: true,
        states: [
          { name: 'empty', color: null, symbol: '.', blocking: false },
          { name: 'car', color: '#4dabf7', symbol: 'C', blocking: true },
        ],
        neighborhood: 'vonNeumann',
        radius: 1,
        boundary: 'wrap',
        update: 'synchronous',
        initial: { mode: 'random', density: 0.3, state: 'car' },
        rules: [
          { id: 'move', name: '前进', kind: 'traffic', from: ['car'], counts: [], to: 'empty', direction: 'east', probability: 1 },
        ],
        syncWithAgent: 'afterMove',
      },
      collision: { obstacle: 'pass' },
      endConditions: { maxSteps: 300, wall: false, obstacle: false },
      style: { cellSize: 16, showTrail: false, showBody: true },
    }),
  },
  {
    id: 'ca-driven',
    name: 'CA 驱动移动体（人工生命）',
    description: '环境状态作为感知输入：前方有火则转向，周围树多则增长，实现环境—移动体耦合。',
    build: () => base({
      meta: { name: 'CA 驱动移动体', description: '环境感知驱动的人工生命' },
      grid: { type: 'square', width: 40, height: 28, boundary: 'wrap' },
      start: { col: 20, row: 14, direction: 'up' },
      body: { initialLength: 3, lengthPolicy: { mode: 'variable', growth: { enabled: false } } },
      moveRules: { left: 0.34, straight: 0.32, right: 0.34 },
      caMode: {
        enabled: true,
        states: [
          { name: 'empty', color: null, symbol: '.' },
          { name: 'tree', color: '#2f9e44', symbol: 'T', blocking: false },
          { name: 'fire', color: '#ff6b35', symbol: 'F', blocking: true },
        ],
        neighborhood: 'vonNeumann',
        radius: 1,
        boundary: 'wrap',
        update: 'asynchronous',
        initial: { mode: 'random', density: 0.5, state: 'tree' },
        rules: [
          { id: 'burn', name: '燃烧', from: ['tree'], counts: [{ state: 'fire', min: 1 }], to: 'fire', probability: 0.25 },
          { id: 'ash', name: '灰烬', from: ['fire'], counts: [], to: 'empty', probability: 1 },
          { id: 'grow', name: '生长', from: ['empty'], counts: [], to: 'tree', probability: 0.05 },
        ],
        syncWithAgent: 'afterMove',
      },
      environmentRules: [
        rule('fire-avoid', '前方有火则躲开', {
          clauses: [{ type: 'direction', objects: ['fire'], rel: 'front', distance: 1 }],
          actions: [{ type: 'forceTurn', turn: 'left' }, { type: 'setColor', color: '#ff6b35' }],
          priority: 6,
        }),
        rule('safe', '确认安全后恢复', {
          clauses: [{ type: 'count', kind: 'moore', radius: 1, objects: ['fire'], comparator: '==', value: 0 }],
          actions: [{ type: 'setColor', color: '#51cf66' }],
          priority: 1,
        }),
        rule('eat-tree', '吃掉前方树并增长', {
          clauses: [{ type: 'cellState', position: 'front', state: 'tree' }],
          actions: [{ type: 'changeLength', amount: 1 }, { type: 'setCellState', position: 'front', state: 'fire' }],
          priority: 3,
          probability: 0.5,
        }),
      ],
      endConditions: { maxSteps: 400, wall: false, selfCollision: true },
      collision: { obstacle: 'stop' },
      style: { cellSize: 20 },
    }),
  },
];

export function getPreset(id) {
  return PRESETS.find((p) => p.id === id) || null;
}

export function buildPresetConfig(id) {
  const p = getPreset(id);
  return p ? p.build() : defaultConfig();
}
