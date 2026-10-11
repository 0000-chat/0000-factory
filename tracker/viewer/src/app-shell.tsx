import { useEffect, useRef, type MouseEvent as ReactMouseEvent } from 'react';
import {
  Link,
  Outlet,
  useNavigate,
  useRouteContext,
  useRouterState,
} from '@tanstack/react-router';
import { BarChart3, CalendarDays, ClipboardList, LayoutDashboard, Redo2, Undo2, Users } from 'lucide-react';
import { ItemDetailSheet } from './features/details.jsx';
import { Button } from './components/ui/button.tsx';
import { ThemeControl } from './theme-control';
import { reportFilterOptions } from './reports-model';
import { parseReportsSearch, sessionReportsFilters } from './reports-state';
import { GlobalSearchDialog, type GlobalSearchResult } from './global-search-dialog';
import { SnapshotFooter } from './shared.jsx';
import { BrowseSelectionProvider } from './browse-controller';
import { projectFilterOptions, teamFilterOptions } from './route-data';
import type { TrackerSnapshot } from './snapshot';
import { trackerInstanceConfig } from './instance-config';
import {
  parsePlansSearch,
  parseTeamSearch,
  parseTodaySearch,
  parseWorkSearch,
  sessionBrowseFilters,
  type ProjectFilterOptions,
  type SearchInput,
  type TeamFilterOptions,
} from './routing-state';
import {
  classifySupportedPath,
  closeItemMutation,
  currentBrowseSearch,
  formatUrl,
  internalLinkTarget,
  parseUrlSearch,
  replaceFiltersMutation,
  selectItemMutation,
  selectedItemId,
  shouldInterceptMarkdownClick,
  validatedReturnTo,
} from './navigation';
import { isTeamProjection } from './team-mode';
import { useViewerIdentity, ViewerIdentityProvider } from './viewer-identity';

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function returnToFromState(state: unknown): unknown {
  return isRecord(state) ? state.returnTo : undefined;
}

function routeReturnTo(pathname: string, search: SearchInput, state: unknown, options: ProjectFilterOptions & TeamFilterOptions): string {
  const route = classifySupportedPath(pathname);
  if (route.kind === 'work' && route.itemId !== undefined) {
    return validatedReturnTo(returnToFromState(state), options) ?? '/work';
  }
  const path = formatUrl(pathname, currentBrowseSearch(pathname, search, options));
  return validatedReturnTo(path, options) ?? '/work';
}

function returnLabel(value: string): string {
  const url = new URL(value, 'https://tracker.invalid');
  const route = classifySupportedPath(url.pathname);
  switch (route.kind) {
    case 'today': return 'Return to Today';
    case 'work': return 'Return to Work';
    case 'plans': return 'Return to Plans';
    case 'team': return 'Return to Team';
    case 'reports': return 'Return to Reports';
    case 'weekly-planning': return trackerInstanceConfig.features.weeklyPlanning ? 'Return to Weekly planning' : 'Return to Work';
    default: return 'Return to Work';
  }
}

export function RouteReturnLink({ value, options = {} }: { value: unknown; options?: ProjectFilterOptions & TeamFilterOptions }) {
  const returnTo = validatedReturnTo(value, options) ?? '/work';
  const url = new URL(returnTo, 'https://tracker.invalid');
  const search = parseUrlSearch(url.search);
  const label = returnLabel(returnTo);
  const replace = true;
  switch (classifySupportedPath(url.pathname).kind) {
    case 'reports':
      return <Link to="/reports" search={parseReportsSearch(search, options)} replace>{label}</Link>;
    case 'today':
      return <Link to="/today" search={parseTodaySearch(search, options)} replace>{label}</Link>;
    case 'work':
      return <Link to="/work" search={parseWorkSearch(search, options)} replace>{label}</Link>;
    case 'plans': {
      const route = classifySupportedPath(url.pathname);
      if (route.kind === 'plans' && route.planId !== undefined) {
        return <Link to="/plans/$planId" params={{ planId: route.planId }} search={parsePlansSearch(search)} replace>{label}</Link>;
      }
      return <Link to="/plans" search={parsePlansSearch(search)} replace>{label}</Link>;
    }
    case 'team': {
      const route = classifySupportedPath(url.pathname);
      if (route.kind === 'team' && route.memberSlug !== undefined) {
        return <Link to="/team/$memberSlug" params={{ memberSlug: route.memberSlug }} search={parseTeamSearch(search, options)} replace>{label}</Link>;
      }
      return <Link to="/team" search={parseTeamSearch(search, options)} replace>{label}</Link>;
    }
    case 'weekly-planning':
      if (!trackerInstanceConfig.features.weeklyPlanning) {
        return <Link to="/work" search={parseWorkSearch({}, options)} replace>Return to Work</Link>;
      }
      return <Link to="/weekly-planning" replace>{label}</Link>;
    default:
      return <Link to="/work" search={parseWorkSearch({}, options)} replace>Return to Work</Link>;
  }
}

