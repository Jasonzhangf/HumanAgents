import assert from 'node:assert/strict';
import test from 'node:test';
import { allocateRequestNumber } from '../../../packages/core/src/request-numbering.js';

test('first failure keeps the first number and consecutive failures do not advance', () => {
  assert.deepEqual(allocateRequestNumber(1), { requestNumber: 1, nextRequestNumber: 2 });
  // A failed interaction never allocates; the next attempt sees the same next.
  assert.deepEqual(allocateRequestNumber(1), { requestNumber: 1, nextRequestNumber: 2 });
  assert.deepEqual(allocateRequestNumber(1), { requestNumber: 1, nextRequestNumber: 2 });
});

test('a success after failure reuses the same number and then advances once', () => {
  assert.deepEqual(allocateRequestNumber(8), { requestNumber: 8, nextRequestNumber: 9 });
  // Exact retry of the same success keeps the assigned number without advancing.
  assert.deepEqual(allocateRequestNumber(9, 8), { requestNumber: 8, nextRequestNumber: 9 });
});

test('a fresh allocation advances by exactly one', () => {
  assert.deepEqual(allocateRequestNumber(7), { requestNumber: 7, nextRequestNumber: 8 });
});

test('invalid counters are rejected by the typed rule', () => {
  assert.throws(() => allocateRequestNumber(0));
  assert.throws(() => allocateRequestNumber(1.5));
  assert.throws(() => allocateRequestNumber(1, 0));
  assert.throws(() => allocateRequestNumber(1, 2.5));
});
