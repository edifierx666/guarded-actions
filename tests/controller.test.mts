// tests/controller.test.mts - Controller state machine tests
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../src/controller.ts';
import type { 
  PlanBinding, 
  NextContext, 
  ControllerDecision,
  Outcome 
} from '../src/controller.ts';
import type { Plan } from '../src/plan.ts';

const testBinding: PlanBinding = {
  planId: 'test-plan-123',
  turnId: 'turn-1',
  cwd: '/workspace',
  authorCallId: 'call_author',
  authorStep: 5
};

const testPlan: Plan = {
  schemaVersion: 1,
  nodes: [
    { id: 'build', after: null, tool: 'Bash', arguments: { command: 'npm run build' }, when: 'start' },
    { id: 'test', after: 'build', tool: 'Bash', arguments: { command: 'npm test' }, when: 'succeeded' }
  ]
};

describe('Controller.stage', () => {
  test('accepts plan when idle', () => {
    const ctrl = new Controller();
    const result = ctrl.stage(testPlan, testBinding);
    assert.equal(result, true);
    assert.equal(ctrl.status().state, 'staged');
  });

  test('rejects when live plan exists', () => {
    const ctrl = new Controller();
    ctrl.stage(testPlan, testBinding);
    const result = ctrl.stage(testPlan, testBinding);
    assert.equal(result, false);
  });

  test('deep copies and freezes node arguments', () => {
    const ctrl = new Controller();
    const mutableArgs = { command: 'test' };
    const plan: Plan = {
      schemaVersion: 1,
      nodes: [
        { id: 'a', after: null, tool: 'Bash', arguments: mutableArgs, when: 'start' },
        { id: 'b', after: 'a', tool: 'Read', arguments: { file_path: '/test' }, when: 'succeeded' }
      ]
    };
    
    ctrl.stage(plan, testBinding);
    ctrl.noteAuthor(testBinding.authorStep, [testBinding.authorCallId], false);
    
    mutableArgs.command = 'hacked';
    
    const ctx: NextContext = { turnId: testBinding.turnId, step: 1, cwd: testBinding.cwd, enabled: true };
    const decision = ctrl.next(ctx);
    
    assert.equal(decision.kind, 'action');
    if (decision.kind === 'action') {
      const args = decision.node.arguments as Record<string, unknown>;
      assert.equal(args.command, 'test');
    }
  });
});

describe('Controller.noteAuthor', () => {
  test('activates when authorStep matches and single call ID matches', () => {
    const ctrl = new Controller();
    ctrl.stage(testPlan, testBinding);
    ctrl.noteAuthor(testBinding.authorStep, [testBinding.authorCallId], false);
    assert.equal(ctrl.status().state, 'ready');
  });

  test('invalidates when authorStep mismatches', () => {
    const ctrl = new Controller();
    ctrl.stage(testPlan, testBinding);
    ctrl.noteAuthor(999, [testBinding.authorCallId], false);
    assert.equal(ctrl.status().state, 'invalidated');
  });

  test('invalidates on mixed output', () => {
    const ctrl = new Controller();
    ctrl.stage(testPlan, testBinding);
    ctrl.noteAuthor(testBinding.authorStep, [testBinding.authorCallId, 'other_call'], false);
    assert.equal(ctrl.status().state, 'invalidated');
  });

  test('invalidates when aborted', () => {
    const ctrl = new Controller();
    ctrl.stage(testPlan, testBinding);
    ctrl.noteAuthor(testBinding.authorStep, [testBinding.authorCallId], true);
    assert.equal(ctrl.status().state, 'invalidated');
  });

  test('ignores when not staged', () => {
    const ctrl = new Controller();
    ctrl.noteAuthor(testBinding.authorStep, [testBinding.authorCallId], false);
    assert.equal(ctrl.status().state, 'idle');
  });
});

