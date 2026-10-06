import { getScopeItems, isAccepted } from './view-model.mjs';
import { workItemPath } from './navigation';
import { UNASSIGNED_OWNER } from './routing-state';
import {
  parseReportsSearch,
  type ReportsFilterOptions,
  type ReportsSearch,
} from './reports-state';
import type { SnapshotRecord, TrackerItem, TrackerSnapshot } from './snapshot';

export type ReportScheduleCoverage = 'approved-baseline-only' | 'forecast-only' | 'both' | 'none';
export type ReportHealthState = 'on-track' | 'at-risk' | 'blocked' | 'unknown';

export interface ReportOwnerChoice {
  readonly value: string;
  readonly label: string;
}

export interface ReportOptions extends ReportsFilterOptions {
  readonly ownerChoices: ReportOwnerChoice[];
}

export interface ReportsSupportRecord {
  readonly id: string;
  readonly title: string;
  readonly href: string;
  readonly status: string;
  readonly completed: boolean;
  readonly ownerKey: string;
  readonly ownerLabel: string;
  readonly profileName: string | null;
  readonly profileSlug: string | null;
  readonly health: ReportHealthState;
  readonly blocked: boolean;
  readonly scheduleCoverage: ReportScheduleCoverage;
  readonly progressScoped: boolean;
  readonly progressPercent: number | null;
}

export interface ReportCount {
  readonly key: string;
  readonly count: number;
}

export interface ReportHealthCounts {
  readonly 'on-track': number;
  readonly 'at-risk': number;
  readonly blocked: number;
  readonly unknown: number;
}

export interface ReportScheduleCounts {
  readonly 'approved-baseline-only': number;
  readonly 'forecast-only': number;
  readonly both: number;
  readonly none: number;
}

export interface ReportProgressCounts {
  readonly scoped: number;
  readonly unknown: number;
}

export interface ReportAssignment {
  readonly ownerKey: string;
  readonly ownerLabel: string;
  readonly profileName: string | null;
  readonly profileSlug: string | null;
  readonly recordCount: number;
  readonly blockedCount: number;
  readonly unscheduledCount: number;
  readonly records: ReportsSupportRecord[];
}

export interface ReportsProjection {
  readonly filters: ReportsSearch;
  readonly recordCount: number;
  readonly excludedAcceptedParentCount: number;
  readonly records: ReportsSupportRecord[];
  readonly excludedAcceptedParents: ReportsSupportRecord[];
  readonly statusCounts: ReportCount[];
  readonly healthCounts: ReportHealthCounts;
  readonly blockedCount: number;
  readonly unassignedCount: number;
  readonly scheduleCounts: ReportScheduleCounts;
  readonly progressCounts: ReportProgressCounts;
  readonly assignments: ReportAssignment[];
}

interface OwnerProfile {
  readonly name: string;
  readonly slug: string;
}

function cleanText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text.length === 0 || text === '-' ? undefined : text;
}

function normalizedStatus(value: unknown): string {
  return cleanText(value) ?? 'unknown';
}

function normalizedOwner(value: unknown): string {
  const owner = cleanText(value);
  return owner === undefined || owner.toLowerCase() === 'unassigned'
    ? UNASSIGNED_OWNER
    : owner;
}

function isCompleted(item: TrackerItem): boolean {
  const status = cleanText(item.status)?.toLowerCase();
  return item.completed === true
    || item.archived === true
    || status === 'done'
    || status === 'completed'
    || status === 'archived';
}

function isRecord(value: unknown): value is SnapshotRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasRecordedBlocker(item: TrackerItem): boolean {
  return (cleanText(item.sections?.blocker) !== undefined)
    || (Array.isArray(item.blockers) && item.blockers.length > 0);
}

function isBlocked(item: TrackerItem): boolean {
  return cleanText(item.status)?.toLowerCase() === 'blocked' || hasRecordedBlocker(item);
}

function healthState(item: TrackerItem): ReportHealthState {
  const value = cleanText(item.health?.state)?.toLowerCase().replaceAll('_', '-').replaceAll(' ', '-');
  return value === 'on-track' || value === 'at-risk' || value === 'blocked' || value === 'unknown'
    ? value
    : 'unknown';
}

function dateMillis(value: unknown): number | null {
  const candidate = cleanText(value);
  if (candidate === undefined || !/^\d{4}-\d{2}-\d{2}$/u.test(candidate)) return null;
  const [year, month, day] = candidate.split('-').map(Number);
  const valueAtUtc = Date.UTC(year, month - 1, day);
  const date = new Date(valueAtUtc);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? valueAtUtc
    : null;
}

function hasInterval(start: unknown, end: unknown): boolean {
  const startAt = dateMillis(start);
  const endAt = dateMillis(end);
  return startAt !== null && endAt !== null && endAt >= startAt;
}

