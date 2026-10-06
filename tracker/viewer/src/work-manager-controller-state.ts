import {
  parseWorkSearch,
  type SearchInput,
  type WorkFilterOptions,
  type WorkFilters,
  type WorkManagerPreset,
  type WorkSearch,
} from './routing-state';

type SavedManagerFilters = Pick<WorkFilters,
  'activity' | 'completed' | 'planned' | 'drafts' | 'q' | 'owners' | 'statuses' | 'people' | 'from' | 'to' | 'undated'>;

export interface WorkManagerRouteState {
  readonly savedFilters: SavedManagerFilters | null;
}

export function createWorkManagerRouteState(): WorkManagerRouteState {
  return { savedFilters: null };
}

function copyFilters(search: WorkSearch): SavedManagerFilters {
  return {
    activity: search.activity,
    completed: search.completed,
    planned: search.planned,
    drafts: search.drafts,
    q: search.q,
    owners: [...search.owners],
    statuses: [...search.statuses],
    people: [...search.people],
    ...(search.from === undefined ? {} : { from: search.from }),
    ...(search.to === undefined ? {} : { to: search.to }),
    undated: search.undated,
  };
}

function standardWorkFilters(): SavedManagerFilters {
  return {
    activity: 'all',
    completed: false,
    planned: true,
    drafts: false,
    q: '',
    owners: [],
    statuses: [],
    people: [],
    from: undefined,
    to: undefined,
    undated: 'include',
  };
}

function presetDefaults(preset: WorkManagerPreset): Pick<SavedManagerFilters, 'activity' | 'completed' | 'planned' | 'drafts' | 'q' | 'owners' | 'statuses' | 'from' | 'to' | 'undated'> {
  return {
    activity: preset === 'moving' ? 'recent' : 'all',
    completed: false,
    planned: true,
    drafts: true,
    q: '',
    owners: [],
    statuses: [],
    from: undefined,
    to: undefined,
    undated: 'include',
  };
}

function preservedNavigation(search: WorkSearch): SearchInput {
  return {
    scope: search.scope,
    mode: search.mode,
    ...(search.date === undefined ? {} : { date: search.date }),
    ...(search.item === undefined ? {} : { item: search.item }),
  };
}

export function enterManagerPreset(
  state: WorkManagerRouteState,
  search: WorkSearch,
  preset: Exclude<WorkManagerPreset, 'none'>,
  options: WorkFilterOptions = {},
): { readonly state: WorkManagerRouteState; readonly search: WorkSearch } {
  const savedFilters = state.savedFilters
    ?? (search.preset === 'none' ? copyFilters(search) : standardWorkFilters());
  return {
    state: { savedFilters },
    search: parseWorkSearch({
      ...search,
      ...presetDefaults(preset),
      preset,
      people: search.people,
    }, options),
  };
}

export function clearManagerPreset(
  state: WorkManagerRouteState,
  search: WorkSearch,
  options: WorkFilterOptions = {},
): { readonly state: WorkManagerRouteState; readonly search: WorkSearch } {
  return {
    state: createWorkManagerRouteState(),
    search: parseWorkSearch({
      ...search,
      ...(state.savedFilters ?? standardWorkFilters()),
      ...preservedNavigation(search),
      preset: 'none',
    }, options),
  };
}

export function workManagerExpansionFingerprint(search: WorkSearch): string {
  if (search.preset === 'none' && search.people.length === 0) return '';
  return JSON.stringify([
    search.preset,
    search.people,
    search.activity,
    search.completed,
    search.planned,
    search.drafts,
    search.q,
    search.owners,
    search.statuses,
    search.from ?? null,
    search.to ?? null,
    search.undated,
  ]);
}

export function hasManagerAdvancedRefinements(search: WorkSearch): boolean {
  if (search.preset === 'none') return false;
  const defaultActivity = search.preset === 'moving' ? 'recent' : 'all';
  return search.activity !== defaultActivity
    || search.completed
    || !search.planned
    || !search.drafts
    || Boolean(search.q.trim())
    || search.owners.length > 0
    || search.statuses.length > 0
    || search.from !== undefined
    || search.to !== undefined
    || search.undated !== 'include';
}
