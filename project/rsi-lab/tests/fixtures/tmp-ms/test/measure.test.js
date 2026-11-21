import assert from 'node:assert/strict';
import { measure } from '../src/measure.js';

assert.equal(measure([]), 0);
assert.equal(measure([1, 2, 3]), 6);
assert.equal(measure([-1, 1]), 0);
assert.equal(measure([2.5, 0.5]), 3);