function routeIsBrowsing(pathname: string): boolean {
  const route = classifySupportedPath(pathname);
  return route.kind === 'today'
    || (route.kind === 'work' && route.itemId === undefined)
    || route.kind === 'plans'
    || route.kind === 'team';
}

function editableFieldLabel(field: string): string {
  switch (field) {
    case 'title': return 'Title';
    case 'sections.outcome': return 'Outcome';
    case 'sections.completionCondition': return 'Completion condition';
    case 'sections.nextStep': return 'Next step';
    case 'sections.evidence': return 'Evidence';
    default: return field;
  }
}

function NotFoundPage() {
  return <section className="surface-card empty-hero route-not-found"><h1>Page not found</h1><p>This route is not part of the tracker.</p><Link to="/work" search={parseWorkSearch({})}>Return to Work</Link></section>;
}

function ViewerIdentitySummary() {
  const identity = useViewerIdentity();
  if (identity.kind === 'loading') {
    return <div className="sidebar-identity" data-testid="viewer-identity"><span className="sidebar-identity-label">Signed-in identity</span><strong>Checking identity…</strong></div>;
  }
  if (identity.kind === 'unavailable') {
    return <div className="sidebar-identity sidebar-identity-unavailable" data-testid="viewer-identity"><span className="sidebar-identity-label">Signed-in identity</span><strong>Identity unavailable</strong><small>{identity.message}</small></div>;
  }
  if (identity.actor.kind === 'service') {
    return <div className="sidebar-identity" data-testid="viewer-identity"><span className="sidebar-identity-label">Signed-in identity</span><strong>Service identity</strong><small>Read-only access</small></div>;
  }
  const name = typeof identity.actor.person?.name === 'string' && identity.actor.person.name.trim() !== ''
    ? identity.actor.person.name
    : 'Signed-in user';
  return <div className="sidebar-identity" data-testid="viewer-identity"><span className="sidebar-identity-label">Signed-in identity</span><strong>{name}</strong><small>{identity.actor.email ?? 'Verified directory identity'}</small></div>;
}

