const ACTIVITY_KINDS = new Set(['work', 'result', 'decision', 'discussion', 'unknown']);
const QUALIFYING_KINDS = new Set(['work', 'result', 'decision']);
const ATTRIBUTION_BASES = new Set(['task-id', 'linked-pr', 'context', 'review']);
const ACTIVITY_FIELDS = ['occurred_at', 'activity_kind', 'activity_summary', 'attribution_basis', 'evidence_ref'];
const UNKNOWN = new Set(['', '-', 'unknown', 'tbd', 'unset', 'null']);

function dataOf(record) {
  return record?.data && typeof record.data === 'object' ? record.data : record ?? {};
}

function pathOf(record, data = dataOf(record)) {
  return record?.path ?? `tracker/updates/${data.item ?? 'unknown'}/${data.id ?? 'unknown'}.md`;
}

function text(value) {
  if (value === undefined || value === null) return null;
  const valueText = String(value).trim();
  return UNKNOWN.has(valueText.toLowerCase()) ? null : valueText;
}

function hasValue(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function hasMeaningfulValue(value) {
  return text(value) !== null;
}

function isUtcSecond(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value ?? '')) return false;
  const date = new Date(value);
  return !Number.isNaN(date.valueOf()) && date.toISOString().replace('.000Z', 'Z') === value;
}

function reference(value) {
  const parts = typeof value === 'string' ? value.trim().split('/') : [];
  if (parts.length !== 2 || parts.some(part => !part || part === '.' || part === '..')) return null;
  return { itemId: parts[0], updateId: parts[1], key: `${parts[0]}/${parts[1]}` };
}

function recordKey(itemId, updateId) {
  return `${itemId ?? ''}/${updateId ?? ''}`;
}

function isAmendment(data) {
  return data.activity_action !== undefined
    || data.target_update !== undefined
    || data.supersedes_update !== undefined
    || data.approval_decision !== undefined;
}

function issue(issues, path, message) {
  issues?.push(`${path}: ${message}`);
}

function validateActivityFields(data, path, issues, { required = false } = {}) {
  let valid = true;
  const fail = message => {
    issue(issues, path, message);
    valid = false;
  };

  for (const key of ACTIVITY_FIELDS) {
    if (data[key] !== undefined && data[key] !== null && typeof data[key] !== 'string') fail(`${key} must be a scalar string`);
  }

  const occurredAt = text(data.occurred_at);
  if (occurredAt && !isUtcSecond(occurredAt)) fail('occurred_at must be unknown or a valid UTC second');

  const kindValue = text(data.activity_kind);
  const kind = kindValue ?? 'unknown';
  if (kindValue && !ACTIVITY_KINDS.has(kindValue)) fail('activity_kind must be work, result, decision, discussion, or unknown');

  const summary = text(data.activity_summary);
  if (summary && /[\r\n]/.test(summary)) fail('activity_summary must be one line');

  const attributionBasis = text(data.attribution_basis);
  if (attributionBasis && !ATTRIBUTION_BASES.has(attributionBasis)) {
    fail('attribution_basis must be task-id, linked-pr, context, or review');
  }

  if (required && (data.occurred_at === undefined || data.activity_kind === undefined
    || data.activity_summary === undefined || data.attribution_basis === undefined || data.evidence_ref === undefined)) {
    fail('replacement must provide all activity metadata fields');
  }

  if (QUALIFYING_KINDS.has(kind)) {
    if (!summary) fail('qualifying activity requires activity_summary');
    if (!attributionBasis || !ATTRIBUTION_BASES.has(attributionBasis)) fail('qualifying activity requires a valid attribution_basis');
    if (!text(data.evidence_ref)) fail('qualifying activity requires a nonempty evidence_ref');
  }

  return { valid, occurredAt, kind, summary, attributionBasis, evidenceRef: text(data.evidence_ref) };
}

