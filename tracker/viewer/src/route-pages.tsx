import { useEffect, useMemo, useRef } from 'react';
import { Link, useNavigate, useRouteContext, useRouterState } from '@tanstack/react-router';
import { WorkView, TodayView, PlansView } from './features/browsing.jsx';
import { ItemPage, ItemNotFound, DecisionPage, DecisionNotFound } from './features/details.jsx';
import { TeamView } from './team-view.jsx';
import { TrackerEmpty } from './tracker-empty';
import { NavigationDateControls, WorkFilterControls } from './work-filter-controls';
import { projectFilteredWork } from './work-filters';
import { ProjectSelector, VisibilityControls } from './shared.jsx';
import { parsePlansSearch, parseTeamSearch, parseTodaySearch, parseWorkSearch, type SearchInput, type WorkManagerPreset, type WorkWorkflow, type WorkSearch } from './routing-state';
import { selectedItemId, validatedReturnTo } from './navigation';
import { projectFilterOptions, teamFilterOptions } from './route-data';
import { getScopeItems, isAccepted, plansForScope, scheduleFeatures, workVisibility } from './view-model.mjs';
import type { TrackerItem } from './snapshot';
import { RouteReturnLink } from './app-shell';
import { useBrowseItemSelection } from './browse-controller';
import { sessionBrowseFilters } from './routing-state';
import { buildWorkProjection, selectWorkRows } from './work-activity.mjs';
import { useWorkActivityClock, useWorkActivityController } from './work-activity-controller';
import { buildManagerProjection, selectManagerMatches } from './work-manager-model.mjs';
import type { BuildManagerProjectionInput, ManagerPreset } from './work-manager-types';
import { WorkManagerControls } from './work-manager-controls';
import { clearManagerPreset, createWorkManagerRouteState, enterManagerPreset, hasManagerAdvancedRefinements, workManagerExpansionFingerprint } from './work-manager-controller-state';
import { isTeamProjection } from './team-mode';
import { projectedTeamProfiles } from './team-model.mjs';
import { manilaTodayKey, shiftWorkWeek, workWindowForFocusWeek, workWeekForManilaDay, workWeekFromSearch, workflowSearch } from './work-week';

let managerPresetStateForSession = createWorkManagerRouteState();

function useCurrentLocation() {
  return useRouterState({ select: state => state.location });
}

function useSnapshot() {
  return useRouteContext({ from: '__root__' }).data;
}

function useSelection() {
  const location = useCurrentLocation();
  const data = useSnapshot();
  const itemId = selectedItemId(location.search as SearchInput);
  return itemId === undefined ? null : data.itemById.get(itemId) ?? null;
}

function hasOpenDescendant(item: TrackerItem, data: ReturnType<typeof useSnapshot>, seen = new Set<string>()): boolean {
  if (seen.has(item.id)) return false;
  const nextSeen = new Set(seen).add(item.id);
  return item.childIds.some(childId => {
    const child = data.itemById.get(childId);
    return child !== undefined && (!child.completed || hasOpenDescendant(child, data, nextSeen));
  });
}

function workVisibleItems(items: TrackerItem[], data: ReturnType<typeof useSnapshot>, completed: boolean, scope: string) {
  const scoped = getScopeItems(items, scope === 'all' ? '*' : scope) as TrackerItem[];
  return completed ? scoped : scoped.filter(item => !item.completed || hasOpenDescendant(item, data));
}

function hasDirectScheduleDate(item: TrackerItem): boolean {
  const schedule = item.schedule;
  return [
    schedule.plannedStart,
    schedule.plannedEnd,
    schedule.proposedStart,
    schedule.proposedEnd,
    schedule.forecastStart,
    schedule.forecastEndMin,
    schedule.forecastEndMax,
  ].some(value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/u.test(value.trim()));
}

