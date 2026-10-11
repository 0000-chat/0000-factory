/**
 * @typedef {import('./work-activity-types').BuildWorkProjectionInput} BuildWorkProjectionInput
 * @typedef {import('./work-activity-types').SelectWorkRowsInput} SelectWorkRowsInput
 * @typedef {import('./work-activity-types').SelectWorkRowsResult} SelectWorkRowsResult
 * @typedef {import('./work-activity-types').WorkProjectionEntry} WorkProjectionEntry
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;
const MANILA_ZONE = 'Asia/Manila';
const QUALIFYING_KINDS = new Set(['work', 'result', 'decision']);
const COMPLETED_STATUSES = new Set(['done', 'completed', 'archived']);
const ACTIVITY_FILTERS = new Set(['all', 'recent', 'quiet', 'attention']);

const manilaFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: MANILA_ZONE,
  calendar: 'gregory',
  numberingSystem: 'latn',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function text(value) {
  const result = String(value ?? '').trim();
  return result && result !== '-' ? result : null;
}

function validDay(day) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const date = Number(match[3]);
  if (month < 1 || month > 12 || date < 1 || date > 31) return false;
  const candidate = new Date(0);
  candidate.setUTCHours(0, 0, 0, 0);
  candidate.setUTCFullYear(year, month - 1, date);
  return candidate.getUTCFullYear() === year
    && candidate.getUTCMonth() === month - 1
    && candidate.getUTCDate() === date;
}

function dateFromInstant(milliseconds) {
  const parts = Object.fromEntries(manilaFormatter.formatToParts(new Date(milliseconds)).map(part => [part.type, part.value]));
  return `${parts.year.padStart(4, '0')}-${parts.month}-${parts.day}`;
}

function stringDateParts(value) {
  const match = /^(\d{4}-\d{2}-\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:?\d{2})?)?$/.exec(value);
  if (!match || !validDay(match[1])) return null;
  const hour = Number(match[2] ?? 0);
  const minute = Number(match[3] ?? 0);
  const second = Number(match[4] ?? 0);
  const fraction = match[5] ? Number(`0.${match[5]}`) : 0;
  if (hour > 23 || minute > 59 || second > 59) return null;
  return { day: match[1], hour, minute, second, millisecond: Math.floor(fraction * 1000), zone: match[6] ?? null };
}

function instantMilliseconds(value) {
  if (value instanceof Date) return Number.isNaN(value.valueOf()) ? null : value.valueOf();
  if (typeof value === 'number') {
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? null : date.valueOf();
  }
  const source = text(value);
  if (!source) return null;
  const parts = stringDateParts(source);
  if (!parts) return null;
  if (parts.zone) {
    const parsed = Date.parse(source);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const [year, month, day] = parts.day.split('-').map(Number);
  const localAsUtc = new Date(0);
  localAsUtc.setUTCHours(parts.hour, parts.minute, parts.second, parts.millisecond);
  localAsUtc.setUTCFullYear(year, month - 1, day);
  return localAsUtc.valueOf() - MANILA_OFFSET_MS;
}

/**
 * Convert an instant or ISO value to its Asia/Manila calendar day.
 * @param {Date | number | string | null | undefined} value
 * @returns {string | null}
 */
export function manilaDay(value) {
  if (value instanceof Date || typeof value === 'number') {
    const instant = instantMilliseconds(value);
    return instant === null ? null : dateFromInstant(instant);
  }
  const source = text(value);
  if (!source) return null;
  const parts = stringDateParts(source);
  if (!parts) return null;
  if (!parts.zone) return parts.day;
  const instant = instantMilliseconds(source);
  return instant === null ? null : dateFromInstant(instant);
}

function dayOrdinal(day) {
  if (!validDay(day)) return null;
  const [year, month, date] = day.split('-').map(Number);
  const value = new Date(0);
  value.setUTCHours(0, 0, 0, 0);
  value.setUTCFullYear(year, month - 1, date);
  return Math.floor(value.valueOf() / DAY_MS);
}

