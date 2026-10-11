import { decisionPath, encodePathSegment, teamPath, workItemPath } from './navigation';
import { buildTeamDirectory } from './team-model.mjs';
import type { SnapshotRecord, TrackerDecision, TrackerItem, TrackerPlan, TrackerSnapshot } from './snapshot';

export type SearchKind = 'work' | 'plan' | 'decision' | 'person';

export interface SearchResult {
  kind: SearchKind;
  id: string;
  title: string;
  subtitle: string;
  href: string;
  referenceCode?: string;
}

export interface SearchGroup {
  kind: SearchKind;
  label: string;
  total: number;
  results: SearchResult[];
}

interface SearchCandidate {
  result: SearchResult;
  fields: string[];
  exactFields: string[];
  prefixFields: string[];
}

interface RankedResult {
  result: SearchResult;
  rank: number;
}

const MAX_RESULTS_PER_GROUP = 8;

const GROUPS = [
  { kind: 'work', label: 'Work' },
  { kind: 'plan', label: 'Plans' },
  { kind: 'decision', label: 'Decisions' },
  { kind: 'person', label: 'People' },
] satisfies { kind: SearchKind; label: string }[];

function text(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function textValues(...values: unknown[]): string[] {
  return values.map(text).filter(value => value.length > 0);
}

function arrayTextValues(value: unknown): string[] {
  return Array.isArray(value) ? value.flatMap(entry => textValues(entry)) : [];
}

function firstText(...values: unknown[]): string {
  return textValues(...values)[0] ?? '';
}

function normalized(value: string): string {
  return value.toLowerCase().trim().split(/\s+/u).filter(Boolean).join(' ');
}

function recordText(record: SnapshotRecord, ...keys: string[]): string[] {
  return keys.flatMap(key => textValues(record[key]));
}

function titleCase(value: string): string {
  return value
    .replaceAll('-', ' ')
    .replaceAll('_', ' ')
    .replace(/\b\w/gu, letter => letter.toUpperCase());
}

function workSubtitle(item: TrackerItem): string {
  const status = text(item.status).toLowerCase().replaceAll('_', '-').replaceAll(' ', '-');
  const commitment = text(item.commitment).toLowerCase();

  if (item.archived === true || status === 'archived') return 'Archived';
  if (item.completed === true || ['done', 'completed'].includes(status)) return 'Completed';
  if (commitment === 'draft') return 'Draft';
  if (commitment === 'planned') return 'Planned';
  if (commitment === 'accepted') return status ? `Accepted · ${titleCase(status)}` : 'Accepted';
  return titleCase(commitment || status) || 'Work';
}

function candidate(
  result: SearchResult,
  fields: string[],
  exactFields: string[],
  prefixFields: string[],
): SearchCandidate {
  return { result, fields, exactFields, prefixFields };
}

function workCandidate(item: TrackerItem): SearchCandidate {
  const id = text(item.id);
  const title = firstText(item.title, id) || 'Untitled work';
  const ownerFields = [...recordText(item, 'ownerName', 'owner')];
  const nameFields = [...recordText(item, 'name')];
  const referenceCode = text(item.referenceCode);

  return candidate({
    kind: 'work',
    id,
    title,
    subtitle: workSubtitle(item),
    href: workItemPath(id),
    referenceCode,
  }, [id, title, referenceCode, ...nameFields, ...ownerFields], [id, title, referenceCode, ...nameFields, ...ownerFields], [title, ...nameFields]);
}

function planCandidate(plan: TrackerPlan): SearchCandidate {
  const id = text(plan.id);
  const title = firstText(plan.title, id) || 'Untitled plan';
  const nameFields = recordText(plan, 'name');
  const ownerFields = recordText(plan, 'ownerName', 'owner');
  const exactFields = [id, title, ...nameFields, ...ownerFields];

  return candidate({
    kind: 'plan',
    id,
    title,
    subtitle: titleCase(text(plan.status)) || 'Plan',
    href: `/plans/${encodePathSegment(id)}`,
  }, [id, title, ...nameFields, ...ownerFields], exactFields, [title, ...nameFields]);
}

function decisionCandidate(decision: TrackerDecision): SearchCandidate {
  const id = text(decision.id);
  const title = firstText(decision.title, id) || 'Untitled decision';
  const nameFields = recordText(decision, 'name');
  const ownerFields = recordText(decision, 'ownerName', 'owner');
  const exactFields = [id, title, ...nameFields, ...ownerFields];

  return candidate({
    kind: 'decision',
    id,
    title,
    subtitle: titleCase(text(decision.state)) || 'Decision',
    href: decisionPath(id),
  }, [id, title, ...nameFields, ...ownerFields], exactFields, [title, ...nameFields]);
}

function isRecord(value: unknown): value is SnapshotRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function personCandidates(data: TrackerSnapshot): SearchCandidate[] {
  const profiles = Array.isArray(data.team) ? data.team.filter(isRecord) : [];
  const items = Array.isArray(data.items) ? data.items.filter(isRecord) : [];
  const directory: SnapshotRecord[] = buildTeamDirectory(profiles, items).filter(isRecord);

  return directory.flatMap(profile => {
    const id = firstText(profile.id, profile.slug, profile.handle, profile.githubHandle);
    const slug = firstText(profile.slug, profile.id, profile.handle, profile.githubHandle);
    if (!id || !slug) return [];

    const names = [
      ...recordText(profile, 'name', 'fullName'),
      ...arrayTextValues(profile.aliases),
    ];
    const handles = recordText(profile, 'handle', 'githubHandle');
    const stableIds = recordText(profile, 'id', 'slug');
    const title = firstText(profile.name, profile.fullName, ...handles, id) || 'Team member';
    const organization = firstText(...arrayTextValues(profile.organizations), profile.organization);
    const subtitle = firstText(profile.directoryRole, profile.current, organization) || 'Team member';
    const identityFields = [...stableIds, ...handles, ...names];

    return [candidate({
      kind: 'person',
      id,
      title,
      subtitle,
      href: teamPath(slug),
    }, identityFields, identityFields, names.length > 0 ? names : [title])];
  });
}

function rankCandidate(candidateValue: SearchCandidate, query: string, tokens: string[]): RankedResult | null {
  const fields = candidateValue.fields.map(normalized).filter(Boolean);
  if (!tokens.every(token => fields.some(field => field.includes(token)))) return null;

  const exact = candidateValue.exactFields.some(field => normalized(field) === query);
  if (exact) return { result: candidateValue.result, rank: 0 };

  const prefix = candidateValue.prefixFields.some(field => normalized(field).startsWith(query));
  return { result: candidateValue.result, rank: prefix ? 1 : 2 };
}

function compareText(left: string, right: string): number {
  const normalizedLeft = normalized(left);
  const normalizedRight = normalized(right);
  if (normalizedLeft < normalizedRight) return -1;
  if (normalizedLeft > normalizedRight) return 1;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareRankedResults(left: RankedResult, right: RankedResult): number {
  return left.rank - right.rank
    || compareText(left.result.title, right.result.title)
    || compareText(left.result.id, right.result.id);
}

/** Search every current snapshot record, independent of the viewer's active filters. */
export function searchSnapshot(data: TrackerSnapshot, query: string): SearchGroup[] {
  const normalizedQuery = normalized(query);
  if (!normalizedQuery) return [];
  const tokens = normalizedQuery.split(' ');

  const candidatesByKind: Record<SearchKind, SearchCandidate[]> = {
    work: data.items.filter(item => text(item.id).length > 0).map(workCandidate),
    plan: data.plans.filter(plan => text(plan.id).length > 0).map(planCandidate),
    decision: data.decisions.filter(decision => text(decision.id).length > 0).map(decisionCandidate),
    person: personCandidates(data),
  };

  return GROUPS.flatMap(({ kind, label }) => {
    const ranked = candidatesByKind[kind]
      .map(item => rankCandidate(item, normalizedQuery, tokens))
      .filter((item): item is RankedResult => item !== null)
      .sort(compareRankedResults);
    if (ranked.length === 0) return [];
    return [{ kind, label, total: ranked.length, results: ranked.slice(0, MAX_RESULTS_PER_GROUP).map(item => item.result) }];
  });
}
