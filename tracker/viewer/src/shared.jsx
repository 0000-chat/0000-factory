import {
  AlertTriangle,
  ArrowUpRight,
  ChevronRight,
  GitBranch,
} from 'lucide-react';
import { useRouteContext } from '@tanstack/react-router';
import { Badge } from './components/ui/badge.tsx';
import { Checkbox } from './components/ui/checkbox.tsx';
import { Combobox } from './components/ui/combobox.tsx';
import { Pill } from './components/kibo-ui/pill/index.tsx';
import { Progress } from './components/ui/progress.tsx';
import { renderMarkdown } from './markdown.js';
import { PersonLink } from './person-link.tsx';
import { markdownPersonOptions, PersonText } from './person-text.tsx';
import { TrackerExplanation } from './tracker-explanations.tsx';
import { DEFAULT_HEALTH, DEFAULT_PROGRESS, DEFAULT_SCHEDULE } from './snapshot-normalizer.js';
import { commitmentLabel, isAccepted, isDraft, progressDisplayLabel } from './view-model.mjs';

export { DEFAULT_HEALTH, DEFAULT_PROGRESS, DEFAULT_SCHEDULE };

export function humanize(value) {
  return String(value ?? '').replaceAll('-', ' ').replaceAll('_', ' ').replace(/\b\w/g, letter => letter.toUpperCase());
}

export function formatDate(value, options = {}) {
  if (!value) return 'Unknown';
  const date = new Date(String(value).includes('T') ? value : `${value}T00:00:00+08:00`);
  if (Number.isNaN(date.valueOf())) return String(value);
  return new Intl.DateTimeFormat('en-PH', { dateStyle: 'medium', timeZone: 'Asia/Manila', ...options }).format(date);
}

export function formatTimestamp(value) {
  return value ? formatDate(value, { timeStyle: 'short' }) : 'Unknown';
}

export function dateValue(value) {
  if (!value) return null;
  const date = new Date(String(value).includes('T') ? value : `${value}T00:00:00+08:00`);
  return Number.isNaN(date.valueOf()) ? null : date;
}

export function safeText(value) {
  const text = String(value ?? '').trim();
  return text && text !== '-' ? text : null;
}

export function decisionHref(id) {
  return `/decisions/${encodeURIComponent(String(id))}`;
}

export function workHref(id) {
  return `/work/${encodeURIComponent(String(id))}`;
}

export function statusTone(status) {
  const normalized = String(status ?? '').toLowerCase().replaceAll(' ', '-');
  return {
    active: 'blue',
    queued: 'slate',
    blocked: 'red',
    done: 'green',
    proposed: 'amber',
    approved: 'green',
    'awaiting-prereqs': 'amber',
    promoted: 'blue',
    deferred: 'slate',
  }[normalized] ?? 'slate';
}

export function healthTone(state) {
  return { 'on-track': 'green', 'at-risk': 'amber', blocked: 'red', unknown: 'slate' }[state] ?? 'slate';
}

/** @param {import('./features/contracts').BadgeChipProps} props */
export function BadgeChip({ children, tone = 'slate', className = '' }) {
  return <Badge className={`tracker-badge tracker-badge-${tone} ${className}`} variant="outline">{children}</Badge>;
}

export function healthLabel(state) {
  return { 'on-track': 'On track', 'at-risk': 'At risk', blocked: 'Blocked', unknown: 'Unknown' }[state] ?? 'Unknown';
}

/** @param {import('./features/contracts').MarkdownProps} props */
export function Markdown({ value, className = '', resolveLink }) {
  const data = useRouteContext({ strict: false, select: context => context?.data });
  if (!value) return <p className="empty-copy">No record yet.</p>;
  return <div className={`markdown ${className}`} dangerouslySetInnerHTML={{ __html: renderMarkdown(value, { ...markdownPersonOptions(data), resolveLink }) }} />;
}

/** @param {{ item: import('./snapshot').TrackerItem }} props */
export function ProgressSummary({ item }) {
  const progress = item.progress ?? DEFAULT_PROGRESS;
  const hasChildren = item.childSummary.total > 0;
  return (
    <div className="progress-summary" data-testid="progress-summary">
      <div className="progress-heading">
        <div className="tracker-summary-label"><span className="section-label">Verified progress</span><TrackerExplanation title="How progress is measured" tooltip="A percentage needs an approved milestone plan."><p>An accepted item without an approved milestone plan stays <strong>Unscoped</strong>, with no percentage shown. Verified progress comes from the weights of milestones confirmed complete under the approved plan.</p><p>Draft and planned items are proposals. They do not contribute to Today workload or verified progress.</p></TrackerExplanation></div>
        {progress.scoped && progress.percent !== null ? <strong>{progressDisplayLabel(progress)} verified</strong> : <BadgeChip>Unscoped</BadgeChip>}
      </div>
      {progress.scoped && progress.percent !== null ? <Progress aria-label={`${progress.percent}% verified progress`} value={progress.percent} /> : <div className="progress-placeholder">Milestone plan is not approved, so no percentage is shown.</div>}
      {hasChildren ? <p className="child-progress"><GitBranch size={14} aria-hidden="true" /> Child completion: {item.childSummary.done} of {item.childSummary.total} direct children done</p> : null}
    </div>
  );
}

