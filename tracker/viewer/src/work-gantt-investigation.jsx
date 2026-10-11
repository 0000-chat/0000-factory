import { useEffect, useMemo, useRef } from 'react';
import {
  Activity,
  ArrowUpRight,
  CalendarDays,
  FileText,
  Link2,
  X,
} from 'lucide-react';
import { Button } from './components/ui/button.tsx';
import {
  BadgeChip,
  Markdown,
  formatDate,
  humanize,
  statusTone,
} from './shared.jsx';
import { PersonLink } from './person-link.tsx';
import './work-gantt-investigation.css';

function text(value) {
  const result = String(value ?? '').trim();
  return result && result !== '-' ? result : null;
}

function itemFor(data, id) {
  return data?.itemById?.get?.(id)
    ?? data?.items?.find(item => item?.id === id)
    ?? null;
}

function day(value) {
  const candidate = text(value);
  return candidate && /^\d{4}-\d{2}-\d{2}$/.test(candidate) ? candidate : null;
}

function dateRange(start, end) {
  const from = day(start);
  const to = day(end);
  if (from && to) {
    const first = formatDate(from);
    const last = formatDate(to);
    return first === last ? first : `${first} – ${last}`;
  }
  if (from) return `Starts ${formatDate(from)} · due date not recorded`;
  if (to) return `Due ${formatDate(to)} · start date not recorded`;
  return null;
}

function activityRange(entry) {
  const first = day(entry?.own?.firstDate);
  const last = day(entry?.own?.lastDate);
  return dateRange(first, last) ?? 'No recorded activity';
}

function scheduleLabel(start, due) {
  return dateRange(start, due) ?? 'No approved dates recorded';
}

function sourceLabel(item, entry, hasChildSchedule, data) {
  const hasOwnSchedule = Boolean(day(entry?.timeline?.ownPlannedStart) || day(entry?.timeline?.ownPlannedDue));
  if (hasOwnSchedule) {
    const planId = text(item?.plan);
    const plan = planId ? data?.plans?.find(candidate => candidate?.id === planId) : null;
    return plan?.title ? <>Approved plan · {plan.title}</> : 'Approved plan';
  }
  if (hasChildSchedule) return 'Derived from approved child schedules';
  return 'No approved schedule recorded';
}

function approvedSchedule(row) {
  return {
    start: day(row?.entry?.timeline?.ownPlannedStart),
    due: day(row?.entry?.timeline?.ownPlannedDue),
  };
}

function childSchedule(row) {
  return {
    start: day(row?.childApprovedEnvelope?.startDay),
    due: day(row?.childApprovedEnvelope?.endDay),
  };
}

function rowHasChildren(row) {
  return Boolean(row?.hasChildren || row?.entry?.childIds?.length);
}

function missingDateReasons(row, own, child) {
  const reasons = [];
  const hasChildren = rowHasChildren(row);
  const ownPlanIsPartial = Boolean(own.start) !== Boolean(own.due);
  if (!hasChildren) {
    if (!own.start) reasons.push('own start date');
    if (!own.due) reasons.push('own due date');
  } else if (ownPlanIsPartial) {
    if (!own.start) reasons.push('own start date');
    if (!own.due) reasons.push('own due date');
  }
  if (hasChildren && (!child.start || !child.due || row.childSummaryIncomplete)) {
    reasons.push('one or more child dates');
  }
  return reasons;
}

function dependencyIds(item, entry) {
  const values = item?.dependsOn ?? item?.depends_on ?? entry?.dependsOn ?? [];
  return [...new Set((Array.isArray(values) ? values : String(values).split(','))
    .map(value => text(value))
    .filter(Boolean))];
}

function ownerName(item, entry) {
  return text(item?.ownerName) ?? text(entry?.ownerName) ?? text(item?.owner) ?? text(entry?.owner);
}

function ownerId(item, entry) {
  return text(item?.owner) ?? text(entry?.owner);
}

