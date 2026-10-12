import { useMemo, useRef } from 'react';
import { ChevronRight, FileText, Folder, FolderOpen, Inbox } from 'lucide-react';
import { BadgeChip, DEFAULT_SCHEDULE, formatDate, healthLabel, healthTone, humanize } from './shared.jsx';
import { commitmentLabel, isAccepted, isDraft } from './view-model.mjs';
import { WorkActivityIndicator, WorkActivitySummary, WorkOwnership } from './work-activity-ui.jsx';
import { WorkManagerRowMetadata } from './work-manager-controls';
import './work-manager-controls.css';
import './work-activity.css';

function emptyEntry(item) {
  return {
    id: item.id,
    parentId: item.parent ?? null,
    childIds: item.childIds ?? [],
    title: item.title,
    status: item.status,
    completed: item.completed,
    owner: item.owner ?? null,
    ownerName: item.ownerName ?? null,
    own: {
      state: 'unknown', firstDate: null, lastDate: null, firstOccurredAt: null,
      lastOccurredAt: null, ageBusinessDays: null, summary: null, evidenceRef: null,
      evidenceIds: [], streak: { days: 0, endDate: null },
    },
    descendants: { recentIds: [], quietIds: [], unknownIds: [], ownerIds: [], streaks: [] },
    timeline: {},
    attentionReasons: [],
  };
}

function progressInline(item) {
  const progress = item.progress;
  const percent = progress?.scoped === true && Number.isFinite(Number(progress.percent))
    ? Math.max(0, Math.min(100, Math.round(Number(progress.percent))) )
    : null;
  if (percent === null) return <span className="tree-unscoped" title="No approved milestone plan">Unscoped</span>;
  return (
    <span
      className="tree-progress-meta"
      role="progressbar"
      aria-label={`${percent}% verified progress`}
      aria-valuemin="0"
      aria-valuemax="100"
      aria-valuenow={percent}
      title={`${percent}% verified progress`}
    >
      <span className="tree-progress-track"><span className="tree-progress-fill" style={{ width: `${percent}%` }} /></span>
      <span className="tree-percent">{percent}%</span>
    </span>
  );
}

function scheduleInline(item) {
  const schedule = { ...DEFAULT_SCHEDULE, ...item.schedule };
  const minimum = schedule.forecastEndMin || schedule.forecastEndMax;
  const maximum = schedule.forecastEndMax || schedule.forecastEndMin;
  if (minimum || maximum) {
    return <span className="tree-forecast" title="Recorded forecast end">Forecast · {formatDate(minimum)}{maximum && maximum !== minimum ? `–${formatDate(maximum)}` : ''}</span>;
  }
  if (schedule.plannedEnd && schedule.approved === true && isAccepted(item)) {
    return <span className="tree-forecast tree-baseline" title="Approved baseline end">Baseline · {formatDate(schedule.plannedEnd)}</span>;
  }
  if (schedule.plannedEnd && !isAccepted(item)) {
    return <span className="tree-forecast tree-proposed" title="Proposed end">{commitmentLabel(item)} · {formatDate(schedule.plannedEnd)}</span>;
  }
  return null;
}

function attentionLabel(reason, entry) {
  switch (reason) {
    case 'blocked': return { label: 'Blocked', tone: 'red' };
    case 'quiet': return { label: 'Quiet', tone: 'amber' };
    case 'overdue': return { label: `Overdue · ${entry.timeline.overdueCalendarDays} calendar days`, tone: 'amber' };
    case 'missing-evidence': return { label: 'No activity recorded', tone: 'slate' };
    default: return null;
  }
}

function focusVisibleItem(treeElement, current, direction, parentId) {
  if (!treeElement) return;
  if (direction === 'parent' && parentId) {
    Array.from(treeElement.querySelectorAll('[role="treeitem"]'))
      .find(row => row.dataset.workId === parentId)?.focus();
    return;
  }
  const rows = Array.from(treeElement.querySelectorAll('[role="treeitem"]'))
    .filter(row => !row.closest('[hidden]'));
  const index = rows.indexOf(current);
  const next = direction === 'home'
    ? rows[0]
    : direction === 'end'
      ? rows.at(-1)
      : rows[index + direction];
  next?.focus();
}