describe('Controller.next', () => {
  test('defers when disabled and invalidates live plan', () => {
    const ctrl = new Controller();
    ctrl.stage(testPlan, testBinding);
    ctrl.noteAuthor(testBinding.authorStep, [testBinding.authorCallId], false);
    
    const ctx: NextContext = { turnId: testBinding.turnId, step: 1, cwd: testBinding.cwd, enabled: false };
    const decision = ctrl.next(ctx);
    
    assert.equal(decision.kind, 'defer');
    assert.equal(ctrl.status().state, 'invalidated');
  });

  test('detects duplicate step and invalidates', () => {
    const ctrl = new Controller();
    ctrl.stage(testPlan, testBinding);
    ctrl.noteAuthor(testBinding.authorStep, [testBinding.authorCallId], false);
    
    const ctx: NextContext = { turnId: testBinding.turnId, step: 1, cwd: testBinding.cwd, enabled: true };
    ctrl.next(ctx);
    
    const decision2 = ctrl.next(ctx);
    assert.equal(decision2.kind, 'defer');
    assert.equal(ctrl.status().state, 'invalidated');
  });

  test('invalidates on turn change', () => {
    const ctrl = new Controller();
    ctrl.stage(testPlan, testBinding);
    ctrl.noteAuthor(testBinding.authorStep, [testBinding.authorCallId], false);
    
    const ctx: NextContext = { turnId: 'different-turn', step: 1, cwd: testBinding.cwd, enabled: true };
    const decision = ctrl.next(ctx);
    
    assert.equal(decision.kind, 'defer');
    assert.equal(ctrl.status().state, 'invalidated');
  });

  test('invalidates on cwd change', () => {
    const ctrl = new Controller();
    ctrl.stage(testPlan, testBinding);
    ctrl.noteAuthor(testBinding.authorStep, [testBinding.authorCallId], false);
    
    const ctx: NextContext = { turnId: testBinding.turnId, step: 1, cwd: '/other', enabled: true };
    const decision = ctrl.next(ctx);
    
    assert.equal(decision.kind, 'defer');
    assert.equal(ctrl.status().state, 'invalidated');
  });

  test('dispatches root node as initial', () => {
    const ctrl = new Controller();
    ctrl.stage(testPlan, testBinding);
    ctrl.noteAuthor(testBinding.authorStep, [testBinding.authorCallId], false);
    
    const ctx: NextContext = { turnId: testBinding.turnId, step: 1, cwd: testBinding.cwd, enabled: true };
    const decision = ctrl.next(ctx);
    
    assert.equal(decision.kind, 'action');
    if (decision.kind === 'action') {
      assert.equal(decision.node.id, 'build');
      assert.equal(decision.initial, true);
      assert.match(decision.callId, /^ga_/);
      assert.equal(ctrl.status().state, 'in_flight');
    }
  });

  test('marks node in_flight before returning', () => {
    const ctrl = new Controller();
    ctrl.stage(testPlan, testBinding);
    ctrl.noteAuthor(testBinding.authorStep, [testBinding.authorCallId], false);
    
    const ctx: NextContext = { turnId: testBinding.turnId, step: 1, cwd: testBinding.cwd, enabled: true };
    const decision = ctrl.next(ctx);
    
    assert.equal(decision.kind, 'action');
    const status = ctrl.status();
    const node = status.nodes.find(n => n.id === 'build');
    assert.equal(node?.state, 'in_flight');
  });

  test('invalidates on missing receipt from in_flight node', () => {
    const ctrl = new Controller();
    ctrl.stage(testPlan, testBinding);
    ctrl.noteAuthor(testBinding.authorStep, [testBinding.authorCallId], false);
    
    const ctx1: NextContext = { turnId: testBinding.turnId, step: 1, cwd: testBinding.cwd, enabled: true };
    ctrl.next(ctx1);
    
    const ctx2: NextContext = { turnId: testBinding.turnId, step: 2, cwd: testBinding.cwd, enabled: true };
    const decision2 = ctrl.next(ctx2);
    assert.equal(decision2.kind, 'defer');
    assert.equal(ctrl.status().state, 'invalidated');
  });

  test('invalidates on ambiguous branch', () => {
    const ambiguousPlan: Plan = {
      schemaVersion: 1,
      nodes: [
        { id: 'root', after: null, tool: 'Read', arguments: { file_path: '/test' }, when: 'start' },
        { id: 'a', after: 'root', tool: 'Read', arguments: { file_path: '/a' }, when: 'succeeded' },
        { id: 'b', after: 'root', tool: 'Read', arguments: { file_path: '/b' }, when: 'succeeded' }
      ]
    };
    
    const ctrl = new Controller();
    ctrl.stage(ambiguousPlan, testBinding);
    ctrl.noteAuthor(testBinding.authorStep, [testBinding.authorCallId], false);
    
    const ctx1: NextContext = { turnId: testBinding.turnId, step: 1, cwd: testBinding.cwd, enabled: true };
    const decision1 = ctrl.next(ctx1);
    assert.equal(decision1.kind, 'action');
    
    if (decision1.kind === 'action') {
      ctrl.receipt(decision1.callId, 'Read', { file_path: '/test' }, 'succeeded');
    }
    
    const ctx2: NextContext = { turnId: testBinding.turnId, step: 2, cwd: testBinding.cwd, enabled: true };
    const decision2 = ctrl.next(ctx2);
    assert.equal(decision2.kind, 'defer');
    assert.equal(ctrl.status().state, 'invalidated');
  });
});

