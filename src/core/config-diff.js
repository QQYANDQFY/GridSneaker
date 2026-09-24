/**
 * 配置差异比对
 * 把「当前配置」与「基准配置（模板基准）」的差异整理成可直接展示的中文条目，
 * 供「载入模板前提示将被覆盖的自定义改动」等场景使用。
 *
 * 设计原则：
 *  - 纯函数：只读取两个配置对象，不产生副作用，便于离线回归测试；
 *  - 可读：字段名 / 枚举取值按界面文案中文化，且与配置面板用语保持一致；
 *  - 克制：仅比对普通对象与原始值，数组（规则表 / 状态表等）按整体内容变化报告一条，
 *    不递归展开，避免一条规则改动产生成百上千条噪声差异。
 */
import { INTERACTION_LABELS, SPAWN_LABELS } from './config.js';
import { CA_UPDATE_LABELS, CA_BOUNDARY_LABELS } from './ca.js';
import { DIR_LABEL_CN } from './grid.js';

/** 顶层配置键 → 中文分组名 */
export const CONFIG_SECTION_LABELS = {
  meta: '场景信息',
  seed: '随机种子',
  speed: '播放速度',
  ruleExecution: '规则执行方式',
  grid: '网格与坐标',
  start: '起点与方向',
  body: '移动体与身体',
  moveRules: '移动规则',
  safety: '安全避撞',
  multiSnake: '多移动体',
  collision: '碰撞处理',
  selfCollisionPolicy: '自撞策略',
  advancedRules: '高级规则',
  environmentRules: '环境规则',
  caMode: '元胞自动机',
  endConditions: '结束规则',
  style: '展示样式',
};

/** 叶子字段名 → 中文标签（与配置面板上的标签一致） */
export const CONFIG_FIELD_LABELS = {
  name: '名称', description: '描述',
  type: '网格类型', width: '宽', height: '高', boundary: '边界行为',
  col: '起点列', row: '起点行', direction: '起始方向',
  enabled: '启用', initialLength: '初始长度', segmentSize: '体节尺寸', shape: '体节形状', colorMode: '配色模式',
  head: '头色', tail: '尾色', solid: '单色', trail: '轨迹色', custom: '自定义色带',
  mode: '模式', trigger: '触发时机', amount: '变化量', probability: '概率',
  maxLength: '最大长度', minLength: '最小长度', interval: '间隔',
  left: '左转权重', straight: '直行权重', right: '右转权重',
  avoidAll: '避开全部（总开关）', avoidBody: '避让自身身体', avoidObstacle: '避让障碍物', avoidOtherAgents: '避让其它移动体',
  avoidWall: '避让不可穿越边界', warnSelfCollision: '自撞预警提示',
  times: '预定时间点', minInterval: '最小间隔', maxInterval: '最大间隔',
  maxAgents: '最大同时存在', length: '长度', events: '触发事件', colorPalette: '逐个体配色',
  headIntoBody: '撞到自身身体', headIntoTail: '撞到尾部', wall: '撞墙', outOfBounds: '越界',
  obstacle: '撞障碍物', countMode: '碰撞计数方式',
  action: '处理动作', n: '次数', maxConsecutive: '连续上限',
  states: '状态表', neighborhood: '邻域', radius: '邻域半径', update: '更新顺序',
  rules: '状态转移规则表', initial: '初始状态', density: '散布密度', pattern: '图案文本',
  environmentRules: '环境规则表', advancedRules: '高级规则表',
  syncWithAgent: '与移动体同步时机', every: '演化间隔', stopWhenAgentEnds: '随移动体结束',
  stopOnStable: '稳定即结束', stableSteps: '稳定判定步数',
  markerInteraction: '标记物交互机制', effects: '触碰反馈规则表', value: '数值',
  consume: '消耗标记物', consumeTo: '消耗后状态', color: '颜色',
  maxSteps: '步数上限', lengthReached: '长度达标', lengthTarget: '目标长度',
  coverage: '覆盖率达标', coveragePercent: '覆盖比例', noMove: '无路可走',
  maxTime: '运行超时', maxTimeMs: '超时毫秒', ruleEnd: '规则驱动结束',
  caStable: '元胞稳定结束', allAgentsGone: '移动体全部消失', priority: '结束优先级',
  selfCollision: '撞到自身', selfCollisionTotal: '自撞总次数', selfCollisionTotalN: '自撞总次数阈值',
  selfCollisionConsecutive: '连续自撞', selfCollisionConsecutiveN: '连续自撞阈值',
  cellSize: '格子大小', gap: '格子间距', darkMode: '暗黑模式', showGrid: '网格线',
  showTrail: '轨迹', showBody: '身体', showArrows: '方向箭头', showCoords: '坐标文本',
  showObstacles: '障碍物', showMarkers: '标记物', highlightRules: '规则高亮', showStartEnd: '起点/终点',
  trailFade: '轨迹渐隐', fadeMode: '轨迹衰减模式', fadeLength: '衰减步长',
  showEyes: '蛇头眼睛', showEffects: '交互特效', glow: '蛇身发光',
  showCrossings: '边界进出点', crossingScale: '进出点标记尺寸',
  hoverCrosshair: '悬停行列准线', hoverCrosshairWidth: '准线宽度',
  showRevisit: '重访格高亮', revisitMin: '重访判定次数', revisitAlpha: '重访高亮不透明度',
  hoverTip: '悬浮提示', hoverTipState: '提示：环境状态', hoverTipAgent: '提示：移动体',
  hoverTipTrail: '提示：轨迹信息', hoverTipMarkers: '提示：标记信息',
  trailJoin: '轨迹连接方式', bodyJoin: '蛇身连接方式', trailAngle: '切角角度',
  followAgent: '跟随移动体', axisLabels: '坐标轴',
  hiddenStats: '隐藏的统计项', tabColors: '选项卡配色', compact: '紧凑排版', statFlash: '统计切换淡入',
  activeBg: '激活 · 背景', activeText: '激活 · 文字', activeBorder: '激活 · 边框',
  inactiveBg: '未激活 · 背景', inactiveText: '未激活 · 文字', inactiveBorder: '未激活 · 边框',
};