function normalizeOriginal(update, issues) {
  const data = dataOf(update);
  const path = pathOf(update, data);
  if (!text(data.source)) issue(issues, path, 'source must be a nonempty source-event ID');
  const metadata = validateActivityFields(data, path, issues);
  const occurredAt = metadata.occurredAt && isUtcSecond(metadata.occurredAt) ? metadata.occurredAt : null;
  const observedAt = text(data.observed_at);
  const discoveredAt = observedAt && isUtcSecond(observedAt) ? observedAt : null;
  return {
    id: recordKey(data.item, data.id),
    originalItemId: data.item ?? null,
    originalUpdateId: data.id ?? null,
    itemId: data.item ?? null,
    sourceEventId: text(data.source),
    occurredAt,
    discoveredAt,
    kind: metadata.kind,
    summary: metadata.summary,
    attributionBasis: metadata.attributionBasis,
    evidenceRef: metadata.evidenceRef,
    included: true,
    amendmentIds: [],
    approvalDecisionIds: []
  };
}

function addOnce(values, value) {
  if (value && !values.includes(value)) values.push(value);
}

function metadataFromEvent(event) {
  return {
    occurred_at: event.occurredAt,
    activity_kind: event.kind,
    activity_summary: event.summary,
    attribution_basis: event.attributionBasis,
    evidence_ref: event.evidenceRef
  };
}

function checkApproval(amendment, original, current, nextItemId, decisionsById, issues) {
  const data = dataOf(amendment);
  const path = pathOf(amendment, data);
  const decisionId = text(data.approval_decision);
  if (!decisionId) {
    issue(issues, path, `${data.activity_action} amendment requires approval_decision`);
    return null;
  }
  const decision = decisionsById.get(decisionId);
  if (!decision) {
    issue(issues, path, `approval_decision ${decisionId} does not exist`);
    return null;
  }
  const decisionData = dataOf(decision);
  let valid = true;
  if (decisionData.state !== 'approved') {
    issue(issues, path, `approval_decision ${decisionId} must be approved`);
    valid = false;
  }
  if (!['don', 'owner'].includes(String(decisionData.approved_by ?? '').toLowerCase())) {
    issue(issues, path, `approval_decision ${decisionId} must be approved by Don`);
    valid = false;
  }
  const approvedAt = decisionData.approved_at;
  const approvedDate = /^\d{4}-\d{2}-\d{2}$/.test(approvedAt ?? '') ? new Date(`${approvedAt}T00:00:00Z`) : null;
  if (!approvedDate || Number.isNaN(approvedDate.valueOf()) || approvedDate.toISOString().slice(0, 10) !== approvedAt) {
    issue(issues, path, `approval_decision ${decisionId} needs a valid approved_at date`);
    valid = false;
  }
  const affected = Array.isArray(decisionData.affects)
    ? decisionData.affects.map(value => String(value).trim())
    : String(decisionData.affects ?? '').split(',').map(value => value.trim()).filter(Boolean);
  const expected = new Set([original.originalItemId, current.itemId, nextItemId].filter(Boolean));
  for (const itemId of expected) {
    if (!affected.includes(itemId)) {
      issue(issues, path, `approval_decision ${decisionId} must affect item ${itemId}`);
      valid = false;
    }
  }
  return valid ? decisionId : null;
}