function TreeItem({
  itemId,
  data,
  treeRef,
  parentId,
  level,
  selectedId,
  onSelect,
  visibleIds,
  contextualIds,
  workActivity,
  expandedIds,
  toggleExpanded,
  attentionFilter,
  managerProjection,
  managerEnabled,
  managerPeople,
  ownerContextLabel = null,
}) {
  const item = data.itemById.get(itemId);
  if (!item || (visibleIds && !visibleIds.has(item.id))) return null;
  const projected = workActivity.projection.get(item.id);
  const entry = projected ?? emptyEntry(item);
  const childIds = projected ? projected.childIds : item.childIds;
  const children = childIds.map(id => data.itemById.get(id)).filter(Boolean)
    .filter(child => !visibleIds || visibleIds.has(child.id));
  const hasChildren = children.length > 0;
  const expanded = hasChildren && expandedIds.has(item.id);
  const collapsedForOwnership = entry.childIds.length > 0 && !expandedIds.has(item.id);
  const contextual = contextualIds?.has(item.id) ?? false;
  const structural = item.contextOnly === true;
  const reasons = attentionFilter
    ? entry.attentionReasons.map(reason => attentionLabel(reason, entry)).filter(Boolean)
    : [];

  function handleKeyDown(event) {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect(item.id);
      return;
    }
    if (event.key === 'ArrowRight') {
      if (hasChildren && !expanded) {
        event.preventDefault();
        toggleExpanded(item.id);
      } else if (expanded) {
        event.preventDefault();
        event.currentTarget.querySelector('[role="group"] [role="treeitem"]')?.focus();
      }
      return;
    }
    if (event.key === 'ArrowLeft') {
      if (expanded) {
        event.preventDefault();
        toggleExpanded(item.id);
      } else {
        event.preventDefault();
        focusVisibleItem(treeRef.current, event.currentTarget, 'parent', parentId);
      }
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      focusVisibleItem(treeRef.current, event.currentTarget, event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      focusVisibleItem(treeRef.current, event.currentTarget, event.key === 'Home' ? 'home' : 'end');
    }
  }

  return (
    <div
      role="treeitem"
      aria-level={level + 1}
      aria-selected={selectedId === item.id}
      aria-expanded={hasChildren ? expanded : undefined}
      data-testid={`tree-item-${item.id}`}
      data-work-id={item.id}
      tabIndex={0}
      className={`work-tree-item ${selectedId === item.id ? 'is-selected' : ''}`}
      onKeyDown={handleKeyDown}
      style={{ '--work-tree-level': level }}
    >
      <div className="work-tree-row" onClick={event => { event.currentTarget.parentElement.focus(); onSelect(item.id); }}>
        {hasChildren
          ? <button
            type="button"
            className="work-tree-expander"
            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${item.title}`}
            aria-expanded={expanded}
            aria-controls={`work-tree-group-${item.id}`}
            onClick={event => { event.stopPropagation(); toggleExpanded(item.id); }}
            onKeyDown={event => event.stopPropagation()}
          ><ChevronRight size={14} aria-hidden="true" /></button>
          : <span className="work-tree-expander is-empty" aria-hidden="true" />}
        <span className="work-tree-icon" aria-hidden="true">
          {hasChildren ? expanded ? <FolderOpen size={16} /> : <Folder size={16} /> : <FileText size={15} />}
        </span>
        <div className={`tracker-tree-label ${contextual ? 'tree-contextual' : ''}`}>
          <span className="work-tree-title">
            {item.referenceCode ? <code className="work-reference-code">{item.referenceCode}</code> : null}
            <strong>{item.title}</strong>
            {!structural && !isAccepted(item) ? <BadgeChip tone={isDraft(item) ? 'slate' : 'amber'} className="tree-planned-chip">{commitmentLabel(item)}</BadgeChip> : null}
          </span>
          <small>
            {structural ? 'Context' : contextual ? `${commitmentLabel(item)} context` : item.childSummary.total ? `${item.childSummary.done}/${item.childSummary.total} children done` : humanize(item.type)}
            {ownerContextLabel ? <span className="work-tree-owner-context"> · In {ownerContextLabel}</span> : null}
            {structural ? null : <span className="work-tree-lifecycle" data-testid={`tree-lifecycle-${item.id}`}> · Status · {humanize(item.status)}</span>}
          </small>
        </div>
        <span className="tree-row-meta">
          {structural ? null : <WorkOwnership item={item} data={data} entry={entry} collapsed={collapsedForOwnership} showName size="sm" assignment />}
          {structural ? null : <BadgeChip className="tree-health-chip" tone={healthTone(item.health?.state)}>{healthLabel(item.health?.state)}</BadgeChip>}
          {structural ? null : progressInline(item)}
          {structural ? null : scheduleInline(item)}
          {!structural && reasons.length ? (
            <span className="work-attention-reasons" data-testid={`attention-reasons-${item.id}`}>
              {reasons.map((reason, index) => <BadgeChip key={`${reason.label}-${index}`} tone={reason.tone} className={`work-attention-${reason.tone}`}>{reason.label}</BadgeChip>)}
            </span>
          ) : null}
          {structural ? null : <WorkActivityIndicator entry={entry} projection={workActivity.projection} collapsed={collapsedForOwnership} paused={workActivity.animationsPaused} evidence={data.activityEvidence} />}
          {structural ? null : <WorkActivitySummary entry={entry} projection={workActivity.projection} evidence={data.activityEvidence} />}
          {structural ? null : <WorkManagerRowMetadata entry={managerProjection?.byId.get(item.id)} people={managerPeople} itemTitle={item.title} enabled={managerEnabled} />}
        </span>
      </div>
      {hasChildren ? (
        <div id={`work-tree-group-${item.id}`} role="group" hidden={!expanded} className="work-tree-children">
          {children.map(child => (
            <TreeItem
              key={child.id}
              itemId={child.id}
              data={data}
              treeRef={treeRef}
              parentId={item.id}
              level={level + 1}
              selectedId={selectedId}
              onSelect={onSelect}
              visibleIds={visibleIds}
              contextualIds={contextualIds}
              workActivity={workActivity}
              expandedIds={expandedIds}
              toggleExpanded={toggleExpanded}
              attentionFilter={attentionFilter}
              managerProjection={managerProjection}
              managerEnabled={managerEnabled}
              managerPeople={managerPeople}
              ownerContextLabel={null}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function buildOwnerTreeGroups({ roots, data, visibleIds, contextualIds }) {
  const groups = new Map();
  const seen = new Set();
  const visit = (item, ancestors) => {
    if (!item || seen.has(item.id) || (visibleIds && !visibleIds.has(item.id))) return;
    seen.add(item.id);
    const children = (item.childIds ?? []).map(id => data.itemById.get(id)).filter(Boolean)
      .filter(child => !visibleIds || visibleIds.has(child.id));
    if (children.length) {
      for (const child of children) visit(child, [...ancestors, item.title]);
      return;
    }
    if (contextualIds?.has(item.id) || item.contextOnly === true) return;
    const ownerValue = String(item.owner ?? '').trim().toLowerCase();
    const ownerKey = ownerValue && ownerValue !== 'unassigned' ? ownerValue : 'unassigned';
    const ownerLabel = ownerKey === 'unassigned' ? 'Unassigned' : String(item.ownerName ?? ownerKey).trim() || ownerKey;
    let group = groups.get(ownerKey);
    if (!group) {
      group = { id: `owner-group:${ownerKey}`, ownerKey, label: ownerLabel, rows: [] };
      groups.set(ownerKey, group);
    }
    group.rows.push({ item, contextLabel: ancestors.filter(Boolean).join(' / ') || null });
  };
  for (const root of roots) visit(root, []);
  return [...groups.values()].sort((left, right) => left.ownerKey.localeCompare(right.ownerKey));
}

function OwnerTreeGroup({ group, treeRef, ...treeProps }) {
  function handleKeyDown(event) {
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      event.currentTarget.querySelector('[role="group"] [role="treeitem"]')?.focus();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      focusVisibleItem(treeRef.current, event.currentTarget, event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : event.key === 'Home' ? 'home' : 'end');
    }
  }
  return <div
    role="treeitem"
    aria-level={1}
    aria-expanded="true"
    data-work-id={group.id}
    data-owner-group-id={group.ownerKey}
    tabIndex={0}
    className="work-tree-owner-group"
    onKeyDown={handleKeyDown}
  >
    <div className="work-tree-owner-group-heading"><strong>{group.label}</strong><span>{group.rows.length} task{group.rows.length === 1 ? '' : 's'}</span></div>
    <div role="group" aria-label={`${group.label} tasks`} className="work-tree-owner-group-items">
      {group.rows.map(({ item, contextLabel }) => <TreeItem
        key={item.id}
        itemId={item.id}
        treeRef={treeRef}
        parentId={group.id}
        level={1}
        ownerContextLabel={contextLabel}
        {...treeProps}
      />)}
    </div>
  </div>;
}

/** @param {{ roots: import('./snapshot').TrackerItem[], data: import('./snapshot').TrackerSnapshot, selectedId: string|null, onSelect: (id:string)=>void, visibleIds?: ReadonlySet<string>, contextualIds?: ReadonlySet<string>, workActivity: { projection: Map<string, import('./work-activity-types').WorkProjectionEntry>, expandedIds: ReadonlySet<string>, toggleExpanded: (id: string) => void, animationsPaused: boolean, activityFilter: string }, managerProjection?: import('./work-manager-types').ManagerProjection, managerEnabled?: boolean, groupByOwner?: boolean }} props */
export function WorkTree({ roots, data, selectedId, onSelect, visibleIds, contextualIds = new Set(), workActivity, managerProjection, managerEnabled = false, groupByOwner = false }) {
  const treeRef = useRef(null);
  const rootIds = useMemo(() => roots.map(item => item.id), [roots]);
  const expandedIds = workActivity.expandedIds;
  const toggleExpanded = workActivity.toggleExpanded;
  const activityFilter = workActivity.activityFilter;
  const managerPeople = Array.isArray(data.people) ? data.people : [];
  const ownerGroups = useMemo(
    () => groupByOwner ? buildOwnerTreeGroups({ roots, data, visibleIds, contextualIds }) : [],
    [contextualIds, data, groupByOwner, roots, visibleIds],
  );

  return (
    <div ref={treeRef} role="tree" aria-label="Work hierarchy" aria-multiselectable="false" className="tracker-tree work-tree">
      {groupByOwner ? ownerGroups.map(group => <OwnerTreeGroup
        key={group.id}
        group={group}
        treeRef={treeRef}
        data={data}
        selectedId={selectedId}
        onSelect={onSelect}
        visibleIds={visibleIds}
        contextualIds={contextualIds}
        workActivity={workActivity}
        expandedIds={expandedIds}
        toggleExpanded={toggleExpanded}
        attentionFilter={activityFilter === 'attention'}
        managerProjection={managerProjection}
        managerEnabled={managerEnabled}
        managerPeople={managerPeople}
      />) : rootIds.length ? rootIds.map(id => (
        <TreeItem
          key={id}
          itemId={id}
          data={data}
          treeRef={treeRef}
          parentId={null}
          level={0}
          selectedId={selectedId}
          onSelect={onSelect}
          visibleIds={visibleIds}
          contextualIds={contextualIds}
          workActivity={workActivity}
          expandedIds={expandedIds}
          toggleExpanded={toggleExpanded}
          attentionFilter={activityFilter === 'attention'}
          managerProjection={managerProjection}
          managerEnabled={managerEnabled}
          managerPeople={managerPeople}
        />
      )) : <div className="empty-panel"><Inbox size={22} aria-hidden="true" /><p>No work matches this scope.</p></div>}
    </div>
  );
}