describe('Controller.receipt', () => {
  test('rejects unknown callId', () => {
    const ctrl = new Controller();
    const result = ctrl.receipt('unknown', 'Bash', { command: 'test' }, 'succeeded');
    assert.equal(result.matched, false);
    assert.equal(result.accepted, false);
  });

  test('rejects when node not in_flight', () => {
    const ctrl = new Controller();
    ctrl.stage(testPlan, testBinding);
    ctrl.noteAuthor(testBinding.authorStep, [testBinding.authorCallId], false);
    
    const ctx: NextContext = { turnId: testBinding.turnId, step: 1, cwd: testBinding.cwd, enabled: true };
    const decision = ctrl.next(ctx);
    
    if (decision.kind === 'action') {
      ctrl.receipt(decision.callId, 'Bash', { command: 'npm run build' }, 'succeeded');
      const result2 = ctrl.receipt(decision.callId, 'Bash', { command: 'npm run build' }, 'succeeded');
      
      assert.equal(result2.matched, true);
      assert.equal(result2.accepted, false);
    }
  });

  test('invalidates on tool mismatch', () => {
    const ctrl = new Controller();
    ctrl.stage(testPlan, testBinding);
    ctrl.noteAuthor(testBinding.authorStep, [testBinding.authorCallId], false);
    
    const ctx: NextContext = { turnId: testBinding.turnId, step: 1, cwd: testBinding.cwd, enabled: true };
    const decision = ctrl.next(ctx);
    
    if (decision.kind === 'action') {
      const result = ctrl.receipt(decision.callId, 'Read', { command: 'npm run build' }, 'succeeded');
      assert.equal(result.accepted, false);
      assert.equal(ctrl.status().state, 'invalidated');
    }
  });

  test('invalidates on args mismatch', () => {
    const ctrl = new Controller();
    ctrl.stage(testPlan, testBinding);
    ctrl.noteAuthor(testBinding.authorStep, [testBinding.authorCallId], false);
    
    const ctx: NextContext = { turnId: testBinding.turnId, step: 1, cwd: testBinding.cwd, enabled: true };
    const decision = ctrl.next(ctx);
    
    if (decision.kind === 'action') {
      const result = ctrl.receipt(decision.callId, 'Bash', { command: 'different' }, 'succeeded');
      assert.equal(result.accepted, false);
      assert.equal(ctrl.status().state, 'invalidated');
    }
  });

  test('accepts success and marks node succeeded', () => {
    const ctrl = new Controller();
    ctrl.stage(testPlan, testBinding);
    ctrl.noteAuthor(testBinding.authorStep, [testBinding.authorCallId], false);
    
    const ctx: NextContext = { turnId: testBinding.turnId, step: 1, cwd: testBinding.cwd, enabled: true };
    const decision = ctrl.next(ctx);
    
    if (decision.kind === 'action') {
      const result = ctrl.receipt(decision.callId, 'Bash', { command: 'npm run build' }, 'succeeded');
      assert.equal(result.accepted, true);
      assert.equal(result.initial, true);
      
      const status = ctrl.status();
      const node = status.nodes.find(n => n.id === 'build');
      assert.equal(node?.state, 'succeeded');
    }
  });

  test('sets completed after final success', () => {
    const ctrl = new Controller();
    ctrl.stage(testPlan, testBinding);
    ctrl.noteAuthor(testBinding.authorStep, [testBinding.authorCallId], false);
    
    const ctx1: NextContext = { turnId: testBinding.turnId, step: 1, cwd: testBinding.cwd, enabled: true };
    const decision1 = ctrl.next(ctx1);
    
    if (decision1.kind === 'action') {
      ctrl.receipt(decision1.callId, 'Bash', { command: 'npm run build' }, 'succeeded');
    }
    
    const ctx2: NextContext = { turnId: testBinding.turnId, step: 2, cwd: testBinding.cwd, enabled: true };
    const decision2 = ctrl.next(ctx2);
    
    if (decision2.kind === 'action') {
      ctrl.receipt(decision2.callId, 'Bash', { command: 'npm test' }, 'succeeded');
    }
    
    assert.equal(ctrl.status().state, 'completed');
  });

  test('marks pending as unknown and invalidates', () => {
    const ctrl = new Controller();
    ctrl.stage(testPlan, testBinding);
    ctrl.noteAuthor(testBinding.authorStep, [testBinding.authorCallId], false);
    
    const ctx: NextContext = { turnId: testBinding.turnId, step: 1, cwd: testBinding.cwd, enabled: true };
    const decision = ctrl.next(ctx);
    
    if (decision.kind === 'action') {
      ctrl.receipt(decision.callId, 'Bash', { command: 'npm run build' }, 'pending');
      
      const status = ctrl.status();
      const node = status.nodes.find(n => n.id === 'build');
      assert.equal(node?.state, 'unknown');
      assert.equal(status.state, 'invalidated');
    }
  });

  test('marks failed and skips remaining', () => {
    const ctrl = new Controller();
    ctrl.stage(testPlan, testBinding);
    ctrl.noteAuthor(testBinding.authorStep, [testBinding.authorCallId], false);
    
    const ctx: NextContext = { turnId: testBinding.turnId, step: 1, cwd: testBinding.cwd, enabled: true };
    const decision = ctrl.next(ctx);
    
    if (decision.kind === 'action') {
      ctrl.receipt(decision.callId, 'Bash', { command: 'npm run build' }, 'failed');
      
      const status = ctrl.status();
      const buildNode = status.nodes.find(n => n.id === 'build');
      const testNode = status.nodes.find(n => n.id === 'test');
      
      assert.equal(buildNode?.state, 'failed');
      assert.equal(testNode?.state, 'skipped');
      assert.equal(status.state, 'invalidated');
    }
  });

  test('marks unknown and skips remaining', () => {
    const ctrl = new Controller();
    ctrl.stage(testPlan, testBinding);
    ctrl.noteAuthor(testBinding.authorStep, [testBinding.authorCallId], false);
    
    const ctx: NextContext = { turnId: testBinding.turnId, step: 1, cwd: testBinding.cwd, enabled: true };
    const decision = ctrl.next(ctx);
    
    if (decision.kind === 'action') {
      ctrl.receipt(decision.callId, 'Bash', { command: 'npm run build' }, 'unknown');
      
      const status = ctrl.status();
      const buildNode = status.nodes.find(n => n.id === 'build');
      const testNode = status.nodes.find(n => n.id === 'test');
      
      assert.equal(buildNode?.state, 'unknown');
      assert.equal(testNode?.state, 'skipped');
      assert.equal(status.state, 'invalidated');
    }
  });

  test('continuation not marked as initial', () => {
    const ctrl = new Controller();
    ctrl.stage(testPlan, testBinding);
    ctrl.noteAuthor(testBinding.authorStep, [testBinding.authorCallId], false);
    
    const ctx1: NextContext = { turnId: testBinding.turnId, step: 1, cwd: testBinding.cwd, enabled: true };
    const decision1 = ctrl.next(ctx1);
    
    if (decision1.kind === 'action') {
      ctrl.receipt(decision1.callId, 'Bash', { command: 'npm run build' }, 'succeeded');
    }
    
    const ctx2: NextContext = { turnId: testBinding.turnId, step: 2, cwd: testBinding.cwd, enabled: true };
    const decision2 = ctrl.next(ctx2);
    
    if (decision2.kind === 'action') {
      const result = ctrl.receipt(decision2.callId, 'Bash', { command: 'npm test' }, 'succeeded');
      assert.equal(result.initial, false);
    }
  });
});

