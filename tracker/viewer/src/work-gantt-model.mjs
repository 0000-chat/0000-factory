import { manilaDay } from './work-activity.mjs';
import { dependenciesOf, isAccepted } from './view-model.mjs';

const MARK_PRIORITY = ['approved', 'observed', 'proposed', 'forecast'];
const DAY_MS = 86400000;

export const GANTT_DEFAULT_ZOOM = 100;
// Keep the lower bound low enough for a multi-decade plan in a narrow chart.
// The chart's daily cells remain usable at this scale, while Fit all can still
// represent a range that would otherwise be clamped to a visibly too-large
// zoom.
export const GANTT_MIN_ZOOM = 0.001;
export const GANTT_MAX_ZOOM = 1000;
export const GANTT_ZOOM_STEP = 0.001;
export const GANTT_DAILY_COLUMN_WIDTH = 30;
const GANTT_DATE_TICK_MIN_WIDTH = 28;
export const GANTT_FIT_PADDING_DAYS = 2;
export const GANTT_SELECTED_WEEK_PADDING_DAYS = 1;
const GANTT_ZOOM_DECIMALS = 3;
const GANTT_ZOOM_SCALE = 10 ** GANTT_ZOOM_DECIMALS;
const MARK_STATUS = {
  approved: { id: 'approved', name: 'Approved plan', color: 'var(--primary)' },
  observed: { id: 'observed', name: 'Observed activity', color: 'var(--activity-quiet)' },
  proposed: { id: 'proposed', name: 'Proposed plan', color: 'var(--proposed)' },
  forecast: { id: 'forecast', name: 'Forecast', color: 'var(--forecast)' },
};

export function proposedScheduleLabel(kind) {
  if (kind === 'checkpoint') return 'Proposed checkpoint';
  if (kind === 'slice') return 'Proposed slice';
  return 'Proposed schedule';
}

export function proposedEnvelopeLabel(envelope) {
  const kinds = new Set((envelope?.marks ?? [])
    .filter(mark => mark.sourceKind === 'proposed')
    .map(mark => mark.proposedScheduleKind ?? 'span'));
  if (kinds.size > 1) return 'Proposed schedules';
  return proposedScheduleLabel(kinds.values().next().value ?? null);
}