function scheduleCoverage(item: TrackerItem): ReportScheduleCoverage {
  const schedule: Record<string, unknown> = isRecord(item.schedule) ? item.schedule : {};
  const baseline = schedule.approved === true
    && hasInterval(schedule.plannedStart ?? schedule.planned_start, schedule.plannedEnd ?? schedule.planned_end);
  const forecastEnd = schedule.forecastEndMax ?? schedule.forecastEndMin
    ?? schedule.forecast_end_max ?? schedule.forecast_end_min;
  const forecast = hasInterval(schedule.forecastStart ?? schedule.forecast_start, forecastEnd);
  if (baseline && forecast) return 'both';
  if (baseline) return 'approved-baseline-only';
  if (forecast) return 'forecast-only';
  return 'none';
}

function normalizedIdentity(value: unknown): string {
  return String(value ?? '')
    .trim()
    .replace(/^@/u, '')
    .toLocaleLowerCase();
}

function rosterProfiles(data: TrackerSnapshot): Map<string, OwnerProfile | null> {
  const candidates = new Map<string, OwnerProfile[]>();
  for (const profile of data.team) {
    const name = cleanText(profile.name);
    const slug = cleanText(profile.slug);
    if (!name || !slug) continue;
    const uniqueValues = new Set([profile.id, profile.slug, profile.handle, profile.githubHandle]
      .map(normalizedIdentity)
      .filter(Boolean));
    for (const value of uniqueValues) {
      const matches = candidates.get(value) ?? [];
      matches.push({ name, slug });
      candidates.set(value, matches);
    }
  }
  return new Map([...candidates].map(([key, matches]) => [key, matches.length === 1 ? matches[0] : null]));
}

function matchedProfile(owner: string, profiles: ReadonlyMap<string, OwnerProfile | null>): OwnerProfile | null {
  if (owner === UNASSIGNED_OWNER) return null;
  return profiles.get(normalizedIdentity(owner)) ?? null;
}

function labelForOwner(key: string, profiles: ReadonlyMap<string, OwnerProfile | null>): string {
  if (key === UNASSIGNED_OWNER) return 'Unassigned';
  const profile = matchedProfile(key, profiles);
  return profile?.name ?? key;
}

function ownerChoicesFrom(data: TrackerSnapshot, profiles: ReadonlyMap<string, OwnerProfile | null>): ReportOwnerChoice[] {
  const keys = new Set(data.items.map(item => normalizedOwner(item.owner)));
  return [...keys]
    .map(value => ({ value, label: labelForOwner(value, profiles) }))
    .sort((left, right) => left.label.localeCompare(right.label) || left.value.localeCompare(right.value));
}

export function reportFilterOptions(data: TrackerSnapshot): ReportOptions {
  const profiles = rosterProfiles(data);
  const ownerChoices = ownerChoicesFrom(data, profiles);
  return {
    projectIds: new Set(data.items
      .filter(item => item.childIds.length > 0 || item.type === 'project' || !item.parent)
      .map(item => item.id)),
    ownerValues: new Set(ownerChoices.map(choice => choice.value)),
    ownerChoices,
  };
}

function parentId(item: TrackerItem): string | null {
  const value: unknown = item.parent;
  if (typeof value === 'string') return cleanText(value) ?? null;
  if (isRecord(value)) return cleanText(value.id) ?? null;
  return null;
}

function childrenByParent(items: readonly TrackerItem[]): Map<string, string[]> {
  const knownIds = new Set(items.map(item => item.id));
  const children = new Map<string, string[]>();
  for (const item of items) {
    const parent = parentId(item);
    if (!parent || !knownIds.has(parent)) continue;
    const values = children.get(parent) ?? [];
    values.push(item.id);
    children.set(parent, values);
  }
  return children;
}

function hasAcceptedDescendant(
  item: TrackerItem,
  byId: ReadonlyMap<string, TrackerItem>,
  children: ReadonlyMap<string, readonly string[]>,
): boolean {
  const seen = new Set([item.id]);
  const pending = [...(children.get(item.id) ?? [])];
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    const child = byId.get(id);
    if (!child) continue;
    if (isAccepted(child)) return true;
    pending.push(...(children.get(id) ?? []));
  }
  return false;
}

