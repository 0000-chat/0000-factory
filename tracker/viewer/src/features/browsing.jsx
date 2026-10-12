import { useEffect, useMemo } from 'react';
import { Link } from '@tanstack/react-router';
import {
  ArrowUpRight,
  CheckCircle2,
  CircleHelp,
  Inbox,
  Info,
  ListChecks,
} from 'lucide-react';
import { Button } from '../components/ui/button.tsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card.tsx';
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableHeaderGroup,
  TableProvider,
  TableRow,
} from '../components/kibo-ui/table/index.tsx';
import { PersonLink } from '../person-link.tsx';
import { SearchField } from '../search-field.tsx';
import { TrackerEmpty } from '../tracker-empty.tsx';
import { CalendarView, KanbanView } from '../work-modes.jsx';
import { WorkActivityControls } from '../work-activity-ui.jsx';
import { WorkGantt } from '../work-gantt.jsx';
import { WorkTree } from '../work-tree.jsx';
import { WorkWeekControls } from '../work-week-controls.tsx';
import {
  AttentionCard,
  BadgeChip,
  EmptyInline,
  Markdown,
  TodayFocus,
  formatDate,
  healthLabel,
  humanize,
  planCounts,
  statusTone,
  DEFAULT_SCHEDULE,
} from '../shared.jsx';
import {
  commitmentLabel,
  groupAttention,
  isAccepted,
  isDraft,
  scheduleFeatures as buildScheduleFeatures,
} from '../view-model.mjs';

function progressPercent(progress) {
  if (!progress || progress.scoped !== true) return null;
  const value = Number(progress.percent);
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null;
}

function ProgressInline({ item }) {
  const value = progressPercent(item.progress);
  if (value === null) return <span className="tree-unscoped" title="No approved milestone plan">Unscoped</span>;
  return <span className="tree-progress-meta" role="progressbar" aria-label={`${Math.round(value)}% verified progress`} aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(value)} title={`${Math.round(value)}% verified progress`}><span className="tree-progress-track"><span className="tree-progress-fill" style={{ width: `${value}%` }} /></span><span className="tree-percent">{Math.round(value)}%</span></span>;
}

function ScheduleInline({ item }) {
  const schedule = { ...DEFAULT_SCHEDULE, ...item.schedule };
  const minimum = schedule.forecastEndMin || schedule.forecastEndMax;
  const maximum = schedule.forecastEndMax || schedule.forecastEndMin;
  if (minimum || maximum) return <span className="tree-forecast" title="Recorded forecast end">Forecast · {formatDate(minimum)}{maximum && maximum !== minimum ? `–${formatDate(maximum)}` : ''}</span>;
  if (schedule.proposedEnd) return <span className="tree-forecast tree-proposed" title={schedule.proposedScheduleKind === 'checkpoint' ? 'Proposed checkpoint end' : schedule.proposedScheduleKind === 'slice' ? 'Proposed slice end' : 'Proposed schedule end'}>{schedule.proposedScheduleKind === 'checkpoint' ? 'Checkpoint' : schedule.proposedScheduleKind === 'slice' ? 'Slice' : 'Proposed'} · {formatDate(schedule.proposedEnd)}</span>;
  if (schedule.plannedEnd && schedule.approved === true && isAccepted(item)) return <span className="tree-forecast tree-baseline" title="Approved baseline end">Baseline · {formatDate(schedule.plannedEnd)}</span>;
  if (schedule.plannedEnd && !isAccepted(item)) return <span className="tree-forecast tree-proposed" title="Proposed end">{commitmentLabel(item)} · {formatDate(schedule.plannedEnd)}</span>;
  return <span className="tree-forecast" title="No approved or forecast dates">Unscheduled</span>;
}

function scheduleSortValue(item) {
  const features = buildScheduleFeatures([item]);
  return features.reduce((earliest, feature) => !earliest || feature.startAt.valueOf() < earliest.valueOf() ? feature.startAt : earliest, null);
}

