import { getScopeItems, scheduleFeatures, workVisibility } from './view-model.mjs';
import { UNASSIGNED_OWNER, type WorkSearch } from './routing-state';
import type { TrackerItem, TrackerSnapshot } from './snapshot';

export interface WorkFilterChoice {
  readonly value: string;
  readonly label: string;
}

export interface WorkFilterChoices {
  readonly owners: WorkFilterChoice[];
  readonly statuses: WorkFilterChoice[];
}

export interface FilteredWorkProjection {
  readonly items: TrackerItem[];
  readonly roots: TrackerItem[];
  readonly visibleIds: ReadonlySet<string>;
  readonly contextualIds: ReadonlySet<string>;
  readonly externalItems: TrackerItem[];
  readonly matchCount: number;
}

interface ScheduleInterval {
  readonly startAt: Date;
  readonly endAt: Date;
}

function cleanText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text.length === 0 || text === '-' ? undefined : text;
}

function ownerFilterValue(item: TrackerItem): string {
  const owner = cleanText(item.owner);
  return owner === undefined || owner.toLowerCase() === 'unassigned'
    ? UNASSIGNED_OWNER
    : owner;
}

function choiceLabel(value: string): string {
  return value
    .split(/[-_\s]+/u)
    .filter(part => part.length > 0)
    .map(part => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

export function workFilterOptions(data: TrackerSnapshot): WorkFilterChoices {
  const ownerLabels = new Map<string, string>();
  const statusValues = new Set<string>();
  for (const item of data.items) {
    const ownerValue = ownerFilterValue(item);
    if (ownerValue === UNASSIGNED_OWNER) {
      ownerLabels.set(UNASSIGNED_OWNER, 'Unassigned');
    } else {
      const currentLabel = ownerLabels.get(ownerValue);
      const ownerName = cleanText(item.ownerName);
      if (currentLabel === undefined || (currentLabel === ownerValue && ownerName !== undefined)) {
        ownerLabels.set(ownerValue, ownerName ?? ownerValue);
      }
    }
    const status = cleanText(item.status);
    if (status !== undefined) statusValues.add(status);
  }
  return {
    owners: [...ownerLabels]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([value, label]) => ({ value, label })),
    statuses: [...statusValues]
      .sort((left, right) => left.localeCompare(right))
      .map(value => ({ value, label: choiceLabel(value) })),
  };
}

function hasOpenDescendant(item: TrackerItem, data: TrackerSnapshot, seen = new Set<string>()): boolean {
  if (seen.has(item.id)) return false;
  const nextSeen = new Set(seen).add(item.id);
  return item.childIds.some(childId => {
    const child = data.itemById.get(childId);
    return child !== undefined && (!child.completed || hasOpenDescendant(child, data, nextSeen));
  });
}

function completionVisibleItems(
  scopedItems: TrackerItem[],
  data: TrackerSnapshot,
  search: WorkSearch,
): TrackerItem[] {
  return search.completed
    ? scopedItems
    : scopedItems.filter(item => !item.completed || hasOpenDescendant(item, data));
}

function queryTokens(query: string): string[] {
  return query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
}

function matchesQuery(item: TrackerItem, tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  const searchable = [item.title, item.id, item.ownerName]
    .map(cleanText)
    .filter((value): value is string => value !== undefined)
    .map(value => value.toLocaleLowerCase());
  return tokens.every(token => searchable.some(value => value.includes(token)));
}

function matchesOwners(item: TrackerItem, owners: string[]): boolean {
  return owners.length === 0 || owners.includes(ownerFilterValue(item));
}

function matchesStatuses(item: TrackerItem, statuses: string[]): boolean {
  return statuses.length === 0 || statuses.includes(item.status);
}

function validIntervals(item: TrackerItem): ScheduleInterval[] {
  return scheduleFeatures([item]).flatMap(feature => {
    if (!(feature.startAt instanceof Date) || !(feature.endAt instanceof Date)) return [];
    if (!Number.isFinite(feature.startAt.valueOf()) || !Number.isFinite(feature.endAt.valueOf())) return [];
    if (feature.startAt.valueOf() > feature.endAt.valueOf()) return [];
    return [{ startAt: feature.startAt, endAt: feature.endAt }];
  });
}

function manilaDate(value: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value);
  const year = parts.find(part => part.type === 'year')?.value ?? '';
  const month = parts.find(part => part.type === 'month')?.value ?? '';
  const day = parts.find(part => part.type === 'day')?.value ?? '';
  return `${year}-${month}-${day}`;
}