function dayAtOrdinal(ordinal) {
  if (!Number.isFinite(ordinal)) return null;
  return new Date(ordinal * DAY_MS).toISOString().slice(0, 10);
}

function weekday(ordinal) {
  return ((ordinal + 4) % 7 + 7) % 7;
}

/**
 * Count Monday–Friday calendar days after occurrence through the Manila today.
 * @param {Date | number | string | null | undefined} occurredAt
 * @param {Date | number | string} [now]
 * @returns {number}
 */
export function businessDayAge(occurredAt, now = new Date()) {
  const occurredDay = manilaDay(occurredAt);
  const today = manilaDay(now);
  const start = dayOrdinal(occurredDay);
  const end = dayOrdinal(today);
  if (start === null || end === null || end <= start) return 0;
  let age = 0;
  for (let day = start + 1; day <= end; day += 1) {
    const dayOfWeek = weekday(day);
    if (dayOfWeek >= 1 && dayOfWeek <= 5) age += 1;
  }
  return age;
}

/**
 * Count calendar days after occurrence through the Manila today.
 * @param {Date | number | string | null | undefined} occurredAt
 * @param {Date | number | string} [now]
 * @returns {number}
 */
export function calendarDayAge(occurredAt, now = new Date()) {
  const start = dayOrdinal(manilaDay(occurredAt));
  const end = dayOrdinal(manilaDay(now));
  if (start === null || end === null) return 0;
  return Math.max(0, end - start);
}

/**
 * Milliseconds from an instant until the next Asia/Manila midnight.
 * @param {Date | number | string} [now]
 * @returns {number | null}
 */
export function millisecondsUntilManilaMidnight(now = new Date()) {
  const today = manilaDay(now);
  const todayOrdinal = dayOrdinal(today);
  const instant = instantMilliseconds(now);
  if (todayOrdinal === null || instant === null) return null;
  const nextDay = dayAtOrdinal(todayOrdinal + 1);
  const [year, month, day] = nextDay.split('-').map(Number);
  const midnightAsUtc = new Date(0);
  midnightAsUtc.setUTCHours(0, 0, 0, 0);
  midnightAsUtc.setUTCFullYear(year, month - 1, day);
  return midnightAsUtc.valueOf() - MANILA_OFFSET_MS - instant;
}

function itemId(item) {
  return text(item?.id ?? item?.data?.id);
}

function parentRef(item) {
  let value = item?.parent ?? item?.parentId ?? item?.parent_id ?? item?.data?.parent;
  if (Array.isArray(value)) value = value[0];
  return text(typeof value === 'object' ? value?.id : value);
}

function childRefs(item) {
  const value = item?.childIds ?? item?.children ?? item?.data?.childIds;
  const values = Array.isArray(value) ? value : value == null || value === '-' ? [] : String(value).split(',');
  return values.map(entry => text(typeof entry === 'object' ? entry?.id : entry)).filter(Boolean);
}

function statusOf(item) {
  const status = text(item?.status ?? item?.data?.status);
  if (item?.contextOnly === true || item?.teamProjection?.contextOnly === true) return status ?? '';
  return status ?? 'unknown';
}

function isCompleted(item, status = statusOf(item)) {
  return item?.completed === true || item?.archived === true || COMPLETED_STATUSES.has(status.toLowerCase());
}

function ownerOf(item) {
  const owner = text(item?.owner ?? item?.data?.owner);
  // Snapshot owners are canonical roster handles/IDs; handles are case-insensitive.
  return owner?.toLowerCase() ?? null;
}

function ownerNameOf(item, owner) {
  const name = text(item?.ownerName ?? item?.owner_name);
  if (name) return name;
  return owner && owner !== 'unassigned' ? owner : null;
}

function scheduleOf(item) {
  return item?.schedule && typeof item.schedule === 'object' ? item.schedule : {};
}

function dateField(...values) {
  for (const value of values) {
    const day = manilaDay(value);
    if (day) return day;
  }
  return null;
}

