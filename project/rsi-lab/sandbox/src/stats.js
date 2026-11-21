// 统计工具库 · 演示靶子（sprint 1 已完成；sprint 2 新增三函数待实现）
'use strict';

function mean(xs) {
  if (xs.length === 0) return NaN;
  let sum = 0;
  for (const x of xs) sum += x;
  return sum / xs.length;
}

function sortedCopy(xs) {
  return xs.slice().sort((a, b) => a - b);
}

function median(xs) {
  if (xs.length === 0) return NaN;
  const s = sortedCopy(xs);
  const mid = Math.floor(s.length / 2);
  if (s.length % 2 === 1) return s[mid];
  return (s[mid - 1] + s[mid]) / 2;
}

function percentile(xs, p) {
  if (xs.length === 0) return NaN;
  const s = sortedCopy(xs);
  const rank = (p / 100) * (s.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return s[lo];
  return s[lo] + (rank - lo) * (s[hi] - s[lo]);
}

function stddev(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let acc = 0;
  for (const x of xs) acc += (x - m) * (x - m);
  return Math.sqrt(acc / (xs.length - 1));
}

function mode(xs) {
  if (xs.length === 0) return NaN;
  const counts = new Map();
  for (const x of xs) counts.set(x, (counts.get(x) || 0) + 1);
  let best = NaN;
  let bestCount = 0;
  for (const [x, c] of counts) {
    if (c > bestCount || (c === bestCount && x < best)) {
      best = x;
      bestCount = c;
    }
  }
  return best;
}

function variance(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let acc = 0;
  for (const x of xs) acc += (x - m) * (x - m);
  return acc / (xs.length - 1);
}

function correlation(xs, ys) {
  if (xs.length !== ys.length || xs.length === 0) return NaN;
  const mx = mean(xs);
  const my = mean(ys);
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < xs.length; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    cov += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }
  if (vx === 0 || vy === 0) return NaN;
  return cov / Math.sqrt(vx * vy);
}

module.exports = { mean, median, percentile, stddev, mode, variance, correlation };