function findActiveUndatedItems(
  data: ReturnType<typeof useSnapshot>,
  search: ReturnType<typeof parseWorkSearch>,
  projection: ReturnType<typeof buildWorkProjection>,
): TrackerItem[] {
  const ownerMatches = (item: TrackerItem) => search.owners.length === 0 || search.owners.some(owner => {
    const itemOwner = item.owner && item.owner.toLowerCase() !== 'unassigned' ? item.owner : '__unassigned__';
    return itemOwner === owner || itemOwner.toLowerCase() === owner.toLowerCase();
  });
  return getScopeItems(data.items, search.scope === 'all' ? '*' : search.scope)
    .filter(item => {
      const type = item.type?.toLowerCase();
      const isContainer = type === 'project' || type === 'workstream';
      const owner = item.owner?.trim().toLowerCase();
      const isOwnedContainer = isContainer && Boolean(owner) && owner !== 'unassigned';
      const own = projection.get(item.id)?.own;
      const hasOwnActivity = Boolean(own?.evidenceIds?.length || own?.firstDate || own?.lastDate);
      const hasDirectWork = scheduleFeatures([item]).length > 0 || hasDirectScheduleDate(item);
      const eligible = type === 'task'
        ? scheduleFeatures([item]).length === 0
        : isOwnedContainer && (hasOwnActivity || hasDirectWork);
      return eligible && item.status.toLowerCase() === 'active' && isAccepted(item) && !item.completed && ownerMatches(item);
    });
}

function filteredActiveUndatedItems(
  data: ReturnType<typeof useSnapshot>,
  search: ReturnType<typeof parseWorkSearch>,
  projection: ReturnType<typeof buildWorkProjection>,
): TrackerItem[] {
  const candidates = findActiveUndatedItems(data, search, projection);
  const filtered = projectFilteredWork(data, {
    ...search,
    from: undefined,
    to: undefined,
    undated: 'include',
    completed: false,
  });
  return candidates.filter(item => filtered.visibleIds.has(item.id) && !filtered.contextualIds.has(item.id));
}

