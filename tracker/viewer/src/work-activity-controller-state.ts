import type { WorkActivityFilter } from './work-activity-types';

export interface FilteredExpansionState {
  readonly filter: WorkActivityFilter;
  readonly fingerprint: string;
  readonly expandedIds: ReadonlySet<string>;
  readonly manuallyCollapsedIds: ReadonlySet<string>;
}

export interface WorkExpansionState {
  readonly unfilteredIds: ReadonlySet<string>;
  readonly filteredByFingerprint: ReadonlyMap<string, FilteredExpansionState>;
  readonly hasManualExpansionInteraction: boolean;
  readonly ganttExpansionInitialized: boolean;
}

function expansionKey(filter: WorkActivityFilter, fingerprint: string): string {
  return filter + '\u001f' + fingerprint;
}

function isUnfiltered(filter: WorkActivityFilter, fingerprint: string): boolean {
  return filter === 'all' && fingerprint.length === 0;
}

export function createWorkExpansionState(defaultExpandedIds: Iterable<string>): WorkExpansionState {
  return {
    unfilteredIds: new Set(defaultExpandedIds),
    filteredByFingerprint: new Map(),
    hasManualExpansionInteraction: false,
    ganttExpansionInitialized: false,
  };
}

function replaceControlledIds(
  currentIds: ReadonlySet<string>,
  expandedIds: ReadonlySet<string>,
  controlledIds: ReadonlySet<string>,
): ReadonlySet<string> {
  const nextIds = new Set(currentIds);
  for (const id of controlledIds) {
    if (expandedIds.has(id)) nextIds.add(id);
    else nextIds.delete(id);
  }
  return nextIds;
}

function filteredStateFor(
  state: WorkExpansionState,
  filter: WorkActivityFilter,
  fingerprint: string,
): FilteredExpansionState | undefined {
  return state.filteredByFingerprint.get(expansionKey(filter, fingerprint));
}

export function visibleExpandedIds(
  state: WorkExpansionState,
  filter: WorkActivityFilter,
  revealAncestorIds: ReadonlySet<string>,
  fingerprint = '',
): ReadonlySet<string> {
  if (isUnfiltered(filter, fingerprint)) return state.unfilteredIds;

  const filtered = filteredStateFor(state, filter, fingerprint);
  const visible = new Set(filtered?.expandedIds ?? state.unfilteredIds);
  for (const id of revealAncestorIds) {
    if (!filtered?.manuallyCollapsedIds.has(id)) visible.add(id);
  }
  return visible;
}

export function transitionWorkExpansionState(
  state: WorkExpansionState,
  filter: WorkActivityFilter,
  revealAncestorIds: ReadonlySet<string>,
  fingerprint = '',
): WorkExpansionState {
  if (isUnfiltered(filter, fingerprint)) return state;

  const key = expansionKey(filter, fingerprint);
  const previous = state.filteredByFingerprint.get(key);
  const nextExpanded = new Set(previous?.expandedIds ?? state.unfilteredIds);
  const manuallyCollapsedIds = previous?.manuallyCollapsedIds ?? new Set<string>();
  for (const id of revealAncestorIds) {
    if (!manuallyCollapsedIds.has(id)) nextExpanded.add(id);
  }
  if (previous && nextExpanded.size === previous.expandedIds.size) return state;

  const filteredByFingerprint = new Map(state.filteredByFingerprint);
  filteredByFingerprint.set(key, {
    filter,
    fingerprint,
    expandedIds: nextExpanded,
    manuallyCollapsedIds: new Set(manuallyCollapsedIds),
  });
  return { ...state, filteredByFingerprint };
}

