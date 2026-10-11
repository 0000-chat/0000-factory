const ALL_SCOPE = '*';
const HEALTH_STATES = new Set(['on-track', 'at-risk', 'blocked', 'unknown']);
const COMPLETED_STATUSES = new Set(['done', 'completed', 'archived']);
const PENDING_DECISION_STATES = new Set([
  'pending',
  'proposed',
  'waiting',
  'waiting-for-don',
  'needs-confirmation',
  'needs-approval',
]);

const PRIORITY_RANKS = new Map([
  ['critical', 500],
  ['urgent', 400],
  ['high', 300],
  ['medium', 200],
  ['normal', 100],
  ['low', 50],
]);

function text(value) {
  const result = String(value ?? '').trim();
  return result && result !== '-' ? result : null;
}

function itemId(item) {
  return text(item?.id ?? item?.data?.id);
}

function parentId(item) {
  const value = item?.parent ?? item?.parentId ?? item?.parent_id ?? item?.data?.parent;
  const parent = Array.isArray(value) ? value[0] : value;
  return text(typeof parent === 'object' ? parent.id : parent);
}

function recordsById(items) {
  const output = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const id = itemId(item);
    if (id && !output.has(id)) output.set(id, item);
  }
  return output;
}

function normalizedScope(scopeId) {
  return scopeId === null || scopeId === undefined || scopeId === '' ? ALL_SCOPE : String(scopeId);
}

export function dependenciesOf(item) {
  const value = item?.dependsOn ?? item?.depends_on ?? item?.dependencies ?? item?.data?.depends_on;
  const values = Array.isArray(value) ? value : value === null || value === undefined || value === '-' ? [] : String(value).split(',');
  return values.map(value => {
    if (value && typeof value === 'object') return text(value.id ?? value.itemId ?? value.taskId);
    return text(value);
  }).filter(Boolean);
}

function buildChildren(byId) {
  const children = new Map();
  for (const [id, item] of byId) {
    const parent = parentId(item);
    if (!parent || !byId.has(parent)) continue;
    const list = children.get(parent) ?? [];
    list.push(id);
    children.set(parent, list);
  }
  return children;
}

/** Return distinct item IDs in the selected project/subproject scope. */
export function scopeItemIds(items, scopeId = ALL_SCOPE) {
  const byId = recordsById(items);
  const scope = normalizedScope(scopeId);
  if (scope === ALL_SCOPE) return [...byId.keys()];
  if (!byId.has(scope)) return [];

  const children = buildChildren(byId);
  const included = new Set([scope]);
  const pending = [scope];
  while (pending.length) {
    const parent = pending.pop();
    for (const child of children.get(parent) ?? []) {
      if (included.has(child)) continue;
      included.add(child);
      pending.push(child);
    }
  }
  return [...byId.keys()].filter(id => included.has(id));
}

/** Return item records in source order for the selected scope. */
export function getScopeItems(items, scopeId = ALL_SCOPE) {
  const byId = recordsById(items);
  return scopeItemIds(items, scopeId).map(id => byId.get(id)).filter(Boolean);
}

/** Keep every linked plan and its complete task list visible through Work filters. */
export function plansForScope(plans, _scopeIds = null) {
  return Array.isArray(plans) ? plans : [];
}

/** Return distinct known dependency records referenced from outside the scope. */
export function externalDependencies(items, scopeId = ALL_SCOPE) {
  const byId = recordsById(items);
  const scopedIds = new Set(scopeItemIds(items, scopeId));
  const dependencyIds = new Set();
  for (const item of getScopeItems(items, scopeId)) {
    for (const dependencyId of dependenciesOf(item)) {
      if (!scopedIds.has(dependencyId) && byId.has(dependencyId)) dependencyIds.add(dependencyId);
    }
  }
  return [...dependencyIds].map(id => byId.get(id)).filter(Boolean);
}

export function getExternalDependencies(items, scopeId = ALL_SCOPE) {
  return externalDependencies(items, scopeId);
}

function normalizeState(value) {
  const state = text(value)?.toLowerCase().replaceAll('_', '-').replaceAll(' ', '-') ?? 'unknown';
  return HEALTH_STATES.has(state) ? state : 'unknown';
}