function ownSchedule(item) {
  const schedule = scheduleOf(item);
  const commitment = text(item?.commitment ?? item?.data?.commitment)?.toLowerCase();
  const proposed = schedule.proposed === true || (schedule.approved !== true && commitment !== 'accepted');
  const approved = schedule.approved === true && schedule.proposed !== true;
  const plannedStart = dateField(schedule.plannedStart, schedule.planned_start);
  const plannedDue = dateField(schedule.plannedEnd, schedule.planned_end);
  const explicitProposedStart = dateField(schedule.proposedStart, schedule.proposed_start);
  const explicitProposedEnd = dateField(schedule.proposedEnd, schedule.proposed_end);
  const forecastStart = dateField(schedule.forecastStart, schedule.forecast_start);
  const forecastEnd = dateField(schedule.forecastEndMax, schedule.forecast_end_max, schedule.forecastEndMin, schedule.forecast_end_min);
  return {
    plannedStart: approved ? plannedStart : null,
    plannedDue: approved ? plannedDue : null,
    forecastStart,
    forecastEnd,
    proposedStart: explicitProposedStart ?? (proposed ? plannedStart : null),
    proposedEnd: explicitProposedEnd ?? (proposed ? plannedDue : null),
    proposedScheduleKind: text(schedule.proposedScheduleKind ?? schedule.proposed_schedule_kind),
    proposedExplicit: Boolean(explicitProposedStart || explicitProposedEnd || schedule.proposedExplicit === true),
    partial: approved && Boolean(plannedStart) !== Boolean(plannedDue),
    hasApprovedPlan: approved && Boolean(plannedStart || plannedDue),
  };
}

function evidenceIdentity(entry, taskId) {
  const sourceEventId = text(entry?.sourceEventId);
  if (sourceEventId) return `${taskId}\u0000${sourceEventId}`;
  return `${taskId}\u0000record:${text(entry?.id) ?? ''}`;
}

function evidenceDay(entry) {
  return manilaDay(entry?.occurredAt);
}

function evidenceSortKey(entry) {
  const day = evidenceDay(entry);
  const dayNumber = dayOrdinal(day);
  const instant = instantMilliseconds(entry?.occurredAt);
  return [dayNumber ?? Number.MAX_SAFE_INTEGER, instant ?? Number.MAX_SAFE_INTEGER];
}

function compareEvidence(left, right) {
  const [leftDay, leftTime] = evidenceSortKey(left);
  const [rightDay, rightTime] = evidenceSortKey(right);
  return leftDay - rightDay || leftTime - rightTime || String(left.id ?? '').localeCompare(String(right.id ?? ''));
}

function streakFor(evidence) {
  const qualifyingWeekdays = new Set();
  for (const entry of evidence) {
    const ordinal = dayOrdinal(evidenceDay(entry));
    if (ordinal === null) continue;
    const dayOfWeek = weekday(ordinal);
    if (dayOfWeek >= 1 && dayOfWeek <= 5) qualifyingWeekdays.add(ordinal);
  }
  if (!qualifyingWeekdays.size) return { days: 0, endDate: null };
  const endOrdinal = Math.max(...qualifyingWeekdays);
  let cursor = endOrdinal;
  let days = 0;
  while (true) {
    const dayOfWeek = weekday(cursor);
    if (dayOfWeek === 0 || dayOfWeek === 6) {
      cursor -= 1;
      continue;
    }
    if (!qualifyingWeekdays.has(cursor)) break;
    days += 1;
    cursor -= 1;
  }
  return { days, endDate: dayAtOrdinal(endOrdinal) };
}

function ownActivity(events, now) {
  const dated = events.filter(entry => evidenceDay(entry)).sort(compareEvidence);
  const latest = dated.at(-1) ?? null;
  const ageBusinessDays = latest ? businessDayAge(latest.occurredAt, now) : null;
  const evidenceIds = [];
  const seenIds = new Set();
  for (const event of events) {
    const id = text(event?.id);
    if (id && !seenIds.has(id)) {
      evidenceIds.push(id);
      seenIds.add(id);
    }
  }
  return {
    state: ageBusinessDays === null ? 'unknown' : ageBusinessDays <= 2 ? 'recent' : 'quiet',
    firstDate: dated.length ? evidenceDay(dated[0]) : null,
    lastDate: latest ? evidenceDay(latest) : null,
    firstOccurredAt: dated[0]?.occurredAt ?? null,
    lastOccurredAt: latest?.occurredAt ?? null,
    ageBusinessDays,
    summary: text(latest?.summary),
    evidenceRef: text(latest?.evidenceRef),
    evidenceIds,
    streak: streakFor(dated),
  };
}

