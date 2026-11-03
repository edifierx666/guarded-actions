// plan.ts - Immutable bounded action graph validation
// No external dependencies; pure validation module

export type NativeTool = 'Read' | 'Bash';

export interface PlanNode {
  readonly id: string;
  readonly after: string | null;
  readonly tool: NativeTool;
  readonly arguments: Record<string, unknown>;
  readonly when: 'start' | 'succeeded';
}

export interface Plan {
  readonly schemaVersion: 1;
  readonly nodes: readonly PlanNode[];
}

export const PLAN_SCHEMA = {
  type: 'object',
  required: ['schemaVersion', 'nodes'],
  additionalProperties: false,
  properties: {
    schemaVersion: {
      type: 'number',
      const: 1,
      description: 'Plan protocol version; must be 1'
    },
    nodes: {
      type: 'array',
      minItems: 2,
      maxItems: 8,
      description: 'Confirmed necessary actions with fixed parameters',
      items: {
        type: 'object',
        required: ['id', 'after', 'tool', 'arguments', 'when'],
        additionalProperties: false,
        properties: {
          id: {
            type: 'string',
            pattern: '^[-a-zA-Z0-9_]{1,32}$',
            description: 'Unique node identifier'
          },
          after: {
            type: ['string', 'null'],
            pattern: '^[-a-zA-Z0-9_]{1,32}$',
            description: 'Predecessor node ID; null for root'
          },
          tool: {
            type: 'string',
            enum: ['Read', 'Bash'],
            description: 'Native tool name'
          },
          arguments: {
            type: 'object',
            description: 'Fixed tool parameters'
          },
          when: {
            type: 'string',
            enum: ['start', 'succeeded'],
            description: 'Dispatch condition'
          }
        }
      }
    }
  }
} as const;

export const PLAN_DESCRIPTION = 
  'Submit a bounded action graph with fixed parameters. ' +
  'Call this tool alone in a response, never alongside other tools. It stages a plan; does not execute or grant permission. ' +
  'Subsequent actions run only after native completion. Final response or unknown info needs normal reasoning. ' +
  'Only submit if: (1) at least two actions are truly needed and already decided; (2) all parameters are known now; ' +
  '(3) no dynamic conditions or placeholders. Root node has after=null and when=start; dependent nodes reference ' +
  'earlier IDs and use when=succeeded. Supported tools: Read (file_path, offset?, limit?, pages?, allow_large?), ' +
  'Bash (command, description?, timeout?). Do not add extra checks or commands just to use this tool.';

interface ValidationContext {
  seenIds: Record<string, true>;
  nodeIndex: Record<string, number>;
}

const ID_PATTERN = /^[-a-zA-Z0-9_]{1,32}$/;

export function validatePlan(value: unknown): 
  | { ok: true; plan: Plan }
  | { ok: false; reason: string } {
  
  if (!isObject(value)) {
    return { ok: false, reason: 'Plan must be an object' };
  }

  try {
    const serialized = JSON.stringify(value);
    if (new TextEncoder().encode(serialized).length > 16384) return { ok: false, reason: 'plan_too_large' };
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }
  if (Object.keys(value).some(key => key !== 'schemaVersion' && key !== 'nodes')) return { ok: false, reason: 'unexpected_plan_field' };

  if (value.schemaVersion !== 1) {
    return { ok: false, reason: 'schemaVersion must be 1' };
  }

  if (!Array.isArray(value.nodes)) {
    return { ok: false, reason: 'nodes must be an array' };
  }

  const nodes = value.nodes;
  if (nodes.length < 2 || nodes.length > 8) {
    return { ok: false, reason: `nodes must contain 2-8 items` };
  }

  const ctx: ValidationContext = {
    seenIds: Object.create(null),
    nodeIndex: Object.create(null)
  };

  const validatedNodes: PlanNode[] = [];

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    
    if (!isObject(node)) {
      return { ok: false, reason: `Node ${i} is not an object` };
    }

    const allowedNodeKeys: Record<string, true> = {
      id: true,
      after: true,
      tool: true,
      arguments: true,
      when: true
    };
    for (const key of Object.keys(node)) {
      if (!Object.hasOwn(allowedNodeKeys, key)) {
        return { ok: false, reason: `Node ${i}: unexpected property '${key}'` };
      }
    }

    if (typeof node.id !== 'string') {
      return { ok: false, reason: `Node ${i}: id must be string` };
    }
    if (!ID_PATTERN.test(node.id)) {
      return { ok: false, reason: `Node ${i}: id '${node.id}' invalid format` };
    }
    if (ctx.seenIds[node.id]) {
      return { ok: false, reason: `Duplicate node id: '${node.id}'` };
    }

    ctx.seenIds[node.id] = true;
    ctx.nodeIndex[node.id] = i;

    if (node.after !== null && typeof node.after !== 'string') {
      return { ok: false, reason: `Node ${i}: after must be null or string` };
    }
    if (typeof node.after === 'string' && !ID_PATTERN.test(node.after)) {
      return { ok: false, reason: `Node ${i}: after invalid format` };
    }

    if (node.tool !== 'Read' && node.tool !== 'Bash') {
      return { ok: false, reason: `Node ${i}: tool must be Read or Bash` };
    }

    if (!isObject(node.arguments)) {
      return { ok: false, reason: `Node ${i}: arguments must be object` };
    }

    if (node.when !== 'start' && node.when !== 'succeeded') {
      return { ok: false, reason: `Node ${i}: when must be start or succeeded` };
    }

    if (i === 0) {
      if (node.after !== null) {
        return { ok: false, reason: `Root node must have after=null` };
      }
      if (node.when !== 'start') {
        return { ok: false, reason: `Root node must have when=start` };
      }
    } else {
      if (node.after === null) {
        return { ok: false, reason: `Non-root node ${i} must have after` };
      }
      if (node.when !== 'succeeded') {
        return { ok: false, reason: `Non-root node ${i} must have when=succeeded` };
      }
    }

    const argsCheck = node.tool === 'Read' 
      ? validateReadArguments(node.arguments, node.id)
      : validateBashArguments(node.arguments, node.id);
    
    if (!argsCheck.ok) {
      return argsCheck;
    }

    validatedNodes.push({
      id: node.id,
      after: node.after,
      tool: node.tool as NativeTool,
      arguments: deepFreezeArgs(node.arguments),
      when: node.when as 'start' | 'succeeded'
    });
  }

  for (let i = 0; i < validatedNodes.length; i++) {
    const node = validatedNodes[i];
    if (!node) continue;
    
    if (node.after !== null) {
      const depIndex = ctx.nodeIndex[node.after];
      if (depIndex === undefined) {
        return { ok: false, reason: `Node ${i}: depends on unknown '${node.after}'` };
      }
      if (depIndex >= i) {
        return { ok: false, reason: `Node ${i}: depends on non-earlier '${node.after}'` };
      }
    }
  }

  return {
    ok: true,
    plan: {
      schemaVersion: 1,
      nodes: Object.freeze(validatedNodes.map(n => Object.freeze(n)))
    }
  };
}

