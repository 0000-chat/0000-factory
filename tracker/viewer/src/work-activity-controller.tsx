import { useCallback, useEffect, useReducer, useState } from 'react';
import type { ActivityFilter } from './routing-state';
import type { WorkProjectionEntry } from './work-activity-types';
import {
  createWorkExpansionState,
  initializeGanttExpansionState,
  setWorkExpansionState,
  transitionWorkExpansionState,
  toggleWorkExpansionState,
  visibleExpandedIds,
  type WorkExpansionState,
} from './work-activity-controller-state';
import { millisecondsUntilManilaMidnight } from './work-activity.mjs';
import { trackerInstanceConfig } from './instance-config';

const PAUSE_STORAGE_KEY = trackerInstanceConfig.browser.activityPausedKey;
const expansionByScope = new Map<string, WorkExpansionState>();

export interface WorkActivityControls {
  readonly projection: Map<string, WorkProjectionEntry>;
  readonly expandedIds: ReadonlySet<string>;
  readonly toggleExpanded: (id: string) => void;
  readonly setExpandedForIds: (
    expandedIds: ReadonlySet<string>,
    controlledIds: ReadonlySet<string>,
  ) => void;
  readonly initializeGanttExpansion: (
    expandedIds: ReadonlySet<string>,
    controlledIds: ReadonlySet<string>,
  ) => void;
  readonly animationsPaused: boolean;
  readonly setAnimationsPaused: (paused: boolean) => void;
  readonly activityFilter: ActivityFilter;
  readonly setActivityFilter: (filter: ActivityFilter) => void;
  readonly matchCount: number;
}

export interface UseWorkActivityControllerInput {
  readonly projection: Map<string, WorkProjectionEntry>;
  readonly scopeRootId: string | null;
  readonly defaultExpandedIds: readonly string[];
  readonly revealAncestorIds: ReadonlySet<string>;
  readonly activityFilter: ActivityFilter;
  readonly expansionFingerprint?: string;
  readonly matchCount: number;
  readonly onActivityFilterChange: (filter: ActivityFilter) => void;
}

function readPausePreference(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(PAUSE_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function expansionScopeKey(scopeRootId: string | null): string {
  return scopeRootId === null ? '\u0000all' : `scope:${scopeRootId}`;
}

export function useWorkActivityClock(): Date {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    let timer: number | undefined;
    const refresh = () => {
      const current = new Date();
      setNow(current);
      if (timer !== undefined) window.clearTimeout(timer);
      const untilMidnight = millisecondsUntilManilaMidnight(current) ?? 60_000;
      timer = window.setTimeout(refresh, Math.max(1, untilMidnight + 1));
    };

    refresh();
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);

  return now;
}

export function useWorkActivityController({
  projection,
  scopeRootId,
  defaultExpandedIds,
  revealAncestorIds,
  activityFilter,
  expansionFingerprint = '',
  matchCount,
  onActivityFilterChange,
}: UseWorkActivityControllerInput): WorkActivityControls {
  const [, refreshExpansion] = useReducer((revision: number) => revision + 1, 0);
  const [animationsPaused, setAnimationsPausedState] = useState(readPausePreference);
  const scopeKey = expansionScopeKey(scopeRootId);
  let state = expansionByScope.get(scopeKey);
  if (state === undefined) {
    state = createWorkExpansionState(defaultExpandedIds);
    expansionByScope.set(scopeKey, state);
  }
  const expandedIds = visibleExpandedIds(state, activityFilter, revealAncestorIds, expansionFingerprint);

  useEffect(() => {
    const current = expansionByScope.get(scopeKey) ?? createWorkExpansionState(defaultExpandedIds);
    const next = transitionWorkExpansionState(current, activityFilter, revealAncestorIds, expansionFingerprint);
    if (next !== current) {
      expansionByScope.set(scopeKey, next);
      refreshExpansion();
    }
  }, [activityFilter, defaultExpandedIds, expansionFingerprint, revealAncestorIds, scopeKey]);

  const toggleExpanded = useCallback((id: string) => {
    const current = expansionByScope.get(scopeKey) ?? createWorkExpansionState(defaultExpandedIds);
    const next = toggleWorkExpansionState(current, activityFilter, id, revealAncestorIds, expansionFingerprint);
    expansionByScope.set(scopeKey, next);
    refreshExpansion();
  }, [activityFilter, defaultExpandedIds, expansionFingerprint, revealAncestorIds, scopeKey]);

  const setExpandedForIds = useCallback((
    expandedIds: ReadonlySet<string>,
    controlledIds: ReadonlySet<string>,
  ) => {
    const current = expansionByScope.get(scopeKey) ?? createWorkExpansionState(defaultExpandedIds);
    const next = setWorkExpansionState(current, activityFilter, expandedIds, controlledIds, revealAncestorIds, expansionFingerprint);
    expansionByScope.set(scopeKey, next);
    refreshExpansion();
  }, [activityFilter, defaultExpandedIds, expansionFingerprint, revealAncestorIds, scopeKey]);

  const initializeGanttExpansion = useCallback((
    expandedIds: ReadonlySet<string>,
    controlledIds: ReadonlySet<string>,
  ) => {
    const current = expansionByScope.get(scopeKey) ?? createWorkExpansionState(defaultExpandedIds);
    const next = initializeGanttExpansionState(
      current,
      expandedIds,
      controlledIds,
      activityFilter,
      revealAncestorIds,
      expansionFingerprint,
    );
    if (next === current) return;
    expansionByScope.set(scopeKey, next);
    refreshExpansion();
  }, [activityFilter, defaultExpandedIds, expansionFingerprint, revealAncestorIds, scopeKey]);

  const setAnimationsPaused = useCallback((paused: boolean) => {
    setAnimationsPausedState(paused);
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(PAUSE_STORAGE_KEY, String(paused));
    } catch {
      // Keep the in-memory preference if browser storage is unavailable.
    }
  }, []);

  return {
    projection,
    expandedIds,
    toggleExpanded,
    setExpandedForIds,
    initializeGanttExpansion,
    animationsPaused,
    setAnimationsPaused,
    activityFilter,
    setActivityFilter: onActivityFilterChange,
    matchCount,
  };
}