function healthOf(item) {
  const health = item?.health;
  if (typeof health === 'string') return { state: normalizeState(health) };
  return health && typeof health === 'object' ? health : {};
}

function healthState(item) {
  return normalizeState(healthOf(item).state ?? item?.healthState ?? item?.health_status);
}

function firstText(...values) {
  for (const value of values) {
    const result = text(value);
    if (result) return result;
  }
  return null;
}

function isCompleted(item) {
  const status = text(item?.status ?? item?.data?.status)?.toLowerCase();
  return item?.completed === true || item?.archived === true || COMPLETED_STATUSES.has(status);
}

export function commitmentOf(item) {
  const value = item?.commitment ?? item?.data?.commitment;
  return text(value)?.toLowerCase() ?? null;
}

export function isDraft(item) {
  return commitmentOf(item) === 'draft';
}

export function isPlanned(item) {
  return commitmentOf(item) === 'planned';
}

export function isAccepted(item) {
  return commitmentOf(item) === 'accepted';
}

export function commitmentLabel(item) {
  const commitment = commitmentOf(item);
  return commitment ? commitment[0].toUpperCase() + commitment.slice(1) : 'Unknown';
}

function parentOf(item) {
  return parentId(item);
}

/**
 * Apply Work visibility toggles while retaining hidden draft/planned context
 * needed to explain an accepted descendant or its prerequisite.
 */
export function workVisibility(items, scopeId = ALL_SCOPE, showPlanned = true, showDrafts = false) {
  const scoped = getScopeItems(items, scopeId);
  const byId = recordsById(scoped);
  const visibleByToggle = item => isAccepted(item) || (isPlanned(item) && showPlanned) || (isDraft(item) && showDrafts);
  const included = new Set(scoped.filter(visibleByToggle).map(item => itemId(item)));
  const contextualIds = new Set();
  const addContextChain = startId => {
    let current = byId.get(startId);
    const seen = new Set();
    while (current && parentOf(current) && !seen.has(parentOf(current))) {
      seen.add(parentOf(current));
      const parent = byId.get(parentOf(current));
      if (!parent) break;
      if (!included.has(itemId(parent))) {
        included.add(itemId(parent));
        contextualIds.add(itemId(parent));
      }
      current = parent;
    }
  };
  for (const id of [...included]) addContextChain(id);
  const pending = [...included];
  const dependencySeen = new Set();
  while (pending.length) {
    const currentId = pending.pop();
    const current = byId.get(currentId);
    for (const dependencyId of dependenciesOf(current)) {
      if (dependencySeen.has(dependencyId)) continue;
      dependencySeen.add(dependencyId);
      const dependency = byId.get(dependencyId);
      if (!dependency || included.has(dependencyId)) continue;
      included.add(dependencyId);
      contextualIds.add(dependencyId);
      addContextChain(dependencyId);
      pending.push(dependencyId);
    }
  }
  const visible = scoped.filter(item => included.has(itemId(item)));
  return {
    items: visible,
    contextualIds,
    workloadItems: visible.filter(item => !contextualIds.has(itemId(item)) && isAccepted(item))
  };
}

function explicitDecisionState(value) {
  const state = text(value)?.toLowerCase().replaceAll('_', '-').replaceAll(' ', '-');
  return state && PENDING_DECISION_STATES.has(state);
}

function awaitsDonDecision(item) {
  if (item?.awaitingDon === true || item?.requiresDon === true || item?.requiresDonApproval === true || item?.needsDonApproval === true) return true;
  for (const value of [item?.approvalStatus, item?.approval?.status, item?.planStatus, item?.decisionStatus]) {
    if (explicitDecisionState(value)) return true;
  }
  const decisions = Array.isArray(item?.linked?.decisions) ? item.linked.decisions : Array.isArray(item?.decisions) ? item.decisions : [];
  return decisions.some(decision => explicitDecisionState(decision?.state ?? decision?.status));
}

function launchRequired(item) {
  for (const value of [item?.launchRequired, item?.launch_required, item?.health?.launchRequired, item?.health?.launch_required]) {
    if (value === true || String(value ?? '').trim().toLowerCase() === 'true') return true;
  }
  return false;
}

