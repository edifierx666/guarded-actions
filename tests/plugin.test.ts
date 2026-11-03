import { test, expect } from 'claude-code/testing';
import type { TurnStepChunk } from 'claude-code';

const TOOL = 'mcp__guarded-actions__commit_plan';
const plan = { schemaVersion: 1, nodes: [
  { id: 'build', after: null, tool: 'Bash', arguments: { command: 'npm run build' }, when: 'start' },
  { id: 'test', after: 'build', tool: 'Bash', arguments: { command: 'npm test' }, when: 'succeeded' },
] };

function stubs(on, modelCalls: string[], messages: unknown[], authoredPlan = plan, hostVersion = '2.1.316') {
  on('session.start', ($, e) => ({ cwd: e.cwd }));
  on('session.version', () => ({ value: { version: hostVersion, base: hostVersion, builtAt: '' } }));
  on('session.id', () => ({ value: 'test-session' }));
  on('session.cwd', () => ({ value: '/work' }));
  on('session.messages', () => ({ value: messages }));
  on('tool.list', () => ({ value: [{ name: 'Read' }, { name: 'Bash' }] }));
  on('tool.register', () => ({ value: { tool: TOOL } }));
  on('command.register', () => ({ value: undefined }));
  on('ui.log', () => ({ value: undefined }));
  on('ui.invalidate', () => ({ value: undefined }));
  on('prompt.submit', ($, e) => ({ text: e.text }));
  on('classic.PostToolUse', () => ({}));
  on('classic.PostToolUseFailure', () => ({}));
  on('turn.complete', () => ({ text: '' }));
  on('session.end', ($, e) => ({ sessionId: e.sessionId }));
  on('session.compact', ($, e) => ({ messages: e.messages }));
  on('classic.CwdChanged', () => ({}));
  on('turn.step', async function* ($, e) {
    modelCalls.push(`${e.turnId}:${e.index}`);
    if (e.index === 0) {
      yield { kind: 'tool', index: 0, id: 'author-call', name: TOOL };
      yield { kind: 'input', index: 0, json: JSON.stringify(authoredPlan) };
      yield { kind: 'stop', stopReason: 'tool_use', usage: null };
      messages.push({ role: 'assistant', text: '', toolUses: [{ tool_use_id: 'author-call', tool: TOOL, input: authoredPlan }] });
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [{ name: TOOL, input: plan }], stopReason: 'tool_use', usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 20, cache_creation_input_tokens: 0, model: 'test' } };
    }
    yield { kind: 'text', index: 0, text: 'model resumed' };
    return { turnId: e.turnId, index: e.index, answer: 'model resumed', toolUses: [], stopReason: 'end_turn', usage: null };
  });
}

async function step($, index: number) {
  const stream = $.turn.step({ turnId: 'turn', index, model: 'test', messageCount: 1 });
  const chunks: TurnStepChunk[] = [];
  let item = await stream.next();
  while (!item.done) { chunks.push(item.value); item = await stream.next(); }
  return { chunks, result: item.value };
}

async function begin($, authoredPlan = plan) {
  await $.session.start({ cwd: '/work', surface: null, isInteractive: false });
  await $.command.run({ command: 'guarded', args: 'on', origin: { kind: 'sdk' } });
  await step($, 0);
  const response = await $.tool.call({ tool: TOOL, tool_use_id: 'author-call', ...authoredPlan });
  expect(JSON.parse(response.result).status).toBe('staged');
}

test('successive native receipts replace reasoning but not final interpretation', async ($, on) => {
  const calls: string[] = [];
  const messages: unknown[] = [];
  const response = { stdout: '', stderr: '', interrupted: false };
  stubs(on, calls, messages);
  on('tool.call', () => ({ ref: 1, result: response, text: '' }));
  await begin($);
  for (let index = 1; index <= 2; index++) {
    const routed = await step($, index);
    const tool = routed.chunks.find(chunk => chunk.kind === 'tool');
    expect(tool.name).toBe('Bash');
    const args = routed.result.toolUses[0].input;
    await $.classic.PostToolUse({ tool_name: 'Bash', tool_use_id: tool.id, tool_input: args, tool_response: response, session_id: 'test-session', cwd: '/work', transcript_path: '/unused', hook_event_name: 'PostToolUse' });
    await $.tool.call({ tool: 'Bash', tool_use_id: tool.id, ...args });
    messages.push({ role: 'assistant', text: '', toolUses: [{ tool_use_id: tool.id, tool: 'Bash', input: args }] }, { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: tool.id, text: '', isError: false, result: response }] });
  }
  expect((await step($, 3)).result.answer).toBe('model resumed');
  expect(calls).toEqual(['turn:0', 'turn:3']);
  const status = JSON.parse((await $.command.run({ command: 'guarded', args: 'status' })).text);
  expect(status.initialDispatches).toBe(1);
  expect(status.certifiedSubstitutions).toBe(1);
  expect(status.plan.state).toBe('completed');
});

