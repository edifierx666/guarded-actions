// controller.ts - Deterministic state controller for bounded action graphs
// No external dependencies; pure state machine

import type { Plan, PlanNode } from './plan.ts';
import { stableJson } from './plan.ts';

export type NodeState = 'pending' | 'in_flight' | 'succeeded' | 'failed' | 'unknown' | 'skipped';
export type PlanState = 'idle' | 'staged' | 'ready' | 'in_flight' | 'completed' | 'invalidated';
export type Outcome = 'succeeded' | 'failed' | 'pending' | 'unknown';

export interface PlanBinding {
  readonly planId: string;
  readonly turnId: string;
  readonly cwd: string;
  readonly authorCallId: string;
  readonly authorStep: number;
}

export interface NextContext {
  readonly turnId: string;
  readonly step: number;
  readonly cwd: string;
  readonly enabled: boolean;
}

export interface ActionResult {
  readonly kind: 'action';
  readonly node: PlanNode;
  readonly callId: string;
  readonly planId: string;
  readonly initial: boolean;
}

export interface DeferResult {
  readonly kind: 'defer';
  readonly reason: string | null;
}

export type ControllerDecision = ActionResult | DeferResult;

export interface ReceiptResult {
  readonly matched: boolean;
  readonly accepted: boolean;
  readonly initial?: boolean;
  readonly planId?: string;
  readonly nodeId?: string;
  readonly reason?: string;
}

export interface NodeStatus {
  readonly id: string;
  readonly state: NodeState;
  readonly callId?: string;
}

export interface StatusSnapshot {
  readonly planId: string | null;
  readonly state: PlanState;
  readonly reason: string | null;
  readonly nodes: readonly NodeStatus[];
}

export interface PendingActionInfo {
  readonly callId: string;
  readonly tool: string;
  readonly args: unknown;
  readonly initial: boolean;
  readonly planId: string;
  readonly nodeId: string;
}

interface NodeRecord {
  node: PlanNode;
  state: NodeState;
  callId: string | null;
  argsStable: string;
}


export class Controller {
  private planState: PlanState = 'idle';
  private binding: PlanBinding | null = null;
  private nodes: NodeRecord[] = [];
  private invalidationReason: string | null = null;
  private seenSteps: Record<number, true> = {};

  stage(plan: Plan, binding: PlanBinding): boolean {
    if (this.hasLive()) {
      return false;
    }

    this.nodes = plan.nodes.map(node => ({
      node: Object.freeze({ ...node, arguments: Object.freeze({ ...node.arguments }) }),
      state: 'pending' as NodeState,
      callId: null,
      argsStable: stableJson(node.arguments)
    }));

    this.binding = { ...binding };
    this.planState = 'staged';
    this.invalidationReason = null;
    this.seenSteps = {};

    return true;
  }

  noteAuthor(authorStep: number, toolCallIds: readonly string[], aborted: boolean): void {
    if (this.planState !== 'staged') {
      return;
    }

    if (!this.binding) {
      return;
    }

    if (!aborted && 
        authorStep === this.binding.authorStep &&
        toolCallIds.length === 1 && 
        toolCallIds[0] === this.binding.authorCallId) {
      this.planState = 'ready';
    } else {
      this.invalidate('author_mixed_output');
    }
  }

  next(ctx: NextContext): ControllerDecision {
    if (this.seenSteps[ctx.step]) {
      if (this.planState === 'in_flight' || this.planState === 'ready') {
        this.invalidate('duplicate_step');
      }
      return { kind: 'defer', reason: 'duplicate_step' };
    }
    this.seenSteps[ctx.step] = true;

    if (!ctx.enabled) {
      if (this.hasLive()) {
        this.invalidate('disabled');
      }
      return { kind: 'defer', reason: null };
    }

    if (this.planState === 'idle') {
      return { kind: 'defer', reason: null };
    }

    if (this.planState === 'invalidated') {
      return { kind: 'defer', reason: this.invalidationReason };
    }

    if (this.planState === 'completed') {
      return { kind: 'defer', reason: 'graph_exhausted' };
    }

    if (this.planState === 'staged') {
      return { kind: 'defer', reason: 'not_activated' };
    }

    if (!this.binding) {
      this.invalidate('missing_binding');
      return { kind: 'defer', reason: 'missing_binding' };
    }

    if (ctx.turnId !== this.binding.turnId) {
      this.invalidate('turn_changed');
      return { kind: 'defer', reason: 'turn_changed' };
    }

    if (ctx.cwd !== this.binding.cwd) {
      this.invalidate('cwd_changed');
      return { kind: 'defer', reason: 'cwd_changed' };
    }

    const eligible = this.findEligibleNodes();

    if (eligible.length === 0) {
      const hasInFlight = this.nodes.some(n => n.state === 'in_flight');
      if (hasInFlight) {
        this.invalidate('missing_receipt');
        return { kind: 'defer', reason: 'missing_receipt' };
      }

      const allTerminal = this.nodes.every(n => 
        n.state === 'succeeded' || n.state === 'failed' || 
        n.state === 'unknown' || n.state === 'skipped'
      );

      if (allTerminal) {
        const allSucceeded = this.nodes.every(n => 
          n.state === 'succeeded' || n.state === 'skipped'
        );
        this.planState = allSucceeded ? 'completed' : 'invalidated';
        if (!allSucceeded && !this.invalidationReason) {
          this.invalidationReason = 'graph_exhausted';
        }
        return { kind: 'defer', reason: 'graph_exhausted' };
      }

      this.invalidate('no_eligible_nodes');
      return { kind: 'defer', reason: 'no_eligible_nodes' };
    }

    if (eligible.length > 1) {
      this.invalidate('ambiguous_branch');
      return { kind: 'defer', reason: 'ambiguous_branch' };
    }

    const nodeIndex = eligible[0];
    if (nodeIndex === undefined) {
      this.invalidate('no_eligible_nodes');
      return { kind: 'defer', reason: 'no_eligible_nodes' };
    }

    const record = this.nodes[nodeIndex];
    if (!record) {
      this.invalidate('invalid_node_index');
      return { kind: 'defer', reason: 'invalid_node_index' };
    }

    const isInitial = this.planState === 'ready';
    const callId = this.allocateCallId(record.node.id);
    
    record.callId = callId;
    record.state = 'in_flight';
    this.planState = 'in_flight';

    return {
      kind: 'action',
      node: record.node,
      callId,
      planId: this.binding.planId,
      initial: isInitial
    };
  }

