import { scheduleFeatures } from './view-model.mjs';

const SUMMARY_LABEL = 'Derived summary';
const KIND_ORDER = ['baseline', 'forecast', 'proposed'];

function text(value) {
  const result = String(value ?? '').trim();
  return result && result !== '-' ? result : null;
}

function idOf(item) {
  return text(item?.id ?? item?.data?.id);
}

function parentIdOf(item) {
  let value = item?.parent ?? item?.parentId ?? item?.parent_id ?? item?.data?.parent;
  if (Array.isArray(value)) value = value[0];
  return text(typeof value === 'object' ? value?.id : value);
}

function idSet(values) {
  const entries = values instanceof Set ? [...values] : Array.isArray(values) ? values : [];
  return new Set(entries.map(text).filter(Boolean));
}

function scheduleInput(item, id) {
  if (item?.id === id) return item;
  return { ...item, id, title: item?.title ?? id };
}

function ownScheduleFeatures(item, id) {
  const source = scheduleInput(item, id);
  const schedule = source?.schedule && typeof source.schedule === 'object' ? source.schedule : {};
  const provisional = schedule.provisional ?? schedule.schedule_provisional ?? null;
  return scheduleFeatures([source]).map(feature => ({
    ...feature,
    provisional,
    summary: false,
    synthetic: false,
    summaryLabel: null,
  }));
}

function compareKinds(left, right) {
  const leftIndex = KIND_ORDER.indexOf(left);
  const rightIndex = KIND_ORDER.indexOf(right);
  if (leftIndex === -1 && rightIndex === -1) return left.localeCompare(right);
  if (leftIndex === -1) return 1;
  if (rightIndex === -1) return -1;
  return leftIndex - rightIndex;
}

function dateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function provisionalFor(features) {
  if (features.some(feature => feature.provisional === true)) return true;
  if (features.every(feature => feature.provisional === false)) return false;
  return null;
}

function summaryFeatures(node, featuresByKind) {
  const features = [];
  for (const kind of [...featuresByKind.keys()].sort(compareKinds)) {
    const sourceFeatures = featuresByKind.get(kind);
    if (!sourceFeatures?.length) continue;
    let startAt = sourceFeatures[0].startAt;
    let endAt = sourceFeatures[0].endAt;
    for (const feature of sourceFeatures.slice(1)) {
      if (feature.startAt.valueOf() < startAt.valueOf()) startAt = feature.startAt;
      if (feature.endAt.valueOf() > endAt.valueOf()) endAt = feature.endAt;
    }
    const name = `${SUMMARY_LABEL} · ${node.item?.title ?? node.id}`;
    const color = sourceFeatures.find(feature => feature.status?.color)?.status.color;
    const rangeLabel = `${dateOnly(startAt)} → ${dateOnly(endAt)}`;
    features.push({
      id: `summary:${node.id}:${kind}`,
      name,
      startAt: new Date(startAt.valueOf()),
      endAt: new Date(endAt.valueOf()),
      status: { id: `summary-${kind}`, name: SUMMARY_LABEL, color },
      itemId: node.id,
      kind,
      proposed: sourceFeatures.every(feature => feature.proposed === true),
      provisional: provisionalFor(sourceFeatures),
      summary: true,
      synthetic: true,
      summaryLabel: SUMMARY_LABEL,
      rangeLabel,
      sourceCount: sourceFeatures.length,
    });
  }
  return features;
}

function addFeatureToKind(groups, feature) {
  const values = groups.get(feature.kind) ?? [];
  values.push(feature);
  groups.set(feature.kind, values);
}

function fullDateRange(nodes) {
  const features = nodes.flatMap(node => node.ownFeatures);
  if (!features.length) return null;
  let startAt = features[0].startAt;
  let endAt = features[0].endAt;
  for (const feature of features.slice(1)) {
    if (feature.startAt.valueOf() < startAt.valueOf()) startAt = feature.startAt;
    if (feature.endAt.valueOf() > endAt.valueOf()) endAt = feature.endAt;
  }
  return { startAt: new Date(startAt.valueOf()), endAt: new Date(endAt.valueOf()) };
}

