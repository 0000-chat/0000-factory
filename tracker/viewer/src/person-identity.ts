import type { SnapshotRecord } from './snapshot';

/**
 * The roster fields used by identity resolution. The tracker snapshot keeps
 * team entries open ended, so callers can retain their own record fields.
 */
export type PersonRecord = SnapshotRecord;

const STABLE_FIELDS = ['id', 'slug', 'handle', 'githubHandle'] as const;
const HUMAN_FIELDS = ['name', 'fullName'] as const;
const SPECIAL_IDENTITIES = new Set([
  '',
  '-',
  '—',
  '?',
  'na',
  'n/a',
  'none',
  'null',
  'undefined',
  'unknown',
  'unassigned',
  '__unassigned__',
]);

function textValue(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

/** Normalize a stable roster key without deleting punctuation. */
export function normalizePersonIdentity(value: unknown): string {
  return textValue(value).replace(/^@/u, '').toLocaleLowerCase();
}

function normalizeHumanName(value: unknown): string {
  return textValue(value).replace(/\s+/gu, ' ').toLocaleLowerCase();
}

function isSpecialIdentity(value: unknown): boolean {
  return SPECIAL_IDENTITIES.has(normalizePersonIdentity(value));
}

function valuesFor(record: PersonRecord, fields: readonly string[]): string[] {
  return fields.map(field => textValue(record[field])).filter(Boolean);
}

function aliasesFor(record: PersonRecord): string[] {
  const aliases = record.aliases;
  return Array.isArray(aliases) ? aliases.map(textValue).filter(Boolean) : [];
}

function stableValuesFor(record: PersonRecord): string[] {
  return valuesFor(record, STABLE_FIELDS).map(normalizePersonIdentity).filter(Boolean);
}

function humanValuesFor(record: PersonRecord): string[] {
  return [
    ...valuesFor(record, HUMAN_FIELDS),
    ...aliasesFor(record),
  ].map(normalizeHumanName).filter(Boolean);
}

function uniqueRecords<T extends PersonRecord>(records: readonly T[]): T[] {
  return [...new Set(records)];
}

/**
 * Return a canonical route slug for a resolved roster record.
 *
 * The generated roster normally always has `slug`; the stable fallbacks keep
 * this helper useful for older snapshots and isolated component tests.
 */
export function personSlug(person: PersonRecord | null | undefined): string | null {
  if (!person) return null;
  for (const field of ['slug', 'id', 'handle', 'githubHandle']) {
    const value = textValue(person[field]);
    if (value && !isSpecialIdentity(value)) return value;
  }
  return null;
}

/**
 * Resolve a recorded owner to exactly one roster record.
 *
 * Stable ids are checked before human names. A stable key that occurs on more
 * than one record is ambiguous even when the optional display name points at
 * one of those records. The optional name is only considered when the primary
 * value is absent; this prevents an unknown explicit handle from being
 * silently relinked through an ownerName field.
 */
export function resolvePerson<T extends PersonRecord>(
  team: readonly T[] | null | undefined,
  value: string | null | undefined,
  name?: string | null,
): T | null {
  const records = Array.isArray(team) ? team : [];
  const normalizedValue = normalizePersonIdentity(value);
  if (normalizedValue && isSpecialIdentity(value)) return null;

  if (normalizedValue) {
    const stableMatches = uniqueRecords(
      records.filter(record => stableValuesFor(record).includes(normalizedValue)),
    );
    if (stableMatches.length === 1) return stableMatches[0];
    if (stableMatches.length > 1) return null;
  }

  // A provided owner value is authoritative for fallback purposes. Only use
  // ownerName when there is no value to resolve, never for an unknown handle.
  const humanValue = textValue(value) || textValue(name);
  if (!humanValue || isSpecialIdentity(humanValue)) return null;
  const normalizedHumanValue = normalizeHumanName(humanValue);
  if (!normalizedHumanValue) return null;

  const humanMatches = uniqueRecords(
    records.filter(record => humanValuesFor(record).includes(normalizedHumanValue)),
  );
  return humanMatches.length === 1 ? humanMatches[0] : null;
}

export interface PersonMentionSegment<T extends PersonRecord = PersonRecord> {
  readonly text: string;
  readonly person: T | null;
}

function isMentionBoundary(value: string | undefined): boolean {
  return value === undefined || !/[\p{L}\p{N}_.+\-@]/u.test(value);
}

function isWordBoundary(value: string | undefined): boolean {
  return value === undefined || !/[\p{L}\p{N}_-]/u.test(value);
}

function appendSegment<T extends PersonRecord>(
  segments: PersonMentionSegment<T>[],
  text: string,
  person: T | null,
): void {
  if (!text) return;
  const previous = segments.at(-1);
  if (previous && previous.person === person) {
    segments[segments.length - 1] = { text: previous.text + text, person };
    return;
  }
  segments.push({ text, person });
}

function backtickRunLength(source: string, index: number): number {
  let length = 0;
  while (source[index + length] === '`') length += 1;
  return length;
}

function matchingBacktickSpan(source: string, index: number): number | null {
  const length = backtickRunLength(source, index);
  if (length === 0) return null;
  let cursor = index + length;
  while (cursor < source.length) {
    if (source[cursor] !== '`') {
      cursor += 1;
      continue;
    }
    const closingLength = backtickRunLength(source, cursor);
    if (closingLength === length) return cursor + closingLength;
    cursor += closingLength;
  }
  return source.length;
}

function protectedSpanAt(source: string, index: number): number | null {
  if (source[index] === '`') return matchingBacktickSpan(source, index);
  const url = /^(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/|www\.)[^\s<>()]+/iu.exec(source.slice(index));
  if (url) return index + url[0].length;

  const email = /^[^\s<>()]+@[^\s<>()]+/u.exec(source.slice(index));
  if (email) return index + email[0].length;

  const path = /^(?:\.\/|\/)?(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+(?:[?#][^\s<>()]*)?/u.exec(source.slice(index));
  return path ? index + path[0].length : null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

interface MentionCandidate {
  readonly value: string;
  readonly caseSensitive: boolean;
}

function mentionCandidates<T extends PersonRecord>(team: readonly T[] | null | undefined): MentionCandidate[] {
  const records = Array.isArray(team) ? team : [];
  const candidates = records.flatMap(record => [
    ...valuesFor(record, HUMAN_FIELDS).map(value => ({ value, human: true })),
    ...aliasesFor(record).map(value => ({ value, human: true })),
    ...valuesFor(record, STABLE_FIELDS).map(value => ({ value, human: false })),
  ]).filter(candidate => candidate.value && !isSpecialIdentity(candidate.value) && !candidate.value.includes('\n'));
  const uniqueCandidates = new Map<string, { value: string; human: boolean }>();
  for (const candidate of candidates) {
    const key = normalizeHumanName(candidate.value);
    if (!key) continue;
    const current = uniqueCandidates.get(key);
    if (!current) uniqueCandidates.set(key, candidate);
    else if (candidate.human && !current.human) uniqueCandidates.set(key, candidate);
  }
  return [...uniqueCandidates.values()]
    .map(candidate => ({
      value: candidate.value,
      // Ordinary prose should retain the capitalization signal for any
      // single-word human name. Distinctive stable handles remain useful when
      // copied with a different case; short stable keys stay exact.
      caseSensitive: /\S/u.test(candidate.value)
        && !/\s/u.test(candidate.value)
        && !/[._-]/u.test(candidate.value)
        && (candidate.human || candidate.value.length < 8),
    }))
    .sort((left, right) => right.value.length - left.value.length);
}

function candidateEndAt(source: string, index: number, candidate: MentionCandidate): number | null {
  if (candidate.value.startsWith('@')) return null;
  const parts = candidate.value.trim().split(/\s+/u).map(escapeRegExp);
  if (parts.length === 0 || parts.some(part => part.length === 0)) return null;
  const match = new RegExp(`^${parts.join('\\s+')}`, candidate.caseSensitive ? 'u' : 'iu').exec(source.slice(index));
  if (!match) return null;
  const end = index + match[0].length;
  if (!isWordBoundary(source[index - 1]) || !isWordBoundary(source[end])) return null;
  return end;
}

/**
 * Split plain prose into safe mention candidates for a later renderer.
 * Mentions inside code spans, fenced code, and URL text remain ordinary text.
 */
export function segmentPersonMentions<T extends PersonRecord>(
  source: string,
  team: readonly T[] | null | undefined,
): readonly PersonMentionSegment<T>[] {
  const value = String(source ?? '');
  if (!value) return [];

  const segments: PersonMentionSegment<T>[] = [];
  const candidates = mentionCandidates(team);
  let plainStart = 0;
  let index = 0;
  const flushPlain = (end: number) => {
    appendSegment(segments, value.slice(plainStart, end), null);
  };

  while (index < value.length) {
    const protectedEnd = protectedSpanAt(value, index);
    if (protectedEnd !== null) {
      flushPlain(index);
      appendSegment(segments, value.slice(index, protectedEnd), null);
      index = protectedEnd;
      plainStart = index;
      continue;
    }

    if (value[index] === '@' && isMentionBoundary(value[index - 1])) {
      const match = /^@[A-Za-z0-9][A-Za-z0-9._-]*/u.exec(value.slice(index));
      if (match) {
        const token = match[0];
        const person = resolvePerson(team, token);
        if (person) {
          flushPlain(index);
          appendSegment(segments, token, person);
          index += token.length;
          plainStart = index;
          continue;
        }
      }
    }

    let matchedCandidate = false;
    for (const candidate of candidates) {
      const end = candidateEndAt(value, index, candidate);
      if (end === null) continue;
      const matchedText = value.slice(index, end);
      const person = resolvePerson(team, matchedText);
      if (!person) continue;
      flushPlain(index);
      appendSegment(segments, matchedText, person);
      index = end;
      plainStart = index;
      matchedCandidate = true;
      break;
    }
    if (matchedCandidate) continue;
    index += 1;
  }

  flushPlain(value.length);
  return segments;
}