export function WorkPage() {
  const data = useSnapshot();
  const teamProjection = isTeamProjection(data);
  const now = useWorkActivityClock();
  const projection = useMemo(() => buildWorkProjection({
    items: data.items,
    evidence: data.activityEvidence,
    now,
  }), [data.activityEvidence, data.items, now]);
  const location = useCurrentLocation();
  const navigate = useNavigate();
  const selectItem = useBrowseItemSelection();
  const options = projectFilterOptions(data);
  const routeSearch = parseWorkSearch(location.search, options);
  const workflow = routeSearch.workflow ?? 'standard';
  const selectedWeek = workWeekFromSearch(routeSearch);
  const focusWindow = workflow === 'this-week' ? workWindowForFocusWeek(selectedWeek) : null;
  // Workflow defaults are applied once when entering a workflow. After that,
  // URL state is authoritative so view tabs and refinements remain sticky.
  const search = routeSearch;
  const managerState = useRef(managerPresetStateForSession);
  useEffect(() => {
    if (search.preset === 'none') {
      managerState.current = createWorkManagerRouteState();
      managerPresetStateForSession = managerState.current;
    }
  }, [search.preset]);
  const visible = useMemo(() => {
    const candidateSearch: WorkSearch = workflow === 'next-week'
      ? { ...search, from: undefined, to: undefined, undated: 'include' }
      : workflow === 'this-week' && focusWindow
        ? { ...search, from: focusWindow.start, to: focusWindow.end }
      : search;
    const base = projectFilteredWork(data, candidateSearch);
    if (workflow !== 'this-week' || focusWindow === null) return base;
    const undated = filteredActiveUndatedItems(data, search, projection);
    // Completed rows qualify by recorded activity in the four-week context;
    // remove schedule bounds here so an activity-backed completion is not
    // discarded merely because its original schedule was outside the context
    // (or undated). The source-backed activity check below remains the gate.
    const completedSearch = { ...candidateSearch, from: undefined, to: undefined, undated: 'include' as const, completed: true };
    const completedInWindow = new Set(data.items
      .filter(item => item.completed)
      .filter(item => {
        const lastDate = projection.get(item.id)?.own.lastDate;
        return typeof lastDate === 'string' && lastDate >= focusWindow.start && lastDate <= focusWindow.end;
      })
      .map(item => item.id));
    const completed = projectFilteredWork(data, completedSearch).items.filter(item => completedInWindow.has(item.id));
    const baseIds = new Set(base.items.map(item => item.id));
    const extras = [...new Map([...undated, ...completed].map(item => [item.id, item])).values()]
      .filter(item => !baseIds.has(item.id));
    if (!extras.length) return base;
    const ids = baseIds;
    const contextualIds = new Set(base.contextualIds);
    for (const item of extras) {
      ids.add(item.id);
      let parentId = item.parent ?? null;
      while (parentId) {
        ids.add(parentId);
        contextualIds.add(parentId);
        parentId = data.itemById.get(parentId)?.parent ?? null;
      }
    }
    const items = data.items.filter(item => ids.has(item.id));
    const roots = items.filter(item => !item.parent || !data.itemById.has(item.parent));
    return { ...base, items, roots, visibleIds: new Set(items.map(item => item.id)), contextualIds, matchCount: base.matchCount + extras.length };
  }, [data, focusWindow, projection, search, workflow]);
  const managerScopeIds = useMemo(() => new Set(getScopeItems(
    data.items,
    search.scope === 'all' ? '*' : search.scope,
  ).map(item => item.id)), [data.items, search.scope]);
  const managerProjection = useMemo(() => {
    const input = {
      items: data.items,
      activityProjection: projection,
      deliveryRecords: Array.isArray(data.deliveryRecords) ? data.deliveryRecords : [],
      decisions: data.decisions,
      activityEvidence: data.activityEvidence,
      people: Array.isArray(data.people) ? data.people : [],
      now,
      scopeIds: managerScopeIds,
    } as BuildManagerProjectionInput;
    return buildManagerProjection(input);
  }, [data.activityEvidence, data.decisions, data.deliveryRecords, data.items, data.people, managerScopeIds, now, projection]);
  const managerMatchIds = useMemo(() => selectManagerMatches({
    managerProjection,
    preset: search.preset as ManagerPreset,
    people: search.people,
  }), [managerProjection, search.people, search.preset]);
  const managerScopeTaskCount = [...managerScopeIds].filter(id => {
    const entry = managerProjection.byId.get(id);
    return entry?.type === 'task' && entry.unfinished;
  }).length;
  const eligibleIds = useMemo(() => new Set(visible.items
    .filter(item => !item.contextOnly && !visible.contextualIds.has(item.id))
    .map(item => item.id)), [visible.contextualIds, visible.items]);
  const managerEnabled = !teamProjection && (workflow === 'next-week' || search.preset !== 'none' || search.people.length > 0);
  const activityMode = search.mode === 'tree' || search.mode === 'gantt';
  const applyManagerFilter = managerEnabled && activityMode;
  const activityEligibleIds = useMemo(() => applyManagerFilter
    ? new Set([...eligibleIds].filter(id => managerMatchIds.has(id)))
    : eligibleIds,
  [applyManagerFilter, eligibleIds, managerMatchIds]);
  const activityRows = useMemo(() => selectWorkRows({
    projection,
    eligibleIds: activityEligibleIds,
    activityFilter: search.activity,
    revealAncestors: applyManagerFilter,
    scopeRootId: search.scope === 'all' ? null : search.scope,
  }), [activityEligibleIds, applyManagerFilter, projection, search.activity, search.scope]);
  const dailyAttentionIds = useMemo(() => {
    if (workflow !== 'daily-review') return null;
    const attention = new Set<string>();
    for (const item of data.items) {
      const entry = projection.get(item.id);
      if (!entry || entry.completed) continue;
      const healthState = item.health?.state?.toLowerCase();
      const hasAttention = entry.attentionReasons.length > 0
        || entry.own.state === 'unknown'
        || healthState === 'unknown'
        || healthState === 'blocked'
        || healthState === 'at-risk'
        || item.status.toLowerCase() === 'blocked'
        || Boolean(item.sections?.blocker)
        || item.blockers.length > 0;
      if (hasAttention) attention.add(item.id);
    }
    for (const id of [...attention]) {
      let parentId = projection.get(id)?.parentId ?? null;
      while (parentId) {
        attention.add(parentId);
        parentId = projection.get(parentId)?.parentId ?? null;
      }
    }
    return attention;
  }, [data.items, projection, workflow]);
  const applyActivityFilter = activityMode && (search.activity !== 'all' || managerEnabled || dailyAttentionIds !== null);
  const displayedIds: ReadonlySet<string> = applyActivityFilter
    ? new Set([...activityRows.visibleIds].filter(id => visible.visibleIds.has(id) && (dailyAttentionIds === null || dailyAttentionIds.has(id))))
    : visible.visibleIds;
  const displayedContextualIds: ReadonlySet<string> = useMemo(() => {
    if (!applyActivityFilter) return visible.contextualIds;
    return new Set([...visible.contextualIds, ...activityRows.contextIds]
      .filter(id => displayedIds.has(id)));
  }, [activityRows.contextIds, applyActivityFilter, displayedIds, visible.contextualIds]);
  const candidateIds = useMemo(() => {
    if (workflow !== 'next-week') return null;
    return new Set([...managerProjection.byId.values()]
      .filter(entry => entry.type === 'task' && entry.unfinished && (entry.current || entry.upcoming || entry.unreviewed || entry.decisions.some(decision => decision.state === 'proposed')) && ['ready', 'waiting', 'not-assessed'].includes(entry.readiness))
      .map(entry => entry.id));
  }, [managerProjection, workflow]);
  const candidateVisibleIds = useMemo(() => {
    if (candidateIds === null) return visible.visibleIds;
    const result = new Set<string>();
    for (const item of visible.items) {
      if (!candidateIds.has(item.id)) continue;
      result.add(item.id);
      let parentId = item.parent ?? null;
      while (parentId) {
        result.add(parentId);
        const parent = data.itemById.get(parentId);
        parentId = parent?.parent ?? null;
      }
    }
    return result;
  }, [candidateIds, data.itemById, visible.items, visible.visibleIds]);
  const workflowVisibleIds = candidateIds === null
    ? visible.visibleIds
    : candidateVisibleIds;
  const workflowItems = candidateIds === null
    ? visible.items
    : visible.items.filter(item => workflowVisibleIds.has(item.id));
  const workflowRoots = candidateIds === null
    ? visible.roots
    : visible.roots.filter(item => workflowVisibleIds.has(item.id));
  const workflowMatchCount = candidateIds === null
    ? visible.matchCount
    : [...candidateIds].filter(id => visible.visibleIds.has(id)).length;
  const displayedRoots = applyActivityFilter
    ? workflowRoots.filter(item => displayedIds.has(item.id))
    : workflowRoots;
  const displayedItemsForWorkflow = !applyActivityFilter
    ? workflowItems
    : workflowItems.filter(item => displayedIds.has(item.id));
  const finalVisibleIds = new Set(displayedItemsForWorkflow.map(item => item.id));
  const finalContextualIds = new Set([...displayedContextualIds].filter(id => finalVisibleIds.has(id)));
  const undatedActiveItems = useMemo(() => {
    if (workflow !== 'this-week') return [];
    return filteredActiveUndatedItems(data, search, projection)
      .filter(item => scheduleFeatures([item]).length === 0);
  }, [data, projection, search, workflow]);
  const update = (changes: SearchInput) => {
    const next = parseWorkSearch({ ...search, ...changes }, options);
    void navigate({ to: '/work', search: next, replace: true });
  };
  const updateWorkflow = (nextWorkflow: 'standard' | WorkWorkflow) => {
    const todayWeek = workWeekForManilaDay(manilaTodayKey());
    const nextWeek = nextWorkflow === 'next-week' ? shiftWorkWeek(todayWeek, 1) : todayWeek;
    const next = nextWorkflow === 'standard'
      ? parseWorkSearch({ ...routeSearch, workflow: undefined }, options)
      : workflowSearch(routeSearch, nextWorkflow, nextWorkflow === 'next-week' ? nextWeek : todayWeek);
    void navigate({ to: '/work', search: next, replace: true });
  };
  const updateWeek = (direction: -1 | 1) => {
    const nextWeek = shiftWorkWeek(selectedWeek, direction);
    const next = parseWorkSearch({ ...routeSearch, from: nextWeek.start, to: nextWeek.end }, options);
    void navigate({ to: '/work', search: next, replace: true });
  };
  const updatePresentation = (presentationMode: boolean) => update({ presentationMode: presentationMode || undefined });
  const updateGrouping = (groupByOwner: boolean) => update({ groupByOwner: groupByOwner || undefined });
  const updateManagerPreset = (preset: ManagerPreset) => {
    const result = preset === 'none'
      ? clearManagerPreset(managerState.current, search, options)
      : enterManagerPreset(managerState.current, search, preset as Exclude<WorkManagerPreset, 'none'>, options);
    managerState.current = result.state;
    managerPresetStateForSession = result.state;
    void navigate({ to: '/work', search: result.search, replace: true });
  };
  const managerDirectTaskCount = [...managerMatchIds].filter(id => {
    const entry = managerProjection.byId.get(id);
    return entry?.type === 'task' && workflowVisibleIds.has(id) && !visible.contextualIds.has(id);
  }).length;
  const activityTaskCount = [...activityRows.matchIds]
    .filter(id => managerProjection.byId.get(id)?.type === 'task').length;
  const managerMatchCount = applyActivityFilter ? activityTaskCount : managerDirectTaskCount;
  const expansionFingerprint = workManagerExpansionFingerprint(search);
  const workActivity = useWorkActivityController({
    projection,
    scopeRootId: search.scope === 'all' ? null : search.scope,
    defaultExpandedIds: data.defaultExpanded,
    revealAncestorIds: activityRows.revealAncestorIds,
    activityFilter: search.activity,
    expansionFingerprint,
    matchCount: applyManagerFilter ? activityTaskCount : activityRows.matchIds.size,
    onActivityFilterChange: activity => update({ activity }),
  });
  const controls = <>
    {teamProjection ? <section className="team-projection-work-note" aria-label="Person-scoped My Work">
      <strong>My Work</strong>
      <span>Use Person to view one team member’s tasks.</span>
    </section> : <WorkManagerControls
      projection={managerProjection}
      people={(Array.isArray(data.people) ? data.people : []) as import('./work-manager-controls').WorkManagerPerson[]}
      search={search}
      mode={search.mode}
      matchCount={managerMatchCount}
      resultCount={applyActivityFilter ? activityRows.matchIds.size : workflowMatchCount}
      scopeTaskCount={managerScopeTaskCount}
      modified={hasManagerAdvancedRefinements(search)}
      onPresetChange={updateManagerPreset}
      onPeopleChange={people => update({ people })}
    />}
    <WorkFilterControls data={data} search={search} onChange={update} matchCount={workflowMatchCount} />
  </>;
  const onModeChange = (mode: typeof search.mode) => update({ mode });
  return <WorkView
    items={displayedItemsForWorkflow}
    roots={displayedRoots}
    data={data}
    selectedId={search.item ?? null}
    onSelectItem={selectItem}
    mode={search.mode}
    onModeChange={onModeChange}
    externalItems={visible.externalItems}
    visibleIds={finalVisibleIds}
    contextualIds={finalContextualIds}
    managerProjection={managerProjection}
    managerEnabled={managerEnabled}
    workActivity={workActivity}
    toolbarControls={controls}
    navigationControls={<NavigationDateControls date={search.date} onChange={update} />}
    navigationDate={search.date}
    selectedWeek={selectedWeek}
    focusWindow={focusWindow}
    workflow={workflow}
    onWorkflowChange={updateWorkflow}
    onWeekChange={updateWeek}
    undatedActiveItems={undatedActiveItems}
    groupByOwner={search.groupByOwner === true}
    onGroupByOwnerChange={updateGrouping}
    presentationMode={search.presentationMode === true}
    onPresentationModeChange={updatePresentation}
  />;
}