function minDay(...values) {
  const days = values.flat().filter(Boolean);
  return days.length ? days.reduce((min, value) => value < min ? value : min) : null;
}

function maxDay(...values) {
  const days = values.flat().filter(Boolean);
  return days.length ? days.reduce((max, value) => value > max ? value : max) : null;
}

function safeParent(childId, parentId, parents) {
  let current = parentId;
  const seen = new Set();
  while (current) {
    if (current === childId || seen.has(current)) return false;
    seen.add(current);
    current = parents.get(current) ?? null;
  }
  return true;
}

function makeTree(items) {
  const ordered = [];
  const byId = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const id = itemId(item);
    if (!id || byId.has(id)) continue;
    byId.set(id, { id, item, parentId: null, childIds: [] });
    ordered.push(byId.get(id));
  }

  const parents = new Map();
  for (const node of ordered) {
    const parentId = parentRef(node.item);
    if (parentId && byId.has(parentId) && parentId !== node.id && safeParent(node.id, parentId, parents)) {
      parents.set(node.id, parentId);
    }
  }
  for (const node of ordered) node.parentId = parents.get(node.id) ?? null;
  for (const parent of ordered) {
    for (const childId of childRefs(parent.item)) {
      const child = byId.get(childId);
      if (child?.parentId === parent.id && !parent.childIds.includes(childId)) parent.childIds.push(childId);
    }
  }
  for (const node of ordered) {
    const parent = node.parentId ? byId.get(node.parentId) : null;
    if (parent && !parent.childIds.includes(node.id)) parent.childIds.push(node.id);
  }

  const roots = ordered.filter(node => !node.parentId);
  const postorder = [];
  const visited = new Set();
  const traverse = start => {
    const stack = [{ node: start, visited: false }];
    while (stack.length) {
      const entry = stack.pop();
      if (entry.visited) {
        postorder.push(entry.node);
        continue;
      }
      if (visited.has(entry.node.id)) continue;
      visited.add(entry.node.id);
      stack.push({ node: entry.node, visited: true });
      for (let index = entry.node.childIds.length - 1; index >= 0; index -= 1) {
        const child = byId.get(entry.node.childIds[index]);
        if (child && !visited.has(child.id)) stack.push({ node: child, visited: false });
      }
    }
  };
  for (const root of roots) traverse(root);
  for (const node of ordered) if (!visited.has(node.id)) traverse(node);
  return { ordered, byId, postorder };
}

function indexedEvidence(evidence, byId) {
  const grouped = new Map();
  const seen = new Set();
  for (const entry of Array.isArray(evidence) ? evidence : []) {
    if (entry?.included !== true || !QUALIFYING_KINDS.has(entry?.kind)) continue;
    const taskId = text(entry?.itemId);
    if (!taskId || !byId.has(taskId)) continue;
    const key = evidenceIdentity(entry, taskId);
    if (seen.has(key)) continue;
    seen.add(key);
    const events = grouped.get(taskId) ?? [];
    events.push(entry);
    grouped.set(taskId, events);
  }
  return grouped;
}

function attentionFor(entry) {
  if (entry.completed) return [];
  const reasons = [];
  const status = entry.status.toLowerCase();
  if (status === 'blocked') reasons.push('blocked');
  if (entry.own.state === 'quiet') reasons.push('quiet');
  if (entry.timeline.overdueCalendarDays > 0) reasons.push('overdue');
  if (status === 'active' && entry.own.state === 'unknown') reasons.push('missing-evidence');
  return reasons;
}