/** @param {import('./features/contracts').HealthSummaryProps} props */
export function HealthSummary({ health }) {
  const value = { ...DEFAULT_HEALTH, ...health };
  const bad = value.state !== 'on-track';
  return (
    <div className={`health-summary health-${healthTone(value.state)}`} data-testid="health-summary">
      <div className="health-title"><span className="section-label">Delivery health</span><BadgeChip tone={healthTone(value.state)}>{healthLabel(value.state)}</BadgeChip></div>
      <p className="health-reason"><PersonText value={value.reason} /></p>
      {bad ? <dl className="health-facts"><div><dt>Missing information</dt><dd><PersonText value={value.missingInformation} /></dd></div><div><dt>Suggested action</dt><dd><PersonText value={value.suggestedAction} /></dd></div><div><dt>Actor</dt><dd><PersonLink value={value.actor} name={value.actor} avatar pill className="health-actor-link" /></dd></div></dl> : null}
      {value.reviewedAt ? <p className="source-note">Reviewed {formatDate(value.reviewedAt)}.</p> : null}
    </div>
  );
}

/** @param {{ item: import('./snapshot').TrackerItem }} props */
export function ScheduleSummary({ item }) {
  const schedule = { ...DEFAULT_SCHEDULE, ...item.schedule };
  const target = item.target;
  const hasBaseline = schedule.plannedStart || schedule.plannedEnd;
  const hasForecast = schedule.forecastStart || schedule.forecastEndMin || schedule.forecastEndMax;
  const heading = <div className="tracker-summary-label"><span className="section-label">Schedule</span><TrackerExplanation title="How schedule dates are labeled" tooltip="The summary distinguishes baselines, forecasts, and proposals."><p><strong>Approved baseline</strong> dates describe the accepted work schedule. <strong>Forecast</strong> dates are estimates and remain labeled as forecasts.</p><p><strong>Proposed</strong> dates belong to planned or draft work and stay distinct from accepted work. Schedule approval is a separate part of the work record, and a known target is shown separately from a work schedule.</p></TrackerExplanation></div>;
  if (!hasBaseline && !hasForecast) return <div className="schedule-summary">{heading}{target ? <><BadgeChip tone="amber">Known target</BadgeChip><p><strong>Target</strong> · {formatDate(target)}</p><p className="source-note">No approved or forecast start and finish dates are recorded.</p></> : <><BadgeChip>Unscheduled</BadgeChip><p className="source-note">No approved or forecast dates are recorded.</p></>}</div>;
  const proposed = !isAccepted(item);
  const label = commitmentLabel(item);
  return <div className="schedule-summary">{heading}{hasBaseline ? <p><strong>{proposed ? `${label} proposed dates` : 'Approved baseline'}</strong> · {formatDate(schedule.plannedStart)} → {formatDate(schedule.plannedEnd)}</p> : null}{hasForecast ? <p><strong>{proposed ? `${label} proposed forecast` : 'Forecast'}</strong> · {formatDate(schedule.forecastStart)} → {formatDate(schedule.forecastEndMin)}{schedule.forecastEndMax && schedule.forecastEndMax !== schedule.forecastEndMin ? `–${formatDate(schedule.forecastEndMax)}` : ''}{schedule.provisional ? ' · provisional' : ''}</p> : null}</div>;
}

