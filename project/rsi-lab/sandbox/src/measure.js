'use strict';

// 语义来源：微内核 measure.go —— 一根轴答「谁算的」，一根轴答「有没有」。
// 合成一个枚举的后果是实测过的：缺席会被下游读成 0。

const BASIS = { measured: 1, relayed: 2, estimated: 3, model_says: 4, absent: 5 };

/**
 * 校验一格测量，合法返回 null，否则返回错误说明。
 *  - 缺席却带数或带出处 → 错误里必须含「缺席」
 *  - relayed/estimated 缺 source → 错误里必须含「来源」
 *  - 非缺席但 basis 不在 1..4 → 错误里必须含「basis」
 */
function checkMeasure(m) {
  if (!m || typeof m !== 'object') {
    return '测量对象缺失';
  }
  if (m.absent) {
    if (m.n !== undefined && m.n !== null) {
      return '缺席的测量不能带 n';
    }
    if (m.source !== undefined && m.source !== null && m.source !== '') {
      return '缺席的测量不能带 source';
    }
    return null;
  }
  if (m.basis === 2 || m.basis === 3) {
    if (m.source === undefined || m.source === null || m.source === '') {
      return 'basis 为 2 或 3 时必须带来源';
    }
  }
  if (m.basis < 1 || m.basis > 4) {
    return 'basis 必须在 1..4 之间';
  }
  return null;
}

/**
 * 带正分母返回 n/denominator；无分母返回 n；分母 <= 0 返回 NaN。
 */
function readingsRatio(r) {
  if (!r || typeof r !== 'object') {
    return NaN;
  }
  const d = r.denominator;
  if (d === undefined || d === null) {
    return r.n;
  }
  if (typeof d === 'number' && d > 0) {
    return r.n / d;
  }
  return NaN;
}

/**
 * 按 basis 五档计数，返回
 * { measured, relayed, estimated, model_says, absent }。
 */
function basisSummary(readings) {
  throw new Error('basisSummary not implemented');
}

module.exports = { BASIS, checkMeasure, readingsRatio, basisSummary };