function WorkTable({ items, contextualIds = new Set(), onSelect }) {
  const columns = useMemo(() => [
    { accessorKey: 'title', header: 'Work', cell: ({ row }) => { const item = row.original; return <span className="work-title-cell">{item.referenceCode ? <code className="work-reference-code">{item.referenceCode}</code> : null}<span>{item.title}</span>{!isAccepted(item) ? <BadgeChip tone={isDraft(item) ? 'slate' : 'amber'}>{commitmentLabel(item)}</BadgeChip> : null}</span>; } },
    { accessorKey: 'status', header: 'Status', sortingAccessor: item => item.status, cell: ({ row }) => humanize(row.original.status) },
    { id: 'health', header: 'Health', sortingAccessor: item => item.health?.state ?? null, cell: ({ row }) => healthLabel(row.original.health?.state) },
    { id: 'owner', header: 'Owner', sortingAccessor: item => item.ownerName || item.owner || null, cell: ({ row }) => row.original.owner && row.original.owner !== 'unassigned' ? <PersonLink value={row.original.owner} name={row.original.ownerName} avatar assignment className="work-table-owner-link" /> : 'Unassigned' },
    { id: 'progress', header: 'Verified progress', sortingAccessor: item => isAccepted(item) ? progressPercent(item.progress) : null, cell: ({ row }) => <ProgressInline item={row.original} /> },
    { id: 'schedule', header: 'Schedule', sortingAccessor: scheduleSortValue, cell: ({ row }) => <><ScheduleInline item={row.original} />{contextualIds.has(row.original.id) ? <BadgeChip tone="slate">Context</BadgeChip> : null}</> },
    { id: 'children', header: 'Children', sortingAccessor: item => item.childSummary?.total, cell: ({ row }) => row.original.childSummary.total ? `${row.original.childSummary.done}/${row.original.childSummary.total} done` : '—' },
  ], [contextualIds]);
  const selectRow = row => onSelect(row.original.id);
  const handleRowKeyDown = (row, event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      selectRow(row);
    }
  };
  return <div className="work-table-wrap"><TableProvider columns={columns} data={items}><TableHeader>{({ headerGroup }) => <TableHeaderGroup headerGroup={headerGroup}>{({ header }) => <TableHead header={header} />}</TableHeaderGroup>}</TableHeader><TableBody>{({ row }) => <TableRow row={row} className="work-table-row" tabIndex={0} onClick={event => { event.currentTarget.focus(); selectRow(row); }} onKeyDown={event => handleRowKeyDown(row, event)}>{({ cell }) => <TableCell cell={cell} />}</TableRow>}</TableBody></TableProvider></div>;
}

function UndatedActiveCommitments({ items, onSelect }) {
  if (!items.length) return null;
  return <section className="work-undated-active" aria-labelledby="work-undated-active-heading">
    <div className="group-heading"><div><h3 id="work-undated-active-heading">Active commitments without dates</h3><p className="source-note">These accepted items stay visible for follow-up; they are excluded from the dated week view.</p></div><BadgeChip tone="amber">{items.length}</BadgeChip></div>
    <div className="work-undated-active-list">{items.map(item => <button key={item.id} type="button" onClick={() => onSelect(item.id)}><span><strong>{item.title}</strong><small>{item.ownerName || item.owner || 'Owner not recorded'} · {humanize(item.status)}</small></span><ArrowUpRight size={15} aria-hidden="true" /></button>)}</div>
  </section>;
}

function scheduleFeatures(items) {
  return buildScheduleFeatures(items).map(feature => ({
    ...feature,
    rangeLabel: feature.rangeLabel.includes('→')
      ? feature.rangeLabel.split(' → ').map(value => formatDate(value)).join(' → ')
      : feature.rangeLabel,
  }));
}