/** @param {{ item: import('./snapshot').TrackerItem }} props */
export function ApprovalSummary({ item }) {
  const approval = item.approval ?? {};
  const acceptance = item.acceptance ?? {};
  const blockers = [...(Array.isArray(item.blockers) ? item.blockers : []), ...(Array.isArray(acceptance.blockers) ? acceptance.blockers : [])]
    .filter((blocker, index, values) => values.findIndex(candidate => candidate?.id === blocker?.id && candidate?.reason === blocker?.reason) === index);
  const stage = item.commitment ?? 'unknown';
  const stageTone = stage === 'accepted' ? (acceptance.accepted === false ? 'red' : 'green') : stage === 'draft' ? 'slate' : 'amber';
  return <section className="approval-summary detail-block"><div className="health-title"><span className="section-label">Planning and acceptance</span><BadgeChip tone={stageTone}>{commitmentLabel(item)}</BadgeChip></div>{item.plan ? <p><strong>Plan</strong> · {item.plan}</p> : null}{approval.state ? <p><strong>Approval</strong> · {humanize(approval.state)}{approval.approvedBy ? <> by <PersonLink className="profile-text-link" value={approval.approvedBy} /></> : null}{approval.approvedAt ? ` on ${formatDate(approval.approvedAt)}` : ''}{approval.source ? ` · ${approval.source}` : ''}{approval.reference ? ` · ${approval.reference}` : ''}</p> : null}{acceptance.legacy ? <p className="source-note"><strong>Provenance</strong> · Decision-backed frozen approval{acceptance.legacyDecision ? ` · ${acceptance.legacyDecision}` : ''}</p> : null}{approval.parts?.length ? <p className="source-note">Approved parts · {approval.parts.join(', ')}</p> : null}{blockers.length ? <div className="acceptance-blockers"><strong>Blockers</strong><ul>{blockers.map((blocker, index) => <li key={`${blocker.id ?? 'blocker'}-${index}`}>{blocker.id ? `${blocker.id} · ` : ''}<PersonText value={blocker.reason ?? blocker.message ?? String(blocker)} /></li>)}</ul></div> : null}</section>;
}

/** @param {{ item: import('./snapshot').TrackerItem }} props */
export function ItemChips({ item }) {
  const stageTone = isAccepted(item) ? 'green' : isDraft(item) ? 'slate' : 'amber';
  return <div className="item-chips"><Pill variant="outline" className={`tracker-pill tracker-pill-${statusTone(item.status)}`}>{humanize(item.status)}</Pill><Pill variant="outline" className={`tracker-pill tracker-pill-${stageTone}`}>{commitmentLabel(item)}</Pill>{item.phase ? <BadgeChip>{humanize(item.phase)}</BadgeChip> : null}{item.owner && item.owner !== 'unassigned' ? <span className="item-assignee"><PersonLink value={item.owner} name={item.ownerName} avatar pill assignment className="item-assignee-link" /></span> : <BadgeChip>Unassigned</BadgeChip>}<Pill variant="outline" className={`tracker-pill tracker-pill-${healthTone(item.health?.state)}`}>{healthLabel(item.health?.state)}</Pill></div>;
}

/** @param {import('./features/contracts').SnapshotFooterProps} props */
export function SnapshotFooter({ source }) {
  const meta = source ?? {};
  const teamProjection = meta.layout === 'team-projection-v1';
  if (teamProjection) {
    const zeroDigest = meta.projectionDigest === `sha256:${'0'.repeat(64)}`;
    const sharedAt = meta.exportedAt || meta.projectionGeneratedAt;
    return <div className="snapshot-line" data-testid="snapshot-meta"><span>{zeroDigest ? 'No tasks shared yet' : 'Shared tasks'}</span>{sharedAt ? <span>shared {formatTimestamp(sharedAt)}</span> : null}</div>;
  }
  return <div className="snapshot-line" data-testid="snapshot-meta"><span>Source snapshot</span><span>{meta.commit && meta.commit !== 'unknown' ? `commit ${meta.shortCommit || meta.commit.slice(0, 10)}` : 'commit unknown'}</span><span>{`built ${formatTimestamp(meta.builtAt)}`}</span>{meta.committedAt ? <span>{`source ${formatTimestamp(meta.committedAt)}`}</span> : null}{meta.dirty ? <BadgeChip tone="amber">local changes present</BadgeChip> : null}</div>;
}

function scopeOptions(data) {
  return data.items
    .filter(item => item.childIds.length > 0 || item.type === 'project' || !item.parent)
    .sort((a, b) => a.title.localeCompare(b.title));
}

/** @param {import('./features/contracts').ProjectSelectorProps} props */
export function ProjectSelector({ data, scopeId, onChange, label = 'Project scope', compact = false }) {
  const options = scopeOptions(data);
  return <div className="scope-control"><div className="scope-control-heading"><label htmlFor="scope-select">{label}</label>{compact ? null : <TrackerExplanation title="Project scope and context" tooltip="Scope filters work while preserving needed relationship context."><p>Choose <strong>All projects</strong> or a project to filter the work shown.</p><p>When a related item sits outside the selected scope, its ancestor or dependency can remain visible as <strong>Context</strong> so the relationship is clear. Context items are excluded from workload and verified-progress calculations.</p></TrackerExplanation>}</div><Combobox id="scope-select" ariaLabel="Project scope" value={scopeId ?? 'all'} options={[{ value: 'all', label: 'All projects' }, ...options.map(item => ({ value: item.id, label: item.title }))]} onValueChange={value => onChange(value === 'all' ? null : value)} placeholder="All projects" searchLabel="Search projects" searchPlaceholder="Search projects…" emptyMessage="No projects match your search." /></div>;
}

