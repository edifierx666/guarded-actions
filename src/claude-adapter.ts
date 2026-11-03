import type { TurnStepInput, TurnStepResult } from 'claude-code';
import { Controller } from './controller.ts';
import { Accounting } from './accounting.ts';
import { stableJson } from './plan.ts';

export const TOOL = 'mcp__guarded-actions__commit_plan';
export const SUPPORTED_VERSION = '2.1.316';
type Outcome = 'succeeded' | 'failed' | 'pending' | 'unknown';
type NativeEvent = { kind: 'success' | 'failure'; tool: string; arguments: unknown; response?: unknown };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Success requires the native post event AND the unchanged, settled tool result. */
export function normalizeReceipt(tool: string, args: unknown, native: NativeEvent | undefined, result: unknown): { outcome: Outcome; certified: boolean } {
  if (!object(result)) return { outcome: 'unknown', certified: false };
  if (typeof result.deny === 'string') return { outcome: 'failed', certified: false };
  if (!native || native.tool !== tool || stableJson(native.arguments) !== stableJson(args) || !Number.isSafeInteger(result.ref)) {
    return { outcome: 'unknown', certified: false };
  }
  if (native.kind === 'failure') return { outcome: result.isError === true ? 'failed' : 'unknown', certified: result.isError === true };
  if (result.isError || stableJson(native.response) !== stableJson(result.result) || !object(native.response)) return { outcome: 'unknown', certified: false };
  const response = native.response;
  if (tool === 'Bash') {
    if (response.interrupted === true) return { outcome: 'failed', certified: true };
    if (response.backgroundTaskId !== undefined || response.timedOutAfterMs !== undefined || response.backgroundedByUser || response.backgroundedByTurnAbort || response.backgroundedToDeliverMessage) return { outcome: 'pending', certified: false };
    if (response.interrupted !== false || typeof response.stdout !== 'string' || typeof response.stderr !== 'string' || response.dangerouslyDisableSandbox || response.returnCodeInterpretation !== undefined || response.memoryLimitNote !== undefined) return { outcome: 'unknown', certified: false };
    return { outcome: 'succeeded', certified: true };
  }
  if (tool === 'Read' && response.type === 'text' && object(response.file)) {
    const file = response.file;
    if (file.truncatedByTokenCap || typeof file.filePath !== 'string' || typeof file.content !== 'string' || !Number.isSafeInteger(file.numLines) || !Number.isSafeInteger(file.startLine) || !Number.isSafeInteger(file.totalLines)) return { outcome: 'unknown', certified: false };
    return { outcome: 'succeeded', certified: true };
  }
  // Non-text Read variants are still executed natively, but never imply a safe continuation.
  return { outcome: 'unknown', certified: false };
}

export type AuthorBlock = { id: string; name: string; json: string };
export type Author = { turnId: string; step: number; requestId: string; epoch: number; calls: string[]; blocks: Map<number, AuthorBlock>; complete: boolean; aborted: boolean };
export function authorMatches(author: Author, callId: string, input: unknown): boolean {
  const block = [...author.blocks.values()].find(value => value.id === callId);
  if (!block || block.name !== TOOL) return false;
  try { return stableJson(JSON.parse(block.json)) === stableJson(input); }
  catch { return false; }
}
type Receipt = { callId: string; native?: NativeEvent; outcome?: Outcome; certified?: boolean; text?: string; isError?: boolean };

export class Runtime {
  controller = new Controller();
  accounting = new Accounting();
  enabled = false;
  compatible = false;
  version = 'unknown';
  epoch = 0;
  author: Author | null = null;
  receipt: Receipt | null = null;
  active = new Set<string>();
  executed = new Set<string>();
  planAuthor: { callId: string; input: string } | null = null;
  reportedFallbacks = new Set<string>();

