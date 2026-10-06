export const WORK_GANTT_DEPENDENCY_GAP = 12;
export const WORK_GANTT_DEPENDENCY_CHANNEL_STEP = 4;
export const WORK_GANTT_DEFAULT_ROW_HEIGHT = 80;

function compareStrings(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function validId(value) {
  return typeof value === 'string' && value.length > 0;
}

/** Normalize graph edges without traversing the graph, so cycles are harmless. */
export function normalizeWorkGanttDependencyEdges(dependencyEdges = []) {
  const candidates = [];
  for (const edge of dependencyEdges ?? []) {
    if (!validId(edge?.id) || !validId(edge?.fromId) || !validId(edge?.toId) || edge.fromId === edge.toId) continue;
    candidates.push({ id: edge.id, fromId: edge.fromId, toId: edge.toId });
  }

  candidates.sort((left, right) => compareStrings(left.id, right.id)
    || compareStrings(left.fromId, right.fromId)
    || compareStrings(left.toId, right.toId));

  const seenIds = new Set();
  const seenPairs = new Set();
  const normalized = [];
  for (const edge of candidates) {
    const pairKey = JSON.stringify([edge.fromId, edge.toId]);
    if (seenIds.has(edge.id) || seenPairs.has(pairKey)) continue;
    seenIds.add(edge.id);
    seenPairs.add(pairKey);
    normalized.push(edge);
  }
  return normalized;
}

function hasApprovedMark(row) {
  return Array.isArray(row?.marks) && row.marks.some(mark => mark?.sourceKind === 'approved');
}

function mapValue(source, id) {
  if (source instanceof Map) return source.get(id);
  if (source && typeof source === 'object') return source[id];
  return undefined;
}

function usableRect(rect) {
  if (!rect) return null;
  const left = Number(rect.left);
  const right = Number(rect.right);
  const top = Number(rect.top);
  const bottom = Number(rect.bottom);
  if (![left, right, top, bottom].every(Number.isFinite)) return null;
  return {
    left,
    right,
    top,
    bottom,
    point: rect.point === true || rect.isPoint === true,
  };
}

function usableRowBounds(bounds) {
  if (!bounds) return null;
  const top = Number(bounds.top);
  const bottom = Number(bounds.bottom);
  if (![top, bottom].every(Number.isFinite)) return null;
  return { top, bottom };
}

function centerY(rect) {
  return (rect.top + rect.bottom) / 2;
}

function centerX(rect) {
  return (rect.left + rect.right) / 2;
}

function coordinate(value) {
  return Number(value.toFixed(2)).toString();
}

function pathFromPoints(points) {
  const compact = [];
  for (const point of points) {
    const previous = compact.at(-1);
    if (previous && previous.x === point.x && previous.y === point.y) continue;
    compact.push(point);
  }
  return compact.map((point, index) => `${index === 0 ? 'M' : 'L'} ${coordinate(point.x)} ${coordinate(point.y)}`).join(' ');
}

/**
 * Build stable orthogonal routes from row order and approved-anchor rectangles.
 * Anchor rectangles are already in the timeline body's content coordinates.
 */
export function layoutWorkGanttDependencies({
  rows = [],
  dependencyEdges = [],
  anchors = new Map(),
  rowBounds = new Map(),
  rowHeight = WORK_GANTT_DEFAULT_ROW_HEIGHT,
  rowOriginY = 0,
} = {}) {
  const rowIndexes = new Map();
  const approvedRows = new Set();
  for (const [index, row] of rows.entries()) {
    if (!validId(row?.id)) continue;
    if (!rowIndexes.has(row.id)) rowIndexes.set(row.id, index);
    if (hasApprovedMark(row)) approvedRows.add(row.id);
  }

  const candidates = normalizeWorkGanttDependencyEdges(dependencyEdges).flatMap(edge => {
    if (edge.fromId === edge.toId) return [];
    const sourceRect = usableRect(mapValue(anchors, edge.fromId));
    const targetRect = usableRect(mapValue(anchors, edge.toId));
    const sourceIndex = rowIndexes.get(edge.fromId);
    const targetIndex = rowIndexes.get(edge.toId);
    if (sourceIndex === undefined || targetIndex === undefined
      || !approvedRows.has(edge.fromId) || !approvedRows.has(edge.toId)
      || !sourceRect || !targetRect) return [];

    const fromX = sourceRect.point ? centerX(sourceRect) : sourceRect.right;
    const toX = targetRect.point ? centerX(targetRect) : targetRect.left;
    const fromY = centerY(sourceRect);
    const toY = centerY(targetRect);
    const sourceBounds = usableRowBounds(mapValue(rowBounds, edge.fromId));
    const safeRowHeight = Number(rowHeight) > 0 ? Number(rowHeight) : WORK_GANTT_DEFAULT_ROW_HEIGHT;
    const gutterY = sourceBounds
      ? targetIndex > sourceIndex ? sourceBounds.bottom : sourceBounds.top
      : Number(rowOriginY) + (targetIndex > sourceIndex ? sourceIndex + 1 : sourceIndex) * safeRowHeight;
    return [{
      ...edge,
      sourceRect,
      targetRect,
      sourceIndex,
      targetIndex,
      fromX,
      fromY,
      toX,
      toY,
      sourceExitX: fromX + WORK_GANTT_DEPENDENCY_GAP,
      targetApproachX: toX - WORK_GANTT_DEPENDENCY_GAP,
      gutterY,
      backwardsDates: fromX >= toX,
      channelGroup: `rows:${Math.min(sourceIndex, targetIndex)}:${Math.max(sourceIndex, targetIndex)}`,
    }];
  });

  const channels = new Map();
  for (const candidate of candidates) {
    const group = channels.get(candidate.channelGroup) ?? [];
    group.push(candidate);
    channels.set(candidate.channelGroup, group);
  }
  for (const group of channels.values()) {
    group.sort((left, right) => compareStrings(left.id, right.id));
    group.forEach((candidate, index) => {
      candidate.channelIndex = index;
    });
  }

  return candidates.sort((left, right) => compareStrings(left.id, right.id)
    || compareStrings(left.fromId, right.fromId)
    || compareStrings(left.toId, right.toId)).map(candidate => {
    const {
      id, fromId, toId, sourceRect, targetRect, sourceIndex, targetIndex,
      fromX, fromY, toX, toY, sourceExitX, targetApproachX, gutterY,
      backwardsDates, channelIndex,
    } = candidate;
    const channelOffset = channelIndex * WORK_GANTT_DEPENDENCY_CHANNEL_STEP;
    const points = [{ x: fromX, y: fromY }];

    points.push({ x: sourceExitX, y: fromY });
    if (backwardsDates) {
      const laterSourceEdge = sourceRect.point ? centerX(sourceRect) : sourceRect.right;
      const laterTargetEdge = targetRect.point ? centerX(targetRect) : targetRect.right;
      const channelX = Math.max(laterSourceEdge, laterTargetEdge)
        + WORK_GANTT_DEPENDENCY_GAP + channelOffset;
      points.push(
        { x: channelX, y: fromY },
        { x: channelX, y: gutterY + channelOffset },
        { x: targetApproachX, y: gutterY + channelOffset },
      );
    } else {
      points.push(
        { x: sourceExitX, y: gutterY + channelOffset },
        { x: targetApproachX, y: gutterY + channelOffset },
      );
    }

    points.push(
      { x: targetApproachX, y: toY },
      { x: toX, y: toY },
    );
    return {
      id,
      fromId,
      toId,
      path: pathFromPoints(points),
      fromX,
      fromY,
      toX,
      toY,
      sourceRowIndex: sourceIndex,
      targetRowIndex: targetIndex,
      backwardsDates,
      channelIndex,
    };
  });
}

/** Select cached drawable paths for active-only or all-edge display. */
export function selectWorkGanttDependencyPaths(paths = [], { activeId = null, showAll = false } = {}) {
  if (showAll) return paths;
  if (!validId(activeId)) return [];
  return paths.filter(path => path.fromId === activeId || path.toId === activeId);
}

function entriesById(entries, rows) {
  const result = new Map();
  if (entries instanceof Map) {
    for (const [id, entry] of entries) result.set(id, entry);
  } else if (Array.isArray(entries)) {
    for (const entry of entries) {
      if (validId(entry?.id)) result.set(entry.id, entry);
    }
  } else if (entries && typeof entries === 'object') {
    for (const [id, entry] of Object.entries(entries)) result.set(id, entry);
  }
  for (const row of rows ?? []) {
    if (validId(row?.id) && !result.has(row.id)) result.set(row.id, row.entry ?? row);
  }
  return result;
}

/** Create accessible prerequisite/dependent text, including why an edge is absent. */
export function buildWorkGanttDependencySummary({
  activeId = null,
  rows = [],
  dependencyEdges = [],
  entries = new Map(),
} = {}) {
  if (!validId(activeId)) return null;

  const rowById = new Map();
  for (const row of rows ?? []) {
    if (validId(row?.id) && !rowById.has(row.id)) rowById.set(row.id, row);
  }
  const entryMap = entriesById(entries, rows);
  const activeEntry = entryMap.get(activeId);
  const relationships = { prerequisites: [], dependents: [] };

  for (const edge of normalizeWorkGanttDependencyEdges(dependencyEdges)) {
    const isPrerequisite = edge.toId === activeId;
    const isDependent = edge.fromId === activeId;
    if (!isPrerequisite && !isDependent) continue;

    const endpointRows = [rowById.get(edge.fromId), rowById.get(edge.toId)];
    const hidden = endpointRows.some(row => !row);
    const lacksApprovedDates = !hidden && endpointRows.some(row => !hasApprovedMark(row));
    const missingReason = hidden ? 'Hidden in this view' : lacksApprovedDates ? 'No approved dates' : null;
    const relationship = endpointId => ({
      id: edge.id,
      itemId: endpointId,
      title: entryMap.get(endpointId)?.title ?? endpointId,
      missingReason,
    });

    if (isPrerequisite) relationships.prerequisites.push(relationship(edge.fromId));
    if (isDependent) relationships.dependents.push(relationship(edge.toId));
  }

  return {
    activeId,
    activeTitle: activeEntry?.title ?? activeId,
    prerequisites: relationships.prerequisites,
    dependents: relationships.dependents,
  };
}