  receipt(
    callId: string,
    tool: string,
    args: unknown,
    outcome: Outcome
  ): ReceiptResult {
    const nodeIndex = this.nodes.findIndex(n => n.callId === callId);
    
    if (nodeIndex === -1) {
      return { matched: false, accepted: false, reason: 'unknown_call_id' };
    }

    const record = this.nodes[nodeIndex];
    if (!record) {
      return { matched: false, accepted: false, reason: 'invalid_index' };
    }

    if (record.state !== 'in_flight') {
      return { 
        matched: true, 
        accepted: false, 
        nodeId: record.node.id,
        reason: 'not_in_flight' 
      };
    }

    if (tool !== record.node.tool) {
      this.invalidate('tool_mismatch');
      return {
        matched: true,
        accepted: false,
        nodeId: record.node.id,
        reason: 'tool_mismatch'
      };
    }

    const argsStable = stableJson(args);
    if (argsStable !== record.argsStable) {
      this.invalidate('args_mismatch');
      return {
        matched: true,
        accepted: false,
        nodeId: record.node.id,
        reason: 'args_mismatch'
      };
    }

    const isInitial = nodeIndex === 0 && 
      this.nodes.filter(n => n.state !== 'pending' && n.state !== 'skipped').length === 1;

    if (outcome === 'succeeded') {
      record.state = 'succeeded';
      
      const allSucceeded = this.nodes.every(n => 
        n.state === 'succeeded' || n.state === 'skipped' || n.state === 'pending'
      );
      const noPending = this.nodes.every(n => n.state !== 'pending');
      
      if (allSucceeded && noPending) {
        this.planState = 'completed';
      }
    } else if (outcome === 'failed') {
      record.state = 'failed';
      this.invalidateRemaining('execution_failed');
    } else if (outcome === 'unknown') {
      record.state = 'unknown';
      this.invalidateRemaining('receipt_unknown');
    } else if (outcome === 'pending') {
      record.state = 'unknown';
      this.invalidate('receipt_pending');
    }

    return {
      matched: true,
      accepted: true,
      initial: isInitial,
      planId: this.binding?.planId,
      nodeId: record.node.id
    };
  }

  invalidate(reason: string): void {
    if (this.planState === 'completed' || this.planState === 'invalidated') {
      return;
    }

    this.invalidationReason = reason;
    this.planState = 'invalidated';

    for (const record of this.nodes) {
      if (record.state === 'pending') {
        record.state = 'skipped';
      } else if (record.state === 'in_flight') {
        record.state = 'unknown';
      }
    }
  }

  status(): StatusSnapshot {
    return {
      planId: this.binding?.planId ?? null,
      state: this.planState,
      reason: this.invalidationReason,
      nodes: this.nodes.map(r => ({
        id: r.node.id,
        state: r.state,
        callId: r.callId ?? undefined
      }))
    };
  }

  hasLive(): boolean {
    return this.planState !== 'idle' && 
           this.planState !== 'completed' && 
           this.planState !== 'invalidated';
  }

  pendingAction(): PendingActionInfo | null {
    const inFlight = this.nodes.find(n => n.state === 'in_flight');
    if (!inFlight || !inFlight.callId || !this.binding) {
      return null;
    }

    const isInitial = this.nodes.indexOf(inFlight) === 0 &&
      this.nodes.filter(n => n.state !== 'pending' && n.state !== 'skipped').length === 1;

    return {
      callId: inFlight.callId,
      tool: inFlight.node.tool,
      args: inFlight.node.arguments,
      initial: isInitial,
      planId: this.binding.planId,
      nodeId: inFlight.node.id
    };
  }

  private findEligibleNodes(): number[] {
    const eligible: number[] = [];

    for (let i = 0; i < this.nodes.length; i++) {
      const record = this.nodes[i];
      if (!record) continue;

      if (record.state !== 'pending') {
        continue;
      }

      if (record.node.after === null) {
        if (record.node.when === 'start') {
          eligible.push(i);
        }
      } else {
        const depIndex = this.nodes.findIndex(n => n.node.id === record.node.after);
        if (depIndex !== -1) {
          const depRecord = this.nodes[depIndex];
          if (depRecord && record.node.when === 'succeeded' && depRecord.state === 'succeeded') {
            eligible.push(i);
          }
        }
      }
    }

    return eligible;
  }

  private invalidateRemaining(reason: string): void {
    this.invalidationReason = reason;
    this.planState = 'invalidated';

    for (const record of this.nodes) {
      if (record.state === 'pending') {
        record.state = 'skipped';
      }
    }
  }

  private allocateCallId(nodeId: string): string {
    if (!this.binding) {
      throw new Error('Cannot allocate callId without binding');
    }

    return `ga_${this.binding.planId}_${nodeId}`;
  }
}