export function TodayPage() {
  const data = useSnapshot();
  const location = useCurrentLocation();
  const navigate = useNavigate();
  const options = projectFilterOptions(data);
  const search = parseTodaySearch(location.search, options);
  const scoped = workVisibleItems(data.items, data, search.completed, search.scope);
  const visible = workVisibility(scoped, '*', search.planned, search.drafts);
  const update = (changes: SearchInput) => {
    const next = parseTodaySearch({ ...search, ...changes }, options);
    void navigate({ to: '/today', search: next, replace: true });
  };
  const decisions = data.decisions.filter(decision => decision.affects.some(id => visible.items.some(item => item.id === id && isAccepted(item))));
  const controls = <><ProjectSelector data={data} scopeId={search.scope} onChange={scope => update({ scope: scope ?? 'all' })} /><VisibilityControls showPlanned={search.planned} setShowPlanned={value => update({ planned: value })} showDrafts={search.drafts} setShowDrafts={value => update({ drafts: value })} showPlannedControl showCompleted={search.completed} setShowCompleted={value => update({ completed: value })} visibleItemCount={visible.items.length} /></>;
  return <section className="route-view"><div className="control-row">{controls}</div><TodayView items={visible.items} decisions={decisions} selectedItem={useSelection()} onSelectItem={useBrowseItemSelection()} /></section>;
}