/**
 * Build a view-independent activity, ownership, and timeline projection.
 * @param {BuildWorkProjectionInput} [input]
 * @returns {Map<string, WorkProjectionEntry>}
 */
export function buildWorkProjection({ items = [], evidence = [], now = new Date() } = {}) {
  const today = manilaDay(now);
  const { ordered, byId, postorder } = makeTree(items);
  const eventsByTask = indexedEvidence(evidence, byId);
  const calculated = new Map();
  const unfinishedOwnerIdsById = new Map();
  const schedulePresenceById = new Map();
  const unscheduledSubtreeById = new Map();

  for (const node of postorder) {
    const { item, id, parentId, childIds } = node;
    const status = statusOf(item);
    const completed = isCompleted(item, status);
    const owner = ownerOf(item);
    const ownEvents = eventsByTask.get(id) ?? [];
    const own = ownActivity(ownEvents, now);
    const schedule = ownSchedule(item);
    const children = childIds.map(childId => calculated.get(childId)).filter(Boolean);

    const recentIds = [];
    const quietIds = [];
    const unknownIds = [];
    const ownerIds = [];
    const ownerSet = new Set();
    const streaks = [];
    for (const child of children) {
      if (!child.completed) {
        const target = child.own.state === 'recent' ? recentIds : child.own.state === 'quiet' ? quietIds : unknownIds;
        target.push(child.id);
      }
      recentIds.push(...child.descendants.recentIds);
      quietIds.push(...child.descendants.quietIds);
      unknownIds.push(...child.descendants.unknownIds);
      const unfinishedOwners = [...(unfinishedOwnerIdsById.get(child.id) ?? [])];
      if (!child.completed && child.owner) unfinishedOwners.unshift(child.owner);
      for (const descendantOwner of unfinishedOwners) {
        if (descendantOwner !== 'unassigned' && !ownerSet.has(descendantOwner)) {
          ownerSet.add(descendantOwner);
        }
      }
      if (!child.completed && child.own.firstDate) streaks.push({ id: child.id, title: child.title, ...child.own.streak });
      streaks.push(...child.descendants.streaks);
    }
    for (const descendantOwner of ownerSet) if (descendantOwner !== owner) ownerIds.push(descendantOwner);

    const childTimelines = children.map(child => child.timeline);
    const ownObservedDays = ownEvents.map(evidenceDay).filter(Boolean);
    const plannedStart = minDay(schedule.plannedStart, childTimelines.map(timeline => timeline.plannedStart));
    const plannedDue = maxDay(schedule.plannedDue, childTimelines.map(timeline => timeline.plannedDue));
    const observedStart = minDay(ownObservedDays, childTimelines.map(timeline => timeline.observedStart));
    const observedEnd = maxDay(ownObservedDays, childTimelines.map(timeline => timeline.observedEnd));
    const forecastStart = minDay(schedule.forecastStart, childTimelines.map(timeline => timeline.forecastStart));
    const forecastEnd = maxDay(schedule.forecastEnd, childTimelines.map(timeline => timeline.forecastEnd));
    const proposedStart = minDay(schedule.proposedStart, childTimelines.map(timeline => timeline.proposedStart));
    const proposedEnd = maxDay(schedule.proposedEnd, childTimelines.map(timeline => timeline.proposedEnd));
    const childHasApprovedSchedule = children.map(child => schedulePresenceById.get(child.id) === true);
    const hasApprovedSchedule = schedule.hasApprovedPlan || childHasApprovedSchedule.some(Boolean);
    const childHasUnscheduledSubtree = children.map(child => unscheduledSubtreeById.get(child.id) === true);
    const descendantsHaveIncompletePlan = childHasUnscheduledSubtree.some(Boolean);
    const partial = schedule.partial || childTimelines.some(timeline => timeline.partial)
      || (childIds.length > 0 && hasApprovedSchedule && descendantsHaveIncompletePlan);
    const unscheduledSubtree = !hasApprovedSchedule;
    const overdueCalendarDays = !completed && plannedDue && today && plannedDue < today
      ? calendarDayAge(plannedDue, now)
      : 0;
    const timeline = {
      ownPlannedStart: schedule.plannedStart,
      ownPlannedDue: schedule.plannedDue,
      ownProposedStart: schedule.proposedStart,
      ownProposedDue: schedule.proposedEnd,
      ownProposedScheduleKind: schedule.proposedScheduleKind,
      ownProposedExplicit: schedule.proposedExplicit,
      ownForecastStart: schedule.forecastStart,
      ownForecastDue: schedule.forecastEnd,
      plannedStart,
      plannedDue,
      observedStart,
      observedEnd,
      inferredStart: plannedStart ? null : observedStart,
      forecastStart,
      forecastEnd,
      proposedStart,
      proposedEnd,
      partial,
      overdueCalendarDays,
    };

    const entry = {
      id,
      parentId,
      childIds: [...childIds],
      title: text(item?.title ?? item?.data?.title) ?? id,
      status,
      completed,
      owner,
      ownerName: ownerNameOf(item, owner),
      own,
      descendants: { recentIds, quietIds, unknownIds, ownerIds, streaks },
      timeline,
      attentionReasons: [],
    };
    entry.attentionReasons = attentionFor(entry);
    calculated.set(id, entry);
    unfinishedOwnerIdsById.set(id, [...ownerSet]);
    schedulePresenceById.set(id, hasApprovedSchedule);
    unscheduledSubtreeById.set(id, unscheduledSubtree);
  }

  return new Map(ordered.map(node => [node.id, calculated.get(node.id)]).filter(([, entry]) => Boolean(entry)));
}

