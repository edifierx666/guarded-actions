// tests/plan.test.mts - Plan validation tests
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePlan, stableJson } from '../src/plan.ts';

describe('validatePlan', () => {
  test('rejects non-object input', () => {
    const result = validatePlan(null);
    assert.equal(result.ok, false);
  });

  test('rejects wrong schemaVersion', () => {
    const result = validatePlan({ schemaVersion: 2, nodes: [] });
    assert.equal(result.ok, false);
  });

  test('rejects extra top-level properties', () => {
    const result = validatePlan({
      schemaVersion: 1,
      nodes: [
        { id: 'a', after: null, tool: 'Read', arguments: { file_path: '/test' }, when: 'start' },
        { id: 'b', after: 'a', tool: 'Read', arguments: { file_path: '/test2' }, when: 'succeeded' }
      ],
      extra: 'field'
    });
    assert.equal(result.ok, false);
  });

  test('rejects non-array nodes', () => {
    const result = validatePlan({ schemaVersion: 1, nodes: 'not-array' });
    assert.equal(result.ok, false);
  });

  test('rejects too few nodes', () => {
    const result = validatePlan({ schemaVersion: 1, nodes: [{ id: 'a', after: null, tool: 'Read', arguments: { file_path: '/test' }, when: 'start' }] });
    assert.equal(result.ok, false);
  });

  test('rejects too many nodes', () => {
    const nodes = Array.from({ length: 9 }, (_, i) => ({
      id: `node${i}`,
      after: i === 0 ? null : `node${i - 1}`,
      tool: 'Read',
      arguments: { file_path: '/test' },
      when: i === 0 ? 'start' : 'succeeded'
    }));
    const result = validatePlan({ schemaVersion: 1, nodes });
    assert.equal(result.ok, false);
  });

  test('rejects duplicate node IDs', () => {
    const result = validatePlan({
      schemaVersion: 1,
      nodes: [
        { id: 'a', after: null, tool: 'Read', arguments: { file_path: '/test1' }, when: 'start' },
        { id: 'a', after: 'a', tool: 'Read', arguments: { file_path: '/test2' }, when: 'succeeded' }
      ]
    });
    assert.equal(result.ok, false);
  });

  test('rejects invalid ID format', () => {
    const result = validatePlan({
      schemaVersion: 1,
      nodes: [
        { id: 'invalid id!', after: null, tool: 'Read', arguments: { file_path: '/test' }, when: 'start' },
        { id: 'b', after: 'invalid id!', tool: 'Read', arguments: { file_path: '/test' }, when: 'succeeded' }
      ]
    });
    assert.equal(result.ok, false);
  });

  test('rejects prototype keys in node properties', () => {
    const result = validatePlan({
      schemaVersion: 1,
      nodes: [
        { id: 'a', after: null, tool: 'Read', arguments: { file_path: '/test' }, when: 'start', ['__proto__']: {} },
        { id: 'b', after: 'a', tool: 'Read', arguments: { file_path: '/test2' }, when: 'succeeded' }
      ]
    });
    assert.equal(result.ok, false);
  });

  test('rejects prototype keys in Read arguments', () => {
    const result = validatePlan({
      schemaVersion: 1,
      nodes: [
        { id: 'a', after: null, tool: 'Read', arguments: { file_path: '/test', constructor: {} }, when: 'start' },
        { id: 'b', after: 'a', tool: 'Read', arguments: { file_path: '/test2' }, when: 'succeeded' }
      ]
    });
    assert.equal(result.ok, false);
  });

  test('rejects prototype keys in Bash arguments', () => {
    const result = validatePlan({
      schemaVersion: 1,
      nodes: [
        { id: 'a', after: null, tool: 'Bash', arguments: { command: 'test', toString: 'hack' }, when: 'start' },
        { id: 'b', after: 'a', tool: 'Bash', arguments: { command: 'test2' }, when: 'succeeded' }
      ]
    });
    assert.equal(result.ok, false);
  });

  test('rejects root node without after=null', () => {
    const result = validatePlan({
      schemaVersion: 1,
      nodes: [
        { id: 'a', after: 'x', tool: 'Read', arguments: { file_path: '/test' }, when: 'start' },
        { id: 'b', after: 'a', tool: 'Read', arguments: { file_path: '/test' }, when: 'succeeded' }
      ]
    });
    assert.equal(result.ok, false);
  });

  test('rejects root node with when=succeeded', () => {
    const result = validatePlan({
      schemaVersion: 1,
      nodes: [
        { id: 'a', after: null, tool: 'Read', arguments: { file_path: '/test' }, when: 'succeeded' },
        { id: 'b', after: 'a', tool: 'Read', arguments: { file_path: '/test' }, when: 'succeeded' }
      ]
    });
    assert.equal(result.ok, false);
  });

  test('rejects non-root node with after=null', () => {
    const result = validatePlan({
      schemaVersion: 1,
      nodes: [
        { id: 'a', after: null, tool: 'Read', arguments: { file_path: '/test' }, when: 'start' },
        { id: 'b', after: null, tool: 'Read', arguments: { file_path: '/test' }, when: 'start' }
      ]
    });
    assert.equal(result.ok, false);
  });

  test('rejects non-root node with when=start', () => {
    const result = validatePlan({
      schemaVersion: 1,
      nodes: [
        { id: 'a', after: null, tool: 'Read', arguments: { file_path: '/test' }, when: 'start' },
        { id: 'b', after: 'a', tool: 'Read', arguments: { file_path: '/test' }, when: 'start' }
      ]
    });
    assert.equal(result.ok, false);
  });

  test('rejects dependency on unknown node', () => {
    const result = validatePlan({
      schemaVersion: 1,
      nodes: [
        { id: 'a', after: null, tool: 'Read', arguments: { file_path: '/test' }, when: 'start' },
        { id: 'b', after: 'unknown', tool: 'Read', arguments: { file_path: '/test' }, when: 'succeeded' }
      ]
    });
    assert.equal(result.ok, false);
  });

  test('rejects dependency on non-earlier node', () => {
    const result = validatePlan({
      schemaVersion: 1,
      nodes: [
        { id: 'a', after: null, tool: 'Read', arguments: { file_path: '/test' }, when: 'start' },
        { id: 'b', after: 'c', tool: 'Read', arguments: { file_path: '/test' }, when: 'succeeded' },
        { id: 'c', after: 'a', tool: 'Read', arguments: { file_path: '/test' }, when: 'succeeded' }
      ]
    });
    assert.equal(result.ok, false);
  });

  test('rejects cycle', () => {
    const result = validatePlan({
      schemaVersion: 1,
      nodes: [
        { id: 'a', after: null, tool: 'Read', arguments: { file_path: '/test' }, when: 'start' },
        { id: 'b', after: 'b', tool: 'Read', arguments: { file_path: '/test' }, when: 'succeeded' }
      ]
    });
    assert.equal(result.ok, false);
  });

  test('rejects unsupported tool', () => {
    const result = validatePlan({
      schemaVersion: 1,
      nodes: [
        { id: 'a', after: null, tool: 'Write', arguments: {}, when: 'start' },
        { id: 'b', after: 'a', tool: 'Read', arguments: { file_path: '/test' }, when: 'succeeded' }
      ]
    });
    assert.equal(result.ok, false);
  });

  test('rejects Read without file_path', () => {
    const result = validatePlan({
      schemaVersion: 1,
      nodes: [
        { id: 'a', after: null, tool: 'Read', arguments: {}, when: 'start' },
        { id: 'b', after: 'a', tool: 'Read', arguments: { file_path: '/test' }, when: 'succeeded' }
      ]
    });
    assert.equal(result.ok, false);
  });

  test('rejects Read with empty file_path', () => {
    const result = validatePlan({
      schemaVersion: 1,
      nodes: [
        { id: 'a', after: null, tool: 'Read', arguments: { file_path: '' }, when: 'start' },
        { id: 'b', after: 'a', tool: 'Read', arguments: { file_path: '/test' }, when: 'succeeded' }
      ]
    });
    assert.equal(result.ok, false);
  });

  test('rejects Read with relative path', () => {
    const result = validatePlan({
      schemaVersion: 1,
      nodes: [
        { id: 'a', after: null, tool: 'Read', arguments: { file_path: 'relative/path' }, when: 'start' },
        { id: 'b', after: 'a', tool: 'Read', arguments: { file_path: '/test' }, when: 'succeeded' }
      ]
    });
    assert.equal(result.ok, false);
  });

  test('accepts Read with absolute Unix path', () => {
    const result = validatePlan({
      schemaVersion: 1,
      nodes: [
        { id: 'a', after: null, tool: 'Read', arguments: { file_path: '/absolute/path' }, when: 'start' },
        { id: 'b', after: 'a', tool: 'Read', arguments: { file_path: '/test' }, when: 'succeeded' }
      ]
    });
    assert.equal(result.ok, true);
  });

  test('accepts Read with absolute Windows path', () => {
    const result = validatePlan({
      schemaVersion: 1,
      nodes: [
        { id: 'a', after: null, tool: 'Read', arguments: { file_path: 'C:/Windows/path' }, when: 'start' },
        { id: 'b', after: 'a', tool: 'Read', arguments: { file_path: '/test' }, when: 'succeeded' }
      ]
    });
    assert.equal(result.ok, true);
  });

  test('rejects Read with invalid offset', () => {
    const result = validatePlan({
      schemaVersion: 1,
      nodes: [
        { id: 'a', after: null, tool: 'Read', arguments: { file_path: '/test', offset: 0 }, when: 'start' },
        { id: 'b', after: 'a', tool: 'Read', arguments: { file_path: '/test' }, when: 'succeeded' }
      ]
    });
    assert.equal(result.ok, false);
  });

  test('accepts Read with valid offset', () => {
    const result = validatePlan({
      schemaVersion: 1,
      nodes: [
        { id: 'a', after: null, tool: 'Read', arguments: { file_path: '/test', offset: 100 }, when: 'start' },
        { id: 'b', after: 'a', tool: 'Read', arguments: { file_path: '/test' }, when: 'succeeded' }
      ]
    });
    assert.equal(result.ok, true);
  });

  test('rejects Read with invalid limit', () => {
    const result = validatePlan({
      schemaVersion: 1,
      nodes: [
        { id: 'a', after: null, tool: 'Read', arguments: { file_path: '/test', limit: -1 }, when: 'start' },
        { id: 'b', after: 'a', tool: 'Read', arguments: { file_path: '/test' }, when: 'succeeded' }
      ]
    });
    assert.equal(result.ok, false);
  });

  test('accepts Read with valid limit', () => {
    const result = validatePlan({
      schemaVersion: 1,
      nodes: [
        { id: 'a', after: null, tool: 'Read', arguments: { file_path: '/test', limit: 50 }, when: 'start' },
        { id: 'b', after: 'a', tool: 'Read', arguments: { file_path: '/test' }, when: 'succeeded' }
      ]
    });
    assert.equal(result.ok, true);
  });

  test('rejects Read with empty pages', () => {
    const result = validatePlan({
      schemaVersion: 1,
      nodes: [
        { id: 'a', after: null, tool: 'Read', arguments: { file_path: '/test', pages: '' }, when: 'start' },
        { id: 'b', after: 'a', tool: 'Read', arguments: { file_path: '/test' }, when: 'succeeded' }
      ]
    });
    assert.equal(result.ok, false);
  });

  test('accepts Read with valid pages', () => {
    const result = validatePlan({
      schemaVersion: 1,
      nodes: [
        { id: 'a', after: null, tool: 'Read', arguments: { file_path: '/test.pdf', pages: '1-5' }, when: 'start' },
        { id: 'b', after: 'a', tool: 'Read', arguments: { file_path: '/test' }, when: 'succeeded' }
      ]
    });
    assert.equal(result.ok, true);
  });

  test('rejects Read with non-boolean allow_large', () => {
    const result = validatePlan({
      schemaVersion: 1,
      nodes: [
        { id: 'a', after: null, tool: 'Read', arguments: { file_path: '/test', allow_large: 'yes' }, when: 'start' },
        { id: 'b', after: 'a', tool: 'Read', arguments: { file_path: '/test' }, when: 'succeeded' }
      ]
    });
    assert.equal(result.ok, false);
  });

  test('accepts Read with allow_large false', () => {
    const result = validatePlan({
      schemaVersion: 1,
      nodes: [
        { id: 'a', after: null, tool: 'Read', arguments: { file_path: '/test', allow_large: false }, when: 'start' },
        { id: 'b', after: 'a', tool: 'Read', arguments: { file_path: '/test' }, when: 'succeeded' }
      ]
    });
    assert.equal(result.ok, true);
  });

  test('accepts Read with allow_large true', () => {
    const result = validatePlan({
      schemaVersion: 1,
      nodes: [
        { id: 'a', after: null, tool: 'Read', arguments: { file_path: '/large', allow_large: true }, when: 'start' },
        { id: 'b', after: 'a', tool: 'Read', arguments: { file_path: '/test' }, when: 'succeeded' }
      ]
    });
    assert.equal(result.ok, true);
  });

  test('rejects Read with unexpected argument', () => {
    const result = validatePlan({
      schemaVersion: 1,
      nodes: [
        { id: 'a', after: null, tool: 'Read', arguments: { file_path: '/test', extra: 'bad' }, when: 'start' },
        { id: 'b', after: 'a', tool: 'Read', arguments: { file_path: '/test' }, when: 'succeeded' }
      ]
    });
    assert.equal(result.ok, false);
  });

  test('rejects Bash without command', () => {
    const result = validatePlan({
      schemaVersion: 1,
      nodes: [
        { id: 'a', after: null, tool: 'Bash', arguments: {}, when: 'start' },
        { id: 'b', after: 'a', tool: 'Read', arguments: { file_path: '/test' }, when: 'succeeded' }
      ]
    });
    assert.equal(result.ok, false);
  });

  test('rejects Bash with empty command', () => {
    const result = validatePlan({
      schemaVersion: 1,
      nodes: [
        { id: 'a', after: null, tool: 'Bash', arguments: { command: '' }, when: 'start' },
        { id: 'b', after: 'a', tool: 'Read', arguments: { file_path: '/test' }, when: 'succeeded' }
      ]
    });
    assert.equal(result.ok, false);
  });

  test('rejects Bash with non-string description', () => {
    const result = validatePlan({
      schemaVersion: 1,
      nodes: [
        { id: 'a', after: null, tool: 'Bash', arguments: { command: 'echo test', description: 123 }, when: 'start' },
        { id: 'b', after: 'a', tool: 'Read', arguments: { file_path: '/test' }, when: 'succeeded' }
      ]
    });
    assert.equal(result.ok, false);
  });

  test('accepts Bash with valid description', () => {
    const result = validatePlan({
      schemaVersion: 1,
      nodes: [
        { id: 'build', after: null, tool: 'Bash', arguments: { command: 'npm run build', description: 'Build project' }, when: 'start' },
        { id: 'test', after: 'build', tool: 'Bash', arguments: { command: 'npm test' }, when: 'succeeded' }
      ]
    });
    assert.equal(result.ok, true);
  });

  test('rejects Bash with invalid timeout', () => {
    const result = validatePlan({
      schemaVersion: 1,
      nodes: [
        { id: 'a', after: null, tool: 'Bash', arguments: { command: 'sleep 1000', timeout: 700000 }, when: 'start' },
        { id: 'b', after: 'a', tool: 'Read', arguments: { file_path: '/test' }, when: 'succeeded' }
      ]
    });
    assert.equal(result.ok, false);
  });

  test('accepts Bash with valid timeout', () => {
    const result = validatePlan({
      schemaVersion: 1,
      nodes: [
        { id: 'build', after: null, tool: 'Bash', arguments: { command: 'npm run build', timeout: 120000 }, when: 'start' },
        { id: 'test', after: 'build', tool: 'Bash', arguments: { command: 'npm test', timeout: 60000 }, when: 'succeeded' }
      ]
    });
    assert.equal(result.ok, true);
  });

  test('rejects Bash with run_in_background=true', () => {
    const result = validatePlan({
      schemaVersion: 1,
      nodes: [
        { id: 'a', after: null, tool: 'Bash', arguments: { command: 'bg-task', run_in_background: true }, when: 'start' },
        { id: 'b', after: 'a', tool: 'Read', arguments: { file_path: '/test' }, when: 'succeeded' }
      ]
    });
    assert.equal(result.ok, false);
  });

  test('accepts Bash with run_in_background=false', () => {
    const result = validatePlan({
      schemaVersion: 1,
      nodes: [
        { id: 'a', after: null, tool: 'Bash', arguments: { command: 'test', run_in_background: false }, when: 'start' },
        { id: 'b', after: 'a', tool: 'Read', arguments: { file_path: '/test' }, when: 'succeeded' }
      ]
    });
    assert.equal(result.ok, true);
  });

  test('rejects Bash with dangerouslyDisableSandbox=true', () => {
    const result = validatePlan({
      schemaVersion: 1,
      nodes: [
        { id: 'a', after: null, tool: 'Bash', arguments: { command: 'rm -rf /', dangerouslyDisableSandbox: true }, when: 'start' },
        { id: 'b', after: 'a', tool: 'Read', arguments: { file_path: '/test' }, when: 'succeeded' }
      ]
    });
    assert.equal(result.ok, false);
  });

  test('accepts Bash with dangerouslyDisableSandbox=false', () => {
    const result = validatePlan({
      schemaVersion: 1,
      nodes: [
        { id: 'a', after: null, tool: 'Bash', arguments: { command: 'ls', dangerouslyDisableSandbox: false }, when: 'start' },
        { id: 'b', after: 'a', tool: 'Read', arguments: { file_path: '/test' }, when: 'succeeded' }
      ]
    });
    assert.equal(result.ok, true);
  });

  test('rejects Bash with unexpected argument', () => {
    const result = validatePlan({
      schemaVersion: 1,
      nodes: [
        { id: 'a', after: null, tool: 'Bash', arguments: { command: 'test', cwd: '/bad' }, when: 'start' },
        { id: 'b', after: 'a', tool: 'Read', arguments: { file_path: '/test' }, when: 'succeeded' }
      ]
    });
    assert.equal(result.ok, false);
  });

  test('rejects plan exceeding size limit', () => {
    const longString = 'x'.repeat(10000);
    const result = validatePlan({
      schemaVersion: 1,
      nodes: [
        { id: 'a', after: null, tool: 'Bash', arguments: { command: longString }, when: 'start' },
        { id: 'b', after: 'a', tool: 'Bash', arguments: { command: longString }, when: 'succeeded' }
      ]
    });
    assert.equal(result.ok, false);
  });

  test('accepts valid multi-node plan', () => {
    const result = validatePlan({
      schemaVersion: 1,
      nodes: [
        { id: 'read', after: null, tool: 'Read', arguments: { file_path: '/config.json' }, when: 'start' },
        { id: 'build', after: 'read', tool: 'Bash', arguments: { command: 'npm run build', timeout: 120000 }, when: 'succeeded' },
        { id: 'test', after: 'build', tool: 'Bash', arguments: { command: 'npm test', timeout: 60000 }, when: 'succeeded' },
        { id: 'check', after: 'test', tool: 'Read', arguments: { file_path: '/dist/output.js' }, when: 'succeeded' }
      ]
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.plan.nodes.length, 4);
      assert.equal(result.plan.nodes[0].id, 'read');
      assert.equal(result.plan.nodes[3].id, 'check');
    }
  });

  test('returns immutable plan', () => {
    const input = {
      schemaVersion: 1,
      nodes: [
        { id: 'a', after: null, tool: 'Read', arguments: { file_path: '/test' }, when: 'start' },
        { id: 'b', after: 'a', tool: 'Read', arguments: { file_path: '/test' }, when: 'succeeded' }
      ]
    };
    const result = validatePlan(input);
    assert.equal(result.ok, true);
    if (result.ok) {
      input.nodes[0].id = 'modified';
      const inputArgs = input.nodes[0].arguments as Record<string, unknown>;
      inputArgs.file_path = '/hacked';
      
      assert.equal(result.plan.nodes[0].id, 'a');
      const planArgs = result.plan.nodes[0].arguments as Record<string, unknown>;
      assert.equal(planArgs.file_path, '/test');
    }
  });

  test('rejects node with extra properties', () => {
    const result = validatePlan({
      schemaVersion: 1,
      nodes: [
        { id: 'a', after: null, tool: 'Read', arguments: { file_path: '/test' }, when: 'start', extra: 'bad' },
        { id: 'b', after: 'a', tool: 'Read', arguments: { file_path: '/test' }, when: 'succeeded' }
      ]
    });
    assert.equal(result.ok, false);
  });
});

