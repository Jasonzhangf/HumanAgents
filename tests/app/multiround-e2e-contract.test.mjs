#!/usr/bin/env node
/**
 * Focused contract test for the real multi-round explicit -> implicit E2E
 * receipt. It does not call the provider; it guards the durable artifact the
 * live run writes so a truncated or single-round receipt can never be reported
 * as multi-round completion evidence.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { assertReceiptContract } from './real-explicit-implicit-e2e.mjs';

function validReceipt() {
  return {
    proof: 'explicit-implicit-e2e',
    gitSha: 'a'.repeat(40),
    mainSha: 'b'.repeat(40),
    sourceDigest: 'sha256:deadbeef',
    rounds: [
      {
        round: 1,
        taskId: 'ui-task-implicit-draft-1',
        terminalState: 'succeeded',
        toolCallIds: ['call_round_1'],
        dashboard: { executionEpoch: 1 },
      },
      {
        round: 2,
        taskId: 'ui-task-implicit-draft-1',
        terminalState: 'succeeded',
        toolCallIds: ['call_round_2'],
        dashboard: { executionEpoch: 2 },
      },
    ],
  };
}

test('multi-round receipt contract accepts a real two-round succeeded receipt', () => {
  assert.equal(assertReceiptContract(validReceipt()), true);
});

test('multi-round receipt contract rejects a single-round receipt', () => {
  const receipt = validReceipt();
  receipt.rounds = receipt.rounds.slice(0, 1);
  assert.throws(() => assertReceiptContract(receipt), /at least two executor rounds/);
});

test('multi-round receipt contract rejects a non-succeeded round', () => {
  const receipt = validReceipt();
  receipt.rounds[1].terminalState = 'waiting';
  assert.throws(() => assertReceiptContract(receipt), /did not reach terminal succeeded/);
});

test('multi-round receipt contract rejects a missing git binding', () => {
  const receipt = validReceipt();
  delete receipt.gitSha;
  assert.throws(() => assertReceiptContract(receipt), /not bound to a git commit/);
});

test('multi-round receipt contract rejects rounds without a real tool call id', () => {
  const receipt = validReceipt();
  receipt.rounds[0].toolCallIds = [];
  assert.throws(() => assertReceiptContract(receipt), /recorded no real tool call id/);
});

test('multi-round receipt contract rejects two rounds on different tasks', () => {
  const receipt = validReceipt();
  receipt.rounds[1].taskId = 'ui-task-implicit-draft-2';
  assert.throws(() => assertReceiptContract(receipt), /both rounds on the same task/);
});