describe('Controller.invalidate', () => {
  test('does not reopen finished nodes', () => {
    const ctrl = new Controller();
    ctrl.stage(testPlan, testBinding);
    ctrl.noteAuthor(testBinding.authorStep, [testBinding.authorCallId], false);
    
    const ctx: NextContext = { turnId: testBinding.turnId, step: 1, cwd: testBinding.cwd, enabled: true };
    const decision = ctrl.next(ctx);
    
    if (decision.kind === 'action') {
      ctrl.receipt(decision.callId, 'Bash', { command: 'npm run build' }, 'succeeded');
    }
    
    ctrl.invalidate('test_reason');
    
    const status = ctrl.status();
    const buildNode = status.nodes.find(n => n.id === 'build');
    assert.equal(buildNode?.state, 'succeeded');
  });

  test('marks pending as skipped', () => {
    const ctrl = new Controller();
    ctrl.stage(testPlan, testBinding);
    ctrl.noteAuthor(testBinding.authorStep, [testBinding.authorCallId], false);
    
    ctrl.invalidate('test_reason');
    
    const status = ctrl.status();
    const buildNode = status.nodes.find(n => n.id === 'build');
    const testNode = status.nodes.find(n => n.id === 'test');
    
    assert.equal(buildNode?.state, 'skipped');
    assert.equal(testNode?.state, 'skipped');
  });

  test('marks in_flight as unknown', () => {
    const ctrl = new Controller();
    ctrl.stage(testPlan, testBinding);
    ctrl.noteAuthor(testBinding.authorStep, [testBinding.authorCallId], false);
    
    const ctx: NextContext = { turnId: testBinding.turnId, step: 1, cwd: testBinding.cwd, enabled: true };
    ctrl.next(ctx);
    
    ctrl.invalidate('test_reason');
    
    const status = ctrl.status();
    const buildNode = status.nodes.find(n => n.id === 'build');
    assert.equal(buildNode?.state, 'unknown');
  });

  test('preserves completed state', () => {
    const ctrl = new Controller();
    ctrl.stage(testPlan, testBinding);
    ctrl.noteAuthor(testBinding.authorStep, [testBinding.authorCallId], false);
    
    const ctx1: NextContext = { turnId: testBinding.turnId, step: 1, cwd: testBinding.cwd, enabled: true };
    const decision1 = ctrl.next(ctx1);
    if (decision1.kind === 'action') {
      ctrl.receipt(decision1.callId, 'Bash', { command: 'npm run build' }, 'succeeded');
    }
    
    const ctx2: NextContext = { turnId: testBinding.turnId, step: 2, cwd: testBinding.cwd, enabled: true };
    const decision2 = ctrl.next(ctx2);
    if (decision2.kind === 'action') {
      ctrl.receipt(decision2.callId, 'Bash', { command: 'npm test' }, 'succeeded');
    }
    
    assert.equal(ctrl.status().state, 'completed');
    
    ctrl.invalidate('late_invalidation');
    assert.equal(ctrl.status().state, 'completed');
  });
});