function ancestorsOf(id, projection, scopeRootId) {
  const ancestors = [];
  const seen = new Set([id]);
  let current = projection.get(id)?.parentId ?? null;
  while (current && !seen.has(current)) {
    const entry = projection.get(current);
    if (!entry) break;
    seen.add(current);
    ancestors.push(current);
    if (scopeRootId && current === scopeRootId) break;
    current = entry.parentId;
  }
  return ancestors;
}

function belongsToScope(id, projection, scopeRootId) {
  if (!scopeRootId) return true;
  if (!projection.has(scopeRootId)) return false;
  const seen = new Set();
  let current = id;
  while (current && !seen.has(current)) {
    if (current === scopeRootId) return true;
    seen.add(current);
    current = projection.get(current)?.parentId ?? null;
  }
  return false;
}

/**
 * Select matching task rows and the ancestor context needed to render their paths.
 * @param {SelectWorkRowsInput} [input]
 * @returns {SelectWorkRowsResult}
 */
export function selectWorkRows({ projection = new Map(), eligibleIds = [], activityFilter = 'all', revealAncestors = false, scopeRootId = null } = {}) {
  const normalizedFilter = ACTIVITY_FILTERS.has(activityFilter) ? activityFilter : 'all';
  const rootId = text(scopeRootId);
  const eligible = new Set([...eligibleIds].map(text).filter(id => id && projection.has(id) && belongsToScope(id, projection, rootId)));
  const matchIds = new Set();
  for (const id of eligible) {
    const entry = projection.get(id);
    if (!entry) continue;
    if (normalizedFilter === 'recent' && (entry.completed || entry.own.state !== 'recent')) continue;
    if (normalizedFilter === 'quiet' && (entry.completed || entry.own.state !== 'quiet')) continue;
    if (normalizedFilter === 'attention' && (entry.completed || entry.attentionReasons.length === 0)) continue;
    matchIds.add(id);
  }

  const contextIds = new Set();
  const revealAncestorIds = new Set();
  for (const id of matchIds) {
    for (const ancestorId of ancestorsOf(id, projection, rootId)) {
      if (!belongsToScope(ancestorId, projection, rootId)) continue;
      if (!matchIds.has(ancestorId)) contextIds.add(ancestorId);
      if (normalizedFilter !== 'all' || revealAncestors) revealAncestorIds.add(ancestorId);
    }
  }
  const visibleIds = new Set([...matchIds, ...contextIds]);
  return { matchIds, visibleIds, contextIds, revealAncestorIds };
}