function DetailField({ icon: Icon, label, children, className = '' }) {
  return (
    <div className={`work-gantt-investigation-field ${className}`.trim()}>
      <dt><Icon size={15} aria-hidden="true" />{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function ActivityValue({ entry }) {
  const reference = text(entry?.own?.evidenceRef);
  const referenceIsUrl = reference && /^https?:\/\//i.test(reference);
  return (
    <span className="work-gantt-investigation-activity-value">
      <span>{activityRange(entry)}</span>
      {entry?.own?.summary ? <small>{entry.own.summary}</small> : null}
      {referenceIsUrl
        ? <a href={reference} target="_blank" rel="noreferrer">Open source evidence</a>
        : reference
          ? <small>Source reference · {reference}</small>
          : null}
    </span>
  );
}

/**
 * Compact, non-modal investigation surface for a selected Gantt row.
 *
 * The parent owns selection and layout. This component only reads the model
 * row plus the canonical snapshot and reports close/full-detail actions.
 * @param {{ row?: object|null, data?: object, onClose?: () => void, onOpenFullDetails?: (id: string) => void }} props
 */
export function WorkGanttInvestigation({ row, data, onClose, onOpenFullDetails }) {
  const entry = row?.entry ?? null;
  const item = itemFor(data, row?.id ?? entry?.id);
  const closeRef = useRef(null);
  const own = useMemo(() => approvedSchedule(row), [row]);
  const child = useMemo(() => childSchedule(row), [row]);
  const dependencies = useMemo(() => dependencyIds(item, entry), [item, entry]);
  const missingDates = useMemo(() => missingDateReasons(row, own, child), [row, own, child]);
  const contextual = row?.contextual === true || item?.contextOnly === true;
  const owner = ownerId(item, entry);
  const displayOwner = ownerName(item, entry);
  const status = contextual ? null : text(item?.status) ?? text(entry?.status) ?? 'unknown';
  const outcome = text(item?.sections?.outcome) ?? text(item?.description);
  const hasChildSchedule = Boolean(child.start || child.due);

  useEffect(() => {
    if (row?.id) closeRef.current?.focus();
  }, [row?.id]);

  if (!row || !entry) return null;

  return (
    <aside
      className="work-gantt-investigation-panel"
      aria-label="Work item investigation"
      data-testid="work-gantt-investigation"
      data-item-id={row.id}
    >
      <header className="work-gantt-investigation-header">
        <div className="work-gantt-investigation-heading">
          <p className="work-gantt-investigation-eyebrow">Work item</p>
          <h2>{item?.referenceCode ? <code className="work-reference-code">{item.referenceCode}</code> : null}{entry.title || item?.title || row.id}</h2>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="work-gantt-investigation-close"
          ref={closeRef}
          aria-label="Close work item investigation"
          title="Close"
          onClick={() => onClose?.()}
        >
          <X size={18} aria-hidden="true" />
        </Button>
      </header>

      <div className="work-gantt-investigation-owner">
        {!contextual && owner && owner !== 'unassigned'
          ? <PersonLink value={owner} name={displayOwner} data={data} avatar className="work-gantt-investigation-owner-link" />
          : contextual ? <span className="work-gantt-investigation-owner-context">Context row</span> : <span className="work-gantt-investigation-owner-unassigned">Unassigned</span>}
        {!contextual ? <span>Owner</span> : null}
      </div>

      {status ? <div className="work-gantt-investigation-status">
        <BadgeChip tone={statusTone(status)}>{humanize(status)}</BadgeChip>
      </div> : null}

      <dl className="work-gantt-investigation-fields">
        <DetailField icon={CalendarDays} label="Approved schedule">
          {scheduleLabel(own.start, own.due)}
        </DetailField>
        {rowHasChildren(row) ? (
          <DetailField icon={CalendarDays} label="Child schedule">
            {scheduleLabel(child.start, child.due)}
          </DetailField>
        ) : null}
        <DetailField icon={CalendarDays} label="Due date">
          {own.due ? formatDate(own.due) : 'Due date not recorded'}
        </DetailField>
        <DetailField icon={FileText} label="Source">
          {sourceLabel(item, entry, hasChildSchedule, data)}
        </DetailField>
        <DetailField icon={Link2} label="Prerequisite">
          {dependencies.length ? (
            <ul className="work-gantt-investigation-links">
              {dependencies.map(id => {
                const dependency = itemFor(data, id);
                return (
                  <li key={id}>
                    <button type="button" onClick={() => onOpenFullDetails?.(id)}>
                      {dependency?.title ?? id}<ArrowUpRight size={13} aria-hidden="true" />
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : 'No prerequisite recorded'}
        </DetailField>
        <DetailField icon={Activity} label="Recorded activity">
          <ActivityValue entry={entry} />
        </DetailField>
      </dl>

      <div className="work-gantt-investigation-divider" />

      <section className="work-gantt-investigation-outcome" aria-label="Description and outcome">
        <h3>Description / outcome</h3>
        {outcome ? <Markdown value={outcome} data={data} /> : <p className="work-gantt-investigation-empty">No description or outcome recorded.</p>}
      </section>

      {missingDates.length ? (
        <p className="work-gantt-investigation-warning" role="note">
          <strong>Dates incomplete</strong>
          <span>Recorded {missingDates.join(', ')} {missingDates.length === 1 ? 'is' : 'are'} missing. No schedule or progress is inferred.</span>
        </p>
      ) : null}

      <div className="work-gantt-investigation-actions">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onOpenFullDetails?.(row.id)}
        >
          <ArrowUpRight size={14} aria-hidden="true" />
          Open full details
        </Button>
      </div>
    </aside>
  );
}

export default WorkGanttInvestigation;
