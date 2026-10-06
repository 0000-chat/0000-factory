import { useEffect, useMemo, useRef } from 'react';
import { Link, useNavigate, useRouteContext, useRouterState } from '@tanstack/react-router';
import { WorkView, TodayView, PlansView } from './features/browsing.jsx';
import { ItemPage, ItemNotFound, DecisionPage, DecisionNotFound } from './features/details.jsx';
import { TeamView } from './team-view.jsx';
import { TrackerEmpty } from './tracker-empty';
import { NavigationDateControls, WorkFilterControls } from './work-filter-controls';
import { projectFilteredWork } from './work-filters';
import { ProjectSelector, VisibilityControls } from './shared.jsx';
import { parsePlansSearch, parseTeamSearch, parseTodaySearch, parseWorkSearch, type SearchInput, type WorkManagerPreset } from './routing-state';
import { selectedItemId, validatedReturnTo } from './navigation';
import { projectFilterOptions, teamFilterOptions } from './route-data';
import { getScopeItems, isAccepted, plansForScope, workVisibility } from './view-model.mjs';
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

export function WorkPage() {
  const data = useSnapshot();
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
  const search = parseWorkSearch(location.search, options);
  const managerState = useRef(managerPresetStateForSession);
  useEffect(() => {
    if (search.preset === 'none') {
      managerState.current = createWorkManagerRouteState();
      managerPresetStateForSession = managerState.current;
    }
  }, [search.preset]);
  const visible = projectFilteredWork(data, search);
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
    .filter(item => !visible.contextualIds.has(item.id))
    .map(item => item.id)), [visible.contextualIds, visible.items]);
  const managerEnabled = search.preset !== 'none' || search.people.length > 0;
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
  const applyActivityFilter = activityMode && (search.activity !== 'all' || managerEnabled);
  const displayedIds: ReadonlySet<string> = applyActivityFilter
    ? new Set([...activityRows.visibleIds].filter(id => visible.visibleIds.has(id)))
    : visible.visibleIds;
  const displayedItems = !applyActivityFilter
    ? visible.items
    : visible.items.filter(item => displayedIds.has(item.id));
  const displayedContextualIds: ReadonlySet<string> = useMemo(() => {
    if (!applyActivityFilter) return visible.contextualIds;
    return new Set([...visible.contextualIds, ...activityRows.contextIds]
      .filter(id => displayedIds.has(id)));
  }, [activityRows.contextIds, applyActivityFilter, displayedIds, visible.contextualIds]);
  const displayedRoots = applyActivityFilter
    ? visible.roots.filter(item => displayedIds.has(item.id))
    : visible.roots;
  const update = (changes: SearchInput) => {
    const next = parseWorkSearch({ ...search, ...changes }, options);
    void navigate({ to: '/work', search: next, replace: true });
  };
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
    return entry?.type === 'task' && visible.visibleIds.has(id) && !visible.contextualIds.has(id);
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
    <WorkManagerControls
      projection={managerProjection}
      people={(Array.isArray(data.people) ? data.people : []) as import('./work-manager-controls').WorkManagerPerson[]}
      search={search}
      mode={search.mode}
      matchCount={managerMatchCount}
      resultCount={applyActivityFilter ? activityRows.matchIds.size : visible.matchCount}
      scopeTaskCount={managerScopeTaskCount}
      modified={hasManagerAdvancedRefinements(search)}
      onPresetChange={updateManagerPreset}
      onPeopleChange={people => update({ people })}
    />
    <WorkFilterControls data={data} search={search} onChange={update} matchCount={visible.matchCount} />
  </>;
  const onModeChange = (mode: typeof search.mode) => update({ mode });
  return <WorkView
    items={displayedItems}
    roots={displayedRoots}
    data={data}
    selectedId={search.item ?? null}
    onSelectItem={selectItem}
    mode={search.mode}
    onModeChange={onModeChange}
    externalItems={visible.externalItems}
    visibleIds={displayedIds}
    contextualIds={displayedContextualIds}
    managerProjection={managerProjection}
    managerEnabled={managerEnabled}
    workActivity={workActivity}
    toolbarControls={controls}
    navigationControls={<NavigationDateControls date={search.date} onChange={update} />}
    navigationDate={search.date}
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
  return <TeamView profiles={data.team} items={data.items} memberSlug={memberSlug ?? null} search={search.q} onSearchChange={q => update({ q })} organizationFilter={search.organization} onOrganizationChange={organization => update({ organization })} onResetFilters={() => update({ q: '', organization: 'all' })} onSelectItem={useBrowseItemSelection()} />;
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