function Sidebar({
  data,
  teamProjection,
  pathname,
  onNavigateSearchHref,
  onSelectSearchResult,
}: {
  data: TrackerSnapshot;
  teamProjection: boolean;
  pathname: string;
  onNavigateSearchHref: (href: string) => void;
  onSelectSearchResult: (result: GlobalSearchResult) => void;
}) {
  const projectOptions = projectFilterOptions(data);
  const organizationOptions = teamFilterOptions(data);
  const reportsOptions = reportFilterOptions(data);
  const branding = trackerInstanceConfig.branding;
  const route = classifySupportedPath(pathname);
  const activeFamily = route.kind === 'today' ? 'today'
    : route.kind === 'work' ? 'work'
      : route.kind === 'plans' ? 'plans'
        : route.kind === 'team' ? 'team'
          : route.kind === 'reports' ? 'reports'
          : route.kind === 'weekly-planning' ? 'weekly-planning'
          : null;
  const active = (family: 'today' | 'work' | 'plans' | 'team' | 'reports' | 'weekly-planning') => activeFamily === family;
  const navClass = (family: 'today' | 'work' | 'plans' | 'team' | 'reports' | 'weekly-planning') => `app-nav-link${active(family) ? ' app-nav-link-active' : ''}`;
  const workSearch = parseWorkSearch(sessionBrowseFilters.restoreWork(projectOptions), projectOptions);
  const todaySearch = parseTodaySearch(sessionBrowseFilters.restoreToday(projectOptions), projectOptions);
  const plansSearch = parsePlansSearch(sessionBrowseFilters.restorePlans());
  const teamSearch = parseTeamSearch(sessionBrowseFilters.restoreTeam(organizationOptions), organizationOptions);
  const reportsSearch = sessionReportsFilters.restore(reportsOptions);

  return <aside className="app-sidebar" aria-label="Tracker navigation">
    <Link className="brand-lockup" to="/work" search={workSearch} aria-label={branding.homeLabel}>
      <span className="brand-mark">{branding.markText}</span><span className="brand-name">{branding.name}</span>
    </Link>
    {teamProjection ? null : <GlobalSearchDialog data={data} onNavigate={onNavigateSearchHref} onSelectResult={onSelectSearchResult} />}
    <nav className="primary-nav" data-primary-navigation aria-label="Tracker views">
      <div className="app-tabs">
        {teamProjection ? null : <Link className={navClass('today')} data-slot="tabs-trigger" data-state={active('today') ? 'active' : 'inactive'} to="/today" search={todaySearch} aria-current={active('today') ? 'page' : undefined}><CalendarDays size={16} aria-hidden="true" />Today</Link>}
        <Link className={navClass('work')} data-slot="tabs-trigger" data-state={active('work') ? 'active' : 'inactive'} to="/work" search={workSearch} aria-current={active('work') ? 'page' : undefined}><LayoutDashboard size={16} aria-hidden="true" />Work</Link>
        {teamProjection ? null : <Link className={navClass('plans')} data-slot="tabs-trigger" data-state={active('plans') ? 'active' : 'inactive'} to="/plans" search={plansSearch} aria-current={active('plans') ? 'page' : undefined}><ClipboardList size={16} aria-hidden="true" />Plans</Link>}
        {trackerInstanceConfig.features.weeklyPlanning ? <Link className={navClass('weekly-planning')} data-slot="tabs-trigger" data-state={active('weekly-planning') ? 'active' : 'inactive'} to="/weekly-planning" aria-current={active('weekly-planning') ? 'page' : undefined}><ClipboardList size={16} aria-hidden="true" />Weekly planning</Link> : null}
        <Link className={navClass('team')} data-slot="tabs-trigger" data-state={active('team') ? 'active' : 'inactive'} to="/team" search={teamSearch} aria-current={active('team') ? 'page' : undefined}><Users size={16} aria-hidden="true" />Team</Link>
        {teamProjection ? null : <Link className={navClass('reports')} data-slot="tabs-trigger" data-state={active('reports') ? 'active' : 'inactive'} to="/reports" search={reportsSearch} aria-current={active('reports') ? 'page' : undefined}><BarChart3 size={16} aria-hidden="true" />Reports</Link>}
      </div>
    </nav>
    <ViewerIdentitySummary />
    <ThemeControl />
  </aside>;
}