function wouldCreateCycle(node, candidateParent) {
  let current = candidateParent;
  while (current) {
    if (current === node) return true;
    current = current.parent;
  }
  return false;
}

/**
 * Build a visible preorder schedule tree while keeping each parent summary
 * independent of its expansion state. Source items and their schedules are
 * treated as immutable snapshots.
 */
export function buildScheduleTree({ items = [], expandedIds = [], contextualIds = [] } = {}) {
  const sourceItems = Array.isArray(items) ? items : [];
  const expanded = idSet(expandedIds);
  const contextual = idSet(contextualIds);
  const nodesById = new Map();
  const orderedNodes = [];

  for (const item of sourceItems) {
    const id = idOf(item);
    if (!id || nodesById.has(id)) continue;
    const node = {
      id,
      item,
      parent: null,
      children: [],
      ownFeatures: [],
      features: [],
      unscheduled: false,
      hasUnscheduledDescendants: false,
      rollupFeaturesByKind: new Map(),
    };
    nodesById.set(id, node);
    orderedNodes.push(node);
  }

  const roots = [];
  for (const node of orderedNodes) {
    const requestedParentId = parentIdOf(node.item);
    const candidateParent = requestedParentId ? nodesById.get(requestedParentId) : null;
    if (!candidateParent || candidateParent === node || wouldCreateCycle(node, candidateParent)) {
      roots.push(node);
      continue;
    }
    node.parent = candidateParent;
    candidateParent.children.push(node);
  }

  for (const node of orderedNodes) {
    if (!contextual.has(node.id)) node.ownFeatures = ownScheduleFeatures(node.item, node.id);
  }
  const dateRange = fullDateRange(orderedNodes);

  const postorder = [];
  const pending = roots.map(node => ({ node, visited: false })).reverse();
  while (pending.length) {
    const entry = pending.pop();
    if (entry.visited) {
      postorder.push(entry.node);
      continue;
    }
    pending.push({ node: entry.node, visited: true });
    for (let index = entry.node.children.length - 1; index >= 0; index -= 1) {
      pending.push({ node: entry.node.children[index], visited: false });
    }
  }

  for (const node of postorder) {
    const rollup = new Map();
    for (const feature of node.ownFeatures) addFeatureToKind(rollup, feature);
    for (const child of node.children) {
      for (const [kind, childFeatures] of child.rollupFeaturesByKind) {
        const values = rollup.get(kind) ?? [];
        values.push(...childFeatures);
        rollup.set(kind, values);
      }
    }
    node.rollupFeaturesByKind = rollup;
    node.features = node.children.length ? summaryFeatures(node, rollup) : node.ownFeatures;
    node.unscheduled = !contextual.has(node.id) && node.features.length === 0;
    node.hasUnscheduledDescendants = node.children.some(child => child.unscheduled || child.hasUnscheduledDescendants);
    node.summaryPartial = node.features.some(feature => feature.summary) && node.hasUnscheduledDescendants;
    node.row = {
      id: node.id,
      item: node.item,
      depth: 0,
      hasChildren: node.children.length > 0,
      features: node.features,
      summaryLabel: node.features.some(feature => feature.summary) ? SUMMARY_LABEL : null,
      summaryPartial: node.summaryPartial,
      hasUnscheduledDescendants: node.hasUnscheduledDescendants,
      contextual: contextual.has(node.id),
    };
  }

  const rows = [];
  const visible = roots.map(node => ({ node, depth: 0 })).reverse();
  while (visible.length) {
    const { node, depth } = visible.pop();
    rows.push({ ...node.row, depth });
    if (!expanded.has(node.id)) continue;
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      visible.push({ node: node.children[index], depth: depth + 1 });
    }
  }

  return {
    rows,
    dateRange,
    unscheduledItems: orderedNodes.filter(node => node.unscheduled).map(node => node.item),
  };
}