  invalidate(reason: string) {
    const pending = this.controller.pendingAction();
    if (pending) this.accounting.settled({ callId: pending.callId, outcome: 'unknown', certified: false });
    if (this.controller.hasLive()) {
      this.controller.invalidate(reason);
      this.reportFallback(reason);
    }
    this.receipt = null;
    this.epoch += 1;
    this.planAuthor = null;
  }

  reportFallback(reason: string) {
    const key = this.controller.status().planId;
    if (!key || this.reportedFallbacks.has(key)) return;
    this.reportedFallbacks.add(key);
    this.accounting.fallback(reason);
  }

  resetSession() {
    this.invalidate('session_ended');
    this.enabled = false;
    this.author = null;
    this.active.clear();
    this.executed.clear();
    this.reportedFallbacks.clear();
    this.controller = new Controller();
    this.accounting = new Accounting();
  }

  verifyAuthor(messages: unknown[]) {
    if (this.controller.status().nodes.some(node => node.callId)) return;
    const source = this.planAuthor;
    if (!source) { this.invalidate('author_transcript_mismatch'); return; }
    let matches = 0;
    let valid = false;
    for (const message of messages) {
      if (!object(message) || !Array.isArray(message.toolUses)) continue;
      for (const use of message.toolUses) {
        if (object(use) && use.tool_use_id === source.callId) {
          matches += 1;
          valid = message.role === 'assistant' && message.toolUses.length === 1 && use.tool === TOOL && stableJson(use.input) === source.input;
        }
      }
    }
    if (!source || !valid || matches !== 1) this.invalidate('author_transcript_mismatch');
  }

  status() {
    return { enabled: this.enabled, compatible: this.compatible, version: this.version, supportedVersion: SUPPORTED_VERSION,
      plan: this.controller.status(), ...this.accounting.snapshot(),
      accountingScope: 'Main-loop forwarded steps, not provider retry attempts. Root dispatch is not a saving. No estimated token savings.' };
  }

  settle(messages: unknown[]) {
    const pending = this.controller.pendingAction();
    if (!pending) return;
    const receipt = this.receipt;
    let matchingUse: Record<string, unknown> | undefined;
    let matchingResult: Record<string, unknown> | undefined;
    let uses = 0;
    let results = 0;
    let lastCall = '';
    for (const message of messages) {
      if (!object(message)) continue;
      for (const use of Array.isArray(message.toolUses) ? message.toolUses : []) {
        if (!object(use)) continue;
        lastCall = String(use.tool_use_id);
        if (use.tool_use_id === pending.callId) { matchingUse = use; uses += 1; }
      }
      for (const value of Array.isArray(message.toolResults) ? message.toolResults : []) {
        if (object(value) && value.tool_use_id === pending.callId) { matchingResult = value; results += 1; }
      }
    }
    const verified = receipt?.callId === pending.callId && receipt.outcome !== undefined && uses === 1 && results === 1 && lastCall === pending.callId && matchingUse?.tool === pending.tool && stableJson(matchingUse?.input) === stableJson(pending.args) && typeof receipt.text === 'string' && matchingResult?.text === receipt.text && matchingResult?.isError === Boolean(receipt.isError);
    const outcome = verified ? receipt.outcome! : 'unknown';
    const certified = Boolean(verified && receipt.certified);
    const settled = this.controller.receipt(pending.callId, pending.tool, pending.args, outcome);
    if (settled.matched) this.accounting.settled({ callId: pending.callId, outcome: outcome === 'pending' ? 'unknown' : outcome, certified });
    if (!verified || outcome !== 'succeeded') this.reportFallback(this.controller.status().reason ?? 'receipt_unverified');
    this.receipt = null;
  }
}

export function requestResult(e: TurnStepInput, answer: string, toolUses: TurnStepResult['toolUses'], stopReason: TurnStepResult['stopReason']): TurnStepResult {
  return { turnId: e.turnId, index: e.index, answer, toolUses, stopReason, usage: null };
}