function AppShellContent() {
  const { data, taskEdit } = useRouteContext({ from: '__root__' });
  const teamProjection = isTeamProjection(data);
  const location = useRouterState({ select: state => state.location });
  const navigate = useNavigate();
  const returnFocus = useRef<HTMLElement | null>(null);
  const pendingHistoryIntent = useRef<{ undo: string | null; redo: string | null }>({ undo: null, redo: null });
  const projectOptions = projectFilterOptions(data);
  const organizationOptions = teamFilterOptions(data);
  const reportsOptions = reportFilterOptions(data);
  const pathname = location.pathname;
  const route = classifySupportedPath(pathname);
  const browsing = routeIsBrowsing(pathname);
  const currentRouteRef = useRef({ pathname, browsing });
  currentRouteRef.current = { pathname, browsing };
  const rawSearch = location.search as SearchInput;
  if (route.kind === 'today') sessionBrowseFilters.rememberToday(parseTodaySearch(rawSearch, projectOptions), projectOptions);
  else if (route.kind === 'work' && route.itemId === undefined) sessionBrowseFilters.rememberWork(parseWorkSearch(rawSearch, projectOptions), projectOptions);
  else if (route.kind === 'plans') sessionBrowseFilters.rememberPlans(parsePlansSearch(rawSearch));
  else if (route.kind === 'team') sessionBrowseFilters.rememberTeam(parseTeamSearch(rawSearch, organizationOptions), organizationOptions);
  else if (route.kind === 'reports') sessionReportsFilters.remember(rawSearch, reportsOptions);
  const itemId = browsing ? selectedItemId(rawSearch) : undefined;
  const selectedItem = itemId === undefined ? null : data.itemById.get(itemId) ?? null;
  const selectedHistory = itemId === undefined ? null : data.history.find(entry => entry.id === itemId) ?? null;
  const sheetOpen = browsing && itemId !== undefined;
  const returnTo = routeReturnTo(pathname, rawSearch, location.state, { ...projectOptions, ...organizationOptions });
  const meaningfulSessions = taskEdit.sessions.filter(session => session.currentValue !== session.beforeValue);
  const localMeaningfulSession = meaningfulSessions.find(session => session.ownerId === taskEdit.ownerId) ?? null;
  const undoAction = taskEdit.history.undo.at(-1) ?? null;
  const redoAction = taskEdit.history.redo.at(-1) ?? null;
  const undoTarget = localMeaningfulSession ?? undoAction;
  const undoExpectedActionId = localMeaningfulSession?.sessionId ?? undoAction?.actionId;
  const redoExpectedActionId = redoAction?.actionId;
  const redoBlockedBySession = meaningfulSessions.length > 0;
  const undoTargetExists = undoTarget === null || data.itemById.has(undoTarget.itemId);
  const redoTargetExists = redoAction === null || data.itemById.has(redoAction.itemId);
  const undoHeldByOtherTab = undoTarget !== null && taskEdit.sessions.some(session =>
    session.ownerId !== taskEdit.ownerId
    && session.itemId === undoTarget.itemId
    && session.field === undoTarget.field
  );
  const redoHeldByOtherTab = redoAction !== null && taskEdit.sessions.some(session =>
    session.ownerId !== taskEdit.ownerId
    && session.itemId === redoAction.itemId
    && session.field === redoAction.field
  );
  const canUndo = taskEdit.ownerState === 'ready'
    && undoTarget !== null
    && undoTargetExists
    && !undoHeldByOtherTab;
  const canRedo = taskEdit.ownerState === 'ready'
    && redoAction !== null
    && redoTargetExists
    && !redoBlockedBySession
    && !redoHeldByOtherTab;
  const unavailableUndo = localMeaningfulSession === null && undoAction !== null && !undoTargetExists ? undoAction : null;
  const unavailableRedo = redoAction !== null && !redoTargetExists ? redoAction : null;
  const undoTargetTitle = undoTarget ? data.itemById.get(undoTarget.itemId)?.title ?? undoTarget.itemId : null;
  const redoTargetTitle = redoAction ? data.itemById.get(redoAction.itemId)?.title ?? redoAction.itemId : null;
  const taskHistoryStatus = taskEdit.ownerState === 'checking'
    ? 'Checking edit history…'
    : taskEdit.ownerState === 'unsupported'
      ? 'This browser cannot coordinate task edits across tabs.'
      : taskEdit.history.skipped.length > 0
        ? `${taskEdit.history.skipped.length} unavailable edit${taskEdit.history.skipped.length === 1 ? '' : 's'} skipped and retained in history.`
        : null;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      const target = event.target;
      if (target instanceof HTMLElement && (
        target.isContentEditable
        || target.closest('input, textarea, [contenteditable="true"]') !== null
      )) return;
      const key = event.key.toLowerCase();
      const direction = key === 'z' && event.shiftKey || key === 'y'
        ? 'redo'
        : key === 'z' ? 'undo' : null;
      if (direction === null) return;
      if (direction === 'undo' ? !canUndo : !canRedo) return;
      const expectedActionId = direction === 'undo' ? undoExpectedActionId : redoExpectedActionId;
      if (expectedActionId === undefined) return;
      event.preventDefault();
      taskEdit.requestHistoryMove(direction, expectedActionId);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [canRedo, canUndo, redoExpectedActionId, taskEdit, undoExpectedActionId]);

  const navigateSearchHref = (href: string) => {
    const target = internalLinkTarget(href, window.location.href);
    if (target === null) return;
    const targetRoute = classifySupportedPath(target.pathname);
    switch (targetRoute.kind) {
      case 'reports':
        void navigate({ to: '/reports', search: parseReportsSearch({ ...sessionReportsFilters.restore(reportsOptions), ...target.search }, reportsOptions) });
        break;
      case 'work':
        if (targetRoute.itemId === undefined) {
          const search = parseWorkSearch({ ...sessionBrowseFilters.restoreWork(projectOptions), ...target.search }, projectOptions);
          void navigate({ to: '/work', search });
        } else {
          void navigate({ to: '/work/$itemId', params: { itemId: targetRoute.itemId }, state: { returnTo } });
        }
        break;
      case 'today': {
        const search = parseTodaySearch({ ...sessionBrowseFilters.restoreToday(projectOptions), ...target.search }, projectOptions);
        void navigate({ to: '/today', search });
        break;
      }
      case 'plans': {
        const search = parsePlansSearch({ ...sessionBrowseFilters.restorePlans(), ...target.search });
        if (targetRoute.planId === undefined) void navigate({ to: '/plans', search });
        else void navigate({ to: '/plans/$planId', params: { planId: targetRoute.planId }, search });
        break;
      }
      case 'team': {
        const search = parseTeamSearch({ ...sessionBrowseFilters.restoreTeam(organizationOptions), ...target.search }, organizationOptions);
        if (targetRoute.memberSlug === undefined) void navigate({ to: '/team', search });
        else void navigate({ to: '/team/$memberSlug', params: { memberSlug: targetRoute.memberSlug }, search });
        break;
      }
      case 'decision':
        void navigate({ to: '/decisions/$decisionId', params: { decisionId: targetRoute.decisionId } });
        break;
      case 'weekly-planning':
        if (trackerInstanceConfig.features.weeklyPlanning) void navigate({ to: '/weekly-planning' });
        else void navigate({ to: '/work', search: parseWorkSearch({}, projectOptions), replace: true });
        break;
      case 'root':
      case 'invalid':
      case 'unknown':
        break;
      default: {
        const exhaustive: never = targetRoute;
        return exhaustive;
      }
    }
  };

  const onSelectSearchResult = (result: GlobalSearchResult) => navigateSearchHref(result.href);

  const focusFallback = () => {
    const link = document.querySelector<HTMLElement>('[data-primary-navigation] [aria-current="page"]');
    if (link?.isConnected) {
      link.focus({ preventScroll: true });
      return;
    }
    document.querySelector<HTMLElement>('main.app-shell')?.focus({ preventScroll: true });
  };

  const onCloseAutoFocus = (event: Event) => {
    event.preventDefault();
    if (!currentRouteRef.current.browsing) {
      returnFocus.current = null;
      requestAnimationFrame(() => document.querySelector<HTMLElement>('main.app-shell')?.focus({ preventScroll: true }));
      return;
    }
    const trigger = returnFocus.current;
    returnFocus.current = null;
    requestAnimationFrame(() => {
      if (trigger?.isConnected && trigger.getClientRects().length > 0) trigger.focus({ preventScroll: true });
      else focusFallback();
    });
  };

  const rememberTriggerIfClosed = () => {
    if (sheetOpen || returnFocus.current !== null) return;
    const active = document.activeElement;
    returnFocus.current = active instanceof HTMLElement && active !== document.body ? active : null;
  };

  const navigateSearchMutation = (mutation: ReturnType<typeof selectItemMutation> | ReturnType<typeof closeItemMutation> | ReturnType<typeof replaceFiltersMutation>) => {
    if (mutation.kind === 'none') return;
    const replace = mutation.kind === 'replace';
    switch (classifySupportedPath(mutation.pathname).kind) {
      case 'today':
        void navigate({ to: '/today', search: parseTodaySearch(mutation.search, projectOptions), replace, resetScroll: false });
        break;
      case 'work': {
        const target = classifySupportedPath(mutation.pathname);
        if (target.kind === 'work' && target.itemId === undefined) {
          void navigate({ to: '/work', search: parseWorkSearch(mutation.search, projectOptions), replace, resetScroll: false });
        }
        break;
      }
      case 'plans': {
        const target = classifySupportedPath(mutation.pathname);
        if (target.kind === 'plans' && target.planId !== undefined) {
          void navigate({ to: '/plans/$planId', params: { planId: target.planId }, search: parsePlansSearch(mutation.search), replace, resetScroll: false });
        } else {
          void navigate({ to: '/plans', search: parsePlansSearch(mutation.search), replace, resetScroll: false });
        }
        break;
      }
      case 'team': {
        const target = classifySupportedPath(mutation.pathname);
        if (target.kind === 'team' && target.memberSlug !== undefined) {
          void navigate({ to: '/team/$memberSlug', params: { memberSlug: target.memberSlug }, search: parseTeamSearch(mutation.search, organizationOptions), replace, resetScroll: false });
        } else {
          void navigate({ to: '/team', search: parseTeamSearch(mutation.search, organizationOptions), replace, resetScroll: false });
        }
        break;
      }
      default:
        break;
    }
  };

  const onSelectItem = (nextItemId: string) => {
    if (!sheetOpen) rememberTriggerIfClosed();
    navigateSearchMutation(selectItemMutation({ pathname, search: rawSearch }, nextItemId));
  };

  const onOpenChange = (open: boolean) => {
    if (open) return;
    navigateSearchMutation(closeItemMutation({ pathname, search: rawSearch }));
  };

  const fullPageLink = itemId !== undefined && (selectedItem !== null || selectedHistory !== null)
    ? <Link to="/work/$itemId" params={{ itemId }} state={{ returnTo }} className="details-sheet-full-page-link">Open full page</Link>
    : null;

  const routeHrefClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!(event.target instanceof Element)) return;
    const anchor = event.target.closest('a');
    if (!(anchor instanceof HTMLAnchorElement) || !shouldInterceptMarkdownClick(event.nativeEvent, anchor)) return;
    const href = anchor.getAttribute('href');
    if (href === null) return;
    const target = internalLinkTarget(href, window.location.href);
    if (target === null) return;
    event.preventDefault();
    const targetRoute = classifySupportedPath(target.pathname);
    switch (targetRoute.kind) {
      case 'reports':
        void navigate({ to: '/reports', search: parseReportsSearch(target.search, reportsOptions) });
        break;
      case 'work':
        if (targetRoute.itemId === undefined) {
          void navigate({ to: '/work', search: parseWorkSearch(target.search, projectOptions) });
        } else {
          const origin = routeReturnTo(pathname, rawSearch, location.state, { ...projectOptions, ...organizationOptions });
          void navigate({ to: '/work/$itemId', params: { itemId: targetRoute.itemId }, state: { returnTo: origin } });
        }
        break;
      case 'today':
        void navigate({ to: '/today', search: parseTodaySearch(target.search, projectOptions) });
        break;
      case 'plans':
        if (targetRoute.planId === undefined) void navigate({ to: '/plans', search: parsePlansSearch(target.search) });
        else void navigate({ to: '/plans/$planId', params: { planId: targetRoute.planId }, search: parsePlansSearch(target.search) });
        break;
      case 'team':
        if (targetRoute.memberSlug === undefined) void navigate({ to: '/team', search: parseTeamSearch(target.search, organizationOptions) });
        else void navigate({ to: '/team/$memberSlug', params: { memberSlug: targetRoute.memberSlug }, search: parseTeamSearch(target.search, organizationOptions) });
        break;
      case 'decision':
        void navigate({ to: '/decisions/$decisionId', params: { decisionId: targetRoute.decisionId } });
        break;
      case 'weekly-planning':
        if (trackerInstanceConfig.features.weeklyPlanning) void navigate({ to: '/weekly-planning' });
        else void navigate({ to: '/work', search: parseWorkSearch({}, projectOptions), replace: true });
        break;
      case 'root':
      case 'invalid':
      case 'unknown':
        break;
      default: {
        const exhaustive: never = targetRoute;
        return exhaustive;
      }
    }
  };

  return <BrowseSelectionProvider onSelectItem={onSelectItem}><div className="app-root" onClick={routeHrefClick}>
    <Sidebar data={data} teamProjection={teamProjection} pathname={pathname} onNavigateSearchHref={navigateSearchHref} onSelectSearchResult={onSelectSearchResult} />
    <div className="app-main">
      <main className="app-shell" tabIndex={-1}>
        {teamProjection ? null : <div className="task-history-toolbar" role="group" aria-label="Task edit history">
          <Button type="button" variant="outline" size="sm" disabled={!canUndo} title={undoTarget ? `Undo last edit to ${editableFieldLabel(undoTarget.field)} on ${undoTargetTitle}` : 'No task edit to undo'} onPointerDownCapture={() => { pendingHistoryIntent.current.undo = undoExpectedActionId ?? null; }} onClick={() => {
            const expected = pendingHistoryIntent.current.undo ?? undoExpectedActionId;
            pendingHistoryIntent.current.undo = null;
            if (expected) taskEdit.requestHistoryMove('undo', expected);
          }}>
            <Undo2 size={15} aria-hidden="true" />Undo
          </Button>
          <Button type="button" variant="outline" size="sm" disabled={!canRedo} title={redoAction ? `Redo edit to ${editableFieldLabel(redoAction.field)} on ${redoTargetTitle}` : 'No task edit to redo'} onPointerDownCapture={() => { pendingHistoryIntent.current.redo = redoExpectedActionId ?? null; }} onClick={() => {
            const expected = pendingHistoryIntent.current.redo ?? redoExpectedActionId;
            pendingHistoryIntent.current.redo = null;
            if (expected) taskEdit.requestHistoryMove('redo', expected);
          }}>
            <Redo2 size={15} aria-hidden="true" />Redo
          </Button>
          {unavailableUndo ? <Button type="button" variant="ghost" size="sm" aria-label="Skip unavailable Undo edit" title={`Skip the unavailable Undo edit for ${unavailableUndo.itemId}; it will remain in retained history.`} onClick={() => taskEdit.skipUnavailable('undo', unavailableUndo.actionId)}>Skip unavailable edit</Button> : null}
          {unavailableRedo ? <Button type="button" variant="ghost" size="sm" aria-label="Skip unavailable Redo edit" title={`Skip the unavailable Redo edit for ${unavailableRedo.itemId}; it will remain in retained history.`} onClick={() => taskEdit.skipUnavailable('redo', unavailableRedo.actionId)}>Skip unavailable edit</Button> : null}
          {taskHistoryStatus ? <span className="task-history-save-state" role="status" aria-live="polite">{taskHistoryStatus}</span> : null}
          {undoHeldByOtherTab || redoHeldByOtherTab ? <span className="task-history-save-error">Finish editing this field in the other tab before changing its history.</span> : null}
        </div>}
        <Outlet />
      </main>
      <footer className="app-footer">
        <SnapshotFooter source={data.source} />
        <span>Repository records remain the source of truth.</span>
      </footer>
    </div>
    {browsing ? <ItemDetailSheet
      item={selectedItem}
      history={selectedHistory}
      data={data}
      open={sheetOpen}
      onOpenChange={onOpenChange}
      onSelectItem={onSelectItem}
      onCloseAutoFocus={onCloseAutoFocus}
      fullPageLink={fullPageLink}
    /> : null}
  </div></BrowseSelectionProvider>;
}

export function TrackerNotFound() {
  return <NotFoundPage />;
}

export function AppShell() {
  const { data } = useRouteContext({ from: '__root__' });
  return <ViewerIdentityProvider team={data.team}><AppShellContent /></ViewerIdentityProvider>;
}