test('a permission denial stops the stored continuation and returns to reasoning', async ($, on) => {
  const calls: string[] = [];
  const messages: unknown[] = [];
  stubs(on, calls, messages);
  on('tool.call', () => ({ deny: 'user refused' }));
  await begin($);
  const routed = await step($, 1);
  const tool = routed.chunks.find(chunk => chunk.kind === 'tool');
  await $.tool.call({ tool: 'Bash', tool_use_id: tool.id, command: 'npm run build' });
  expect((await step($, 2)).result.answer).toBe('model resumed');
  const status = JSON.parse((await $.command.run({ command: 'guarded', args: 'status' })).text);
  expect(status.continuationDispatches).toBe(0);
  expect(status.plan.state).toBe('invalidated');
});

test('a new user requirement invalidates a staged plan', async ($, on) => {
  const calls: string[] = [];
  stubs(on, calls, []);
  await begin($);
  await $.prompt.submit({ text: 'Do not run the checks.', origin: { kind: 'sdk' }, wait: false });
  expect((await step($, 1)).result.answer).toBe('model resumed');
  const status = JSON.parse((await $.command.run({ command: 'guarded', args: 'status' })).text);
  expect(status.initialDispatches).toBe(0);
});

test('disabling a plan leaves no queued action for re-enabling', async ($, on) => {
  const calls: string[] = [];
  stubs(on, calls, []);
  await begin($);
  await $.command.run({ command: 'guarded', args: 'off', origin: { kind: 'sdk' } });
  await $.command.run({ command: 'guarded', args: 'on', origin: { kind: 'sdk' } });
  expect((await step($, 1)).result.answer).toBe('model resumed');
});

test('off after emission blocks a queued native action instead of executing it', async ($, on) => {
  const calls: string[] = [];
  const executed: string[] = [];
  stubs(on, calls, []);
  on('tool.call', ($, e) => { executed.push(e.tool_use_id); return { ref: 1, result: { stdout: '', stderr: '', interrupted: false }, text: '' }; });
  await begin($);
  const routed = await step($, 1);
  const call = routed.chunks.find(chunk => chunk.kind === 'tool');
  await $.command.run({ command: 'guarded', args: 'off', origin: { kind: 'sdk' } });
  const reply = await $.tool.call({ tool: 'Bash', tool_use_id: call.id, command: 'npm run build' });
  expect(reply.deny).toBeDefined();
  expect(executed).toEqual([]);
});

test('a native tool call identifier is never executed twice', async ($, on) => {
  const calls: string[] = [];
  const executed: string[] = [];
  stubs(on, calls, []);
  on('tool.call', ($, e) => { executed.push(e.tool_use_id); return { ref: 1, result: { stdout: '', stderr: '', interrupted: false }, text: '' }; });
  await begin($);
  const routed = await step($, 1);
  const call = routed.chunks.find(chunk => chunk.kind === 'tool');
  await $.tool.call({ tool: 'Bash', tool_use_id: call.id, command: 'npm run build' });
  const repeated = await $.tool.call({ tool: 'Bash', tool_use_id: call.id, command: 'npm run build' });
  expect(repeated.deny).toBeDefined();
  expect(executed).toEqual([call.id]);
});

test('a changed stored command is refused before native execution', async ($, on) => {
  const calls: string[] = [];
  const executed: string[] = [];
  stubs(on, calls, []);
  on('tool.call', ($, e) => { executed.push(e.tool_use_id); return { ref: 1, result: { stdout: '', stderr: '', interrupted: false }, text: '' }; });
  await begin($);
  const routed = await step($, 1);
  const call = routed.chunks.find(chunk => chunk.kind === 'tool');
  const reply = await $.tool.call({ tool: 'Bash', tool_use_id: call.id, command: 'npm publish' });
  expect(reply.deny).toBeDefined();
  expect(executed).toEqual([]);
});

test('unknown top-level plan fields are rejected before staging', async ($, on) => {
  const calls: string[] = [];
  stubs(on, calls, []);
  await $.session.start({ cwd: '/work', surface: null, isInteractive: false });
  await $.command.run({ command: 'guarded', args: 'on', origin: { kind: 'sdk' } });
  await step($, 0);
  const response = await $.tool.call({ tool: TOOL, tool_use_id: 'author-call', ...plan, permission: 'allow' });
  expect(JSON.parse(response.result).status).toBe('rejected');
  expect((await step($, 1)).result.answer).toBe('model resumed');
});

test('an unrelated native tool invalidates a staged plan instead of racing it', async ($, on) => {
  const calls: string[] = [];
  stubs(on, calls, []);
  on('tool.call', () => ({ ref: 1, result: { stdout: '', stderr: '', interrupted: false }, text: '' }));
  await begin($);
  await $.tool.call({ tool: 'Bash', tool_use_id: 'unrelated', command: 'printf other' });
  expect((await step($, 1)).result.answer).toBe('model resumed');
  const status = JSON.parse((await $.command.run({ command: 'guarded', args: 'status' })).text);
  expect(status.initialDispatches).toBe(0);
  expect(status.plan.state).toBe('invalidated');
});

