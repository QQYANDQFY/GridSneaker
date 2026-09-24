/**
 * 得分系统
 * 把一轮运行的统计量折算成「总分 + 分项 + 等级」，供界面展示与最高分比较。
 *
 * 设计原则：
 *  - 纯函数：只读取统计量 / 网格 / 结束原因，不产生副作用，便于离线回归测试；
 *  - 分项透明：成长 / 探索 / 存活 / 交互 / 收尾奖励 / 碰撞罚分，每项都能单独解释；
 *  - 尺寸无关：等级按「总分 ÷ 网格格数」的相对分折算，不同地图尺寸之间可横向比较。
 */

/**
 * 结束原因的收尾奖励分。
 * 只有「正向收尾」（达成目标而结束）给奖励；失败收尾不再额外扣分——罚分已由碰撞项体现。
 */
export const END_BONUS = {
  lengthReached: 250,
  coverage: 350,
  maxSteps: 60,
  caStable: 80,
  ruleEnd: 40,
  frameLimit: 0,
  allAgentsGone: 0,
  noMove: 0,
  obstacle: 0,
  selfCollision: 0,
  selfCollisionTotal: 0,
  selfCollisionConsecutive: 0,
  wall: 0,
  outOfBounds: 0,
  maxTime: 0,
};

/** 等级阈值（相对分 = 总分 / 网格格数），从高到低匹配第一个满足项 */
export const GRADE_THRESHOLDS = [
  { grade: 'S', ratio: 1.9, label: 'S · 完美' },
  { grade: 'A', ratio: 1.25, label: 'A · 优秀' },
  { grade: 'B', ratio: 0.75, label: 'B · 良好' },
  { grade: 'C', ratio: 0.4, label: 'C · 及格' },
  { grade: 'D', ratio: -Infinity, label: 'D · 待改进' },
];

/** 各分项的权重（集中定义，便于调整与解释） */
export const SCORE_WEIGHTS = {
  growth: 12,
  explore: 6,
  endurance: 0.8,
  marker: 15,
  merge: 25,
  repel: 5,
  spawn: 10,
  collision: 3,
  selfCollision: 8,
};

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function round(v) {
  return Math.round(num(v));
}

/** 数字千分位格式化（不依赖 Intl，保证任何环境下输出一致） */
export function formatScore(n) {
  const v = Math.round(num(n));
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * 按总分与网格格数判定等级。
 * @returns {{grade: string, label: string, ratio: number}}
 */
export function gradeFor(total, grid) {
  const size = Math.max(1, num(grid && grid.size) || 1);
  const ratio = num(total) / size;
  const hit = GRADE_THRESHOLDS.find((g) => ratio >= g.ratio) || GRADE_THRESHOLDS[GRADE_THRESHOLDS.length - 1];
  return { grade: hit.grade, label: hit.label, ratio };
}

/**
 * 计算得分分项。
 * @param {object} stats 运行统计量（simulation.js 的 stats 对象）
 * @param {object} grid  网格（取 size 作为等级基准）
 * @param {object|null} endReason 结束原因（含 code）
 * @returns {Array<{key: string, label: string, value: number, detail: string}>}
 */
export function scoreParts(stats, grid, endReason) {
  const s = stats || {};
  const w = SCORE_WEIGHTS;
  const maxLength = round(s.maxLength);
  const coverage = num(s.coverage);
  const steps = round(s.steps);
  const markers = round(s.markerInteractions);
  const merges = round(s.merges);
  const repels = round(s.repels);
  const spawns = round(s.spawns);
  const collisions = round(s.collisionsTotal ?? s.collisions);
  const selfCollisions = round(s.selfCollisions);
  const code = endReason && endReason.code ? endReason.code : null;
  const bonus = code && END_BONUS[code] !== undefined ? END_BONUS[code] : 0;
  return [
    { key: 'growth', label: '成长', value: maxLength * w.growth, detail: `最大长度 ${maxLength} × ${w.growth}` },
    { key: 'explore', label: '探索', value: Math.round(coverage * w.explore), detail: `覆盖率 ${coverage.toFixed(1)}% × ${w.explore}` },
    { key: 'endurance', label: '存活', value: Math.round(steps * w.endurance), detail: `${steps} 步 × ${w.endurance}` },
    {
      key: 'interaction',
      label: '交互',
      value: markers * w.marker + merges * w.merge + repels * w.repel + spawns * w.spawn,
      detail: `标记物 ${markers} · 融合 ${merges} · 排斥 ${repels} · 生成 ${spawns}`,
    },
    { key: 'bonus', label: '收尾奖励', value: bonus, detail: code ? `结束于「${code}」` : '未结束（达到帧上限）' },
    {
      key: 'penalty',
      label: '碰撞罚分',
      value: -(collisions * w.collision + selfCollisions * w.selfCollision),
      detail: `碰撞 ${collisions} × ${w.collision} + 自撞 ${selfCollisions} × ${w.selfCollision}`,
    },
  ];
}

/**
 * 计算完整得分结果。
 * @returns {{total: number, grade: string, gradeLabel: string, ratio: number, parts: Array, endCode: string|null}}
 */
export function computeScore(stats, grid, endReason) {
  const parts = scoreParts(stats, grid, endReason);
  const raw = parts.reduce((sum, p) => sum + p.value, 0);
  const total = Math.max(0, Math.round(raw));
  const g = gradeFor(total, grid);
  return {
    total,
    grade: g.grade,
    gradeLabel: g.label,
    ratio: g.ratio,
    parts,
    endCode: endReason && endReason.code ? endReason.code : null,
  };
}