export function PlansPage({ selectedPlanId }: { selectedPlanId?: string }) {
  const data = useSnapshot();
  const location = useCurrentLocation();
  const navigate = useNavigate();
  const selectItem = useBrowseItemSelection();
  const search = parsePlansSearch(location.search);
  const plans = plansForScope(data.plans, null);
  const update = (changes: SearchInput) => {
    const next = parsePlansSearch({ ...search, ...changes });
    if (selectedPlanId === undefined) void navigate({ to: '/plans', search: next, replace: true });
    else void navigate({ to: '/plans/$planId', params: { planId: selectedPlanId }, search: next, replace: true });
  };
  if (selectedPlanId !== undefined && !data.plans.some(plan => plan.id === selectedPlanId)) return <section className="surface-card empty-hero"><TrackerEmpty title={<h1>Plan not found</h1>} description="This plan is not in the current snapshot." action={<Link to="/plans" search={search}>Return to Plans</Link>} /></section>;
  return <PlansView plans={plans} data={data} search={search.q} onSearchChange={q => update({ q })} selectedPlanId={selectedPlanId ?? null} onSelectPlan={planId => void navigate({ to: '/plans/$planId', params: { planId }, search, replace: false })} onSelectItem={selectItem} onOpenWork={() => {
    const projectOptions = projectFilterOptions(data);
    void navigate({ to: '/work', search: parseWorkSearch(sessionBrowseFilters.restoreWork(projectOptions), projectOptions) });
  }} />;
}