describe('Controller integration', () => {
  test('full success flow', () => {
    const ctrl = new Controller();
    
    assert.equal(ctrl.stage(testPlan, testBinding), true);
    ctrl.noteAuthor(testBinding.authorStep, [testBinding.authorCallId], false);
    
    const ctx1: NextContext = { turnId: testBinding.turnId, step: 1, cwd: testBinding.cwd, enabled: true };
    const d1 = ctrl.next(ctx1);
    assert.equal(d1.kind, 'action');
    if (d1.kind === 'action') {
      assert.equal(d1.node.id, 'build');
      ctrl.receipt(d1.callId, 'Bash', { command: 'npm run build' }, 'succeeded');
    }
    
    const ctx2: NextContext = { turnId: testBinding.turnId, step: 2, cwd: testBinding.cwd, enabled: true };
    const d2 = ctrl.next(ctx2);
    assert.equal(d2.kind, 'action');
    if (d2.kind === 'action') {
      assert.equal(d2.node.id, 'test');
      ctrl.receipt(d2.callId, 'Bash', { command: 'npm test' }, 'succeeded');
    }
    
    assert.equal(ctrl.status().state, 'completed');
    
    const ctx3: NextContext = { turnId: testBinding.turnId, step: 3, cwd: testBinding.cwd, enabled: true };
    const d3 = ctrl.next(ctx3);
    assert.equal(d3.kind, 'defer');
  });

  test('failure stops execution', () => {
    const ctrl = new Controller();
    ctrl.stage(testPlan, testBinding);
    ctrl.noteAuthor(testBinding.authorStep, [testBinding.authorCallId], false);
    
    const ctx1: NextContext = { turnId: testBinding.turnId, step: 1, cwd: testBinding.cwd, enabled: true };
    const d1 = ctrl.next(ctx1);
    if (d1.kind === 'action') {
      ctrl.receipt(d1.callId, 'Bash', { command: 'npm run build' }, 'failed');
    }
    
    const status = ctrl.status();
    assert.equal(status.state, 'invalidated');
    const testNode = status.nodes.find(n => n.id === 'test');
    assert.equal(testNode?.state, 'skipped');
  });
});
