const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function day(value) {
  if (typeof value !== 'string' || !DAY_RE.test(value)) return null;
  const [year, month, date] = value.split('-').map(Number);
  const candidate = new Date(0);
  candidate.setUTCHours(0, 0, 0, 0);
  candidate.setUTCFullYear(year, month - 1, date);
  return candidate.getUTCFullYear() === year
    && candidate.getUTCMonth() === month - 1
    && candidate.getUTCDate() === date
    ? value
    : null;
}

function endpointRange(start, end) {
  return {
    start: day(start),
    end: day(end),
  };
}

function hasEndpoint(range) {
  return Boolean(range?.start || range?.end);
}

function envelopeRange(envelope) {
  return endpointRange(envelope?.startDay, envelope?.endDay);
}

function ownRange(row, prefix) {
  const timeline = row?.entry?.timeline ?? row?.timeline ?? {};
  return endpointRange(timeline[`${prefix}Start`], timeline[`${prefix}Due`]);
}

function markIsDated(mark) {
  if (mark?.sourceKind !== 'approved' && mark?.sourceKind !== 'proposed' && mark?.sourceKind !== 'forecast') return false;
  return hasEndpoint(endpointRange(mark.startDay, mark.endDay));
}

function childCountsFromIntervals(row) {
  const intervals = Array.isArray(row?.childSummaryIntervals) ? row.childSummaryIntervals : null;
  if (!intervals?.length) return null;
  const byChild = new Map();
  for (const interval of intervals) {
    const childId = interval?.childId;
    if (!childId) continue;
    if (!byChild.has(childId)) byChild.set(childId, false);
    if (markIsDated(interval)) byChild.set(childId, true);
  }
  if (!byChild.size) return null;
  const total = Number.isInteger(row?.eligibleChildCount)
    ? Math.max(0, row.eligibleChildCount)
    : byChild.size;
  const dated = [...byChild.values()].filter(Boolean).length;
  return {
    total,
    dated: Math.min(total, dated),
    undated: Math.max(0, total - Math.min(total, dated)),
  };
}

function childCounts(row) {
  const explicit = row?.childDateCounts ?? row?.childScheduleCounts;
  if (explicit && Number.isInteger(explicit.total)) {
    const total = Math.max(0, explicit.total);
    const dated = Number.isInteger(explicit.dated)
      ? Math.max(0, Math.min(total, explicit.dated))
      : Number.isInteger(explicit.undated)
        ? Math.max(0, total - Math.max(0, Math.min(total, explicit.undated)))
        : 0;
    return { total, dated, undated: total - dated };
  }

  const derived = childCountsFromIntervals(row);
  if (derived) return derived;

  const total = Number.isInteger(row?.eligibleChildCount)
    ? Math.max(0, row.eligibleChildCount)
    : 0;
  const legacyUndated = Number.isInteger(row?.undatedChildCount)
    ? Math.max(0, Math.min(total, row.undatedChildCount))
    : total;
  return { total, dated: total - legacyUndated, undated: legacyUndated };
}

function proposedKind(envelope) {
  const kinds = new Set((envelope?.marks ?? [])
    .filter(mark => mark?.sourceKind === 'proposed')
    .map(mark => mark.proposedScheduleKind)
    .filter(Boolean));
  if (kinds.size > 1) return 'schedules';
  if (kinds.has('checkpoint')) return 'checkpoint';
  if (kinds.has('slice')) return 'slice';
  return 'schedule';
}

function proposalFor(row, envelope) {
  const range = envelopeRange(envelope);
  if (!hasEndpoint(range)) return null;
  return { ...range, kind: proposedKind(envelope), envelope };
}

/**
 * Return the schedule facts shared by the Gantt labels and the inspector.
 *
 * Approved and proposed dates are deliberately separate. A proposed endpoint
 * counts as dated for child summaries, but never promotes the row to approved.
 * The model may provide childDateCounts/childScheduleCounts when a partial
 * child has only one approved endpoint; otherwise immediate-child intervals
 * provide the same distinction for complete marks.
 */
export function getWorkDateDetails(row) {
  const timeline = row?.entry?.timeline ?? row?.timeline ?? {};
  const ownApproved = ownRange(row, 'ownPlanned');
  const ownProposed = ownRange(row, 'ownProposed');
  const ownForecast = ownRange(row, 'ownForecast');
  const childApproved = envelopeRange(row?.childApprovedEnvelope);
  const childProposed = proposalFor(row, row?.childProposedEnvelope);
  const childForecast = envelopeRange(row?.childForecastEnvelope);
  const counts = childCounts(row);
  const hasApprovedDates = hasEndpoint(ownApproved) || hasEndpoint(childApproved);
  const hasProposedDates = hasEndpoint(ownProposed) || Boolean(childProposed);
  const hasForecastDates = hasEndpoint(ownForecast) || hasEndpoint(childForecast);
  return {
    ownApproved,
    ownProposed: hasEndpoint(ownProposed)
      ? { ...ownProposed, kind: timeline.ownProposedScheduleKind ?? 'schedule' }
      : null,
    childApproved: hasEndpoint(childApproved) ? childApproved : null,
    childProposed,
    ownForecast: hasEndpoint(ownForecast) ? ownForecast : null,
    childForecast: hasEndpoint(childForecast) ? childForecast : null,
    childCounts: counts,
    hasApprovedDates,
    hasProposedDates,
    hasForecastDates,
    forecastLabel: hasForecastDates ? 'Forecast dates' : null,
    approvalPending: hasProposedDates,
    label: !hasApprovedDates && hasProposedDates
      ? 'Dates awaiting approval'
      : !hasApprovedDates && hasForecastDates
        ? 'Forecast only'
      : !hasApprovedDates
        ? 'Unscheduled'
        : counts.undated > 0
          ? `${counts.undated} child${counts.undated === 1 ? '' : 'ren'} undated`
          : 'Scheduled',
  };
}

/** Return the concise schedule state for a Gantt row. */
export function getWorkDateLabel(row) {
  return getWorkDateDetails(row).label;
}

/** Return the display kind for an envelope of proposed child dates. */
export function getProposedScheduleKind(envelope) {
  return proposedKind(envelope);
}
