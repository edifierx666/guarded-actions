import type { Register, TurnStepChunk, TurnStepResult } from 'claude-code';
import type { ControllerDecision } from '../src/controller.ts';
import { PLAN_DESCRIPTION, PLAN_SCHEMA, stableJson, validatePlan } from '../src/plan.ts';
import { Runtime, TOOL, SUPPORTED_VERSION, normalizeReceipt, requestResult, authorMatches } from '../src/claude-adapter.ts';
import type { Author } from '../src/claude-adapter.ts';

export const register: Register = on => {
  const runtime = new Runtime();

  on('session.start', async ($, e, next) => {
    const version = await $.session.version();
    runtime.version = version.base ?? version.version;
    runtime.compatible = version.base === SUPPORTED_VERSION;
    await $.tool.register({ name: 'commit_plan', description: PLAN_DESCRIPTION, inputSchema: PLAN_SCHEMA, isDeferred: true });
    await $.command.register({ name: 'guarded', description: 'Enable, disable or inspect guarded native actions', argumentHint: 'on|off|status', immediate: true });
    return next(e);
  });

  on('command.run', { command: 'guarded' }, async ($, e) => {
    const action = e.args.trim() || 'status';
    if (action === 'on' || action === 'off') {
      if (!['composer', 'bridge', 'sdk'].includes(e.origin.kind)) return { text: 'Only the user or SDK host can change Guarded Actions mode.' };
      if (action === 'on' && !runtime.compatible) return { text: `Guarded Actions stays off: supported host ${SUPPORTED_VERSION}; current ${runtime.version}.` };
      runtime.invalidate(action === 'on' ? 'mode_changed' : 'disabled');
      runtime.enabled = action === 'on';
      await $.tool.register({ name: 'commit_plan', description: PLAN_DESCRIPTION, inputSchema: PLAN_SCHEMA, isDeferred: !runtime.enabled });
      $.ui.invalidate('tool.describe');
    } else if (action !== 'status') return { text: 'Usage: /guarded on|off|status' };
    return { text: JSON.stringify(runtime.status(), null, 2) };
  });

  on('tool.describe', { tool: TOOL }, async ($, e) => ({
    description: runtime.enabled ? PLAN_DESCRIPTION : 'Guarded Actions is off. Do not call this tool; the user can enable it with /guarded on.',
    isDeferred: !runtime.enabled,
  }));

  on('prompt.submit', async ($, e, next) => {
    runtime.invalidate('new_input');
    return next(e);
  });
  on('turn.start', async ($, e, next) => {
    if (!e.agentId) { runtime.invalidate('new_turn'); runtime.author = null; runtime.executed.clear(); }
    return next(e);
  });
  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) { runtime.invalidate(e.isAborted ? 'cancelled' : 'turn_ended'); runtime.author = null; }
    return next(e);
  });
  on('session.end', async ($, e, next) => {
    runtime.resetSession();
    $.ui.invalidate('tool.describe');
    return next(e);
  });
  on('session.compact', async ($, e, next) => { if (!e.agentId) runtime.invalidate('compacted'); return next(e); });
  on('classic.CwdChanged', async ($, e, next) => { if (!e.agent_id) runtime.invalidate('cwd_changed'); return next(e); });

  on('classic.PostToolUse', async ($, e, next) => {
    if (e.agent_id) return next(e);
    const pending = runtime.controller.pendingAction();
    if (pending?.callId === e.tool_use_id) runtime.receipt = { callId: pending.callId, native: { kind: 'success', tool: e.tool_name, arguments: e.tool_input, response: e.tool_response } };
    return next(e);
  });
  on('classic.PostToolUseFailure', async ($, e, next) => {
    if (e.agent_id) return next(e);
    const pending = runtime.controller.pendingAction();
    if (pending?.callId === e.tool_use_id) runtime.receipt = { callId: pending.callId, native: { kind: 'failure', tool: e.tool_name, arguments: e.tool_input } };
    return next(e);
  });

  on('tool.call', async ($, e, next) => {
    if (e.agentId) return next(e);
    const callId = e.tool_use_id;
    if (e.tool === TOOL) {
      const author = runtime.author;
      let reason: string | undefined;
      if (!runtime.enabled || !runtime.compatible) reason = 'disabled';
      else if (!author || author.epoch !== runtime.epoch || !author.calls.includes(callId)) reason = 'not_current_author';
      else if (runtime.active.size || runtime.controller.hasLive()) reason = 'execution_in_progress';
      if (reason) return { result: JSON.stringify({ status: 'rejected', reason }) };
      const input = Object.fromEntries(Object.entries(e).filter(([key]) => !['tool', 'tool_use_id', 'agentId', 'requestMeta'].includes(key)));
      if (!authorMatches(author!, callId, input)) return { result: JSON.stringify({ status: 'rejected', reason: 'author_input_changed' }) };
      const validated = validatePlan(input);
      if (!validated.ok) return { result: JSON.stringify({ status: 'rejected', reason: validated.reason }) };
      const epoch = runtime.epoch;
      const cwd = await $.session.cwd();
      const tools = await $.tool.list();
      if (epoch !== runtime.epoch || !runtime.enabled) return { result: JSON.stringify({ status: 'rejected', reason: 'state_changed' }) };
      if (validated.plan.nodes.some(node => !tools.some(tool => tool.name === node.tool))) return { result: JSON.stringify({ status: 'rejected', reason: 'tool_unavailable' }) };
      const planId = crypto.randomUUID().replaceAll('-', '');
      const staged = runtime.controller.stage(validated.plan, { planId, turnId: author!.turnId, cwd, authorCallId: callId, authorStep: author!.step });
      if (!staged) return { result: JSON.stringify({ status: 'rejected', reason: 'execution_in_progress' }) };
      runtime.planAuthor = { callId, input: stableJson(input) };
      runtime.accounting.author(author!.requestId);
      if (author!.complete) runtime.controller.noteAuthor(author!.step, author!.calls, author!.aborted);
      const reasonAfterAuthor = runtime.controller.status().reason;
      if (reasonAfterAuthor) runtime.reportFallback(reasonAfterAuthor);
      return { result: JSON.stringify({ status: 'staged', planId, nodeCount: validated.plan.nodes.length }) };
    }
    const pending = runtime.controller.pendingAction();
    const planned = pending?.callId === callId;
    if (callId.startsWith('ga_') && (!planned || !runtime.enabled || next.signal.aborted)) {
      runtime.invalidate('stale_dispatch');
      return { deny: 'This stored action is no longer active. It was not executed.' };
    }
    if (runtime.executed.has(callId)) {
      runtime.invalidate('duplicate_dispatch');
      return { deny: 'Guarded Actions refused a duplicate invocation. Inspect existing execution before making a new decision.' };
    }
    if (planned) {
      const argumentsOnly = Object.fromEntries(Object.entries(e).filter(([key]) => !['tool', 'tool_use_id', 'agentId', 'requestMeta'].includes(key)));
      if (e.tool !== pending.tool || stableJson(argumentsOnly) !== stableJson(pending.args)) {
        runtime.invalidate('rewritten_action');
        return { deny: 'The stored action was changed after admission. It was not executed.' };
      }
    }
    if (planned) runtime.executed.add(callId);
    else if (runtime.controller.hasLive()) runtime.invalidate('interleaved_tool');
    runtime.active.add(callId);
    try {
      const result = await next(e);
      if (planned && runtime.controller.pendingAction()?.callId === callId) {
        const normalized = normalizeReceipt(pending!.tool, pending!.args, runtime.receipt?.native, result);
        runtime.receipt = { ...runtime.receipt, callId, ...normalized, text: result.text, isError: result.isError };
      }
      return result;
    } finally {
      runtime.active.delete(callId);
    }
  }).catch(async ($, e, next) => {
    runtime.active.delete(e.tool_use_id);
    runtime.invalidate('tool_hook_error');
    $.ui.log(`Guarded Actions disabled this plan after tool hook failure: ${next.error.kind}`);
    if (next.called) return next(e);
    if (e.tool === TOOL) return { result: JSON.stringify({ status: 'rejected', reason: 'plugin_error' }) };
    if (e.tool_use_id.startsWith('ga_')) return { deny: 'Guarded execution could not be verified. This action was not executed.' };
    return next(e);
  });

  on('turn.step', async function* ($, e, next) {
    if (e.agentId) return yield* next(e);
    if (next.signal.aborted) { runtime.invalidate('cancelled'); return requestResult(e, '', [], null); }
    let action: ControllerDecision = { kind: 'defer', reason: null };
    try {
      if (runtime.controller.hasLive()) {
        const epoch = runtime.epoch;
        const messages = await $.session.messages();
        const cwd = await $.session.cwd();
        if (next.signal.aborted) { runtime.invalidate('cancelled'); return requestResult(e, '', [], null); }
        if (epoch !== runtime.epoch) runtime.invalidate('state_changed');
        else {
          runtime.verifyAuthor(messages);
          runtime.settle(messages);
          action = runtime.controller.next({ turnId: e.turnId, step: e.index, cwd, enabled: runtime.enabled && runtime.compatible });
        }
      }
    } catch (error) {
      runtime.invalidate('admission_error');
      $.ui.log(`Guarded Actions returned to the model: ${String(error)}`);
    }
    if (action.kind === 'action') {
      const call = action;
      // Serialize before yielding anything; failure can still safely use the original model route.
      let json: string;
      try { json = JSON.stringify(call.node.arguments); }
      catch (error) { runtime.invalidate('serialization_error'); throw error; }
      runtime.accounting.dispatched({ callId: call.callId, initial: call.initial });
      yield { kind: 'tool', index: 0, id: call.callId, name: call.node.tool };
      yield { kind: 'input', index: 0, json };
      yield { kind: 'stop', stopReason: 'tool_use', usage: null };
      return requestResult(e, '', [{ name: call.node.tool, input: call.node.arguments }], 'tool_use');
    }
    if (action.reason) runtime.reportFallback(action.reason);
    const author: Author = { turnId: e.turnId, step: e.index, requestId: `${e.turnId}:${e.index}`, epoch: runtime.epoch, calls: [], blocks: new Map(), complete: false, aborted: false };
    runtime.author = author;
    runtime.accounting.requestStarted(author.requestId);
    const stream = next(e);
    let result: TurnStepResult | undefined;
    try {
      while (true) {
        const item = await stream.next();
        if (item.done) { result = item.value; break; }
        const chunk: TurnStepChunk = item.value;
        if (chunk.kind === 'tool') {
          author.calls.push(chunk.id);
          if (chunk.name === TOOL) author.blocks.set(chunk.index, { id: chunk.id, name: chunk.name, json: '' });
        }
        if (chunk.kind === 'input') {
          const block = author.blocks.get(chunk.index);
          if (block) {
            if (block.json.length + chunk.json.length > 16384) { author.blocks.delete(chunk.index); author.aborted = true; }
            else block.json += chunk.json;
          }
        }
        yield chunk;
      }
      author.complete = true;
      author.aborted = author.aborted || next.signal.aborted || result?.stopReason !== 'tool_use' || Boolean(result.serverToolUses?.length);
      runtime.controller.noteAuthor(author.step, author.calls, author.aborted);
      const authorFailure = runtime.controller.status().reason;
      if (authorFailure) runtime.reportFallback(authorFailure);
      runtime.accounting.requestFinished(author.requestId, result?.usage);
      return result;
    } finally {
      if (!author.complete) {
        author.aborted = true;
        runtime.invalidate('author_interrupted');
        runtime.accounting.requestFinished(author.requestId, result?.usage);
        await stream.return(requestResult(e, '', [], null));
      }
    }
  });
};
