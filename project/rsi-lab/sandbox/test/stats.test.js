'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { mean, median, percentile, stddev } = require('../src/stats.js');

test('mean: 基础平均值', () => {
  assert.strictEqual(mean([1, 2, 3, 4]), 2.5);
});

test('mean: 小数与负数', () => {
  assert.ok(Math.abs(mean([-2, 0, 2, 4]) - 1) < 1e-12);
});

test('median: 偶数个按数值排序', () => {
  // 字典序会把 10 排在 2 前面，必须按数值
  assert.strictEqual(median([10, 2, 30, 4]), 7);
});

test('median: 奇数个', () => {
  assert.strictEqual(median([9, 1, 5]), 5);
});

test('percentile: 线性插值（p=25）', () => {
  // 排序 [10,20,30,40,50]，位置 = 0.25*4 = 1 → 20；同时验证不是取整截断到 0
  assert.strictEqual(percentile([10, 20, 30, 40, 50], 25), 20);
  // p=10：位置 0.4 → 10 + 0.4*(20-10) = 14
  assert.ok(Math.abs(percentile([10, 20, 30, 40, 50], 10) - 14) < 1e-12);
});

test('percentile: 端点', () => {
  const xs = [3, 1, 2];
  assert.strictEqual(percentile(xs, 0), 1);
  assert.strictEqual(percentile(xs, 100), 3);
});

test('stddev: 样本标准差（n-1）', () => {
  // [2,4,4,4,5,5,7,9]：样本标准差 = sqrt(32/7)
  assert.ok(Math.abs(stddev([2, 4, 4, 4, 5, 5, 7, 9]) - Math.sqrt(32 / 7)) < 1e-9);
});

test('stddev: 单个元素返回 0', () => {
  assert.strictEqual(stddev([42]), 0);
});