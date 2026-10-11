import { useMemo } from 'react';
import { CircleHelp, LoaderCircle, Pause, Play } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from './components/ui/avatar.tsx';
import { AvatarStack } from './components/kibo-ui/avatar-stack/index.tsx';
import { Button } from './components/ui/button.tsx';
import { Popover, PopoverContent, PopoverTrigger } from './components/ui/popover.tsx';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './components/ui/select.tsx';
import { resolveAssigneePerson } from './assignee-avatars.jsx';
import { PersonLink } from './person-link.tsx';
import { formatDate, humanize } from './shared.jsx';
import './work-activity.css';

const ACTIVITY_FILTERS = [
  ['all', 'All work'],
  ['recent', 'Recent activity'],
  ['quiet', 'No recent activity'],
  ['attention', 'Needs attention'],
];

function stopPopoverEvent(event) {
  event.stopPropagation();
}

function safeEvidenceUrl(reference) {
  const value = String(reference ?? '').trim();
  if (!/^https?:\/\//i.test(value)) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

function activityTimestamp(entry) {
  const value = entry?.own?.lastOccurredAt || entry?.own?.lastDate;
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function latestSubtreeActivity(entry, projection) {
  const candidates = [];
  const seen = new Set();
  const pending = [...(entry?.childIds ?? [])];
  while (pending.length) {
    const id = pending.pop();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const child = projection.get(id);
    if (!child) continue;
    pending.push(...child.childIds);
    if (child.own?.lastDate || child.own?.lastOccurredAt) candidates.push(child);
  }
  if (entry?.own?.lastDate || entry?.own?.lastOccurredAt) candidates.push(entry);
  return candidates.reduce((latest, candidate) => {
    if (!latest) return candidate;
    const candidateTime = activityTimestamp(candidate) ?? -Infinity;
    const latestTime = activityTimestamp(latest) ?? -Infinity;
    return candidateTime > latestTime ? candidate : latest;
  }, null);
}

function ActivityEvidence({ entry, label = 'Latest qualifying activity' }) {
  if (!entry?.own?.lastDate && !entry?.own?.lastOccurredAt) return null;
  const evidenceUrl = safeEvidenceUrl(entry.own.evidenceRef);
  const day = entry.own.lastDate || entry.own.lastOccurredAt;
  return (
    <div className="work-activity-evidence">
      {label ? <strong>{label}</strong> : null}
      <p>{entry.own.summary || 'Qualifying activity recorded.'}</p>
      <dl>
        <div><dt>Source event</dt><dd><time dateTime={day}>{formatDate(day)}</time></dd></div>
        <div><dt>Business age</dt><dd>{entry.own.ageBusinessDays === null ? 'Unknown' : `${entry.own.ageBusinessDays} ${entry.own.ageBusinessDays === 1 ? 'day' : 'days'}`}</dd></div>
      </dl>
      {evidenceUrl
        ? <a className="work-activity-evidence-link" href={evidenceUrl} target="_blank" rel="noreferrer">Open evidence</a>
        : entry.own.evidenceRef
          ? <p className="work-activity-source-ref">Source reference · {entry.own.evidenceRef}</p>
          : <p className="work-activity-source-ref">No evidence link recorded.</p>}
    </div>
  );
}

function safeSourceLabel(value) {
  const text = String(value ?? '').trim();
  return text && text !== '-' ? text : null;
}

function ActivityHistory({ itemId, evidence = [] }) {
  const updates = Array.isArray(evidence) ? evidence.filter(record => record.itemId === itemId) : [];
  updates.sort((left, right) => {
    const leftParsed = left.occurredAt ? Date.parse(left.occurredAt) : NaN;
    const rightParsed = right.occurredAt ? Date.parse(right.occurredAt) : NaN;
    const leftTime = Number.isFinite(leftParsed) ? leftParsed : -Infinity;
    const rightTime = Number.isFinite(rightParsed) ? rightParsed : -Infinity;
    if (leftTime === rightTime) return String(left.id ?? '').localeCompare(String(right.id ?? ''));
    return rightTime - leftTime;
  });
  return (
    <section className="work-activity-history">
      <h3>Recorded activity history</h3>
      {updates.length ? <ul>{updates.map((update, index) => {
        const kind = safeSourceLabel(update.kind)?.toLowerCase();
        const kindLabel = kind === 'discussion' ? 'Discussion only' : kind && kind !== 'unknown' ? `${humanize(kind)} evidence` : 'Activity type unknown';
        const occurredAt = safeSourceLabel(update.occurredAt);
        const reference = safeSourceLabel(update.evidenceRef);
        const evidenceUrl = safeEvidenceUrl(reference);
        return (
          <li key={update.id ?? `${itemId}-history-${index}`}>
            <div className="work-activity-history-heading">
              <strong>{kindLabel}</strong>
              {update.included === false ? <span>Excluded from activity</span> : null}
            </div>
            <p>{safeSourceLabel(update.summary) ?? 'No summary recorded.'}</p>
            <small>{occurredAt ? `Source event · ${formatDate(occurredAt)}` : 'Source event date not recorded'}</small>
            {update.discoveredAt ? <small>Discovered · {formatDate(update.discoveredAt)}</small> : null}
            {evidenceUrl
              ? <a className="work-activity-evidence-link" href={evidenceUrl} target="_blank" rel="noreferrer">Open evidence</a>
              : reference
                ? <span className="work-activity-source-ref">Source reference · {reference}</span>
                : null}
            {update.sourceEventId ? <span className="work-activity-source-ref">Source event ID · {update.sourceEventId}</span> : null}
            {update.originalItemId || update.originalUpdateId
              ? <span className="work-activity-source-ref">Original record · {[update.originalItemId, update.originalUpdateId].filter(Boolean).join('/')}</span>
              : null}
            {update.attributionBasis ? <span className="work-activity-source-ref">Attribution · {humanize(update.attributionBasis)}</span> : null}
            {update.amendmentIds?.length ? <span className="work-activity-source-ref">Amendments · {update.amendmentIds.join(', ')}</span> : null}
            {update.approvalDecisionIds?.length ? <span className="work-activity-source-ref">Approval decisions · {update.approvalDecisionIds.join(', ')}</span> : null}
          </li>
        );
      })}</ul> : <p>No normalized source evidence is available for this item.</p>}
    </section>
  );
}

function ActivityDetails({ entry, projection, evidence, includeSummary = false }) {
  const latest = useMemo(() => latestSubtreeActivity(entry, projection), [entry, projection]);
  const recentCount = entry?.descendants?.recentIds?.length ?? 0;
  const quietCount = entry?.descendants?.quietIds?.length ?? 0;
  const unknownCount = entry?.descendants?.unknownIds?.length ?? 0;
  const streaks = entry?.descendants?.streaks ?? [];
  return (
    <div className="work-activity-popover">
      {includeSummary ? (
        <section className="work-activity-counts" aria-label="Across all work activity counts">
          <h3>Across all work</h3>
          <p>{recentCount} recent · {quietCount} no recent · {unknownCount} unknown</p>
        </section>
      ) : null}
      {latest && latest.id !== entry.id ? <ActivityEvidence entry={latest} /> : null}
      {entry?.own?.state === 'unknown' ? (
        <section className="work-activity-unknown-detail">
          <h3>Unknown activity</h3>
          <p>No dated qualifying source event is recorded for this item.</p>
          <ActivityHistory itemId={entry.id} evidence={evidence} />
        </section>
      ) : null}
      {entry?.own?.lastDate && entry.childIds.length > 0 ? (
        <section className="work-activity-project">
          <h3>Project activity</h3>
          <ActivityEvidence entry={entry} label={latest?.id === entry.id ? null : 'Direct activity'} />
          <p className="work-activity-streak">Direct streak · {entry.own.streak.days} {entry.own.streak.days === 1 ? 'weekday' : 'weekdays'}{entry.own.streak.endDate ? ` through ${formatDate(entry.own.streak.endDate)}` : ''}</p>
        </section>
      ) : null}
      {entry?.own?.lastDate && entry.childIds.length === 0 ? (
        <section className="work-activity-project work-activity-task">
          <h3>Task activity</h3>
          <ActivityEvidence entry={entry} label={latest?.id === entry.id ? null : 'Direct activity'} />
          <p className="work-activity-streak">Task streak · {entry.own.streak.days} {entry.own.streak.days === 1 ? 'weekday' : 'weekdays'}{entry.own.streak.endDate ? ` through ${formatDate(entry.own.streak.endDate)}` : ''}</p>
        </section>
      ) : null}
      {unknownCount ? <p className="work-activity-unknown"><CircleHelp size={15} aria-hidden="true" /> {unknownCount} descendant{unknownCount === 1 ? '' : 's'} have unknown activity.</p> : null}
      {streaks.length ? (
        <section className="work-activity-streaks">
          <h3>Individual task streaks</h3>
          <ul>{streaks.map(streak => (
            <li key={streak.id}>
              <span>{streak.title}</span>
              <small>{streak.days} {streak.days === 1 ? 'weekday' : 'weekdays'}{streak.endDate ? ` through ${formatDate(streak.endDate)}` : ''}</small>
            </li>
          ))}</ul>
        </section>
      ) : null}
    </div>
  );
}

function initials(value) {
  const letters = String(value ?? '').trim().split(/\s+/).filter(Boolean)
    .map(part => part.match(/[\p{L}\p{N}]/u)?.[0]).filter(Boolean).slice(0, 2);
  return (letters.join('') || '?').toLocaleUpperCase();
}

function ownerDetails(owner, data) {
  const normalized = String(owner ?? '').trim();
  const ownerKey = normalized.toLowerCase();
  const workItem = data?.items?.find(item => String(item.owner ?? '').trim().toLowerCase() === ownerKey && item.ownerName);
  const profile = resolveAssigneePerson(data?.team ?? [], normalized, workItem?.ownerName);
  const displayName = profile?.name ?? profile?.fullName ?? workItem?.ownerName ?? normalized;
  return { owner: normalized, displayName, imageUrl: profile?.avatarUrl ?? null, person: profile };
}

function OwnerAvatar({ owner, data }) {
  const person = ownerDetails(owner, data);
  return (
    <Avatar className="work-owner-avatar" aria-hidden="true">
      {person.imageUrl ? <AvatarImage src={person.imageUrl} alt="" /> : null}
      <AvatarFallback>{initials(person.displayName)}</AvatarFallback>
    </Avatar>
  );
}

function DescendantOwners({ owners, data, entry, assignment = false }) {
  const ids = owners.slice(0, 4);
  const overflow = Math.max(0, owners.length - ids.length);
  const names = owners.map(owner => ownerDetails(owner, data));
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="work-owner-stack-trigger"
          aria-label={`Show ${owners.length} descendant owner${owners.length === 1 ? '' : 's'}`}
          title={names.map(person => person.displayName).join(', ')}
          onClick={stopPopoverEvent}
          onKeyDown={stopPopoverEvent}
        >
          <AvatarStack className="work-owner-avatar-stack" size={22}>
            {ids.map(owner => <OwnerAvatar key={owner} owner={owner} data={data} />)}
          </AvatarStack>
          {overflow ? <span className="work-owner-overflow">+{overflow}</span> : null}
        </button>
      </PopoverTrigger>
      <PopoverContent className="work-owner-popover" align="end">
        <h3>Current descendant owners</h3>
        <ul>{names.map(person => (
          <li key={person.owner}>
            <OwnerAvatar owner={person.owner} data={data} />
            <PersonLink value={person.owner} name={person.displayName} data={data} assignment={assignment} className="work-owner-popover-link" />
          </li>
        ))}</ul>
      </PopoverContent>
    </Popover>
  );
}

/** @param {{ item: import('./snapshot').TrackerItem, data: import('./snapshot').TrackerSnapshot, entry: import('./work-activity-types').WorkProjectionEntry, collapsed: boolean, showName?: boolean, size?: 'xs'|'sm'|'md'|'lg'|number, assignment?: boolean }} props */
export function WorkOwnership({ item, data, entry, collapsed, showName = true, size = 'sm', assignment = false }) {
  const owner = item?.owner ?? entry?.owner;
  const ownerName = item?.ownerName ?? entry?.ownerName;
  const directOwner = owner && owner !== 'unassigned' ? ownerDetails(owner, data) : null;
  const compactOwnerLabel = directOwner?.person && !showName
    ? <span className="profile-visually-hidden">{directOwner.displayName}</span>
    : undefined;
  const ownerSizeClass = `work-owner-size-${String(size)}`;
  const descendantOwners = collapsed
    ? [...new Set(entry?.descendants?.ownerIds ?? [])].filter(id => id && id !== owner && id !== 'unassigned')
    : [];
  return (
    <span className="work-ownership" data-testid={`work-ownership-${item.id}`}>
      {owner && owner !== 'unassigned'
        ? <span className="work-owner-dri"><PersonLink value={owner} name={ownerName} data={data} avatar assignment={assignment} className={`work-owner-link ${ownerSizeClass}${directOwner?.person && !showName ? ' profile-avatar-only' : ''}`}>{compactOwnerLabel}</PersonLink></span>
        : <span className="work-owner-unassigned">Unassigned</span>}
      {descendantOwners.length ? <DescendantOwners owners={descendantOwners} data={data} entry={entry} assignment={assignment} /> : null}
    </span>
  );
}

/** @param {{ entry: import('./work-activity-types').WorkProjectionEntry, projection: Map<string, import('./work-activity-types').WorkProjectionEntry>, collapsed: boolean, paused: boolean, evidence?: import('./work-activity-types').NormalizedWorkEvidence[] }} props */
export function WorkActivityIndicator({ entry, projection, collapsed, paused, evidence = [] }) {
  const ownState = entry?.completed ? null : entry?.own?.state;
  const unknown = entry?.own?.state === 'unknown';
  const states = [];
  if (ownState === 'recent') states.push('recent');
  if (ownState === 'quiet') states.push('quiet');
  if (collapsed) {
    if (ownState !== 'recent' && entry.descendants.recentIds.length) states.push('recent');
    if (ownState !== 'quiet' && entry.descendants.quietIds.length) states.push('quiet');
  }
  if (!states.length && !unknown) return null;
  const label = [unknown ? 'Unknown activity' : null, ...states.map(state => state === 'recent' ? 'Recent activity' : 'No recent activity')].filter(Boolean).join(' and ');
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={`work-activity-indicator ${paused ? 'is-paused' : ''}`}
          aria-label={`${label} details for ${entry.title}`}
          title={label}
          onClick={stopPopoverEvent}
          onKeyDown={stopPopoverEvent}
        >
          {unknown ? <CircleHelp className="work-activity-unknown-icon" size={15} aria-hidden="true" /> : null}
          {states.map(state => state === 'recent'
            ? <LoaderCircle key={state} className="work-activity-spinner" size={15} aria-hidden="true" />
            : <span key={state} className="work-activity-dot" aria-hidden="true" />)}
        </button>
      </PopoverTrigger>
      <PopoverContent className="work-activity-detail-popover" align="end">
        <ActivityDetails entry={entry} projection={projection} evidence={evidence} />
      </PopoverContent>
    </Popover>
  );
}

/** @param {{ entry: import('./work-activity-types').WorkProjectionEntry, projection: Map<string, import('./work-activity-types').WorkProjectionEntry>, evidence?: import('./work-activity-types').NormalizedWorkEvidence[], compact?: boolean }} props */
export function WorkActivitySummary({ entry, projection, evidence = [], compact = false }) {
  if (!entry?.childIds?.length) return null;
  const recent = entry.descendants.recentIds.length;
  const quiet = entry.descendants.quietIds.length;
  const unknown = entry.descendants.unknownIds.length;
  const fullLabel = `${recent} recent · ${quiet} no recent`;
  const compactLabel = `${recent} recent · ${quiet} quiet`;
  const visibleLabel = compact ? compactLabel : recent || quiet ? fullLabel : 'No recent or quiet work';
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="work-activity-summary"
          aria-label={`Across all work: ${fullLabel}; ${unknown} unknown`}
          title={`Across all work: ${fullLabel}; ${unknown} unknown`}
          onClick={stopPopoverEvent}
          onKeyDown={stopPopoverEvent}
        >
          <span>{visibleLabel}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="work-activity-detail-popover" align="end">
        <ActivityDetails entry={entry} projection={projection} evidence={evidence} includeSummary />
      </PopoverContent>
    </Popover>
  );
}

