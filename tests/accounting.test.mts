import assert from 'node:assert/strict';
import test from 'node:test';
import { Accounting } from '../src/accounting.ts';

const usage = (input: number, output: number, read: number, creation: number) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: creation,
});

test('counts forwarded requests once and sums known usage by cache bucket', () => {
  const accounting = new Accounting();
  accounting.requestStarted('r1');
  accounting.requestStarted('r1');
  accounting.requestFinished('r1', usage(10, 4, 7, 2));
  accounting.requestFinished('r1', usage(900, 900, 900, 900));
  accounting.requestStarted('r2');
  accounting.requestFinished('r2', usage(3, 1, 11, 5));

  assert.deepEqual(accounting.snapshot(), {
    modelRequests: 2,
    authorRequests: 0,
    initialDispatches: 0,
    continuationDispatches: 0,
    certifiedSubstitutions: 0,
    unknownUsageRequests: 0,
    usage: {
      input_tokens: 13,
      output_tokens: 5,
      cache_read_input_tokens: 18,
      cache_creation_input_tokens: 7,
    },
    fallbacks: {},
    outcomes: { succeeded: 0, failed: 0, pending: 0, unknown: 0 },
  });
});

test('keeps started, missing, and partial or invalid usage unknown without partial sums', () => {
  const accounting = new Accounting();
  accounting.requestStarted('pending');
  accounting.requestStarted('missing');
  accounting.requestFinished('missing', undefined);
  accounting.requestStarted('partial');
  accounting.requestFinished('partial', { input_tokens: 8, output_tokens: 2, cache_read_input_tokens: 1 });
  accounting.requestStarted('invalid');
  accounting.requestFinished('invalid', usage(2, -1, 3, 4));
  accounting.requestStarted('valid');
  accounting.requestFinished('valid', usage(5, 6, 7, 8));

  const snapshot = accounting.snapshot();
  assert.equal(snapshot.modelRequests, 5);
  assert.equal(snapshot.unknownUsageRequests, 4);
  assert.deepEqual(snapshot.usage, usage(5, 6, 7, 8));
});

test('counts author responses idempotently and returns detached snapshots', () => {
  const accounting = new Accounting();
  accounting.author('author-1');
  accounting.author('author-1');
  accounting.author('author-2');
  const first = accounting.snapshot();
  first.usage.input_tokens = 99;
  first.outcomes.succeeded = 99;
  assert.equal(accounting.snapshot().authorRequests, 2);
  assert.equal(accounting.snapshot().usage.input_tokens, 0);
  assert.equal(accounting.snapshot().outcomes.succeeded, 0);
});

test('separates unique initial and continuation dispatches; only continuations can be certified', () => {
  const accounting = new Accounting();
  accounting.dispatched({ callId: 'root', initial: true });
  accounting.dispatched({ callId: 'root', initial: false });
  accounting.dispatched({ callId: 'next', initial: false });
  accounting.dispatched({ callId: 'next', initial: false });
  accounting.settled({ callId: 'root', outcome: 'succeeded', certified: true });
  accounting.settled({ callId: 'next', outcome: 'succeeded', certified: true });
  accounting.settled({ callId: 'next', outcome: 'failed', certified: true });

  const snapshot = accounting.snapshot();
  assert.equal(snapshot.initialDispatches, 1);
  assert.equal(snapshot.continuationDispatches, 1);
  assert.equal(snapshot.certifiedSubstitutions, 1);
  assert.deepEqual(snapshot.outcomes, { succeeded: 2, failed: 0, pending: 0, unknown: 0 });
});

test('failed certified execution is a substitution, not task success; pending is nonterminal', () => {
  const accounting = new Accounting();
  accounting.dispatched({ callId: 'step', initial: false });
  accounting.settled({ callId: 'step', outcome: 'pending', certified: true });
  assert.equal(accounting.snapshot().continuationDispatches, 1);
  assert.equal(accounting.snapshot().certifiedSubstitutions, 0);
  accounting.settled({ callId: 'step', outcome: 'failed', certified: true });
  accounting.settled({ callId: 'step', outcome: 'succeeded', certified: true });

  const snapshot = accounting.snapshot();
  assert.equal(snapshot.certifiedSubstitutions, 1);
  assert.equal(snapshot.outcomes.failed, 1);
  assert.equal(snapshot.outcomes.succeeded, 0);
});

test('ignores settlement without a dispatch and counts fallback events by reason', () => {
  const accounting = new Accounting();
  accounting.settled({ callId: 'unknown', outcome: 'succeeded', certified: true });
  accounting.fallback('disabled');
  accounting.fallback('disabled');
  accounting.fallback('incompatible');
  assert.deepEqual(accounting.snapshot().fallbacks, { disabled: 2, incompatible: 1 });
  assert.equal(accounting.snapshot().outcomes.succeeded, 0);
});