function validateReadArguments(args: Record<string, unknown>, nodeId: string): 
  | { ok: true }
  | { ok: false; reason: string } {
  
  const allowedKeys: Record<string, true> = {
    file_path: true,
    offset: true,
    limit: true,
    pages: true,
    allow_large: true
  };
  for (const key of Object.keys(args)) {
    if (!Object.hasOwn(allowedKeys, key)) {
      return { ok: false, reason: `Node ${nodeId}: Read unexpected argument '${key}'` };
    }
  }

  if (typeof args.file_path !== 'string' || args.file_path.length === 0) {
    return { ok: false, reason: `Node ${nodeId}: Read file_path required` };
  }

  const path = args.file_path;
  const isAbsolute = path.startsWith('/') || /^[a-zA-Z]:[/\\]/.test(path);
  if (!isAbsolute) {
    return { ok: false, reason: `Node ${nodeId}: Read file_path must be absolute` };
  }

  if (args.offset !== undefined) {
    if (!Number.isInteger(args.offset) || (args.offset as number) < 1) {
      return { ok: false, reason: `Node ${nodeId}: Read offset must be integer >= 1` };
    }
  }

  if (args.limit !== undefined) {
    if (!Number.isInteger(args.limit) || (args.limit as number) < 1) {
      return { ok: false, reason: `Node ${nodeId}: Read limit must be positive integer` };
    }
  }

  if (args.pages !== undefined) {
    if (typeof args.pages !== 'string' || args.pages.length === 0) {
      return { ok: false, reason: `Node ${nodeId}: Read pages must be nonempty string` };
    }
  }

  if (args.allow_large !== undefined) {
    if (typeof args.allow_large !== 'boolean') {
      return { ok: false, reason: `Node ${nodeId}: Read allow_large must be boolean` };
    }
  }

  return { ok: true };
}

function validateBashArguments(args: Record<string, unknown>, nodeId: string):
  | { ok: true }
  | { ok: false; reason: string } {
  
  const allowedKeys: Record<string, true> = {
    command: true,
    description: true,
    timeout: true,
    run_in_background: true,
    dangerouslyDisableSandbox: true
  };
  for (const key of Object.keys(args)) {
    if (!Object.hasOwn(allowedKeys, key)) {
      return { ok: false, reason: `Node ${nodeId}: Bash unexpected argument '${key}'` };
    }
  }

  if (typeof args.command !== 'string' || args.command.length === 0) {
    return { ok: false, reason: `Node ${nodeId}: Bash command required` };
  }

  if (args.description !== undefined && typeof args.description !== 'string') {
    return { ok: false, reason: `Node ${nodeId}: Bash description must be string` };
  }

  if (args.timeout !== undefined) {
    if (!Number.isInteger(args.timeout) || 
        (args.timeout as number) < 1 || 
        (args.timeout as number) > 600000) {
      return { ok: false, reason: `Node ${nodeId}: Bash timeout must be 1-600000` };
    }
  }

  if (args.run_in_background !== undefined) {
    if (args.run_in_background !== false) {
      return { ok: false, reason: `Node ${nodeId}: Bash run_in_background only false allowed` };
    }
  }

  if (args.dangerouslyDisableSandbox !== undefined) {
    if (args.dangerouslyDisableSandbox !== false) {
      return { ok: false, reason: `Node ${nodeId}: Bash dangerouslyDisableSandbox only false allowed` };
    }
  }

  return { ok: true };
}

export function stableJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }

  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    const entries = keys.map(key => [key, sortKeys((value as Record<string, unknown>)[key])] as const);
    return Object.fromEntries(entries);
  }

  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepFreezeArgs(value: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    copy[k] = deepCopyAndFreeze(v);
  }
  return Object.freeze(copy);
}

function deepCopyAndFreeze(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  
  if (Array.isArray(value)) {
    const arr = value.map(deepCopyAndFreeze);
    Object.freeze(arr);
    return arr;
  }
  
  if (typeof value === 'object') {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      obj[k] = deepCopyAndFreeze(v);
    }
    Object.freeze(obj);
    return obj;
  }
  
  return value;
}