function applyAmendment(event, amendment, original, decisionsById, resolvableItemIds, issues) {
  const data = dataOf(amendment);
  const path = pathOf(amendment, data);
  const action = data.activity_action;
  let valid = true;
  const fail = message => {
    issue(issues, path, message);
    valid = false;
  };

  const metadataKeys = ACTIVITY_FIELDS.filter(key => Object.hasOwn(data, key));
  if (action === 'annotate') {
    if (Object.hasOwn(data, 'approval_decision')) fail('annotate amendments do not use approval_decision');
    if (Object.hasOwn(data, 'activity_item')) fail('annotate amendments cannot change activity_item');
    if (!metadataKeys.some(key => hasMeaningfulValue(data[key]))) fail('annotate amendment must add source-verified metadata');
    const patch = validateActivityFields(data, path, issues);
    if (!patch.valid) valid = false;
    for (const key of metadataKeys) {
      const incoming = text(data[key]);
      if (!incoming) continue;
      const existing = metadataFromEvent(event)[key];
      if (existing !== null && existing !== undefined && existing !== 'unknown') {
        fail(existing === incoming
          ? `annotate may only fill absent or unknown ${key}`
          : `annotate cannot contradict existing ${key}`);
      }
    }
    if (!valid) return event;
    const nextData = { ...metadataFromEvent(event) };
    for (const key of metadataKeys) {
      const incoming = text(data[key]);
      if (!incoming) continue;
      nextData[key] = incoming;
    }
    const metadata = validateActivityFields(nextData, path, issues);
    if (!metadata.valid) return event;
    return {
      ...event,
      occurredAt: metadata.occurredAt && isUtcSecond(metadata.occurredAt) ? metadata.occurredAt : null,
      kind: metadata.kind,
      summary: metadata.summary,
      attributionBasis: metadata.attributionBasis,
      evidenceRef: metadata.evidenceRef
    };
  }

  if (action === 'replace') {
    const metadata = validateActivityFields(data, path, issues, { required: true });
    if (!metadata.valid) valid = false;
    const nextItemId = text(data.activity_item);
    if (!nextItemId) fail('replace amendment requires activity_item');
    else if (!resolvableItemIds.has(nextItemId)) fail(`unknown activity_item ${nextItemId}`);
    if (!valid) return event;
    const decisionId = checkApproval(amendment, original, event, nextItemId, decisionsById, issues);
    if (!decisionId) return event;
    addOnce(event.approvalDecisionIds, decisionId);
    return {
      ...event,
      itemId: nextItemId,
      occurredAt: metadata.occurredAt && isUtcSecond(metadata.occurredAt) ? metadata.occurredAt : null,
      kind: metadata.kind,
      summary: metadata.summary,
      attributionBasis: metadata.attributionBasis,
      evidenceRef: metadata.evidenceRef,
      included: true
    };
  }

  if (action === 'exclude') {
    if (metadataKeys.length || Object.hasOwn(data, 'activity_item')) fail('exclude amendments cannot replace activity metadata');
    if (!valid) return event;
    const decisionId = checkApproval(amendment, original, event, event.itemId, decisionsById, issues);
    if (!decisionId) return event;
    addOnce(event.approvalDecisionIds, decisionId);
    return { ...event, included: false };
  }

  return event;
}

function resolveChains(amendments, originalByKey, eventsByKey, decisionsById, resolvableItemIds, issues) {
  const groups = new Map();
  const amendmentByKey = new Map();
  for (const amendment of amendments) {
    const data = dataOf(amendment);
    const path = pathOf(amendment, data);
    if (!text(data.source)) issue(issues, path, 'amendment source must be a nonempty source ID');
    const target = reference(data.target_update);
    if (!target) {
      issue(issues, path, 'target_update must reference item/update-id');
      continue;
    }
    if (target.itemId !== data.item) {
      issue(issues, path, 'target_update must point to the amendment item');
      continue;
    }
    if (!originalByKey.has(target.key)) {
      issue(issues, path, `target_update ${target.key} does not reference an original update`);
      continue;
    }
    if (!['annotate', 'replace', 'exclude'].includes(data.activity_action)) {
      issue(issues, path, 'activity_action must be annotate, replace, or exclude');
      continue;
    }
    const key = recordKey(data.item, data.id);
    if (amendmentByKey.has(key)) issue(issues, path, `duplicate amendment id ${data.id}`);
    else amendmentByKey.set(key, amendment);
    const list = groups.get(target.key) ?? [];
    list.push(amendment);
    groups.set(target.key, list);
  }

  for (const [targetKey, group] of groups) {
    const targetEvent = eventsByKey.get(targetKey);
    const original = originalByKey.get(targetKey);
    const byKey = new Map(group.map(amendment => [recordKey(dataOf(amendment).item, dataOf(amendment).id), amendment]));
    const parentOf = new Map();
    const childrenOf = new Map();
    let structurallyValid = true;
    for (const amendment of group) {
      const data = dataOf(amendment);
      const path = pathOf(amendment, data);
      if (data.supersedes_update === undefined || !hasMeaningfulValue(data.supersedes_update)) {
        parentOf.set(recordKey(data.item, data.id), null);
        continue;
      }
      const parentRef = reference(data.supersedes_update);
      if (!parentRef) {
        issue(issues, path, 'supersedes_update must reference item/amendment-id');
        structurallyValid = false;
        continue;
      }
      const parent = amendmentByKey.get(parentRef.key);
      if (!parent) {
        issue(issues, path, `supersedes_update ${parentRef.key} does not reference an amendment`);
        structurallyValid = false;
        continue;
      }
      if (parentRef.itemId !== data.item || reference(dataOf(parent).target_update)?.key !== targetKey) {
        issue(issues, path, `supersedes_update ${parentRef.key} belongs to a different target`);
        structurallyValid = false;
        continue;
      }
      const key = recordKey(data.item, data.id);
      parentOf.set(key, parentRef.key);
      const children = childrenOf.get(parentRef.key) ?? [];
      children.push(key);
      childrenOf.set(parentRef.key, children);
    }

    for (const [parentKey, children] of childrenOf) {
      if (children.length > 1) {
        issue(issues, pathOf(byKey.get(parentKey), dataOf(byKey.get(parentKey))), 'amendment chain has competing successors');
        structurallyValid = false;
      }
    }
    const roots = [...parentOf.entries()].filter(([, parent]) => parent === null).map(([key]) => key);
    if (roots.length > 1) {
      issue(issues, pathOf(group[0], dataOf(group[0])), `update ${targetKey} has competing amendment tips`);
      structurallyValid = false;
    } else if (roots.length === 0 && group.length) {
      issue(issues, pathOf(group[0], dataOf(group[0])), `update ${targetKey} amendment chain contains a cycle`);
      structurallyValid = false;
    }

    if (!structurallyValid || roots.length !== 1) continue;
    const ordered = [];
    const seen = new Set();
    let cursor = roots[0];
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      ordered.push(byKey.get(cursor));
      cursor = childrenOf.get(cursor)?.[0] ?? null;
    }
    if (seen.size !== group.length) {
      issue(issues, pathOf(group[0], dataOf(group[0])), `update ${targetKey} amendment chain contains a cycle or disconnected amendment`);
      continue;
    }

    let event = targetEvent;
    for (const amendment of ordered) {
      const before = issues.length;
      const nextEvent = applyAmendment(event, amendment, original, decisionsById, resolvableItemIds, issues);
      const data = dataOf(amendment);
      const failed = issues.length > before;
      if (failed) continue;
      event = nextEvent;
      addOnce(event.amendmentIds, data.id);
    }
    eventsByKey.set(targetKey, event);
  }
}

