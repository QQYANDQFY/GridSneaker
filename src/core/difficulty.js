/**
 * 动态难度评估
 * 根据「当前画面的拥挤程度」给出难度等级与建议的播放速度倍率。
 *
 * 纯函数、无副作用：核心只负责评估，是否据此调节播放速度由界面决定
 * （界面「自适应速度」开关打开时，拥挤度升高会自动放慢播放，给观察留出余量）。
 */

/** 难度等级表：min 为拥挤度下限，speedScale 为建议播放速度倍率 */
export const DIFFICULTY_LEVELS = [
  { level: 1, label: '轻松', min: 0, speedScale: 1 },
  { level: 2, label: '正常', min: 0.3, speedScale: 0.85 },
  { level: 3, label: '紧张', min: 0.55, speedScale: 0.65 },
  { level: 4, label: '困难', min: 0.75, speedScale: 0.45 },
  { level: 5, label: '绝境', min: 0.9, speedScale: 0.3 },
];

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

/**
 * 拥挤度：0（空旷）~ 1（几乎占满）。
 * 由「已探索覆盖率」「蛇身长度占地图比例」「同时存活的移动体数量」加权得到。
 */
export function crowdingOf(stats, grid) {
  const s = stats || {};
  const size = Math.max(1, num(grid && grid.size) || 1);
  const cover = clamp01(num(s.coverage) / 100);
  const body = clamp01(num(s.length) / size);
  const agents = clamp01((Math.max(1, num(s.agents)) - 1) / 6);
  // 四舍五入到 1e-6：消除浮点累加噪声，保证 0.9 / 1 这类边界值可被等级阈值精确命中
  return Math.round(clamp01(cover * 0.6 + body * 0.3 + agents * 0.1) * 1e6) / 1e6;
}

/**
 * 当前难度：{ level, label, min, speedScale, crowding }
 */
export function difficultyOf(stats, grid) {
  const crowding = crowdingOf(stats, grid);
  let cur = DIFFICULTY_LEVELS[0];
  for (const l of DIFFICULTY_LEVELS) {
    if (crowding >= l.min) cur = l;
  }
  return { ...cur, crowding };
}

/**
 * 自适应播放速度倍率：拥挤时返回更小的倍率（放慢播放）。
 * 界面用它乘以步长间隔，得到「动态难度」下的实际播放速度。
 */
export function adaptiveSpeedScale(stats, grid) {
  return difficultyOf(stats, grid).speedScale;
}