/** 按「完整路径」覆盖的枚举文案（优先于按字段名匹配） */
const VALUE_LABELS_BY_PATH = {
  'grid.type': { square: '方格图（4 方向）', hex: '六边形图（6 方向）' },
  'grid.boundary': {
    stop: '停止（撞墙即停）', bounce: '反弹', wrap: '穿越到另一侧',
    randomTurn: '随机转向', custom: '自定义（由环境规则决定）',
  },
  'start.direction': { ...DIR_LABEL_CN, random: '任意（每次运行随机）' },
  'body.shape': { round: '圆形', square: '方形', hexagon: '六边形' },
  'body.colorMode': { gradient: '头尾渐变', solid: '单色', custom: '自定义多色' },
  'body.lengthPolicy.mode': { fixed: '固定长度（头进尾出）', variable: '可变长度（增长 / 缩短）', custom: '自定义（由环境规则决定）' },
  'body.lengthPolicy.growth.trigger': { step: '每步', eat: '吃到标记物', collision: '发生碰撞', timer: '每 N 步' },
  'body.lengthPolicy.shrink.trigger': { step: '每步', eat: '吃到标记物', collision: '发生碰撞', timer: '每 N 步' },
  ruleExecution: { async: '异步（逐条即时生效）', sync: '同步（基于阶段快照）' },
  'collision.obstacle': { stop: '停止', destroy: '撞毁障碍物后继续', pass: '直接穿过' },
  'multiSnake.spawn.mode': SPAWN_LABELS,
  'multiSnake.interaction.mode': INTERACTION_LABELS,
  'caMode.neighborhood': {
    vonNeumann: '4 邻域（Von Neumann）', moore: '8 邻域（Moore）',
    hex: '6 邻域（六边形）', radius: '半径 r 邻域',
  },
  'caMode.boundary': CA_BOUNDARY_LABELS,
  'caMode.update': CA_UPDATE_LABELS,
  'caMode.initial.mode': { empty: '全空', random: '随机散布', pattern: '图案文本' },
  'style.fadeMode': { linear: '线性（等速变暗）', exponential: '指数（先急后缓）' },
  'style.trailJoin': { curve: '曲线（贝塞尔）', line: '直线', angle: '预设角度切角' },
  'style.bodyJoin': { curve: '曲线（贝塞尔）', line: '直线', angle: '预设角度切角' },
};

/** 按字段名匹配的枚举文案（无路径覆盖时使用） */
const VALUE_LABELS_BY_KEY = {
  direction: { ...DIR_LABEL_CN, random: '任意（每次运行随机）' },
  mode: { fixed: '固定', variable: '可变', custom: '自定义' },
};

