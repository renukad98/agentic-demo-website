import { createHash } from 'node:crypto';
import type { Sha256Digest } from './contracts/approval.js';

export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

function canonicalValue(value: unknown, ancestors: ReadonlySet<object>): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Operation payload numbers must be finite.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new TypeError('Operation payload cannot contain cycles.');
    const nextAncestors = new Set(ancestors).add(value);
    return `[${value.map((item) => canonicalValue(item, nextAncestors)).join(',')}]`;
  }
  if (typeof value !== 'object' || value === undefined) {
    throw new TypeError('Operation payload must contain only JSON values.');
  }
  if (ancestors.has(value)) throw new TypeError('Operation payload cannot contain cycles.');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Operation payload objects must be plain JSON objects.');
  }
  const nextAncestors = new Set(ancestors).add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors).sort();
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !('value' in descriptor)) {
      throw new TypeError('Operation payload cannot contain accessors or hidden properties.');
    }
  }
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalValue(descriptors[key]!.value, nextAncestors)}`).join(',')}}`;
}

/** Stable JSON serialization for the exact operation payload shown to the approver. */
export function canonicalizeJson(value: unknown): string {
  return canonicalValue(value, new Set());
}

export function digestOperationPayload(value: unknown): Sha256Digest {
  const digest = createHash('sha256').update(canonicalizeJson(value), 'utf8').digest('hex');
  return `sha256:${digest}`;
}

