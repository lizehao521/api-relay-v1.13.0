'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { checkMeasure, readingsRatio, basisSummary } = require('../src/measure.js');

test('checkMeasure: 合法实测返回 null', () => {
  assert.strictEqual(checkMeasure({ n: 3, basis: 1 }), null);
});

test('checkMeasure: 缺席不许顺手塞数', () => {
  assert.match(checkMeasure({ n: 5, basis: 5, absent: true, why: '非流式没有首帧' }), /缺席/);
});

test('checkMeasure: 转述必须带来源', () => {
  assert.match(checkMeasure({ n: 3, basis: 2 }), /来源/);
});

test('checkMeasure: 有数却说不出谁算的', () => {
  assert.match(checkMeasure({ n: 3, basis: 0 }), /basis/);
});

test('readingsRatio: 带正分母返回比值', () => {
  assert.strictEqual(readingsRatio({ n: 3, denominator: 4 }), 0.75);
});

test('readingsRatio: 无分母返回原数', () => {
  assert.strictEqual(readingsRatio({ n: 3 }), 3);
});

test('readingsRatio: 分母非正返回 NaN', () => {
  assert.ok(Number.isNaN(readingsRatio({ n: 3, denominator: 0 })));
  assert.ok(Number.isNaN(readingsRatio({ n: 3, denominator: -1 })));
});

test('basisSummary: 按档计数', () => {
  assert.deepStrictEqual(
    basisSummary([{ basis: 1 }, { basis: 1 }, { basis: 2 }, { basis: 5 }]),
    { measured: 2, relayed: 1, estimated: 0, model_says: 0, absent: 1 }
  );
});
