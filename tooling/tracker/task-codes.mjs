import { createHash } from 'node:crypto';

// The version and alphabet are part of the public reference format. Keep them
// stable so a task's code remains usable when records are reordered or views
// are rebuilt.
export const TASK_CODE_VERSION = 'v1';
export const TASK_CODE_PREFIX = 'T';
export const TASK_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const TASK_CODE_LENGTH = 6;

const CODE_SPACE = BigInt(TASK_CODE_ALPHABET.length) ** BigInt(TASK_CODE_LENGTH);

function canonicalId(id) {
  if (typeof id !== 'string' || id.trim() === '') throw new TypeError('task reference codes require a non-empty canonical ID');
  return id.trim();
}

/** Derive a deterministic human-friendly code from one immutable canonical ID. */
export function taskCodeForId(id) {
  const canonical = canonicalId(id);
  const digest = createHash('sha256')
    .update(`${TASK_CODE_VERSION}\0${canonical}`, 'utf8')
    .digest();
  let value = 0n;
  for (const byte of digest.subarray(0, 8)) value = (value << 8n) | BigInt(byte);
  value %= CODE_SPACE;

  let suffix = '';
  const alphabetSize = BigInt(TASK_CODE_ALPHABET.length);
  for (let index = 0; index < TASK_CODE_LENGTH; index += 1) {
    suffix = TASK_CODE_ALPHABET[Number(value % alphabetSize)] + suffix;
    value /= alphabetSize;
  }
  return `${TASK_CODE_PREFIX}-${suffix}`;
}

function itemId(item) {
  return typeof item === 'string' ? item : item?.data?.id ?? item?.id;
}

/**
 * Build the canonical code index and fail loudly if the frozen short format
 * ever maps two different IDs to the same code.
 */
export function taskCodeIndex(items = []) {
  const byCode = new Map();
  for (const item of items) {
    const id = canonicalId(itemId(item));
    const code = taskCodeForId(id);
    const existing = byCode.get(code);
    if (existing !== undefined && existing !== id) {
      throw new Error(`task reference code collision: ${code} maps to both ${existing} and ${id}`);
    }
    byCode.set(code, id);
  }
  return byCode;
}

/** Resolve either an exact canonical ID or a case-insensitive short code. */
export function resolveTaskReference(reference, items = []) {
  const value = canonicalId(reference);
  const ids = new Set(items.map(itemId).filter(id => typeof id === 'string'));
  if (ids.has(value)) return value;
  const idByCode = new Map([...taskCodeIndex(items)].map(([code, id]) => [code.toUpperCase(), id]));
  return idByCode.get(value.toUpperCase()) ?? null;
}