function resolveActivityEvidence(records, issues) {
  issues ??= [];
  const updates = records?.updates ?? [];
  const originals = updates.filter(update => !isAmendment(dataOf(update)));
  const amendments = updates.filter(update => isAmendment(dataOf(update)));
  const originalByKey = new Map();
  const eventsByKey = new Map();
  const normalized = [];

  for (const update of originals) {
    const data = dataOf(update);
    const key = recordKey(data.item, data.id);
    if (originalByKey.has(key)) {
      issue(issues, pathOf(update, data), `duplicate original update id ${data.id}`);
      continue;
    }
    originalByKey.set(key, update);
    const event = normalizeOriginal(update, issues);
    eventsByKey.set(key, event);
    normalized.push(event);
  }

  const decisionsById = new Map();
  for (const decision of records?.decisions ?? []) {
    const id = dataOf(decision).id;
    if (id && !decisionsById.has(id)) decisionsById.set(id, decision);
  }
  const resolvableItemIds = new Set([
    ...(records?.items ?? []).map(record => dataOf(record).id),
    ...(records?.history ?? []).map(record => dataOf(record).id)
  ].filter(Boolean));
  // Unit callers often supply only update and decision records. Their target
  // and replacement IDs remain meaningful, while the full model supplies the
  // item/history set for strict link validation.
  const hasItemCatalog = (records?.items ?? []).length > 0 || (records?.history ?? []).length > 0;
  if (!hasItemCatalog) for (const update of updates) {
    const data = dataOf(update);
    if (data.item) resolvableItemIds.add(data.item);
  }

  resolveChains(amendments, originalByKey, eventsByKey, decisionsById, resolvableItemIds, issues);

  const effective = normalized.map(event => eventsByKey.get(event.id) ?? event);
  const seen = new Set();
  for (const event of effective.sort((a, b) => a.id.localeCompare(b.id))) {
    if (!event.included) continue;
    const sourceKey = `${event.itemId ?? ''}\u0000${event.sourceEventId ?? ''}`;
    if (!event.sourceEventId || !event.itemId) continue;
    if (seen.has(sourceKey)) event.included = false;
    else seen.add(sourceKey);
  }
  return effective;
}

export function normalizeActivityEvidence(records) {
  return resolveActivityEvidence(records, []);
}

export function validateActivityEvidence(records, issues) {
  const target = Array.isArray(issues) ? issues : [];
  const start = target.length;
  resolveActivityEvidence(records, target);
  return target.slice(start);
}
