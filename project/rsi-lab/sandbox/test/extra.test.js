'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { mode, variance, correlation } = require('../src/stats.js');

test('mode: 最常见的值', () => {
  assert.strictEqual(mode([1, 2, 2, 3]), 2);
});

test('mode: 并列众数取较小值', () => {
  assert.strictEqual(mode([4, 4, 2, 2]), 2);
});

test('mode: 空数组返回 NaN', () => {
  assert.ok(Number.isNaN(mode([])));
});

test('variance: 样本方差（n-1）', () => {
  assert.ok(Math.abs(variance([2, 4, 4, 4, 5, 5, 7, 9]) - 32 / 7) < 1e-9);
});

test('variance: 单个元素返回 0', () => {
  assert.strictEqual(variance([5]), 0);
});

test('correlation: 完全正相关 = 1', () => {
  assert.ok(Math.abs(correlation([1, 2, 3], [2, 4, 6]) - 1) < 1e-9);
});

test('correlation: 完全负相关 = -1', () => {
  assert.ok(Math.abs(correlation([1, 2, 3], [6, 4, 2]) + 1) < 1e-9);
});

test('correlation: 常数序列返回 NaN', () => {
  assert.ok(Number.isNaN(correlation([1, 1, 1], [1, 2, 3])));
});