function ExternalDependencies({ items, onSelect }) {
  if (!items.length) return null;
  return <section className="external-deps" aria-labelledby="external-dependencies-heading"><div className="group-heading"><h3 id="external-dependencies-heading">External dependencies</h3><span>{items.length}</span></div><p className="source-note">Dependencies outside this scope stay visible for context.</p><div className="external-deps-list">{items.map(item => <button key={item.id} type="button" onClick={() => onSelect(item.id)}><span><strong>{item.title}{!isAccepted(item) ? <BadgeChip tone={isDraft(item) ? 'slate' : 'amber'}>{commitmentLabel(item)}</BadgeChip> : null}</strong><small>{humanize(item.status)} · {healthLabel(item.health?.state)}</small></span><ArrowUpRight size={15} aria-hidden="true" /></button>)}</div></section>;
}

/** @param {import('./contracts').WorkViewProps} props */
export function WorkView({ items, roots, data, selectedId, onSelectItem, mode = 'gantt', onModeChange, externalItems, visibleIds, contextualIds = new Set(), managerProjection, managerEnabled = false, workActivity, toolbarControls, navigationControls, navigationDate, selectedWeek, workflow = 'standard', onWorkflowChange = () => {}, onWeekChange = () => {}, undatedActiveItems = [], groupByOwner = false, onGroupByOwnerChange = () => {}, presentationMode = false, onPresentationModeChange = () => {} }) {
  const onSelect = onSelectItem;
  const workloadItems = useMemo(() => items.filter(item => !contextualIds.has(item.id)), [items, contextualIds]);
  const managerContextOnly = managerEnabled && (mode === 'tree' || mode === 'gantt') && items.length > 0;
  const calendarFeatures = useMemo(() => scheduleFeatures(workloadItems), [workloadItems]);
  useEffect(() => {
    if (!presentationMode) return undefined;
    const onKeyDown = event => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onPresentationModeChange(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onPresentationModeChange, presentationMode]);
  return <Card className={`surface-card work-card${presentationMode ? ' work-card-presentation' : ''}`}>
    <CardHeader className="surface-card-header">
      <div className="work-heading"><p className="eyebrow">Execution</p><h1 className="work-title">Work</h1><CardDescription>Accepted work, linked plans, delivery health, and recorded schedule.</CardDescription></div>
      <div className="work-view-switcher" role="group" aria-label="Work view">
        <Button size="sm" variant={mode === 'tree' ? 'secondary' : 'ghost'} aria-pressed={mode === 'tree'} onClick={() => onModeChange('tree')}>Tree</Button>
        <Button size="sm" variant={mode === 'table' ? 'secondary' : 'ghost'} aria-pressed={mode === 'table'} onClick={() => onModeChange('table')}>Table</Button>
        <Button size="sm" variant={mode === 'calendar' ? 'secondary' : 'ghost'} aria-pressed={mode === 'calendar'} onClick={() => onModeChange('calendar')}>Calendar</Button>
        <Button size="sm" variant={mode === 'kanban' ? 'secondary' : 'ghost'} aria-pressed={mode === 'kanban'} onClick={() => onModeChange('kanban')}>Kanban</Button>
        <Button size="sm" variant={mode === 'gantt' ? 'secondary' : 'ghost'} aria-pressed={mode === 'gantt'} onClick={() => onModeChange('gantt')}>Gantt</Button>
      </div>
    </CardHeader>
    <CardContent className="work-content">
      {selectedWeek ? <WorkWeekControls
        workflow={workflow}
        selectedWeek={selectedWeek}
        onWorkflowChange={onWorkflowChange}
        onWeekChange={onWeekChange}
        groupByOwner={groupByOwner}
        onGroupByOwnerChange={onGroupByOwnerChange}
        presentationMode={presentationMode}
        onPresentationModeChange={onPresentationModeChange}
      /> : null}
      {workflow === 'next-week' ? <div className="work-next-week-note" role="status">Candidate queue is limited to open current or upcoming tasks with recorded readiness. Review the Tree queue first; switch to Gantt for the recorded next-week preview. No future dates are inferred.</div> : null}
      <div className="work-toolbar">{toolbarControls}</div>
      <div className="work-content-topbar">
        {mode === 'tree' || mode === 'gantt' ? <WorkActivityControls workActivity={workActivity} /> : <span />}
        <div className="work-date-controls">{navigationControls}</div>
      </div>
      <ExternalDependencies items={externalItems} onSelect={onSelect} />
      {workflow === 'this-week' ? <UndatedActiveCommitments items={undatedActiveItems} onSelect={onSelect} /> : null}
      {workloadItems.length === 0 && !managerContextOnly
      ? <TrackerEmpty className="work-no-matches" icon={<Inbox size={22} aria-hidden="true" />} title={<h3>{data.source?.layout === 'team-projection-v1' && data.items.length === 0 ? 'No shared work is available yet.' : 'No work matches these filters.'}</h3>} description={data.source?.layout === 'team-projection-v1' && data.items.length === 0 ? 'No tasks were included in this shared snapshot.' : 'Change or reset the Work filters to show items again.'} />
      : mode === 'tree' ? <WorkTree roots={roots} data={data} selectedId={selectedId} onSelect={onSelect} visibleIds={visibleIds} contextualIds={contextualIds} workActivity={workActivity} managerProjection={managerProjection} managerEnabled={managerEnabled} groupByOwner={groupByOwner} /> : mode === 'table' ? <WorkTable items={items} contextualIds={contextualIds} onSelect={onSelect} /> : mode === 'calendar' ? <CalendarView items={items} features={calendarFeatures} releases={data.releases ?? []} team={data.team} contextualIds={contextualIds} selectedId={selectedId} onSelect={onSelect} navigationDate={navigationDate} /> : mode === 'kanban' ? <KanbanView items={items} contextualIds={contextualIds} selectedId={selectedId} onSelect={onSelect} /> : <WorkGantt items={items} data={data} selectedId={selectedId} onSelect={onSelect} visibleIds={visibleIds} contextualIds={contextualIds} workActivity={workActivity} managerProjection={managerProjection} managerEnabled={managerEnabled} navigationDate={navigationDate} selectedWeek={workflow === 'standard' ? null : selectedWeek} groupByOwner={groupByOwner} presentationMode={presentationMode} onExitPresentationMode={() => onPresentationModeChange(false)} />}</CardContent>
  </Card>;
}

/** @param {import('./contracts').TodayViewProps} props */
export function TodayView({ items, decisions, selectedItem, onSelectItem }) {
  const onSelect = onSelectItem;
  const attention = groupAttention(items, { scopeId: '*' });
  const urgentIds = new Set(attention.urgent.map(entry => entry.id));
  const risks = items.filter(item => urgentIds.has(item.id) || item.status === 'blocked' || item.sections.blocker || item.health?.state === 'at-risk');
  const pendingDecisions = decisions.filter(decision => decision.state === 'proposed');
  const actionable = items.filter(item => ['queued', 'active'].includes(item.status) && item.owner === 'unassigned' && !risks.includes(item));
  const unknownIds = new Set(attention.unknown.map(entry => entry.id));
  const unknown = items.filter(item => unknownIds.has(item.id) && !risks.includes(item) && !actionable.includes(item));
  const hasUnknown = items.some(item => item.health?.state === 'unknown');
  const allOnTrack = items.length > 0 && items.every(item => item.health?.state === 'on-track');
  const summaryTone = risks.length ? 'red' : hasUnknown ? 'amber' : allOnTrack ? 'green' : 'slate';
  const summaryLabel = risks.length ? `${risks.length} risks` : hasUnknown ? 'Health needs review' : 'No confirmed risks';
  return <div className="today-grid"><TodayFocus item={selectedItem} onSelect={onSelect} /><Card className="surface-card today-card"><CardHeader className="surface-card-header"><div><p className="eyebrow">Today</p><CardTitle>Attention first</CardTitle><CardDescription>Known risks, decisions, and next actions from the current snapshot.</CardDescription></div><BadgeChip tone={summaryTone}>{summaryLabel}</BadgeChip></CardHeader><CardContent className="attention-groups"><section><div className="group-heading"><h3>Urgent known risks</h3><span>{risks.length}</span></div>{risks.length ? risks.map(item => <AttentionCard key={item.id} item={item} onSelect={onSelect} />) : <EmptyInline icon={<CheckCircle2 size={17} />} text="No blocked or at-risk work is recorded." />}</section><section><div className="group-heading"><h3>Decisions awaiting <PersonLink value="owner" name="Don" className="today-person-inline">Don</PersonLink></h3><span>{pendingDecisions.length}</span></div>{pendingDecisions.length ? pendingDecisions.map(decision => <div className="decision-row" key={decision.id}><div><Link className="text-link" to="/decisions/$decisionId" params={{ decisionId: decision.id }}><ArrowUpRight size={14} aria-hidden="true" />{decision.title}</Link><p>{decision.owner || decision.ownerName ? <PersonLink value={decision.owner} name={decision.ownerName} className="decision-owner-link" /> : 'Owner not recorded'} · affects {(decision.affects || []).join(', ')}</p></div><BadgeChip tone="amber">Awaiting <PersonLink value="owner" name="Don" className="today-person-inline">Don</PersonLink></BadgeChip></div>) : <EmptyInline icon={<ListChecks size={17} />} text="No proposed decisions are recorded." />}</section><section><div className="group-heading"><h3>Actionable accepted work</h3><span>{actionable.length}</span></div>{actionable.length ? actionable.map(item => <AttentionCard key={item.id} item={item} label="Needs owner" onSelect={onSelect} />) : <EmptyInline icon={<CheckCircle2 size={17} />} text="No unassigned accepted work in this scope." />}</section>{unknown.length ? <details className="unknown-group"><summary><CircleHelp size={16} aria-hidden="true" />Routine unknowns <span>{unknown.length}</span></summary><div>{unknown.map(item => <AttentionCard key={item.id} item={item} label="Unknown" onSelect={onSelect} />)}</div></details> : null}</CardContent></Card></div>;
}

function PlanBrief({ plan, data, onSelect, onOpenWork }) {
  const linkedTasks = plan.taskIds.map(id => data.itemById.get(id)).filter(Boolean);
  const counts = planCounts(linkedTasks);
  const linkedIds = new Set([...linkedTasks.map(task => task.id), plan.project].filter(id => id && data.itemById.has(id)));
  const relatedDecisions = (data.decisions ?? []).filter(decision => (decision.affects ?? []).some(id => linkedIds.has(id)));
  const openDecisionCount = relatedDecisions.filter(decision => decision.state === 'proposed').length;
  const approval = plan.approval ?? {};
  const projectItem = plan.project ? data.itemById.get(plan.project) : null;
  const projectLabel = projectItem?.title || (plan.project ? humanize(plan.project) : 'Project not recorded');
  return <Card className="surface-card plan-card" id="selected-plan-brief">
    <CardHeader className="surface-card-header">
      <div><p className="eyebrow">Decision brief · {plan.revision ? `revision ${plan.revision}` : 'revision not recorded'}</p><CardTitle>{plan.title}</CardTitle><CardDescription>Project · {projectLabel}</CardDescription></div>
      <BadgeChip tone={statusTone(String(plan.status).toLowerCase())}>{plan.status}</BadgeChip>
    </CardHeader>
    <CardContent>
      <div className="plan-brief-layout">
        <div className="plan-brief-narrative">
          <div className="plan-sections">
            <section><h3>Objective</h3><Markdown value={plan.sections?.objective ?? plan.sections?.outcome} /></section>
            {plan.sections?.tradeoffs ? <section><h3>Tradeoffs</h3><Markdown value={plan.sections.tradeoffs} /></section> : null}
          </div>
        </div>
        <aside className="plan-brief-panel" aria-label="Work and approval review">
          <section className="plan-work-summary" aria-label="Linked work">
            <div className="group-heading"><div><h3>Linked work</h3><p className="source-note">{linkedTasks.length} item{linkedTasks.length === 1 ? '' : 's'}</p></div><Button size="sm" variant="secondary" disabled={!linkedTasks.length} onClick={() => onOpenWork(plan)}>Open in Work<ArrowUpRight size={14} aria-hidden="true" /></Button></div>
            <div className="plan-counts"><BadgeChip tone="slate">Draft {counts.draft}</BadgeChip><BadgeChip tone="amber">Planned {counts.planned}</BadgeChip><BadgeChip tone="green">Accepted {counts.accepted}</BadgeChip>{counts.unrecorded ? <BadgeChip>Unrecorded {counts.unrecorded}</BadgeChip> : null}</div>
          </section>
          <section className="plan-approval" aria-label="Recorded plan approval">
            <div className="group-heading"><h3>Approval boundary</h3>{approval.state ? <BadgeChip tone={statusTone(approval.state)}>{humanize(approval.state)}</BadgeChip> : <BadgeChip>No plan approval recorded</BadgeChip>}</div>
            <p className="source-note">Plan status does not accept linked task scope, assignment, or schedule. Each remains a separate recorded approval.</p>
            {approval.approvedBy || approval.approvedAt || approval.source || approval.reference ? <div className="plan-approval-record">
              {approval.approvedBy || approval.approvedAt ? <span>{approval.approvedBy ? <>Recorded by <PersonLink value={approval.approvedBy} className="plan-approver-link" /></> : ''}{approval.approvedBy && approval.approvedAt ? ' · ' : ''}{approval.approvedAt ? `on ${formatDate(approval.approvedAt)}` : ''}</span> : null}
              {approval.source || approval.reference ? <span>{approval.source ? `Source · ${approval.source}` : ''}{approval.source && approval.reference ? ' · ' : ''}{approval.reference ? `Reference · ${approval.reference}` : ''}</span> : null}
            </div> : null}
          </section>
          <section className="plan-decisions" aria-label="Related recorded decisions">
            <div className="group-heading"><div><h3>Related decisions</h3><p className="source-note">{openDecisionCount} open</p></div><span>{relatedDecisions.length}</span></div>
            {relatedDecisions.length ? <ul className="plan-decision-list">{relatedDecisions.map(decision => {
              const affectedIds = (decision.affects ?? []).filter(id => linkedIds.has(id));
              const visibleAffectedIds = affectedIds.slice(0, 3);
              const remainingAffectedIds = affectedIds.slice(3);
              return <li key={decision.id}><div><Link className="text-link" to="/decisions/$decisionId" params={{ decisionId: decision.id }}><ArrowUpRight size={14} aria-hidden="true" />{decision.title}</Link>{decision.state === 'approved' && decision.approvedAt ? <small>Approved {formatDate(decision.approvedAt)}</small> : null}<div className="plan-decision-affects">{visibleAffectedIds.map(id => <button className="text-link" key={id} type="button" onClick={() => onSelect(id)}>{data.itemById.get(id)?.title || id}</button>)}</div>{remainingAffectedIds.length ? <details className="plan-decision-more"><summary>… {remainingAffectedIds.length} more</summary><div className="plan-decision-more-links">{remainingAffectedIds.map(id => <button className="text-link" key={id} type="button" onClick={() => onSelect(id)}>{data.itemById.get(id)?.title || id}</button>)}</div></details> : null}</div><BadgeChip tone={statusTone(decision.state)}>{humanize(decision.state || 'state not recorded')}</BadgeChip></li>;
            })}</ul> : <p className="source-note">No related decision records.</p>}
          </section>
        </aside>
      </div>
    </CardContent>
  </Card>;
}

/** @param {import('./contracts').PlansViewProps} props */
export function PlansView({ plans, data, search = '', onSearchChange, selectedPlanId, onSelectPlan, onSelectItem, onOpenWork }) {
  const onSelect = onSelectItem;
  const entries = useMemo(() => plans.map(plan => {
    const projectItem = plan.project ? data.itemById.get(plan.project) : null;
    const projectLabel = projectItem?.title || (plan.project ? humanize(plan.project) : 'Project not recorded');
    return {
      plan,
      projectLabel,
      linkedCount: plan.taskIds.map(id => data.itemById.get(id)).filter(Boolean).length,
      searchableText: [plan.title, projectLabel, plan.status, plan.sections?.objective, plan.sections?.tradeoffs].join(' ').toLocaleLowerCase(),
    };
  }), [data, plans]);
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const matchingEntries = useMemo(() => entries.filter(entry => !normalizedSearch || entry.searchableText.includes(normalizedSearch)), [entries, normalizedSearch]);
  const selectedEntry = selectedPlanId
    ? entries.find(entry => entry.plan.id === selectedPlanId) ?? null
    : matchingEntries[0] ?? null;

  if (!plans.length) return <div className="plans-grid"><Card className="surface-card empty-plans"><CardContent><TrackerEmpty className="empty-hero" icon={<Inbox size={28} aria-hidden="true" />} title={<h2>No draft plans yet</h2>} description={<><span>Plans published from Codex or ChatGPT will appear here as decision briefs linked to canonical work records.</span><span className="source-note">Publishing a draft never promotes work automatically.</span></>} /></CardContent></Card></div>;

  return <div className="plans-grid">
    <section className="plan-review-intro" aria-label="Plan review purpose">
      <Info size={18} aria-hidden="true" />
      <p>Review the objective and tradeoffs. The selected brief shows approval boundaries, open decisions, and linked work.</p>
    </section>
    <div className="plans-browser">
      <aside className="plan-index surface-card" aria-label="Plan index">
        <div className="plan-index-heading"><h2>Plans</h2><span aria-live="polite">{matchingEntries.length === plans.length ? `${plans.length} total` : `${matchingEntries.length} of ${plans.length}`}</span></div>
        <SearchField label="Search plans" value={search} onChange={onSearchChange} placeholder="Search plans" />
        {matchingEntries.length ? <ul className="plan-index-list">{matchingEntries.map(({ plan, projectLabel, linkedCount }) => {
          const selected = selectedEntry?.plan.id === plan.id;
          return <li key={plan.id}><button className="plan-index-option" type="button" aria-pressed={selected} aria-controls="selected-plan-brief" onClick={() => onSelectPlan(plan.id)}>
            <span className="plan-index-copy"><strong>{plan.title}</strong><small>{projectLabel}</small></span>
            <span className="plan-index-meta"><BadgeChip tone={statusTone(String(plan.status).toLowerCase())}>{plan.status}</BadgeChip><small>{linkedCount} linked</small></span>
          </button></li>;
        })}</ul> : <TrackerEmpty className="plan-index-empty" title={<p>No plans match “{search.trim()}”.</p>} action={<Button size="sm" variant="ghost" onClick={() => onSearchChange('')}>Clear search</Button>} />}
      </aside>
      {selectedEntry ? <PlanBrief plan={selectedEntry.plan} data={data} onSelect={onSelect} onOpenWork={onOpenWork} /> : <Card className="surface-card plan-no-selection"><CardContent><TrackerEmpty className="plan-no-selection" title={<p>No plan selected.</p>} /></CardContent></Card>}
    </div>
  </div>;
}
