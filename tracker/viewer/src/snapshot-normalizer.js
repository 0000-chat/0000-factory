import { isAccepted } from './view-model.mjs';

export const DEFAULT_HEALTH = {
  state: 'unknown',
  reason: 'No health assessment recorded.',
  missingInformation: 'Health inputs are incomplete.',
  suggestedAction: 'Review current evidence and record the next step.',
  actor: 'agent',
  reviewedAt: null,
};
export const DEFAULT_PROGRESS = { scoped: false, percent: null, milestones: [], approvedAt: null, evidenceReviewedAt: null };
export const DEFAULT_SCHEDULE = {
  plannedStart: null,
  plannedEnd: null,
  forecastStart: null,
  forecastEndMin: null,
  forecastEndMax: null,
  provisional: false,
  approved: false,
};


export function safeText(value) {
  const text = String(value ?? '').trim();
  return text && text !== '-' ? text : null;
}
export function normalizePlan(raw, index) {
  const plan = raw ?? {};
  const approval = plan.approval && typeof plan.approval === 'object' ? plan.approval : {};
  const sections = plan.sections && typeof plan.sections === 'object' ? plan.sections : {};
  return {
    ...plan,
    id: String(plan.id ?? `plan-${index + 1}`),
    title: String(plan.title ?? plan.id ?? `Plan ${index + 1}`),
    project: safeText(plan.project),
    status: plan.status || (approval.state === 'approved' ? 'Approved' : 'Proposed'),
    approval,
    sections: {
      ...sections,
      objective: sections.objective ?? sections.outcome ?? '',
      rationale: sections.rationale ?? sections['planning rationale'] ?? '',
      changeSummary: sections.changeSummary ?? sections.change_summary ?? sections['change summary'] ?? '',
      tradeoffs: sections.tradeoffs ?? sections.tradeoff ?? '',
      evidence: sections.evidence ?? '',
    },
    taskIds: Array.isArray(plan.taskIds) ? plan.taskIds.map(String) : [],
  };
}
export function normalizeDecision(raw, index) {
  const decision = raw ?? {};
  return {
    ...decision,
    id: String(decision.id ?? `decision-${index + 1}`),
    title: String(decision.title ?? decision.id ?? `Decision ${index + 1}`),
    state: String(decision.state ?? 'unknown'),
    owner: safeText(decision.owner),
    ownerName: safeText(decision.ownerName) ?? safeText(decision.owner),
    updatedAt: safeText(decision.updatedAt),
    approvedBy: safeText(decision.approvedBy),
    approvedAt: safeText(decision.approvedAt),
    approvalTimeUtc: safeText(decision.approvalTimeUtc),
    approvalRef: safeText(decision.approvalRef),
    approvalSource: safeText(decision.approvalSource),
    coordinationDigest: safeText(decision.coordinationDigest ?? decision.coordination_digest),
    executorItem: safeText(decision.executorItem ?? decision.executor_item),
    executorKind: safeText(decision.executorKind ?? decision.executor_kind),
    executorRef: safeText(decision.executorRef ?? decision.executor_ref),
    nextItem: safeText(decision.nextItem ?? decision.next_item),
    nextActor: safeText(decision.nextActor ?? decision.next_actor),
    supersededBy: safeText(decision.supersededBy),
    affects: Array.isArray(decision.affects) ? decision.affects.map(String) : [],
    sourcePath: safeText(decision.sourcePath),
    body: String(decision.body ?? ''),
    sections: decision.sections && typeof decision.sections === 'object' ? decision.sections : {},
  };
}