function parseDate(value) {
  const raw = text(value);
  if (!raw) return null;
  let input = raw;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) input = `${raw}T12:00:00+08:00`;
  else if (/^\d{4}-\d{2}-\d{2}T[^zZ+\-]+$/.test(raw)) input = `${raw}+08:00`;
  const result = new Date(input);
  return Number.isNaN(result.valueOf()) ? null : result;
}

function dateValue(item) {
  const schedule = item?.schedule ?? {};
  return firstText(
    item?.target,
    item?.targetDate,
    item?.deadline,
    schedule.plannedEnd,
    schedule.planned_end,
    schedule.forecastEndMax,
    schedule.forecast_end_max
  );
}

function nowDate(value) {
  return parseDate(value) ?? new Date();
}

function priorityRank(item) {
  const value = item?.priority?.level ?? item?.priority?.rank ?? item?.priority;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const normalized = text(value)?.toLowerCase();
  if (!normalized) return 0;
  const named = PRIORITY_RANKS.get(normalized);
  if (named !== undefined) return named;
  const match = /^p(\d+)$/.exec(normalized);
  return match ? Math.max(0, 100 - Number(match[1])) : 0;
}

function titleOf(item) {
  return text(item?.title) ?? itemId(item) ?? '';
}

function attentionEntry(item, group, now) {
  const health = healthOf(item);
  const nextStep = item?.sections?.nextStep;
  const reason = firstText(health.reason, item?.reason, item?.blocker, item?.sections?.blocker) ?? 'Reason not recorded.';
  const missingInformation = firstText(health.missingInformation, item?.missingInformation, item?.missing_information);
  const suggestedAction = firstText(
    health.suggestedAction,
    health.suggested_action,
    item?.suggestedAction,
    item?.suggested_action,
    item?.requestedAction,
    item?.requested_action,
    nextStep
  );
  const actor = firstText(health.actor, item?.actor, item?.actionActor, item?.action_actor, item?.proposedActor, item?.proposed_actor);
  const target = dateValue(item);
  const targetDate = parseDate(target);
  return {
    ...item,
    attention: {
      group,
      state: healthState(item),
      reason,
      missingInformation,
      suggestedAction,
      requestedAction: suggestedAction,
      actor,
      target,
      overdue: Boolean(targetDate && targetDate.valueOf() < now.valueOf()),
    }
  };
}

function isUrgent(item) {
  const state = healthState(item);
  if (state === 'blocked') return true;
  if (state !== 'at-risk') return false;
  return Boolean(dateValue(item) || launchRequired(item));
}

function comparePriorityTitle(left, right) {
  const priorityDifference = priorityRank(right) - priorityRank(left);
  if (priorityDifference) return priorityDifference;
  const titleDifference = titleOf(left).localeCompare(titleOf(right));
  return titleDifference || String(itemId(left)).localeCompare(String(itemId(right)));
}

/** Group active scoped work without inferring urgency from status alone. */
export function groupAttention(items, { scopeId = ALL_SCOPE, now = new Date() } = {}) {
  const current = nowDate(now);
  const groups = { urgent: [], decisions: [], actions: [], unknown: [] };
  for (const item of getScopeItems(items, scopeId)) {
    if (isCompleted(item)) continue;
    const state = healthState(item);
    let group = 'actions';
    if (isUrgent(item)) group = 'urgent';
    else if (awaitsDonDecision(item)) group = 'decisions';
    else if (state === 'unknown') group = 'unknown';
    groups[group].push(attentionEntry(item, group, current));
  }
  for (const group of Object.values(groups)) group.sort(comparePriorityTitle);
  return groups;
}

/** Format a date using the Asia/Manila calendar without shifting date-only values. */
export function formatAsiaManilaDate(value, { locale, ...formatOptions } = {}) {
  const date = parseDate(value);
  if (!date) return null;
  const options = Object.keys(formatOptions).length ? formatOptions : { dateStyle: 'medium' };
  return new Intl.DateTimeFormat(locale, { ...options, timeZone: 'Asia/Manila' }).format(date);
}

export function progressDisplayLabel(progress) {
  if (!progress || progress.scoped !== true) return 'Unscoped';
  return Number.isFinite(progress.percent) ? `${Math.round(progress.percent)}%` : 'Unscoped';
}

export const progressLabel = progressDisplayLabel;