export function TeamPage({ memberSlug }: { memberSlug?: string }) {
  const data = useSnapshot();
  const location = useCurrentLocation();
  const navigate = useNavigate();
  const options = teamFilterOptions(data);
  const search = parseTeamSearch(location.search, options);
  const update = (changes: SearchInput) => {
    const next = parseTeamSearch({ ...search, ...changes }, options);
    if (memberSlug === undefined) void navigate({ to: '/team', search: next, replace: true });
    else void navigate({ to: '/team/$memberSlug', params: { memberSlug }, search: next, replace: true });
  };
  const profiles = data.team.length > 0 ? data.team : (isTeamProjection(data) ? projectedTeamProfiles(data.items) : data.team);
  return <TeamView profiles={profiles} items={data.items} teamProjection={isTeamProjection(data)} memberSlug={memberSlug ?? null} search={search.q} onSearchChange={q => update({ q })} organizationFilter={search.organization} onOrganizationChange={organization => update({ organization })} onResetFilters={() => update({ q: '', organization: 'all' })} onSelectItem={useBrowseItemSelection()} />;
}

export function WorkItemPage({ itemId }: { itemId: string }) {
  const { data, canonicalData, taskDrafts, taskEdit } = useRouteContext({ from: '__root__' });
  const item = data.itemById.get(itemId) ?? null;
  const history = data.history.find(entry => entry.id === itemId) ?? null;
  const taskDraft = taskDrafts.find(draft => draft.recordId === itemId) ?? null;
  const routerState = useRouterState({ select: state => state.location.state });
  if (item === null && history === null) return <ItemNotFound id={itemId} />;
  return <ItemPage
    item={item}
    history={history}
    data={data}
    canonicalData={canonicalData}
    taskDraft={taskDraft}
    taskDrafts={taskDrafts}
    pendingDraftCount={taskDrafts.length}
    taskEdit={taskEdit}
    readOnly={isTeamProjection(data)}
    renderItemLink={(id, label) => <ItemRouteLink itemId={id}>{label}</ItemRouteLink>}
    returnLink={<RouteReturnLink value={routerState.returnTo} />}
  />;
}

function ItemRouteLink({ itemId, children }: { itemId: string; children: React.ReactNode }) {
  const routerState = useRouterState({ select: state => state.location.state });
  const data = useSnapshot();
  const returnTo = validatedReturnTo(routerState.returnTo, { ...projectFilterOptions(data), ...teamFilterOptions(data) }) ?? '/work';
  return <Link to="/work/$itemId" params={{ itemId }} state={{ returnTo }}>{children}</Link>;
}

export function DecisionItemPage({ decisionId }: { decisionId: string }) {
  const data = useSnapshot();
  const decision = data.decisions.find(entry => entry.id === decisionId) ?? null;
  return decision === null ? <DecisionNotFound id={decisionId} /> : <DecisionPage decision={decision} data={data} />;
}
