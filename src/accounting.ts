export type Outcome = 'succeeded' | 'failed' | 'pending' | 'unknown';

export interface AccountingSnapshot {
  modelRequests: number;
  authorRequests: number;
  initialDispatches: number;
  continuationDispatches: number;
  certifiedSubstitutions: number;
  unknownUsageRequests: number;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  };
  fallbacks: Record<string, number>;
  outcomes: Record<string, number>;
}

interface RequestState {
  finished: boolean;
}

interface DispatchState {
  initial: boolean;
  settled: boolean;
}

const USAGE_FIELDS = [
  'input_tokens',
  'output_tokens',
  'cache_read_input_tokens',
  'cache_creation_input_tokens',
] as const;

function emptySnapshot(): AccountingSnapshot {
  return {
    modelRequests: 0,
    authorRequests: 0,
    initialDispatches: 0,
    continuationDispatches: 0,
    certifiedSubstitutions: 0,
    unknownUsageRequests: 0,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    fallbacks: {},
    outcomes: { succeeded: 0, failed: 0, pending: 0, unknown: 0 },
  };
}

function usageFrom(value: unknown): AccountingSnapshot['usage'] | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  for (const field of USAGE_FIELDS) {
    const amount = record[field];
    if (typeof amount !== 'number' || !Number.isFinite(amount) || !Number.isInteger(amount) || amount < 0) return null;
  }
  return {
    input_tokens: record.input_tokens as number,
    output_tokens: record.output_tokens as number,
    cache_read_input_tokens: record.cache_read_input_tokens as number,
    cache_creation_input_tokens: record.cache_creation_input_tokens as number,
  };
}

export class Accounting {
  private readonly requests = new Map<string, RequestState>();
  private readonly authors = new Set<string>();
  private readonly dispatches = new Map<string, DispatchState>();
  private readonly totals = emptySnapshot();

  requestStarted(id: string): void {
    if (this.requests.has(id)) return;
    this.requests.set(id, { finished: false });
    this.totals.modelRequests += 1;
    this.totals.unknownUsageRequests += 1;
  }

  requestFinished(id: string, usage: unknown): void {
    const request = this.requests.get(id);
    if (!request || request.finished) return;
    request.finished = true;
    this.totals.unknownUsageRequests -= 1;
    const parsed = usageFrom(usage);
    if (!parsed) {
      this.totals.unknownUsageRequests += 1;
      return;
    }
    for (const field of USAGE_FIELDS) this.totals.usage[field] += parsed[field];
  }

  author(id: string): void {
    if (this.authors.has(id)) return;
    this.authors.add(id);
    this.totals.authorRequests += 1;
  }

  dispatched({ callId, initial }: { callId: string; initial: boolean }): void {
    if (this.dispatches.has(callId)) return;
    this.dispatches.set(callId, { initial, settled: false });
    if (initial) this.totals.initialDispatches += 1;
    else this.totals.continuationDispatches += 1;
  }

  settled({
    callId,
    outcome,
    certified,
  }: { callId: string; outcome: Outcome; certified: boolean }): void {
    const dispatch = this.dispatches.get(callId);
    if (!dispatch || dispatch.settled || outcome === 'pending') return;
    dispatch.settled = true;
    this.totals.outcomes[outcome] = (this.totals.outcomes[outcome] ?? 0) + 1;
    // A certified substitution requires continuation evidence; success is not implied by certification.
    if (!dispatch.initial && certified) this.totals.certifiedSubstitutions += 1;
  }

  fallback(reason: string): void {
    this.totals.fallbacks[reason] = (this.totals.fallbacks[reason] ?? 0) + 1;
  }

  snapshot(): AccountingSnapshot {
    return {
      ...this.totals,
      usage: { ...this.totals.usage },
      fallbacks: { ...this.totals.fallbacks },
      outcomes: { ...this.totals.outcomes },
    };
  }
}