/** 派生 / 内部字段：与其它字段重复表达同一设置，不参与差异比对 */
const SKIP_KEYS = new Set(['version', 'id', 'smoothTrail', 'smoothBody']);

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 「空值」归一的判定。
 * 基准配置由 JSON 往返（JSON.parse(JSON.stringify(cfg))）得到，而 NaN / Infinity / undefined
 * 都不可被 JSON 表示：undefined 会丢键、NaN 会变成 null。若不做归一化，
 * 「基准里的 null ↔ 当前配置里的 NaN」会被当成用户改动，产生「（空） → NaN」这类假差异。
 */
function isEmptyValue(v) {
  return v === undefined || v === null || (typeof v === 'number' && !Number.isFinite(v));
}

/** 值 → 可读文本（对象 / 数组只给规模，避免成串 JSON 撑爆提示） */
export function describeConfigValue(v) {
  if (isEmptyValue(v)) return '（空）';
  if (Array.isArray(v)) return `${v.length} 项`;
  if (typeof v === 'boolean') return v ? '开' : '关';
  if (typeof v === 'number') return String(v);
  const text = String(v);
  if (!text) return '（空）';
  return text.length > 28 ? `${text.slice(0, 28)}…` : text;
}

/** 枚举取值 → 中文文案：先按完整路径匹配，再按字段名兜底 */
function valueLabel(path, key, value) {
  const table = VALUE_LABELS_BY_PATH[path] || VALUE_LABELS_BY_KEY[key];
  if (table && Object.prototype.hasOwnProperty.call(table, value)) return table[value];
  return null;
}

function formatValue(path, key, v) {
  const label = valueLabel(path, key, v);
  if (label !== null) return label;
  return describeConfigValue(v);
}

function sameJSON(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function fieldLabel(path, key) {
  return CONFIG_FIELD_LABELS[key] || key;
}

function pushChange(out, section, path, key, a, b) {
  const label = fieldLabel(path, key);
  const item = {
    section,
    path,
    key,
    label,
    from: formatValue(path, key, a),
    to: formatValue(path, key, b),
    kind: Array.isArray(a) || Array.isArray(b) ? 'list' : 'value',
  };
  item.text = item.kind === 'list'
    ? `${label}：内容已改动（${describeConfigValue(a)} → ${describeConfigValue(b)}）`
    : `${label}：${item.from} → ${item.to}`;
  out.push(item);
}

function walk(base, next, path, section, out) {
  const keys = new Set([...Object.keys(base || {}), ...Object.keys(next || {})]);
  for (const key of keys) {
    if (SKIP_KEYS.has(key)) continue;
    const a = base ? base[key] : undefined;
    const b = next ? next[key] : undefined;
    const nextPath = path ? `${path}.${key}` : key;
    const nextSection = path ? section : key;
    if (isPlainObject(a) && isPlainObject(b)) {
      walk(a, b, nextPath, nextSection, out);
      continue;
    }
    if (Array.isArray(a) || Array.isArray(b)) {
      if (!sameJSON(a, b)) pushChange(out, nextSection, nextPath, key, a, b);
      continue;
    }
    if (a !== b) {
      // NaN / Infinity / null / undefined 之间互不相等，但都属于「空值」，不算用户改动
      if (isEmptyValue(a) && isEmptyValue(b)) continue;
      pushChange(out, nextSection, nextPath, key, a, b);
    }
  }
}

/**
 * 比对基准配置与当前配置，返回差异条目（按配置结构顺序）。
 * @returns {Array<{section: string, path: string, key: string, label: string, from: string, to: string, text: string, kind: string}>}
 */
export function diffConfigs(base, next) {
  const out = [];
  walk(base || {}, next || {}, '', '', out);
  return out;
}

/** 按分组聚合差异条目，供对话框分节展示 */
export function summarizeConfigChanges(changes) {
  const order = [];
  const grouped = new Map();
  for (const c of changes || []) {
    if (!grouped.has(c.section)) {
      grouped.set(c.section, []);
      order.push(c.section);
    }
    grouped.get(c.section).push(c.text);
  }
  return order.map((section) => ({
    title: CONFIG_SECTION_LABELS[section] || section,
    items: grouped.get(section),
  }));
}