/** @param {{ workActivity: { activityFilter: string, setActivityFilter: (filter: string) => void, animationsPaused: boolean, setAnimationsPaused: (paused: boolean) => void, matchCount: number } }} props */
export function WorkActivityControls({ workActivity }) {
  const filter = ACTIVITY_FILTERS.some(([value]) => value === workActivity.activityFilter) ? workActivity.activityFilter : 'all';
  return (
    <div className="work-activity-controls" data-testid="work-activity-controls" role="group" aria-label="Work activity filters">
      <span className="work-activity-label">Activity</span>
      <Select value={filter} onValueChange={workActivity.setActivityFilter}>
        <SelectTrigger aria-label="Filter work activity" className="work-activity-filter">
          <SelectValue />
        </SelectTrigger>
      <SelectContent>
        {ACTIVITY_FILTERS.map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}
      </SelectContent>
      </Select>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="work-activity-pause"
        aria-pressed={workActivity.animationsPaused}
        aria-label={workActivity.animationsPaused ? 'Resume activity animation' : 'Pause activity animation'}
        onClick={() => workActivity.setAnimationsPaused(!workActivity.animationsPaused)}
      >
        {workActivity.animationsPaused ? <Play size={14} aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />}
        {workActivity.animationsPaused ? 'Resume animation' : 'Pause animation'}
      </Button>
    </div>
  );
}