function normalizePerson(raw) {
  const person = raw && typeof raw === 'object' ? raw : {};
  const aliases = [...new Set((Array.isArray(person.aliases) ? person.aliases : [])
    .map(safeText)
    .filter(alias => alias && !alias.includes('@') && !/^https?:\/\//i.test(alias)))];
  return {
    id: String(person.id ?? ''),
    name: String(person.name ?? person.id ?? ''),
    fullName: safeText(person.fullName),
    status: String(person.status ?? 'inactive'),
    githubHandle: safeText(person.githubHandle),
    avatar: safeText(person.avatar),
    ...(aliases.length ? { aliases } : {}),
  };
}

function values(raw) {
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(',');
  return [...new Set(list.map(value => String(value ?? '').trim()).filter(value => value && value !== '-' && value.toLowerCase() !== 'unknown'))];
}

function isDonApproved(decision) {
  return decision?.state === 'approved'
    && ['don', 'owner'].includes(String(decision.approvedBy ?? '').toLowerCase())
    && Boolean(decision.approvedAt);
}

function affectsItem(decision, itemId) {
  return values(decision?.affects).includes(itemId);
}

function normalizeDeliveryRecord(raw, index, { decisionsById, evidenceById, canonicalPeople, duplicateDiscoveryLinks }) {
  const record = raw && typeof raw === 'object' ? raw : {};
  const sections = record.sections && typeof record.sections === 'object' && Array.isArray(record.sections) === false
    ? Object.fromEntries(Object.entries(record.sections).map(([key, value]) => [key, String(value ?? '')]))
    : {};
  const id = String(record.id ?? `delivery-${index + 1}`);
  const type = String(record.type ?? 'unknown');
  const itemId = safeText(record.itemId ?? record.item);
  const common = {
    id,
    type,
    itemId,
    updatedAt: safeText(record.updatedAt ?? record.updated_at),
    sourcePath: safeText(record.sourcePath ?? record.source_path),
    sections,
  };

  if (type === 'discovery') {
    const evidenceIds = values(record.evidenceIds ?? record.evidence_ids);
    const sourceRefs = values(record.sourceRefs ?? record.source_refs);
    const sourceBacked = evidenceIds.some(evidenceId => {
      const evidence = evidenceById.get(evidenceId);
      if (evidence?.included !== true || evidence.itemId !== itemId || !safeText(evidence.evidenceRef)) return false;
      return !duplicateDiscoveryLinks.has(`${itemId}\u0000evidence:${evidence.id}`)
        && !duplicateDiscoveryLinks.has(`${itemId}\u0000source:${evidence.sourceEventId}`)
        && !duplicateDiscoveryLinks.has(`${itemId}\u0000source:${evidence.evidenceRef}`);
    });
    const observedExecutor = safeText(record.observedExecutor ?? record.observed_executor);
    const priorityDecision = safeText(record.priorityDecision ?? record.priority_decision);
    const decision = decisionsById.get(priorityDecision);
    return {
      ...common,
      origin: safeText(record.origin),
      observedExecutor: record.attribution === 'clear' && sourceBacked && canonicalPeople.has(observedExecutor) ? observedExecutor : null,
      requestedBy: canonicalPeople.has(safeText(record.requestedBy ?? record.requested_by))
        ? safeText(record.requestedBy ?? record.requested_by)
        : null,
      sourceRefs,
      evidenceIds,
      suggestedParent: safeText(record.suggestedParent ?? record.suggested_parent),
      candidateParents: values(record.candidateParents ?? record.candidate_parents),
      attribution: safeText(record.attribution),
      priorityDecision,
      approved: record.approved === true && isDonApproved(decision) && affectsItem(decision, itemId),
    };
  }

  if (type === 'brief') {
    const assignmentDecision = safeText(record.assignmentDecision ?? record.assignment_decision);
    const nextDecision = safeText(record.nextDecision ?? record.next_decision);
    const executorKind = safeText(record.executorKind ?? record.executor_kind);
    const executorRef = safeText(record.executorRef ?? record.executor_ref);
    const assignment = decisionsById.get(assignmentDecision);
    const next = decisionsById.get(nextDecision);
    return {
      ...common,
      executorKind,
      executorRef,
      assignmentDecision,
      nextDecision,
      approved: record.approved === true
        && isDonApproved(assignment)
        && assignment.executorItem === itemId
        && assignment.executorKind === executorKind
        && assignment.executorRef === executorRef
        && affectsItem(assignment, itemId),
      nextApproved: record.nextApproved === true
        && isDonApproved(next)
        && next.nextItem === itemId
        && affectsItem(next, itemId),
    };
  }

  if (type === 'coordination') {
    const approvalDecision = safeText(record.approvalDecision ?? record.approval_decision);
    const requestDigest = safeText(record.requestDigest ?? record.request_digest);
    const decision = decisionsById.get(approvalDecision);
    return {
      ...common,
      recipient: safeText(record.recipient),
      channel: safeText(record.channel),
      approvalDecision,
      requestDigest,
      deliveryReceipt: safeText(record.deliveryReceipt ?? record.delivery_receipt),
      deliveryRef: safeText(record.deliveryRef ?? record.delivery_ref),
      dispatchRequest: safeText(record.dispatchRequest ?? record.dispatch_request),
      dispatchState: safeText(record.dispatchState ?? record.dispatch_state),
      messageApproved: record.messageApproved === true
        && isDonApproved(decision)
        && decision.coordinationDigest === requestDigest
        && affectsItem(decision, itemId),
    };
  }

  if (type === 'cycle') {
    return {
      ...common,
      scope: safeText(record.scope),
      invocationKey: safeText(record.invocationKey ?? record.invocation_key),
      taskIds: values(record.taskIds ?? record.task_ids),
      briefIds: values(record.briefIds ?? record.brief_ids),
      decisionIds: values(record.decisionIds ?? record.decision_ids),
    };
  }

  return {
    ...common,
    cycleId: safeText(record.cycleId ?? record.cycle_id),
    decisionIds: values(record.decisionIds ?? record.decision_ids),
    version: safeText(record.version),
  };
}

function normalizeWorkEvidence(raw) {
  const evidence = raw ?? {};
  return {
    ...evidence,
    id: String(evidence.id ?? ''),
    originalItemId: evidence.originalItemId ?? null,
    originalUpdateId: evidence.originalUpdateId ?? null,
    itemId: evidence.itemId ?? null,
    sourceEventId: evidence.sourceEventId ?? null,
    occurredAt: evidence.occurredAt ?? null,
    discoveredAt: evidence.discoveredAt ?? null,
    kind: evidence.kind ?? 'unknown',
    summary: evidence.summary ?? null,
    attributionBasis: evidence.attributionBasis ?? null,
    evidenceRef: evidence.evidenceRef ?? null,
    included: evidence.included ?? false,
    amendmentIds: evidence.amendmentIds ?? [],
    approvalDecisionIds: evidence.approvalDecisionIds ?? [],
  };
}

/**
 * @param {unknown} payload
 * @returns {import('./snapshot').TrackerSnapshot}
 */
export function normalizeData(payload) {
  const rawItems = Array.isArray(payload?.items) ? payload.items : [];
  const byId = new Map();
  const children = new Map();
  const items = rawItems.map(raw => {
    const item = {
      ...raw,
      id: String(raw?.id ?? ''),
      title: String(raw?.title ?? raw?.id ?? 'Untitled work'),
      childIds: Array.isArray(raw?.childIds) ? raw.childIds.map(String) : [],
      dependsOn: Array.isArray(raw?.dependsOn) ? raw.dependsOn.map(String) : [],
      completed: Boolean(raw?.completed || raw?.status === 'done'),
      commitment: raw?.commitment ?? null,
      plan: raw?.plan ?? null,
      sections: {
        outcome: raw?.sections?.outcome ?? '',
        completionCondition: raw?.sections?.completionCondition ?? '',
        nextStep: raw?.sections?.nextStep ?? '',
        evidence: raw?.sections?.evidence ?? '',
        blocker: raw?.sections?.blocker ?? null,
      },
      progress: raw?.progress && typeof raw.progress === 'object' ? { ...DEFAULT_PROGRESS, ...raw.progress } : DEFAULT_PROGRESS,
      health: raw?.health && typeof raw.health === 'object' ? { ...DEFAULT_HEALTH, ...raw.health } : DEFAULT_HEALTH,
      schedule: raw?.schedule && typeof raw.schedule === 'object' ? { ...DEFAULT_SCHEDULE, ...raw.schedule } : DEFAULT_SCHEDULE,
      effort: raw?.effort ?? null,
      priority: raw?.priority ?? null,
      linked: {
        decisions: raw?.linked?.decisions ?? [],
        releases: raw?.linked?.releases ?? [],
        updates: raw?.linked?.updates ?? [],
      },
      childSummary: raw?.childSummary ?? { done: 0, total: 0 },
      approval: raw?.approval && typeof raw.approval === 'object' ? raw.approval : {},
      acceptance: raw?.acceptance && typeof raw.acceptance === 'object' ? raw.acceptance : {},
      blockers: Array.isArray(raw?.blockers) ? raw.blockers : [],
    };
    byId.set(item.id, item);
    return item;
  });
  for (const item of items) {
    const declaredChildren = item.childIds.filter(id => byId.has(id));
    if (!declaredChildren.length && item.parent && byId.has(item.parent)) {
      const list = children.get(item.parent) ?? [];
      list.push(item.id);
      children.set(item.parent, list);
    }
  }
  for (const item of items) {
    const declared = item.childIds.filter(id => byId.has(id));
    item.childIds = declared.length ? declared : (children.get(item.id) ?? []);
    item.childIds.sort((a, b) => a.localeCompare(b));
    const committedChildren = item.childIds.filter(id => isAccepted(byId.get(id)));
    item.childSummary = {
      done: committedChildren.filter(id => byId.get(id)?.completed).length,
      total: committedChildren.length,
    };
  }
  const roots = items.filter(item => !item.parent || !byId.has(item.parent)).sort((a, b) => a.id.localeCompare(b.id));
  const rootsByBucket = payload?.rootsByBucket ?? { other: roots.map(item => item.id) };
  const activityEvidence = Array.isArray(payload?.activityEvidence) ? payload.activityEvidence.map(normalizeWorkEvidence) : [];
  const decisions = Array.isArray(payload?.decisions) ? payload.decisions.map(normalizeDecision) : [];
  const team = Array.isArray(payload?.team) ? payload.team : [];
  const people = Array.isArray(payload?.people) ? payload.people.map(normalizePerson) : [];
  const decisionsById = new Map(decisions.map(decision => [decision.id, decision]));
  const evidenceById = new Map(activityEvidence.map(evidence => [evidence.id, evidence]));
  const canonicalPeople = new Set(people.map(person => person.id));
  const rawDeliveryRecords = Array.isArray(payload?.deliveryRecords) ? payload.deliveryRecords : [];
  const duplicateDiscoveryLinks = new Set();
  const discoveryLinkCounts = new Map();
  for (const record of rawDeliveryRecords) {
    if (record?.type !== 'discovery') continue;
    const itemId = String(record.itemId ?? record.item ?? '');
    const evidenceIdsForRecord = values(record.evidenceIds ?? record.evidence_ids);
    const sourceRefsForRecord = values(record.sourceRefs ?? record.source_refs);
    const linkedSources = new Set([
      ...evidenceIdsForRecord.map(id => `evidence:${id}`),
      ...sourceRefsForRecord.map(ref => `source:${ref}`),
      ...evidenceIdsForRecord.flatMap(id => {
        const evidence = evidenceById.get(id);
        return evidence ? [`source:${evidence.sourceEventId}`, `source:${evidence.evidenceRef}`] : [];
      }),
    ].filter(value => !value.endsWith(':null') && !value.endsWith(':undefined')));
    for (const source of linkedSources) {
      const key = `${itemId}\u0000${source}`;
      discoveryLinkCounts.set(key, (discoveryLinkCounts.get(key) ?? 0) + 1);
    }
  }
  for (const [key, count] of discoveryLinkCounts) if (count > 1) duplicateDiscoveryLinks.add(key);
  const deliveryRecords = rawDeliveryRecords.map((record, index) => normalizeDeliveryRecord(record, index, {
    decisionsById,
    evidenceById,
    canonicalPeople,
    duplicateDiscoveryLinks,
  }));
  return {
    ...payload,
    schemaVersion: payload?.schemaVersion ?? 4,
    items,
    itemById: byId,
    rootsByBucket,
    bucketOrder: Array.isArray(payload?.bucketOrder) ? payload.bucketOrder : ['product', 'platform', 'operations', 'gtm', 'other'],
    defaultExpanded: Array.isArray(payload?.defaultExpanded) ? payload.defaultExpanded : [],
    activityEvidence,
    deliveryRecords,
    people,
    plans: Array.isArray(payload?.plans) ? payload.plans.map(normalizePlan) : [],
    decisions,
    team,
    history: Array.isArray(payload?.history) ? payload.history : [],
    migrations: Array.isArray(payload?.migrations) ? payload.migrations : [],
    capacities: Array.isArray(payload?.capacities) ? payload.capacities : [],
  };
}

export { normalizeData as normalizeSnapshot };