function toSupportRecord(item: TrackerItem, profiles: ReadonlyMap<string, OwnerProfile | null>): ReportsSupportRecord {
  const ownerKey = normalizedOwner(item.owner);
  const profile = matchedProfile(ownerKey, profiles);
  const ownerLabel = ownerKey === UNASSIGNED_OWNER
    ? 'Unassigned'
    : profile?.name ?? ownerKey;
  const progressPercent = item.progress?.scoped === true && Number.isFinite(item.progress.percent)
    ? item.progress.percent
    : null;
  return {
    id: item.id,
    title: cleanText(item.title) ?? item.id,
    href: workItemPath(item.id),
    status: normalizedStatus(item.status),
    completed: isCompleted(item),
    ownerKey,
    ownerLabel,
    profileName: profile?.name ?? null,
    profileSlug: profile?.slug ?? null,
    health: healthState(item),
    blocked: isBlocked(item),
    scheduleCoverage: scheduleCoverage(item),
    progressScoped: progressPercent !== null,
    progressPercent,
  };
}

function statusCount(items: readonly ReportsSupportRecord[]): ReportCount[] {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.status, (counts.get(item.status) ?? 0) + 1);
  return [...counts]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, count]) => ({ key, count }));
}

function healthCount(items: readonly ReportsSupportRecord[]): ReportHealthCounts {
  const counts: Record<ReportHealthState, number> = {
    'on-track': 0,
    'at-risk': 0,
    blocked: 0,
    unknown: 0,
  };
  for (const item of items) counts[item.health] += 1;
  return counts;
}

function scheduleCount(items: readonly ReportsSupportRecord[]): ReportScheduleCounts {
  const counts: Record<ReportScheduleCoverage, number> = {
    'approved-baseline-only': 0,
    'forecast-only': 0,
    both: 0,
    none: 0,
  };
  for (const item of items) counts[item.scheduleCoverage] += 1;
  return counts;
}

function assignmentRows(items: readonly ReportsSupportRecord[]): ReportAssignment[] {
  const groups = new Map<string, ReportsSupportRecord[]>();
  for (const item of items) {
    const records = groups.get(item.ownerKey) ?? [];
    records.push(item);
    groups.set(item.ownerKey, records);
  }
  return [...groups]
    .map(([ownerKey, records]) => {
      const first = records[0];
      const profileName = first?.profileName ?? null;
      const profileSlug = first?.profileSlug ?? null;
      return {
        ownerKey,
        ownerLabel: first?.ownerLabel ?? (ownerKey === UNASSIGNED_OWNER ? 'Unassigned' : ownerKey),
        profileName,
        profileSlug,
        recordCount: records.length,
        blockedCount: records.filter(record => record.blocked).length,
        unscheduledCount: records.filter(record => record.scheduleCoverage === 'none').length,
        records: [...records].sort((left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id)),
      };
    })
    .sort((left, right) => left.ownerLabel.localeCompare(right.ownerLabel) || left.ownerKey.localeCompare(right.ownerKey));
}

function matchesFilters(item: TrackerItem, filters: ReportsSearch): boolean {
  return (filters.completed || !isCompleted(item))
    && (filters.owners.length === 0 || filters.owners.includes(normalizedOwner(item.owner)));
}

export function buildReportsProjection(
  data: TrackerSnapshot,
  input: unknown = {},
): ReportsProjection {
  const options = reportFilterOptions(data);
  const filters = parseReportsSearch(input, options);
  const scopedItems = getScopeItems(data.items, filters.scope === 'all' ? '*' : filters.scope) as TrackerItem[];
  const allById = new Map(data.items.map(item => [item.id, item]));
  const children = childrenByParent(data.items);
  const terminalIds = new Set<string>();
  const excludedParents: TrackerItem[] = [];
  for (const item of data.items) {
    if (!isAccepted(item)) continue;
    if (hasAcceptedDescendant(item, allById, children)) excludedParents.push(item);
    else terminalIds.add(item.id);
  }
  const excludedIds = new Set(excludedParents.map(item => item.id));
  const cohort = scopedItems.filter(item => terminalIds.has(item.id) && matchesFilters(item, filters));
  const excluded = scopedItems.filter(item => excludedIds.has(item.id) && matchesFilters(item, filters));
  const profiles = rosterProfiles(data);
  const records = cohort.map(item => toSupportRecord(item, profiles));
  const excludedAcceptedParents = excluded.map(item => toSupportRecord(item, profiles));
  const scheduleCounts = scheduleCount(records);
  const progressCounts = {
    scoped: records.filter(record => record.progressScoped).length,
    unknown: records.filter(record => !record.progressScoped).length,
  };
  return {
    filters,
    recordCount: records.length,
    excludedAcceptedParentCount: excludedAcceptedParents.length,
    records,
    excludedAcceptedParents,
    statusCounts: statusCount(records),
    healthCounts: healthCount(records),
    blockedCount: records.filter(record => record.blocked).length,
    unassignedCount: records.filter(record => record.ownerKey === UNASSIGNED_OWNER).length,
    scheduleCounts,
    progressCounts,
    assignments: assignmentRows(records),
  };
}