export function setWorkExpansionState(
  state: WorkExpansionState,
  filter: WorkActivityFilter,
  expandedIds: ReadonlySet<string>,
  controlledIds: ReadonlySet<string>,
  revealAncestorIds: ReadonlySet<string>,
  fingerprint = '',
): WorkExpansionState {
  if (isUnfiltered(filter, fingerprint)) {
    return {
      ...state,
      unfilteredIds: replaceControlledIds(state.unfilteredIds, expandedIds, controlledIds),
      hasManualExpansionInteraction: true,
    };
  }

  const transitioned = transitionWorkExpansionState(state, filter, revealAncestorIds, fingerprint);
  const key = expansionKey(filter, fingerprint);
  const current = transitioned.filteredByFingerprint.get(key);
  if (!current) return transitioned;

  const nextExpandedIds = replaceControlledIds(current.expandedIds, expandedIds, controlledIds);
  const nextManuallyCollapsedIds = new Set(current.manuallyCollapsedIds);
  for (const id of controlledIds) {
    if (expandedIds.has(id)) nextManuallyCollapsedIds.delete(id);
    else nextManuallyCollapsedIds.add(id);
  }

  const filteredByFingerprint = new Map(transitioned.filteredByFingerprint);
  filteredByFingerprint.set(key, {
    ...current,
    expandedIds: nextExpandedIds,
    manuallyCollapsedIds: nextManuallyCollapsedIds,
  });
  return {
    ...transitioned,
    filteredByFingerprint,
    hasManualExpansionInteraction: true,
  };
}

export function initializeGanttExpansionState(
  state: WorkExpansionState,
  expandedIds: ReadonlySet<string>,
  controlledIds: ReadonlySet<string>,
  filter: WorkActivityFilter,
  revealAncestorIds: ReadonlySet<string>,
  fingerprint = '',
): WorkExpansionState {
  const transitioned = transitionWorkExpansionState(state, filter, revealAncestorIds, fingerprint);
  if (transitioned.ganttExpansionInitialized) return transitioned;

  if (transitioned.hasManualExpansionInteraction) {
    return { ...transitioned, ganttExpansionInitialized: true };
  }

  if (isUnfiltered(filter, fingerprint)) {
    return {
      ...transitioned,
      unfilteredIds: replaceControlledIds(transitioned.unfilteredIds, expandedIds, controlledIds),
      ganttExpansionInitialized: true,
    };
  }

  const key = expansionKey(filter, fingerprint);
  const current = transitioned.filteredByFingerprint.get(key);
  if (!current) return { ...transitioned, ganttExpansionInitialized: true };

  const filteredByFingerprint = new Map(transitioned.filteredByFingerprint);
  filteredByFingerprint.set(key, {
    ...current,
    expandedIds: replaceControlledIds(current.expandedIds, expandedIds, controlledIds),
  });
  return {
    ...transitioned,
    filteredByFingerprint,
    ganttExpansionInitialized: true,
  };
}

export function toggleWorkExpansionState(
  state: WorkExpansionState,
  filter: WorkActivityFilter,
  id: string,
  revealAncestorIds: ReadonlySet<string>,
  fingerprint = '',
): WorkExpansionState {
  if (isUnfiltered(filter, fingerprint)) {
    const unfilteredIds = new Set(state.unfilteredIds);
    if (unfilteredIds.has(id)) unfilteredIds.delete(id);
    else unfilteredIds.add(id);
    return {
      ...state,
      unfilteredIds,
      hasManualExpansionInteraction: true,
    };
  }

  const transitioned = transitionWorkExpansionState(state, filter, revealAncestorIds, fingerprint);
  const key = expansionKey(filter, fingerprint);
  const current = transitioned.filteredByFingerprint.get(key);
  if (!current) return transitioned;

  const expandedIds = new Set(current.expandedIds);
  const manuallyCollapsedIds = new Set(current.manuallyCollapsedIds);
  if (visibleExpandedIds(transitioned, filter, revealAncestorIds, fingerprint).has(id)) {
    expandedIds.delete(id);
    manuallyCollapsedIds.add(id);
  } else {
    expandedIds.add(id);
    manuallyCollapsedIds.delete(id);
  }

  const filteredByFingerprint = new Map(transitioned.filteredByFingerprint);
  filteredByFingerprint.set(key, { ...current, expandedIds, manuallyCollapsedIds });
  return {
    ...transitioned,
    filteredByFingerprint,
    hasManualExpansionInteraction: true,
  };
}