describe('stableJson', () => {
  test('sorts object keys', () => {
    const input = { z: 1, a: 2, m: 3 };
    const result = stableJson(input);
    assert.equal(result, '{"a":2,"m":3,"z":1}');
  });

  test('sorts nested object keys', () => {
    const input = { outer: { z: 1, a: 2 }, first: { b: 3, a: 4 } };
    const result = stableJson(input);
    assert.equal(result, '{"first":{"a":4,"b":3},"outer":{"a":2,"z":1}}');
  });

  test('preserves array order', () => {
    const input = { items: [3, 1, 2] };
    const result = stableJson(input);
    assert.equal(result, '{"items":[3,1,2]}');
  });

  test('handles null and primitives', () => {
    assert.equal(stableJson(null), 'null');
    assert.equal(stableJson(42), '42');
    assert.equal(stableJson('test'), '"test"');
    assert.equal(stableJson(true), 'true');
  });

  test('produces same output for semantically equal objects', () => {
    const obj1 = { file_path: '/test', offset: 1, limit: 10 };
    const obj2 = { limit: 10, file_path: '/test', offset: 1 };
    assert.equal(stableJson(obj1), stableJson(obj2));
  });
});

test('malformed non-JSON input is rejected rather than thrown into the host', () => {
  const cyclic: Record<string, unknown> = { schemaVersion: 1 };
  cyclic.nodes = cyclic;
  assert.equal(validatePlan(cyclic).ok, false);
  assert.equal(validatePlan({ schemaVersion: 1, nodes: [1n] }).ok, false);
});