function matchesDate(item: TrackerItem, search: WorkSearch): boolean {
  const intervals = validIntervals(item);
  if (search.undated === 'only') return intervals.length === 0;
  if (intervals.length === 0) return search.undated === 'include';
  return intervals.some(interval => {
    const start = manilaDate(interval.startAt);
    const end = manilaDate(interval.endAt);
    return (search.from === undefined || end >= search.from)
      && (search.to === undefined || start <= search.to);
  });
}

function rootsFor(
  data: TrackerSnapshot,
  scope: string,
  items: TrackerItem[],
  visibleIds: ReadonlySet<string>,
): TrackerItem[] {
  if (scope !== 'all') {
    const root = data.itemById.get(scope);
    return root !== undefined && visibleIds.has(root.id) ? [root] : [];
  }
  return items
    .filter(item => visibleIds.has(item.id) && (!item.parent || !data.itemById.has(item.parent)))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function externalDependenciesFor(
  data: TrackerSnapshot,
  matchItems: TrackerItem[],
  scopedItems: TrackerItem[],
): TrackerItem[] {
  const scopedIds = new Set(scopedItems.map(item => item.id));
  const dependencyIds = new Set<string>();
  for (const item of matchItems) {
    for (const dependencyId of item.dependsOn) {
      if (!scopedIds.has(dependencyId) && data.itemById.has(dependencyId)) dependencyIds.add(dependencyId);
    }
  }
  return [...dependencyIds]
    .map(id => data.itemById.get(id))
    .filter((item): item is TrackerItem => item !== undefined);
}

/** Filter Work's normal content, then restore only the context needed by its matches. */
export function projectFilteredWork(
  data: TrackerSnapshot,
  parsedWorkSearch: WorkSearch,
): FilteredWorkProjection {
  const scopedItems: TrackerItem[] = getScopeItems(
    data.items,
    parsedWorkSearch.scope === 'all' ? '*' : parsedWorkSearch.scope,
  );
  const baseItems = completionVisibleItems(scopedItems, data, parsedWorkSearch);
  const baseVisibility = workVisibility(baseItems, '*', parsedWorkSearch.planned, parsedWorkSearch.drafts);
  const baseContextualIds: ReadonlySet<string> = baseVisibility.contextualIds;
  const tokens = queryTokens(parsedWorkSearch.q);
  const matchItems: TrackerItem[] = baseVisibility.items.filter((item: TrackerItem) =>
    !baseContextualIds.has(item.id)
    && matchesQuery(item, tokens)
    && matchesOwners(item, parsedWorkSearch.owners)
    && matchesStatuses(item, parsedWorkSearch.statuses)
    && matchesDate(item, parsedWorkSearch),
  );
  const matchIds = new Set(matchItems.map(item => item.id));

  // The shared visibility helper treats non-match records as graph-only so it can
  // restore ancestors and dependencies without counting them as search results.
  const graphItems = scopedItems.map(item => matchIds.has(item.id)
    ? item
    : { ...item, commitment: '__filter_context__' });
  const restored = workVisibility(graphItems, '*', parsedWorkSearch.planned, parsedWorkSearch.drafts);
  const originalById = new Map(data.items.map(item => [item.id, item]));
  const items = restored.items
    .map((item: TrackerItem) => originalById.get(item.id))
    .filter((item): item is TrackerItem => item !== undefined);
  const visibleIds: ReadonlySet<string> = new Set(items.map(item => item.id));
  const contextualIds: ReadonlySet<string> = new Set(restored.contextualIds);
  return {
    items,
    roots: rootsFor(data, parsedWorkSearch.scope, items, visibleIds),
    visibleIds,
    contextualIds,
    externalItems: externalDependenciesFor(data, matchItems, scopedItems),
    matchCount: matchItems.length,
  };
}