/** @param {import('./features/contracts').VisibilityControlsProps} props */
export function VisibilityControls({ showPlanned = false, setShowPlanned, showDrafts = false, setShowDrafts, showPlannedControl = false, showCompleted, setShowCompleted, visibleItemCount }) {
  return <div className="control-actions">
    {showPlannedControl ? <><div className="check-control-group"><label className="check-control"><Checkbox checked={showPlanned} onCheckedChange={setShowPlanned} />Show planned</label><TrackerExplanation title="Planned work" tooltip="Planned items are proposals awaiting acceptance."><p>Planned items are ready for acceptance review, but remain proposals until their task scope is approved and the item is accepted. Showing them changes visibility only.</p><p>Planned work stays out of Today workload and verified progress. Any proposed assignment or dates keep their separate approval status.</p></TrackerExplanation></div><div className="check-control-group"><label className="check-control"><Checkbox checked={showDrafts} onCheckedChange={setShowDrafts} />Show drafts</label><TrackerExplanation title="Draft work" tooltip="Draft items remain in readiness discovery."><p>Draft items are readiness proposals, not accepted work. Showing them makes the record and proposed dates available for context; it does not approve the task, assignment, or schedule.</p><p>Draft work stays out of Today workload and verified progress.</p></TrackerExplanation></div></> : null}
    <label className="check-control"><Checkbox checked={showCompleted} onCheckedChange={setShowCompleted} />Show completed</label>
    <span className="scope-count">{visibleItemCount} visible item{visibleItemCount === 1 ? '' : 's'}</span>
    <TrackerExplanation title="Accepted work and visibility" tooltip="Visibility filters do not approve or change work records."><p><strong>Accepted</strong> work is in the current agreed scope. <strong>Planned</strong> items are proposals ready for acceptance review; <strong>draft</strong> items are in readiness discovery. Show planned and Show drafts only change which records are visible.</p><p>Ancestors and dependencies may stay visible as <strong>Context</strong> when they explain a selected item. Context remains available for navigation and is excluded from workload and verified-progress calculations.</p></TrackerExplanation>
  </div>;
}

/** @param {import('./features/contracts').AttentionCardProps} props */
export function AttentionCard({ item, label, onSelect }) {
  const actor = item.health?.actor;
  const handleCardClick = event => {
    if (event.target?.closest?.('a, button')) return;
    onSelect(item.id);
  };
  return <article className="attention-card" onClick={handleCardClick}><button className="attention-card-select" type="button" onClick={() => onSelect(item.id)} aria-label={`Open ${item.title}`}><span className="attention-icon"><AlertTriangle size={17} aria-hidden="true" /></span><span className="attention-copy"><span className="attention-heading"><strong>{item.title}</strong><BadgeChip tone={healthTone(item.health?.state)}>{label || healthLabel(item.health?.state)}</BadgeChip></span></span><ChevronRight size={18} aria-hidden="true" /></button><div className="attention-card-details"><p className="attention-reason"><PersonText value={item.health?.reason} /></p><dl><div><dt>Action</dt><dd><PersonText value={item.health?.suggestedAction} /></dd></div></dl></div><dl className="attention-card-actor"><div><dt>Actor</dt><dd>{actor ? <PersonLink value={actor} name={actor} avatar pill className="attention-actor-link" /> : 'Unknown'}</dd></div></dl></article>;
}

/** @param {import('./features/contracts').TodayFocusProps} props */
export function TodayFocus({ item, onSelect }) {
  if (!item) return null;
  return <section className="today-focus" aria-label="Selected project progress"><div><p className="eyebrow">Selected scope</p><button className="today-focus-title" type="button" onClick={() => onSelect(item.id)}>{item.title}<ArrowUpRight size={14} aria-hidden="true" /></button><ItemChips item={item} /></div><ProgressSummary item={item} /></section>;
}

/** @param {import('./features/contracts').EmptyInlineProps} props */
export function EmptyInline({ icon, text }) {
  return <div className="empty-inline">{icon}<span>{text}</span></div>;
}

export function planCounts(items) {
  return items.reduce((counts, item) => {
    const commitment = item.commitment;
    if (commitment === 'accepted' || isAccepted(item)) counts.accepted += 1;
    else if (commitment === 'draft' || isDraft(item)) counts.draft += 1;
    else if (commitment === 'planned') counts.planned += 1;
    else counts.unrecorded += 1;
    return counts;
  }, { accepted: 0, planned: 0, draft: 0, unrecorded: 0 });
}