function validDay(day) {
  if (typeof day !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const date = Number(match[3]);
  const check = new Date(0);
  check.setUTCHours(0, 0, 0, 0);
  check.setUTCFullYear(year, month - 1, date);
  return check.getUTCFullYear() === year
    && check.getUTCMonth() === month - 1
    && check.getUTCDate() === date;
}

function dayParts(day) {
  if (!validDay(day)) return null;
  return day.split('-').map(Number);
}

function dayOrdinal(day) {
  const parts = dayParts(day);
  return parts ? Math.floor(Date.UTC(parts[0], parts[1] - 1, parts[2]) / DAY_MS) : null;
}

function shiftedDay(day, amount) {
  const ordinal = dayOrdinal(day);
  if (ordinal === null || !Number.isFinite(amount)) return null;
  return new Date((ordinal + Math.trunc(amount)) * DAY_MS).toISOString().slice(0, 10);
}

export function clampGanttZoom(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return GANTT_DEFAULT_ZOOM;
  const bounded = Math.min(GANTT_MAX_ZOOM, Math.max(GANTT_MIN_ZOOM, numeric));
  return Math.round(bounded * GANTT_ZOOM_SCALE) / GANTT_ZOOM_SCALE;
}

export function formatGanttZoom(value) {
  const numeric = clampGanttZoom(value);
  const precision = numeric < 10 ? GANTT_ZOOM_DECIMALS : 0;
  return `${numeric.toFixed(precision).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1')}%`;
}

/** Return the visible date span with a small amount of breathing room. */
export function paddedGanttDateRange(startDay, endDay, paddingDays = GANTT_FIT_PADDING_DAYS) {
  const start = dayOrdinal(startDay);
  const end = dayOrdinal(endDay);
  const padding = Number.isFinite(Number(paddingDays)) ? Math.max(0, Math.trunc(Number(paddingDays))) : GANTT_FIT_PADDING_DAYS;
  if (start === null || end === null || end < start) return null;
  return {
    startDay: shiftedDay(startDay, -padding),
    endDay: shiftedDay(endDay, padding),
    days: end - start + 1 + padding * 2,
  };
}

/** Calculate the largest supported zoom that can show a dated range in a viewport. */
export function fitZoomForGanttDateRange(startDay, endDay, viewportWidth, columnWidth = 50, paddingDays = GANTT_FIT_PADDING_DAYS) {
  const padded = paddedGanttDateRange(startDay, endDay, paddingDays);
  const width = Number(viewportWidth);
  const column = Number(columnWidth);
  if (!padded || !Number.isFinite(width) || width <= 0 || !Number.isFinite(column) || column <= 0) return null;
  return clampGanttZoom(Math.floor((width / (padded.days * column)) * 100 * GANTT_ZOOM_SCALE) / GANTT_ZOOM_SCALE);
}

/**
 * Normalize a date-only week boundary without allowing Date parsing to shift
 * the displayed Manila calendar day through the runtime timezone.
 */
export function selectedWeekGanttDateRange(selectedWeek) {
  const startDay = selectedWeek?.start;
  const endDay = selectedWeek?.end;
  if (!inOrder(startDay, endDay)) return null;
  return { startDay, endDay, days: dayOrdinal(endDay) - dayOrdinal(startDay) + 1 };
}

/**
 * Return the range that a fit action should use. Release targets deliberately
 * stay out of this calculation: they remain in the bounded timeline and in
 * the deadline summary, but a distant target must not widen a work-week view.
 */
export function workGanttFitDateRange({ selectedWeek = null, startDay = null, endDay = null } = {}) {
  return selectedWeekGanttDateRange(selectedWeek) ?? (
    inOrder(startDay, endDay)
      ? { startDay, endDay, days: dayOrdinal(endDay) - dayOrdinal(startDay) + 1 }
      : null
  );
}

// Keep the descriptive alias available to consumers that use the chart's
// domain vocabulary directly.
export const ganttFitDateRange = workGanttFitDateRange;

/** Choose a readable interval for daily date labels at the current chart zoom. */
export function ganttDateTickInterval(zoom, columnWidth = GANTT_DAILY_COLUMN_WIDTH, minTickWidth = GANTT_DATE_TICK_MIN_WIDTH) {
  const numericZoom = Number(zoom);
  const width = Number(columnWidth);
  const minimum = Number(minTickWidth);
  if (!Number.isFinite(numericZoom) || numericZoom <= 0 || !Number.isFinite(width) || width <= 0
    || !Number.isFinite(minimum) || minimum <= 0) return 1;
  return Math.max(1, Math.ceil(minimum / (width * numericZoom / 100)));
}

function formatUtcDay(date) {
  return [
    String(date.getUTCFullYear()).padStart(4, '0'),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

/** Convert a Manila calendar day to the local Date cell used by Gantt. */
export function chartDateForDay(day) {
  const parts = dayParts(day);
  return parts ? new Date(parts[0], parts[1] - 1, parts[2]) : null;
}

/** Convert the current instant to today's Asia/Manila Gantt chart cell. */
export function manilaTodayForChart(now = new Date()) {
  return chartDateForDay(manilaDay(now));
}

export function addCalendarDay(day) {
  const parts = dayParts(day);
  if (!parts) return null;
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(parts[0], parts[1] - 1, parts[2] + 1);
  return formatUtcDay(date);
}

function dayLabel(day) {
  const parts = dayParts(day);
  return parts ? String(parts[1]) + '/' + String(parts[2]) : '';
}

function rangeLabel(startDay, endDay) {
  if (startDay === endDay) return dayLabel(endDay);
  return dayLabel(startDay) + '–' + dayLabel(endDay);
}

function inOrder(startDay, endDay) {
  return validDay(startDay) && validDay(endDay) && startDay <= endDay;
}

function makeMark(entry, kind, startDay, endDay, {
  point = false,
  inferred = false,
  dueDay = null,
  partial = entry.timeline.partial === true,
  proposedScheduleKind = null,
  acceptedProposal = false,
} = {}) {
  if (!inOrder(startDay, endDay)) return null;
  const chartEndDay = addCalendarDay(endDay);
  const startAt = chartDateForDay(startDay);
  const endAt = chartDateForDay(chartEndDay);
  if (!startAt || !endAt) return null;

  const status = kind === 'proposed'
    ? { ...MARK_STATUS.proposed, id: `proposed-${proposedScheduleKind ?? 'span'}`, name: proposedScheduleLabel(proposedScheduleKind) }
    : MARK_STATUS[kind];
  return {
    id: entry.id + ':' + kind,
    itemId: entry.id,
    name: status.name,
    status,
    kind: kind === 'observed' ? 'baseline' : kind,
    sourceKind: kind,
    laneKey: kind,
    dueDay: dueDay ?? (kind === 'approved' || kind === 'observed' ? entry.timeline.plannedDue ?? null : null),
    startAt,
    endAt,
    startDay,
    endDay,
    point,
    inferred,
    proposedScheduleKind: kind === 'proposed' ? proposedScheduleKind : null,
    acceptedProposal: kind === 'proposed' && acceptedProposal,
    partial,
    overdueCalendarDays: entry.timeline.overdueCalendarDays ?? 0,
    observedOverrun: kind === 'observed'
      && Boolean(dueDay ?? entry.timeline.plannedDue)
      && endDay > (dueDay ?? entry.timeline.plannedDue),
  };
}

/** Build the approved schedule recorded directly on an entry, excluding descendant rollups. */
export function approvedPlanMarkForWorkEntry(entry) {
  if (!entry?.id || !entry.timeline) return null;
  const timeline = entry.timeline;
  const startDay = timeline.ownPlannedStart ?? null;
  const dueDay = timeline.ownPlannedDue ?? null;
  const partial = Boolean(startDay) !== Boolean(dueDay);
  if (!dueDay) return null;
  if (startDay && startDay <= dueDay) {
    return makeMark(entry, 'approved', startDay, dueDay, { dueDay, partial });
  }
  return makeMark(entry, 'approved', dueDay, dueDay, { point: true, dueDay, partial });
}

/** Build source marks recorded directly on a grouping item, excluding descendant rollups. */
export function directMarksForWorkEntry(entry) {
  if (!entry?.id || !entry.timeline) return [];
  const timeline = entry.timeline;
  const marks = [];
  const approved = approvedPlanMarkForWorkEntry(entry);
  if (approved) marks.push(approved);

  const observedStart = entry.own?.firstDate ?? null;
  const observedEnd = entry.own?.lastDate ?? null;
  if (observedStart && observedEnd && observedStart <= observedEnd) {
    marks.push(makeMark(entry, 'observed', observedStart, observedEnd, {
      dueDay: timeline.ownPlannedDue ?? null,
    }));
  }
  if (timeline.ownProposedStart && timeline.ownProposedDue) {
    marks.push(makeMark(entry, 'proposed', timeline.ownProposedStart, timeline.ownProposedDue, {
      proposedScheduleKind: timeline.ownProposedScheduleKind ?? null,
      acceptedProposal: timeline.ownProposedExplicit === true,
    }));
  }
  if (timeline.ownForecastStart && timeline.ownForecastDue) {
    marks.push(makeMark(entry, 'forecast', timeline.ownForecastStart, timeline.ownForecastDue));
  }
  return marks;
}

/** Build source-backed interval marks for one full-projection entry. */
export function marksForWorkEntry(entry) {
  if (!entry?.id || !entry.timeline) return [];
  const timeline = entry.timeline;
  const marks = [];

  if (timeline.plannedDue) {
    const startDay = timeline.plannedStart ?? timeline.inferredStart;
    if (startDay && startDay <= timeline.plannedDue) {
      const mark = makeMark(entry, 'approved', startDay, timeline.plannedDue, {
        inferred: !timeline.plannedStart && Boolean(timeline.inferredStart),
      });
      if (mark) marks.push(mark);
    } else {
      const mark = makeMark(entry, 'approved', timeline.plannedDue, timeline.plannedDue, { point: true });
      if (mark) marks.push(mark);
    }
  }

  if (timeline.observedStart && timeline.observedEnd) {
    const mark = makeMark(entry, 'observed', timeline.observedStart, timeline.observedEnd);
    if (mark) marks.push(mark);
  }

  if (timeline.proposedStart && timeline.proposedEnd) {
    const mark = makeMark(entry, 'proposed', timeline.proposedStart, timeline.proposedEnd, {
      proposedScheduleKind: timeline.ownProposedScheduleKind ?? null,
      acceptedProposal: timeline.ownProposedExplicit === true,
    });
    if (mark) marks.push(mark);
  }

  // Only complete source-recorded forecasts are shown; no range is inferred.
  if (timeline.forecastStart && timeline.forecastEnd) {
    const mark = makeMark(entry, 'forecast', timeline.forecastStart, timeline.forecastEnd);
    if (mark) marks.push(mark);
  }

  return marks;
}

export function primaryWorkMark(marks) {
  for (const kind of MARK_PRIORITY) {
    const mark = marks.find(candidate => candidate.sourceKind === kind);
    if (mark) return mark;
  }
  return null;
}

export function hasForecastMarks(projection, ids) {
  const entries = asProjectionMap(projection);
  const candidates = ids && typeof ids[Symbol.iterator] === 'function' ? ids : entries.keys();
  for (const id of candidates) {
    if (marksForWorkEntry(entries.get(id)).some(mark => mark.sourceKind === 'forecast')) return true;
  }
  return false;
}

function asProjectionMap(projection) {
  return projection instanceof Map ? projection : new Map();
}

function asIdSet(values, fallback = []) {
  if (values instanceof Set) return new Set(values);
  if (values && typeof values[Symbol.iterator] === 'function') return new Set(values);
  return new Set(fallback);
}

function getDateRange(projection, releaseDates, now) {
  const days = [];
  const today = manilaDay(now);
  if (validDay(today)) days.push(today);

  for (const entry of projection.values()) {
    for (const mark of marksForWorkEntry(entry)) {
      days.push(mark.startDay, mark.endDay);
    }
  }
  for (const day of releaseDates) {
    const normalized = manilaDay(day);
    if (validDay(normalized)) days.push(normalized);
  }

  if (!days.length) {
    const startAt = manilaTodayForChart(now) ?? new Date();
    const start = new Date(startAt.getFullYear(), startAt.getMonth(), 1);
    const end = new Date(startAt.getFullYear(), startAt.getMonth() + 1, 0);
    return { startAt: new Date(start.getFullYear(), start.getMonth() - 2, 1), endAt: new Date(end.getFullYear(), end.getMonth() + 2, 0) };
  }

  days.sort();
  const earliest = chartDateForDay(days[0]);
  const latest = chartDateForDay(days[days.length - 1]);
  return {
    startAt: new Date(earliest.getFullYear(), earliest.getMonth() - 2, 1),
    endAt: new Date(latest.getFullYear(), latest.getMonth() + 2, 0),
  };
}

function childIdsOf(entry) {
  return Array.isArray(entry?.childIds) ? entry.childIds : [];
}

/**
 * Build a complete projection child index for envelope calculations.
 *
 * The rendered tree is intentionally based on the current eligible set so
 * filtering can hide rows. Parent envelopes still need to include source
 * dates from descendants that are hidden by that filter, so this index keeps
 * the complete projection relationship separate from the row tree.
 */
function buildProjectionChildren(projection) {
  const childrenById = new Map([...projection.keys()].map(id => [id, []]));
  for (const [id, entry] of projection) {
    const parentId = entry?.parentId;
    if (parentId && parentId !== id && childrenById.has(parentId)) {
      childrenById.get(parentId).push(id);
    }
  }

  for (const [parentId, children] of childrenById) {
    const listedChildren = childIdsOf(projection.get(parentId));
    if (!listedChildren.length) continue;
    const childSet = new Set(children);
    const ordered = [];
    for (const childId of listedChildren) {
      if (childSet.delete(childId)) ordered.push(childId);
    }
    for (const childId of children) {
      if (childSet.delete(childId)) ordered.push(childId);
    }
    childrenById.set(parentId, ordered);
  }
  return childrenById;
}

function projectionSubtreeIds(childrenById, id) {
  const result = [];
  const seen = new Set();
  const pending = [id];
  while (pending.length) {
    const current = pending.pop();
    if (seen.has(current)) continue;
    seen.add(current);
    result.push(current);
    const children = childrenById.get(current) ?? [];
    for (let index = children.length - 1; index >= 0; index -= 1) pending.push(children[index]);
  }
  return result;
}

function visibleSourceMarks(projection, ids, showForecast) {
  return ids.flatMap(id => marksForWorkEntry(projection.get(id)))
    .filter(mark => showForecast || mark.sourceKind !== 'forecast');
}

function sourceEnvelope(marks) {
  const dated = marks.filter(mark => validDay(mark.startDay) && validDay(mark.endDay));
  if (!dated.length) return null;
  const startDay = dated.reduce((earliest, mark) => mark.startDay < earliest ? mark.startDay : earliest, dated[0].startDay);
  const endDay = dated.reduce((latest, mark) => mark.endDay > latest ? mark.endDay : latest, dated[0].endDay);
  const primary = primaryWorkMark(dated);
  const sourceKinds = MARK_PRIORITY.filter(kind => dated.some(mark => mark.sourceKind === kind));
  return {
    startDay,
    endDay,
    primaryKind: sourceKinds.length > 1 ? 'mixed' : (primary?.sourceKind ?? null),
    sourceKinds,
    marks: dated,
  };
}

function buildEligibleTree(projection, eligibleIds) {
  const requested = new Set([...eligibleIds].filter(id => projection.has(id)));
  const eligible = new Set([...projection.keys()].filter(id => requested.has(id)));
  const childrenById = new Map([...eligible].map(id => [id, []]));
  const parentById = new Map();

  for (const id of eligible) {
    const parentId = projection.get(id)?.parentId;
    if (!parentId || parentId === id || !eligible.has(parentId)) continue;
    parentById.set(id, parentId);
    childrenById.get(parentId).push(id);
  }

  for (const [parentId, children] of childrenById) {
    if (children.length < 2) continue;
    const listedChildren = childIdsOf(projection.get(parentId));
    const childSet = new Set(children);
    const ordered = [];
    for (const childId of listedChildren) {
      if (childSet.delete(childId)) ordered.push(childId);
    }
    for (const childId of children) {
      if (childSet.delete(childId)) ordered.push(childId);
    }
    childrenById.set(parentId, ordered);
  }

  const roots = [...eligible].filter(id => !parentById.has(id));
  const rootGroups = [];
  const fullyVisited = new Set();
  const visitComponent = rootIds => {
    const pending = [...rootIds].reverse();
    while (pending.length) {
      const id = pending.pop();
      if (fullyVisited.has(id)) continue;
      fullyVisited.add(id);
      const children = childrenById.get(id) ?? [];
      for (let index = children.length - 1; index >= 0; index -= 1) pending.push(children[index]);
    }
  };

  if (roots.length) {
    rootGroups.push(roots);
    visitComponent(roots);
  }
  // A parent cycle has no natural root. Pick one stable synthetic root for each
  // remaining component so every eligible record can still be rendered once.
  for (const id of eligible) {
    if (fullyVisited.has(id)) continue;
    rootGroups.push([id]);
    visitComponent([id]);
  }

  return { eligible, parentById, childrenById, rootGroups };
}

function rowPreorder(projection, tree, expandedIds, contextualIds, {
  projectionChildren = new Map(),
  showForecast = true,
} = {}) {
  const rows = [];
  const seen = new Set();

  for (const rootGroup of tree.rootGroups) {
    const pending = rootGroup.map((id, index) => ({
      id,
      depth: 0,
      ancestorIds: [],
      isLastSibling: index === rootGroup.length - 1,
    })).reverse();

    while (pending.length) {
      const current = pending.pop();
      const { id, depth, ancestorIds, isLastSibling } = current;
      if (seen.has(id)) continue;
      seen.add(id);
      const entry = projection.get(id);
      if (!entry) continue;

      const eligibleChildIds = tree.childrenById.get(id) ?? [];
      const hasChildren = childIdsOf(entry).some(childId => projection.has(childId)) || eligibleChildIds.length > 0;
      const canExpand = eligibleChildIds.length > 0;
      const collapsed = hasChildren && !expandedIds.has(id);
      rows.push({
        entry,
        id,
        depth,
        hasChildren,
        canExpand,
        collapsed,
        contextual: contextualIds.has(id),
        ancestorIds,
        ancestorContinuation: [],
        isLastSibling,
        visibleDescendantIds: [],
        shadeAncestorId: null,
        eligibleChildCount: eligibleChildIds.length,
        undatedChildCount: eligibleChildIds.reduce((count, childId) => (
          marksForWorkEntry(projection.get(childId)).some(mark => mark.sourceKind === 'approved') ? count : count + 1
        ), 0),
        childRollups: eligibleChildIds.flatMap(childId => {
          const approved = marksForWorkEntry(projection.get(childId)).find(mark => mark.sourceKind === 'approved');
          return approved ? [{ ...approved, childId }] : [];
        }).sort((left, right) => left.startDay.localeCompare(right.startDay) || left.childId.localeCompare(right.childId)),
        marks: marksForWorkEntry(entry),
      });

      if (!canExpand || collapsed) continue;
      const nextAncestors = [...ancestorIds, id];
      for (let index = eligibleChildIds.length - 1; index >= 0; index -= 1) {
        pending.push({
          id: eligibleChildIds[index],
          depth: depth + 1,
          ancestorIds: nextAncestors,
          isLastSibling: index === eligibleChildIds.length - 1,
        });
      }
    }
  }

  const rowsById = new Map(rows.map(row => [row.id, row]));
  const visibleDescendantsById = new Map(rows.map(row => [row.id, []]));
  for (const row of rows) {
    for (const ancestorId of row.ancestorIds) visibleDescendantsById.get(ancestorId)?.push(row.id);
    const pathChildren = [...row.ancestorIds.slice(1), row.id];
    row.ancestorContinuation = pathChildren.map(pathChildId => !rowsById.get(pathChildId)?.isLastSibling);
    row.shadeAncestorId = [...row.ancestorIds].reverse().find(ancestorId => {
      if (!expandedIds.has(ancestorId)) return false;
      return marksForWorkEntry(projection.get(ancestorId)).some(mark => mark.sourceKind === 'approved' && !mark.point);
    }) ?? null;
  }
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    rows[rowIndex].rowIndex = rowIndex;
  }
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    const visibleDescendantIds = visibleDescendantsById.get(row.id) ?? [];
    const visibleDescendantIndexes = visibleDescendantIds
      .map(id => rowsById.get(id)?.rowIndex)
      .filter(index => Number.isInteger(index));
    const subtreeIds = projectionSubtreeIds(projectionChildren, row.id);
    const subtreeMarks = visibleSourceMarks(projection, subtreeIds, showForecast);
    const envelope = sourceEnvelope(subtreeMarks);
    const descendantIds = subtreeIds.filter(id => id !== row.id);
    const descendantMarks = visibleSourceMarks(projection, descendantIds, showForecast);
    const childApprovedEnvelope = sourceEnvelope(descendantMarks.filter(mark => mark.sourceKind === 'approved'));
    const childObservedEnvelope = sourceEnvelope(descendantMarks.filter(mark => mark.sourceKind === 'observed'));
    const childProposedEnvelope = sourceEnvelope(descendantMarks.filter(mark => mark.sourceKind === 'proposed' && mark.acceptedProposal === true));
    const ownApprovedMark = approvedPlanMarkForWorkEntry(row.entry);
    const childSummaryIncomplete = row.hasChildren && descendantIds.some(descendantId => {
      const descendant = projection.get(descendantId);
      if (!descendant) return false;
      const hasApprovedDates = marksForWorkEntry(descendant).some(mark => mark.sourceKind === 'approved');
      return !hasApprovedDates || descendant.timeline.partial === true;
    });
    const immediateChildren = projectionChildren.get(row.id) ?? [];
    const childSummaryIntervals = immediateChildren.flatMap(childId => (
      visibleSourceMarks(projection, [childId], showForecast).map(mark => ({ ...mark, childId }))
    )).sort((left, right) => left.startDay.localeCompare(right.startDay)
      || left.endDay.localeCompare(right.endDay)
      || left.sourceKind.localeCompare(right.sourceKind)
      || left.childId.localeCompare(right.childId));

    row.visibleDescendantIds = visibleDescendantIds;
    row.lastVisibleDescendantRowIndex = Math.max(rowIndex, ...visibleDescendantIndexes);
    row.visibleDescendantRowIndex = row.lastVisibleDescendantRowIndex;
    row.isExpanded = row.hasChildren && !row.collapsed;
    row.subtreeIds = subtreeIds;
    row.descendantIds = descendantIds;
    row.childSummaryIntervals = childSummaryIntervals;
    row.childSummaryEnvelope = sourceEnvelope(descendantMarks);
    row.childApprovedEnvelope = childApprovedEnvelope;
    row.childObservedEnvelope = childObservedEnvelope;
    row.childProposedEnvelope = childProposedEnvelope;
    row.childSummaryIncomplete = childSummaryIncomplete;
    row.ownApprovedMark = ownApprovedMark;
    row.ownApprovedIncomplete = row.hasChildren && Boolean(row.entry.timeline.ownPlannedStart) !== Boolean(row.entry.timeline.ownPlannedDue);
    row.parentEnvelope = envelope;
    row.envelopeStartDay = envelope?.startDay ?? null;
    row.envelopeEndDay = envelope?.endDay ?? null;
    row.envelopePrimaryKind = envelope?.primaryKind ?? null;
  }
  return rows;
}

function asItemMap(itemsById) {
  if (itemsById instanceof Map) return itemsById;
  if (Array.isArray(itemsById)) {
    return new Map(itemsById.flatMap(item => {
      const id = item?.id ?? item?.data?.id;
      return id ? [[String(id), item]] : [];
    }));
  }
  return new Map();
}

function dependencyEdgesFor(itemsById) {
  const known = new Map();
  for (const [key, item] of asItemMap(itemsById)) {
    const id = String(item?.id ?? item?.data?.id ?? key ?? '').trim();
    if (id && !known.has(id)) known.set(id, item);
  }

  const edges = new Map();
  for (const [toId, item] of known) {
    for (const fromId of dependenciesOf(item)) {
      if (fromId === toId || !known.has(fromId)) continue;
      const id = `${fromId}->${toId}`;
      if (!edges.has(id)) edges.set(id, { id, fromId, toId });
    }
  }
  return [...edges.values()].sort((left, right) => left.fromId.localeCompare(right.fromId) || left.toId.localeCompare(right.toId));
}

/** Build a depth preset against the eligible hierarchy, including collapsed descendants. */
export function workGanttDepthExpansion(projection, eligibleIds, depth = 'all') {
  const entries = asProjectionMap(projection);
  const eligible = asIdSet(eligibleIds, entries.keys());
  const tree = buildEligibleTree(entries, eligible);
  const levels = depth === 'all'
    ? Number.POSITIVE_INFINITY
    : Number.isFinite(Number(depth)) ? Math.max(1, Math.trunc(Number(depth))) : Number.POSITIVE_INFINITY;
  const controlledIds = new Set();
  const expandedIds = new Set();
  const seen = new Set();

  for (const rootGroup of tree.rootGroups) {
    const pending = rootGroup.slice().reverse().map(id => ({ id, depth: 0 }));
    while (pending.length) {
      const current = pending.pop();
      if (seen.has(current.id)) continue;
      seen.add(current.id);
      const children = tree.childrenById.get(current.id) ?? [];
      if (children.length) {
        controlledIds.add(current.id);
        if (current.depth < levels - 1) expandedIds.add(current.id);
      }
      for (let index = children.length - 1; index >= 0; index -= 1) {
        pending.push({ id: children[index], depth: current.depth + 1 });
      }
    }
  }

  return { controlledIds, expandedIds };
}

function ownerKeyOf(row, itemsById) {
  const item = itemsById.get(row?.id);
  const value = item?.owner ?? row?.entry?.owner;
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized && normalized !== 'unassigned' ? normalized : 'unassigned';
}

function ownerLabelOf(row, itemsById, ownerKey) {
  if (ownerKey === 'unassigned') return 'Unassigned';
  const item = itemsById.get(row?.id);
  return String(item?.ownerName ?? row?.entry?.ownerName ?? ownerKey).trim() || ownerKey;
}

function ownerWorkKind(item) {
  const value = item?.type ?? item?.data?.type;
  const kind = String(value ?? '').trim().toLowerCase();
  return kind === 'project' || kind === 'workstream' ? kind : null;
}

function hasDirectOwnerWork(row, item) {
  const timeline = row?.entry?.timeline ?? {};
  const own = row?.entry?.own ?? {};
  const hasOwnSchedule = Boolean(
    timeline.ownPlannedStart
    || timeline.ownPlannedDue
    || timeline.ownProposedStart
    || timeline.ownProposedDue,
  );
  const hasOwnActivity = Boolean(own.firstDate || own.lastDate || own.evidenceIds?.length);
  return isAccepted(item) && (hasOwnSchedule || hasOwnActivity);
}

function isOwnerWorkloadRow(row, item) {
  if (!row) return false;
  const directContainerWork = row.hasChildren
    && ownerWorkKind(item) !== null
    && hasDirectOwnerWork(row, item);
  if (directContainerWork) return true;
  if (row.contextual || item?.contextOnly === true) return false;
  if (!row.hasChildren) return true;
  return false;
}

/**
 * Build deterministic owner buckets for compact schedule views. Leaf rows and
 * accepted project/workstream records with their own schedules or evidence
 * become workload rows; inherited-only hierarchy containers remain context.
 * Canonical leaf IDs are preserved exactly once and dependency edges continue
 * to use those IDs.
 */
export function buildWorkOwnerGroups(rows = [], itemsById = new Map()) {
  const itemMap = asItemMap(itemsById);
  const groups = new Map();
  for (const row of rows) {
    const item = itemMap.get(row?.id);
    if (!isOwnerWorkloadRow(row, item)) continue;
    const directContainerWork = row.hasChildren
      && ownerWorkKind(item) !== null
      && hasDirectOwnerWork(row, item);
    const ownerKey = ownerKeyOf(row, itemMap);
    let group = groups.get(ownerKey);
    if (!group) {
      group = { id: `owner-group:${ownerKey}`, ownerKey, label: ownerLabelOf(row, itemMap, ownerKey), rows: [] };
      groups.set(ownerKey, group);
    }
    const contextTitles = (row.ancestorIds ?? [])
      .map(id => itemMap.get(id)?.title ?? rows.find(candidate => candidate.id === id)?.entry?.title)
      .filter(Boolean);
    group.rows.push({
      ...row,
      contextual: directContainerWork ? false : row.contextual,
      ownerGroupKey: ownerKey,
      ownerContextLabel: contextTitles.join(' / ') || null,
    });
  }
  return [...groups.values()].sort((left, right) => left.ownerKey.localeCompare(right.ownerKey));
}

/** Return rows grouped by owner, including stable non-workload group rows. */
export function groupWorkGanttRowsByOwner(rows = [], itemsById = new Map()) {
  const grouped = [];
  for (const group of buildWorkOwnerGroups(rows, itemsById)) {
    grouped.push({
      id: group.id,
      ownerGroup: true,
      ownerGroupKey: group.ownerKey,
      ownerGroupLabel: group.label,
      ownerGroupCount: group.rows.length,
      title: group.label,
      entry: {
        id: group.id,
        title: group.label,
        owner: null,
        ownerName: null,
        childIds: [],
        timeline: {},
        completed: false,
      },
      marks: [],
      fitMarks: [],
      primaryMark: null,
      hasChildren: false,
      canExpand: false,
      collapsed: false,
      contextual: true,
      depth: 0,
      ancestorIds: [],
      visibleDescendantIds: [],
      childSummaryIntervals: [],
      eligibleChildCount: 0,
      undatedChildCount: 0,
    });
    grouped.push(...group.rows);
  }
  for (const [rowIndex, row] of grouped.entries()) row.rowIndex = rowIndex;
  return grouped;
}

/**
 * Thin adapter from the shared projection to fixed-height Gantt rows.
 * Date bounds and marks always read the complete projection; row visibility
 * controls only which hierarchy entries are rendered.
 */
export function buildWorkGanttModel({
  projection,
  visibleIds,
  expandedIds,
  contextualIds,
  itemsById = new Map(),
  releaseDates = [],
  now = new Date(),
  showForecast = true,
} = {}) {
  const entries = asProjectionMap(projection);
  const visible = asIdSet(visibleIds, entries.keys());
  const expanded = asIdSet(expandedIds);
  const contextual = asIdSet(contextualIds);
  const tree = buildEligibleTree(entries, visible);
  const projectionChildren = buildProjectionChildren(entries);
  const rows = rowPreorder(entries, tree, expanded, contextual, { projectionChildren, showForecast });
  const parentContainers = rows.filter(row => row.isExpanded && row.parentEnvelope).map(row => ({
    id: row.id,
    depth: row.depth,
    rowIndex: row.rowIndex,
    lastVisibleDescendantRowIndex: row.lastVisibleDescendantRowIndex,
    ...row.parentEnvelope,
  }));
  return {
    rows,
    parentContainers,
    dependencyEdges: dependencyEdgesFor(itemsById),
    dateRange: getDateRange(entries, releaseDates, now),
    unscheduledIds: [...visible]
      .filter(id => entries.has(id) && !contextual.has(id))
      .filter(id => !marksForWorkEntry(entries.get(id)).some(mark => mark.sourceKind !== 'observed')),
  };
}

export function shortWorkDate(day) {
  return dayLabel(day);
}

export function workMarkLabel(mark) {
  return rangeLabel(mark.startDay, mark.endDay);
}

export function workMarkDescription(mark) {
  const label = mark.sourceKind === 'approved'
    ? mark.point ? 'Approved due date' : mark.inferred ? 'Approved plan with inferred display start' : 'Approved plan'
    : mark.sourceKind === 'observed'
      ? 'Observed activity' + (mark.observedOverrun ? ' after approved due date' : '')
      : mark.sourceKind === 'proposed'
        ? proposedScheduleLabel(mark.proposedScheduleKind)
        : 'Forecast';
  const overdue = mark.sourceKind === 'approved' && mark.overdueCalendarDays > 0
    ? ' · ' + mark.overdueCalendarDays + ' calendar days overdue'
    : '';
  return label + ' · ' + mark.startDay + ' to ' + mark.endDay + overdue;
}
