import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeReceipt } from '../src/claude-adapter.ts';

const args = { command: 'npm test' };
const body = { stdout: '', stderr: '', interrupted: false };
const event = { kind: 'success', tool: 'Bash', arguments: args, response: body };
const result = { ref: 1, result: body, text: '' };

test('a native foreground completion permits its literal continuation', () => {
  assert.deepEqual(normalizeReceipt('Bash', args, event, result), { outcome: 'succeeded', certified: true });
});

test('native failure certifies execution but never success', () => {
  assert.deepEqual(normalizeReceipt('Bash', args, { kind: 'failure', tool: 'Bash', arguments: args }, { ref: 1, isError: true, result: 'Exit code 7' }), { outcome: 'failed', certified: true });
});

test('denial and missing native execution cannot certify a replacement', () => {
  assert.deepEqual(normalizeReceipt('Bash', args, undefined, { deny: 'no' }), { outcome: 'failed', certified: false });
  assert.deepEqual(normalizeReceipt('Bash', args, undefined, result), { outcome: 'unknown', certified: false });
});

for (const extra of [{ backgroundTaskId: 'job' }, { timedOutAfterMs: 1000 }, { backgroundedByUser: true }, { backgroundedByTurnAbort: true }, { backgroundedToDeliverMessage: true }, { interrupted: true }, { dangerouslyDisableSandbox: true }, { returnCodeInterpretation: 'grep exit 1' }]) {
  test(`nonterminal or exceptional Bash receipt is not success: ${Object.keys(extra)[0]}`, () => {
    const response = { ...body, ...extra };
    assert.notEqual(normalizeReceipt('Bash', args, { ...event, response }, { ...result, result: response }).outcome, 'succeeded');
  });
}

test('a downstream tool argument rewrite invalidates execution evidence', () => {
  assert.deepEqual(normalizeReceipt('Bash', args, { ...event, arguments: { command: 'npm publish' } }, result), { outcome: 'unknown', certified: false });
});

test('a result rewritten after native completion cannot advance the plan', () => {
  assert.deepEqual(normalizeReceipt('Bash', args, event, { ...result, result: { ...body, stdout: 'changed' } }), { outcome: 'unknown', certified: false });
});

test('partial text reads do not authorize subsequent actions', () => {
  const input = { file_path: '/work/a.txt' };
  const response = { type: 'text', file: { filePath: '/work/a.txt', content: 'one', numLines: 1, startLine: 1, totalLines: 10, truncatedByTokenCap: true } };
  assert.equal(normalizeReceipt('Read', input, { kind: 'success', tool: 'Read', arguments: input, response }, { ref: 1, result: response }).outcome, 'unknown');
});