test('a plan rewritten after model output is never staged', async ($, on) => {
  const calls: string[] = [];
  stubs(on, calls, []);
  await $.session.start({ cwd: '/work', surface: null, isInteractive: false });
  await $.command.run({ command: 'guarded', args: 'on', origin: { kind: 'sdk' } });
  await step($, 0);
  const changed = { ...plan, nodes: plan.nodes.map((node, index) => index ? node : { ...node, arguments: { command: 'npm publish' } }) };
  const reply = await $.tool.call({ tool: TOOL, tool_use_id: 'author-call', ...changed });
  expect(JSON.parse(reply.result).status).toBe('rejected');
  expect((await step($, 1)).result.answer).toBe('model resumed');
});

test('a transcript change after staging prevents activation', async ($, on) => {
  const calls: string[] = [];
  const messages: unknown[] = [];
  stubs(on, calls, messages);
  await begin($);
  messages.length = 0;
  expect((await step($, 1)).result.answer).toBe('model resumed');
  const status = JSON.parse((await $.command.run({ command: 'guarded', args: 'status' })).text);
  expect(status.initialDispatches).toBe(0);
});

test('subagent compaction and directory events leave the main plan active', async ($, on) => {
  const calls: string[] = [];
  stubs(on, calls, []);
  await begin($);
  await $.session.compact({ trigger: 'manual', agentId: 'child', messages: [{ role: 'user', text: 'Child task', toolUses: [] }] });
  await $.classic.CwdChanged({ agent_id: 'child', cwd: '/child', old_cwd: '/work', session_id: 'test-session', transcript_path: '/unused', hook_event_name: 'CwdChanged' });
  const routed = await step($, 1);
  expect(routed.result.stopReason).toBe('tool_use');
  expect(calls).toEqual(['turn:0']);
});

test('clearing a conversation resets plans and usage without a second session.start', async ($, on) => {
  const calls: string[] = [];
  stubs(on, calls, []);
  await begin($);
  await $.session.end({ reason: 'clear', sessionId: 'test-session', resume: {} });
  const status = JSON.parse((await $.command.run({ command: 'guarded', args: 'status' })).text);
  expect(status.enabled).toBe(false);
  expect(status.plan.state).toBe('idle');
  expect(status.modelRequests).toBe(0);
  expect(status.authorRequests).toBe(0);
  expect(status.usage.input_tokens).toBe(0);
});

test('an ambiguous continuation records one fallback instead of silently dropping it', async ($, on) => {
  const calls: string[] = [];
  const messages: unknown[] = [];
  const branched = { ...plan, nodes: [...plan.nodes, { id: 'other', after: 'build', tool: 'Bash', arguments: { command: 'npm run check' }, when: 'succeeded' }] };
  const response = { stdout: '', stderr: '', interrupted: false };
  stubs(on, calls, messages, branched);
  on('tool.call', () => ({ ref: 1, result: response, text: '' }));
  await begin($, branched);
  const routed = await step($, 1);
  const call = routed.chunks.find(chunk => chunk.kind === 'tool');
  const args = { command: 'npm run build' };
  await $.classic.PostToolUse({ tool_name: 'Bash', tool_use_id: call.id, tool_input: args, tool_response: response, session_id: 'test-session', cwd: '/work', transcript_path: '/unused', hook_event_name: 'PostToolUse' });
  await $.tool.call({ tool: 'Bash', tool_use_id: call.id, ...args });
  messages.push({ role: 'assistant', text: '', toolUses: [{ tool_use_id: call.id, tool: 'Bash', input: args }] }, { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: call.id, text: '', isError: false, result: response }] });
  expect((await step($, 2)).result.answer).toBe('model resumed');
  const status = JSON.parse((await $.command.run({ command: 'guarded', args: 'status' })).text);
  expect(status.plan.state).toBe('invalidated');
  expect(status.continuationDispatches).toBe(0);
  expect(Object.values(status.fallbacks)).toEqual([1]);
});

for (const hostVersion of ['2.1.317', '3.0.0']) {
  test(`native plans can be enabled and dispatched on host ${hostVersion}`, async ($, on) => {
    const calls: string[] = [];
    stubs(on, calls, [], plan, hostVersion);
    await begin($);
    const routed = await step($, 1);
    expect(routed.result.toolUses).toEqual([{ name: 'Bash', input: { command: 'npm run build' } }]);
    expect(calls).toEqual(['turn:0']);
    const status = JSON.parse((await $.command.run({ command: 'guarded', args: 'status' })).text);
    expect(status.enabled).toBe(true);
    expect(status.version).toBe(hostVersion);
  });
}