function scheduleDate(value) {
  const raw = text(value);
  if (!raw) return null;
  const input = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T12:00:00+08:00` : raw;
  const date = new Date(input);
  return Number.isNaN(date.valueOf()) ? null : date;
}

function scheduleOf(item) {
  return item?.schedule && typeof item.schedule === 'object' ? item.schedule : {};
}

/** Build timeline bars without treating draft/planned dates as approved baselines. */
export function scheduleFeatures(items) {
  const features = [];
  for (const item of Array.isArray(items) ? items : []) {
    const schedule = scheduleOf(item);
    const proposed = !isAccepted(item);
    const label = commitmentLabel(item);
    const baseline = scheduleDate(schedule.plannedStart ?? schedule.planned_start) && scheduleDate(schedule.plannedEnd ?? schedule.planned_end);
    const explicitProposedStart = scheduleDate(schedule.proposedStart ?? schedule.proposed_start);
    const explicitProposedEnd = scheduleDate(schedule.proposedEnd ?? schedule.proposed_end);
    const explicitProposed = Boolean(explicitProposedStart && explicitProposedEnd);
    const forecastStart = scheduleDate(schedule.forecastStart ?? schedule.forecast_start);
    const forecastEnd = scheduleDate(schedule.forecastEndMax ?? schedule.forecastEndMin ?? schedule.forecast_end_max ?? schedule.forecast_end_min);
    if (explicitProposed) {
      const kind = schedule.proposedScheduleKind ?? schedule.proposed_schedule_kind;
      const kindLabel = kind === 'checkpoint' ? 'Proposed checkpoint' : kind === 'slice' ? 'Proposed slice' : 'Proposed schedule';
      features.push({
        id: `${item.id}-explicit-proposed`,
        name: `${kindLabel} · ${item.title}`,
        startAt: explicitProposedStart,
        endAt: explicitProposedEnd,
        status: { id: `proposed-${kind === 'checkpoint' || kind === 'slice' ? kind : 'span'}`, name: kindLabel, color: 'var(--proposed)' },
        itemId: item.id,
        kind: 'proposed',
        proposed: true,
        proposedScheduleKind: kind === 'checkpoint' || kind === 'slice' ? kind : 'span',
        rangeLabel: `${schedule.proposedStart ?? schedule.proposed_start} → ${schedule.proposedEnd ?? schedule.proposed_end}`
      });
    }
    if (baseline && (schedule.approved === true || !explicitProposed) && (proposed || schedule.approved === true)) {
      features.push({
        id: `${item.id}-${proposed ? `${commitmentOf(item)}-proposed` : 'approved'}`,
        name: `${proposed ? `${label} proposed` : 'Approved'} · ${item.title}`,
        startAt: scheduleDate(schedule.plannedStart ?? schedule.planned_start),
        endAt: scheduleDate(schedule.plannedEnd ?? schedule.planned_end),
        status: { id: proposed ? `${commitmentOf(item)}-proposed` : 'approved', name: proposed ? `${label} proposed dates` : 'Approved baseline', color: proposed ? 'var(--proposed)' : 'var(--baseline)' },
        itemId: item.id,
        kind: proposed ? 'proposed' : 'baseline',
        proposed,
        rangeLabel: `${schedule.plannedStart ?? schedule.planned_start} → ${schedule.plannedEnd ?? schedule.planned_end}`
      });
    }
    if (forecastStart && forecastEnd) {
      features.push({
        id: `${item.id}-${proposed ? `${commitmentOf(item)}-proposed-forecast` : 'forecast'}`,
        name: `${proposed ? `${label} proposed · ` : 'Forecast · '}${item.title}`,
        startAt: forecastStart,
        endAt: forecastEnd,
        status: { id: proposed ? `${commitmentOf(item)}-proposed-forecast` : 'forecast', name: proposed ? `${label} proposed forecast` : schedule.provisional ? 'Forecast · provisional' : 'Forecast range', color: proposed ? 'var(--proposed)' : 'var(--forecast)' },
        itemId: item.id,
        kind: proposed ? 'proposed' : 'forecast',
        proposed,
        rangeLabel: `${schedule.forecastStart ?? schedule.forecast_start} → ${schedule.forecastEndMax ?? schedule.forecastEndMin ?? schedule.forecast_end_max ?? schedule.forecast_end_min}${schedule.provisional ? ' · provisional' : ''}`
      });
    }
  }
  return features;
}
