import {
  coordinationPayloadDigest,
  deliveryReplayIdentity,
  prepareCoordinationRequest
} from './delivery-records.mjs';

export { coordinationPayloadDigest };

const RECOMMENDATION_ACTIONS = new Set(['continue', 'narrow', 'defer', 'stop']);
const MAX_HANDOFFS = 5;
const MAX_DECISION_GROUPS = 3;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function unique(values) {
  return [...new Set(values.filter(value => typeof value === 'string' && value.length > 0))];
}

function recordValue(record, camel, snake = camel) {
  return record?.[camel] ?? record?.data?.[snake] ?? record?.[snake] ?? null;
}

function sectionText(record, names) {
  for (const name of names) {
    const value = record?.sections?.[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function nonPlaceholder(value) {
  if (typeof value !== 'string') return false;
  return value.trim().length > 0 && !/^(?:-|none|n\/a|unknown)$/i.test(value.trim());
}

function recommendationIssue(value) {
  if (!RECOMMENDATION_ACTIONS.has(value?.action)) return 'recommendation action must be continue, narrow, defer, or stop';
  if (!nonPlaceholder(value?.displacementRationale)) return 'displacement rationale is required';
  if (asArray(value?.sourceRefs).length === 0) return 'at least one source reference is required';
  return null;
}

const PRIORITY_ORDER = new Map([
  ['critical', 0], ['high', 1], ['medium', 2], ['normal', 3], ['low', 4], ['unknown', 5]
]);
const RISK_ORDER = new Map([
  ['critical', 0], ['high', 1], ['medium', 2], ['low', 3], ['none', 4], ['unknown', 5]
]);

function rankingSignal(value, allowed, label) {
  const level = typeof value?.level === 'string' ? value.level.toLowerCase() : 'unknown';
  if (!allowed.has(level)) return { level: 'unknown', sourceRefs: [], rationale: `${label} is unverified.` };
  if (level === 'unknown' || level === 'none') {
    return {
      level,
      sourceRefs: unique(asArray(value?.sourceRefs)),
      rationale: nonPlaceholder(value?.rationale) ? value.rationale.trim() : `${label} is unverified.`
    };
  }
  if (!nonPlaceholder(value?.rationale) || asArray(value?.sourceRefs).length === 0) {
    return { level: 'unknown', sourceRefs: [], rationale: `${label} lacks evidence and remains unknown.` };
  }
  return { level, sourceRefs: unique(asArray(value.sourceRefs)), rationale: value.rationale.trim() };
}

function rankCandidate(candidate, itemById) {
  const item = itemById.get(candidate.taskId) ?? {};
  const priorityValue = item.priority && typeof item.priority === 'object' ? item.priority.value : item.priority;
  const priorityRationale = item.priority && typeof item.priority === 'object'
    ? item.priority.rationale
    : item.priority_rationale;
  const rawPriority = String(priorityValue ?? 'unknown').toLowerCase();
  const priority = PRIORITY_ORDER.has(rawPriority) ? rawPriority : 'unknown';
  const deadlineRisk = rankingSignal(candidate.deadlineRisk, RISK_ORDER, 'Deadline risk');
  const dependencyImpact = rankingSignal(candidate.dependencyImpact, RISK_ORDER, 'Dependency impact');
  const sourceRefs = unique([
    ...asArray(candidate.recommendation?.sourceRefs),
    ...deadlineRisk.sourceRefs,
    ...dependencyImpact.sourceRefs
  ]);
  return {
    ...candidate,
    rank: {
      priority,
      priorityRationale: priority === 'unknown'
        ? 'No recorded product priority; it remains unknown.'
        : String(priorityRationale ?? 'Recorded item priority; no additional rationale recorded.'),
      deadlineRisk,
      dependencyImpact,
      sourceRefs
    },
    _rank: [PRIORITY_ORDER.get(priority), RISK_ORDER.get(deadlineRisk.level), RISK_ORDER.get(dependencyImpact.level)]
  };
}

function compareRanked(a, b) {
  for (let index = 0; index < a._rank.length; index += 1) {
    if (a._rank[index] !== b._rank[index]) return a._rank[index] - b._rank[index];
  }
  return String(a.taskId).localeCompare(String(b.taskId));
}

function openDecision(decision) {
  const state = recordValue(decision, 'state');
  return state === 'proposed';
}

function decisionId(decision) {
  return recordValue(decision, 'id');
}

function decisionAffects(decision) {
  const affects = recordValue(decision, 'affects');
  return Array.isArray(affects) ? affects : typeof affects === 'string' ? affects.split(',').map(value => value.trim()) : [];
}

function pendingForDeliveryRecord(record, taskScope) {
  const id = recordValue(record, 'id');
  const type = recordValue(record, 'type');
  const itemId = recordValue(record, 'itemId', 'item');
  let action = null;
  let rank = 10;

  if (type === 'coordination') {
    const state = recordValue(record, 'dispatchState', 'dispatch_state');
    if (state === 'uncertain') {
      rank = 0;
      action = 'read back the owning receipt and provider state before considering any retry';
    } else if (state === 'draft') {
      rank = 1;
      action = recordValue(record, 'messageApproved', 'message_approved') === true
        ? 'prepare the exact approved request for the owning Grok Bot queue'
        : 'keep the exact message as a draft until Don approves its task, recipient, channel, and body';
    } else if (state === 'failed') {
      rank = 2;
      action = 'review the failed request and receipt before preparing another approved request';
    }
  } else if (type === 'brief' && recordValue(record, 'nextApproved', 'next_approved') !== true) {
    rank = 3;
    action = 'resolve the exact task and actor decision before treating the next action as approved';
  } else if (type === 'discovery' && !recordValue(record, 'priorityDecision', 'priority_decision')) {
    rank = 4;
    action = 'triage the source-backed discovery as queued, unassigned draft intake';
  } else if (type === 'cycle') {
    const unresolved = sectionText(record, ['unresolvedActions', 'unresolved actions', 'unresolved']);
    if (unresolved && !/^(?:-|none|no unresolved actions)$/i.test(unresolved)) {
      rank = 5;
      action = unresolved;
    }
  }

  if (!action) return null;
  return {
    id,
    type,
    itemId,
    action,
    inScope: !itemId || taskScope.has(itemId),
    rank
  };
}

function validatePacket(packet, { scopedIds, taskIds, decisionsById }) {
  if (!packet || typeof packet !== 'object') return 'decision packet is not an object';
  const ids = unique(asArray(packet.taskIds));
  if (ids.length === 0) return 'decision packet must identify at least one task';
  if (ids.some(id => !taskIds.has(id))) return 'decision packet references an unknown task';
  if (ids.some(id => !scopedIds.has(id))) return 'decision packet falls outside the requested scope';

  const referencedDecisions = unique(asArray(packet.decisionIds));
  if (referencedDecisions.length === 0) return 'decision packet must link an unresolved decision';
  for (const id of referencedDecisions) {
    const decision = decisionsById.get(id);
    if (!decision || !openDecision(decision)) return `decision ${id} is not an existing proposed decision`;
    if (!decisionAffects(decision).some(affectedId => ids.includes(affectedId))) {
      return `decision ${id} does not affect a task in this packet`;
    }
  }
  if (!nonPlaceholder(packet.outcome)) return 'decision packet outcome is required';
  if (asArray(packet.requestedChanges).filter(nonPlaceholder).length === 0) return 'exact requested changes are required';
  return recommendationIssue(packet.recommendation);
}

function validateHandoff(candidate, { scopedIds, taskIds, projection, deliveryRecords }) {
  if (!candidate || typeof candidate !== 'object') return 'handoff candidate is not an object';
  const id = candidate.taskId;
  if (!taskIds.has(id)) return 'handoff references an unknown task';
  if (!scopedIds.has(id)) return 'handoff falls outside the requested scope';

  const projected = projection?.byId instanceof Map ? projection.byId.get(id) : projection?.byId?.[id];
  if (!projected) return 'task has no current manager projection';
  if (!projected.briefId) return 'task has no actionable brief';
  if (candidate.briefId && candidate.briefId !== projected.briefId) return 'handoff brief does not match the current projection';
  const brief = deliveryRecords.find(record => record?.type === 'brief' && record.id === projected.briefId && record.itemId === id);
  if (!brief) return 'the projected brief record is missing';
  if (!['human', 'agent', 'codex-handoff'].includes(brief.executorKind)) return 'brief needs an explicit human, agent, or Codex proposed executor';
  if (!nonPlaceholder(brief.executorRef)) return 'brief needs an explicit proposed executor reference';
  for (const [section, label] of [
    ['outcome', 'outcome'], ['context', 'context'], ['completion evidence', 'completion evidence'],
    ['dependencies', 'dependency state'], ['next action', 'next action'], ['handoff', 'handoff content']
  ]) {
    if (!nonPlaceholder(brief.sections?.[section])) return `brief is missing required ${label}`;
  }
  return recommendationIssue(candidate.recommendation);
}

/**
 * Build a read-only cycle plan from tracker records and manager review candidates.
 * Scope defaults to all unfinished tasks; pending approvals and delivery outcomes
 * remain visible even when a user narrows the task list.
 */
export function planLetsWorkCycle({
  items = [],
  deliveryRecords = [],
  decisions = [],
  managerProjection,
  invocationKey,
  sourceRefs = [],
  scopeTaskIds,
  handoffCandidates = [],
  decisionPackets = [],
  urgentExceptions = []
} = {}) {
  if (!nonPlaceholder(invocationKey)) {
    throw new TypeError('a stable invocationKey is required for cycle replay safety');
  }
  const cycleId = `cycle-${deliveryReplayIdentity({ type: 'cycle', itemId: '-', invocationKey, sourceRefs })}`;
  const existingCycle = asArray(deliveryRecords).find(record => record?.type === 'cycle' && record.id === cycleId);
  const activeTasks = asArray(items)
    .map(item => item?.data && typeof item.data === 'object' ? item.data : item)
    .filter(item => item?.type === 'task' && item?.status !== 'done');
  const taskIds = new Set(activeTasks.map(item => item.id).filter(Boolean));
  const itemById = new Map(activeTasks.map(item => [item.id, item]));
  const scopeWasExplicit = scopeTaskIds !== undefined;
  const requestedScope = scopeWasExplicit ? new Set(unique(asArray(scopeTaskIds))) : taskIds;
  const unknownScopeIds = [...requestedScope].filter(id => !taskIds.has(id));
  const scopedIds = new Set([...requestedScope].filter(id => taskIds.has(id)));
  const scopedTaskIds = activeTasks.filter(item => scopedIds.has(item.id)).map(item => item.id);

  const pendingFirst = [
    ...asArray(deliveryRecords).map(record => pendingForDeliveryRecord(record, scopedIds)).filter(Boolean),
    ...asArray(decisions)
      .filter(openDecision)
      .map(decision => ({
        id: decisionId(decision),
        type: 'decision',
        itemId: decisionAffects(decision).find(id => taskIds.has(id)) ?? null,
        action: 'review this proposed decision before preparing a duplicate decision packet',
        inScope: decisionAffects(decision).some(id => scopedIds.has(id)),
        rank: 2
      }))
  ].sort((a, b) => a.rank - b.rank || String(a.id).localeCompare(String(b.id)))
    .filter((entry, index, all) => all.findIndex(candidate => candidate.id === entry.id) === index)
    .map(({ rank, ...entry }) => entry);

  const decisionsById = new Map(asArray(decisions).map(decision => [decisionId(decision), decision]));
  const rejected = [];
  const eligibleHandoffs = [];
  const suppressedByReplay = [];
  for (const candidate of asArray(handoffCandidates)) {
    if (existingCycle) {
      suppressedByReplay.push({ kind: 'handoff', id: candidate?.id ?? null, taskId: candidate?.taskId ?? null });
      continue;
    }
    const issue = validateHandoff(candidate, {
      scopedIds,
      taskIds,
      projection: managerProjection,
      deliveryRecords: asArray(deliveryRecords)
    });
    if (issue) {
      rejected.push({ kind: 'handoff', id: candidate?.id ?? null, taskId: candidate?.taskId ?? null, reason: issue });
    } else if (eligibleHandoffs.some(existing => existing.taskId === candidate.taskId)) {
      rejected.push({ kind: 'handoff', id: candidate.id ?? null, taskId: candidate.taskId, reason: 'a handoff for this task is already in the batch' });
    } else {
      const projected = managerProjection.byId instanceof Map
        ? managerProjection.byId.get(candidate.taskId)
        : managerProjection.byId[candidate.taskId];
      const brief = deliveryRecords.find(record => record?.type === 'brief' && record.id === projected.briefId && record.itemId === candidate.taskId);
      // Next approval controls explicit sequencing, not readiness.
      const readinessWaitReasons = [];
      if (brief.approved !== true) readinessWaitReasons.push('assignment approval is still required');
      const dependencyState = projected.dependencyState ?? 'not-assessed';
      const dependencyIsComplete = ['complete', 'none', 'no-dependencies', 'not-applicable'].includes(String(dependencyState).toLowerCase());
      if (!dependencyIsComplete) readinessWaitReasons.push('dependency state is ' + dependencyState + '; confirm it before execution');
      const readinessReasons = unique([...asArray(projected.reasons), ...readinessWaitReasons]);
      const readiness = readinessWaitReasons.length > 0 ? 'waiting' : projected.readiness ?? 'not-assessed';
      eligibleHandoffs.push({
        ...rankCandidate(candidate, itemById),
        briefId: brief.id,
        executorKind: brief.executorKind,
        executorRef: brief.executorRef,
        assignmentDecision: brief.assignmentDecision,
        nextDecision: brief.nextDecision,
        assignmentApproval: brief.approved === true ? 'approved' : 'needs-don-review',
        nextApproval: brief.nextApproved === true ? 'approved' : 'needs-don-review',
        readiness,
        readinessReasons,
        dependencyState,
        outcome: brief.sections.outcome,
        context: brief.sections.context,
        completionEvidence: brief.sections['completion evidence'],
        dependencies: brief.sections.dependencies,
        nextAction: brief.sections['next action'],
        handoffText: brief.sections.handoff,
        delivery: 'draft',
        sessionLaunched: false
      });
    }
  }

  const eligiblePackets = [];
  for (const packet of asArray(decisionPackets)) {
    if (existingCycle) {
      suppressedByReplay.push({ kind: 'decision-packet', id: packet?.id ?? null, taskIds: unique(asArray(packet?.taskIds)) });
      continue;
    }
    const issue = validatePacket(packet, { scopedIds, taskIds, decisionsById });
    if (issue) {
      rejected.push({ kind: 'decision-packet', id: packet?.id ?? null, taskIds: unique(asArray(packet?.taskIds)), reason: issue });
    } else {
      eligiblePackets.push({ ...packet, approvalState: 'requires-don-review' });
    }
  }

  const orderedHandoffs = eligibleHandoffs.sort(compareRanked);
  const orderedPackets = eligiblePackets.sort((a, b) => {
    const first = rankCandidate({ ...a, taskId: asArray(a.taskIds).slice().sort()[0] }, itemById);
    const second = rankCandidate({ ...b, taskId: asArray(b.taskIds).slice().sort()[0] }, itemById);
    return compareRanked(first, second);
  });
  const selectedHandoffs = orderedHandoffs.slice(0, MAX_HANDOFFS).map(({ _rank, ...candidate }) => candidate);
  const selectedPackets = orderedPackets.slice(0, MAX_DECISION_GROUPS).map(packet => {
    const ranked = rankCandidate({ ...packet, taskId: asArray(packet.taskIds).slice().sort()[0] }, itemById);
    const { _rank, taskId, ...result } = ranked;
    return result;
  });
  const deferredByLimit = [
    ...orderedHandoffs.slice(MAX_HANDOFFS).map(({ _rank, ...candidate }) => ({
      ...candidate,
      kind: 'handoff',
      reason: 'focused-cycle handoff limit reached'
    })),
    ...orderedPackets.slice(MAX_DECISION_GROUPS).map(packet => ({
      ...packet,
      kind: 'decision-packet',
      reason: 'focused-cycle decision limit reached'
    }))
  ];

  const coverage = managerProjection?.coverage ?? [];
  return {
    cycleId,
    invocationKey,
    replayed: Boolean(existingCycle),
    existingCycleId: existingCycle?.id ?? null,
    suppressedByReplay,
    scope: scopeWasExplicit ? 'selected-tasks' : 'all-projects',
    taskIds: scopedTaskIds,
    briefIds: existingCycle?.briefIds ?? selectedHandoffs.map(candidate => candidate.briefId),
    decisionIds: existingCycle?.decisionIds ?? unique(selectedPackets.flatMap(packet => asArray(packet.decisionIds))),
    unknownScopeIds,
    coverage,
    sequence: [
      { kind: 'reconcile-pending', ids: pendingFirst.map(entry => entry.id) },
      { kind: 'prepare-handoffs', ids: selectedHandoffs.map(entry => entry.id ?? entry.taskId) },
      { kind: 'review-decisions', ids: selectedPackets.map(entry => entry.id) }
    ],
    pendingFirst,
    handoffs: selectedHandoffs,
    decisionPackets: selectedPackets,
    questionsPrepared: [],
    urgentExceptions: asArray(urgentExceptions),
    deferredByLimit,
    rejected
  };
}

/**
 * Convert an observed discovery into safe draft-intake defaults. Observed
 * attribution stays separate from owner and never accepts the proposal.
 */
export function buildDiscoveryIntakeProposal(discovery, { items, updates = [], existingDecisions = [], observedAt } = {}) {
  if (!discovery || discovery.type !== 'discovery' || !nonPlaceholder(discovery.id)) {
    throw new TypeError('a normalized discovery record with an id is required');
  }
  const sourceRefs = unique(asArray(discovery.sourceRefs));
  const evidenceIds = unique(asArray(discovery.evidenceIds));
  if (sourceRefs.length === 0 && evidenceIds.length === 0) {
    throw new TypeError('a discovery needs source references or normalized evidence ids');
  }
  const clearAttribution = discovery.attribution === 'clear' && nonPlaceholder(discovery.observedExecutor);
  const itemId = nonPlaceholder(discovery.itemId) ? discovery.itemId : null;
  const sourceIdentityRefs = sourceRefs.length ? sourceRefs.slice().sort() : evidenceIds.slice().sort();
  const replayIdentity = deliveryReplayIdentity({
    type: 'discovery',
    itemId: '-',
    invocationKey: sourceIdentityRefs.join('|'),
    sourceRefs: sourceIdentityRefs
  });
  const proposedTaskId = itemId ?? `intake-${replayIdentity.slice(0, 24)}`;
  const itemIdOf = item => item?.id ?? item?.data?.id ?? null;
  const updateItem = update => update?.itemId ?? update?.item ?? update?.data?.item ?? null;
  const updateSource = update => update?.source ?? update?.data?.source ?? update?.sourceEventId ?? null;
  const canonicalItems = items === undefined ? null : asArray(items);
  const linkedBySource = !itemId
    ? asArray(canonicalItems).filter(item => asArray(item?.linked?.updates).some(update => sourceRefs.includes(updateSource(update))))
    : [];
  const linkedIds = unique(linkedBySource.map(itemIdOf));
  const ambiguousSourceMatch = linkedIds.length > 1;
  const existingCanonical = itemId
    ? canonicalItems === null ? { id: itemId } : canonicalItems.find(item => itemIdOf(item) === itemId)
    : linkedIds.length === 1 ? linkedBySource.find(item => itemIdOf(item) === linkedIds[0]) : null;
  const canonicalTaskId = ambiguousSourceMatch ? null : itemIdOf(existingCanonical) ?? proposedTaskId;
  const canonicalTaskExists = Boolean(existingCanonical);
  const taskDisposition = ambiguousSourceMatch ? 'needs-review' : canonicalTaskExists ? 'reuse' : 'create-draft-intake';
  const matchingUpdates = canonicalTaskId
    ? [...asArray(updates), ...asArray(existingCanonical?.linked?.updates)]
        .filter(update => updateItem(update) === canonicalTaskId && sourceRefs.includes(updateSource(update)))
    : [];
  const sourceUpdateRecords = [];
  const resolvedEvidenceIds = evidenceIds.filter(id => canonicalTaskId && id.startsWith(`${canonicalTaskId}/`));
  if (canonicalTaskId && sourceRefs.length > 0) {
    for (const sourceRef of sourceRefs) {
      const existing = matchingUpdates.find(update => updateSource(update) === sourceRef);
      if (existing) {
        const updateId = existing.id ?? existing.data?.id;
        if (nonPlaceholder(updateId)) resolvedEvidenceIds.push(`${canonicalTaskId}/${updateId}`);
        continue;
      }
      if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/.test(String(observedAt ?? ''))) continue;
      const sourceUpdateIdentity = deliveryReplayIdentity({ type: 'discovery-source', itemId: '-', invocationKey: sourceRef, sourceRefs: [sourceRef] });
      const updateId = `source-${sourceUpdateIdentity.slice(0, 24)}`;
      sourceUpdateRecords.push({
        data: {
          id: updateId, item: canonicalTaskId, source: sourceRef, observed_at: observedAt,
          occurred_at: '-', activity_kind: 'unknown', activity_summary: '-', attribution_basis: '-', evidence_ref: sourceRef
        },
        path: `tracker/updates/${canonicalTaskId}/${updateId}.md`, name: updateId,
        body: '# Observation\n\nA source reference was recorded for untriaged intake; no work outcome was inferred.'
      });
      resolvedEvidenceIds.push(`${canonicalTaskId}/${updateId}`);
    }
  }

  const priorityReviewId = discovery.priorityDecision ?? `priority-review-${replayIdentity.slice(0, 24)}`;
  const existingPriorityReview = asArray(existingDecisions).find(decision => decisionId(decision) === priorityReviewId);
  const decisionOwner = String(recordValue(existingPriorityReview, 'owner') ?? '').toLowerCase();
  const decisionAffectsTask = canonicalTaskId && decisionAffects(existingPriorityReview).includes(canonicalTaskId);
  const validExistingReview = existingPriorityReview
    && ['don', 'owner'].includes(decisionOwner)
    && decisionAffectsTask
    && ['proposed', 'approved'].includes(recordValue(existingPriorityReview, 'state'));
  const priorityReview = !canonicalTaskId || ambiguousSourceMatch
    ? { id: priorityReviewId, reused: false, state: 'blocked', itemId: canonicalTaskId, reason: 'resolve the canonical task match before proposing a task-bound priority review' }
    : existingPriorityReview
      ? validExistingReview
        ? { id: priorityReviewId, reused: true, state: recordValue(existingPriorityReview, 'state'), itemId: canonicalTaskId, owner: recordValue(existingPriorityReview, 'owner') }
        : { id: priorityReviewId, reused: false, state: 'blocked', itemId: canonicalTaskId, reason: 'the linked priority review is missing Don ownership or exact task impact' }
      : {
          id: priorityReviewId,
          type: 'decision',
          state: 'proposed',
          owner: 'don',
          affects: [canonicalTaskId],
          itemId: canonicalTaskId,
          question: 'Should this source-backed discovery receive an explicit product priority?',
          rationale: 'Priority remains unknown until Don records an explicit choice.',
          reused: false,
          decisionRecord: { data: { id: priorityReviewId, state: 'proposed', owner: 'don', affects: canonicalTaskId } }
        };
  const taskProposal = taskDisposition === 'create-draft-intake' && !ambiguousSourceMatch
    ? { id: canonicalTaskId, type: 'task', status: 'queued', owner: 'unassigned', commitment: 'draft', priority: 'unknown', sourceRefs: sourceRefs.slice(), needsTemplateDetails: true }
    : null;
  const proposedDiscovery = canonicalTaskId && !ambiguousSourceMatch && priorityReview.state !== 'blocked'
    ? {
        data: {
          id: discovery.id,
          type: 'discovery',
          item: canonicalTaskId,
          updated_at: discovery.updatedAt,
          origin: ['self-initiated', 'requested', 'unknown'].includes(discovery.origin) ? discovery.origin : 'unknown',
          observed_executor: clearAttribution ? discovery.observedExecutor : '-',
          requested_by: nonPlaceholder(discovery.requestedBy) ? discovery.requestedBy : '-',
          source_refs: sourceRefs.join(', ') || '-',
          evidence_ids: unique(resolvedEvidenceIds).join(', ') || '-',
          suggested_parent: '-',
          candidate_parents: '-',
          attribution: clearAttribution ? 'clear' : 'ambiguous',
          priority_decision: priorityReviewId
        },
        path: discovery.sourcePath ?? `tracker/delivery/discovery/${discovery.id}.md`,
        name: discovery.id,
        body: `# Discovery ${discovery.id}\n\n## Context\n\n${sectionText(discovery, ['context']) ?? 'Source-backed request; details need triage.'}\n\n## Evidence\n\n${sourceRefs.join('\n') || evidenceIds.join('\n')}`
      }
    : null;
  return {
    discoveryId: discovery.id,
    replayIdentity,
    canonicalTaskId,
    taskDisposition,
    taskProposal,
    sourceUpdateRecords,
    sourceEvidenceIds: unique(resolvedEvidenceIds),
    proposedDiscovery,
    priorityDecisionId: priorityReview.state === 'blocked' ? null : priorityReview.id,
    priorityReview,
    suggestedParent: nonPlaceholder(discovery.suggestedParent) ? discovery.suggestedParent : null,
    candidateParents: unique(asArray(discovery.candidateParents)),
    origin: ['self-initiated', 'requested', 'unknown'].includes(discovery.origin) ? discovery.origin : 'unknown',
    observedExecutor: clearAttribution ? discovery.observedExecutor : null,
    requestedBy: nonPlaceholder(discovery.requestedBy) ? discovery.requestedBy : null,
    sourceRefs,
    evidenceIds: unique(resolvedEvidenceIds),
    intakeDefaults: {
      status: 'queued',
      owner: 'unassigned',
      commitment: 'draft',
      accepted: false,
      assignmentApproved: false
    },
    nextAction: 'triage the source-backed discovery before acceptance or assignment'
  };
}

function reflectionVersion(value) {
  const match = /^v?(\d+)$/.exec(String(value ?? ''));
  if (!match) throw new TypeError('reflection version must be an integer or v-prefixed integer');
  return Number(match[1]);
}

function requiredRef(value, label) {
  if (!nonPlaceholder(value)) throw new TypeError(`${label} needs a source reference`);
  return value.trim();
}

/**
 * Build a versioned reflection note. Hypotheses remain separate unless Don's
 * explicit choice names the hypothesis; proposed authority changes are always
 * returned as blocked and never become workflow rules.
 */
export function buildLetsWorkReflection({
  version,
  previousVersion,
  cycleId,
  explicitRules = [],
  hypotheses = [],
  explicitChoices = [],
  requestedAuthorityChanges = []
} = {}) {
  const versionNumber = reflectionVersion(version);
  if (previousVersion !== undefined && versionNumber <= reflectionVersion(previousVersion)) {
    throw new TypeError('reflection version must advance beyond the previous version');
  }

  const rules = asArray(explicitRules).map(rule => ({
    id: requiredRef(rule?.id, 'explicit rule'),
    statement: requiredRef(rule?.statement, 'explicit rule'),
    sourceRef: requiredRef(rule?.sourceRef, 'explicit rule'),
    provenance: 'explicit-user-choice'
  }));
  const remainingHypotheses = new Map(asArray(hypotheses).map(hypothesis => [requiredRef(hypothesis?.id, 'hypothesis'), {
    id: requiredRef(hypothesis?.id, 'hypothesis'),
    statement: requiredRef(hypothesis?.statement, 'hypothesis'),
    evidenceRefs: unique(asArray(hypothesis?.evidenceRefs)),
    provenance: 'hypothesis'
  }]));
  const choices = [];
  for (const choice of asArray(explicitChoices)) {
    const id = requiredRef(choice?.hypothesisId, 'explicit choice');
    if (!['adopt', 'reject'].includes(choice?.choice)) throw new TypeError('explicit choice must be adopt or reject');
    const sourceRef = requiredRef(choice?.sourceRef, 'explicit choice');
    const hypothesis = remainingHypotheses.get(id);
    if (!hypothesis) throw new TypeError(`explicit choice references unknown hypothesis ${id}`);
    choices.push({ hypothesisId: id, choice: choice.choice, sourceRef });
    if (choice.choice === 'adopt') {
      rules.push({
        id,
        statement: hypothesis.statement,
        sourceRef,
        provenance: 'explicit-user-choice',
        adoptedFrom: id
      });
      remainingHypotheses.delete(id);
    } else {
      remainingHypotheses.delete(id);
    }
  }

  const blockedAuthorityChanges = unique(asArray(requestedAuthorityChanges));
  const ruleLines = rules.map(rule => `- ${rule.id}: ${rule.statement} (source: ${rule.sourceRef})`);
  const hypothesisLines = [...remainingHypotheses.values()].map(hypothesis =>
    `- ${hypothesis.id}: ${hypothesis.statement} (evidence: ${hypothesis.evidenceRefs.join(', ') || 'none recorded'})`
  );
  const choiceLines = choices.map(choice => `- Don explicitly chose to ${choice.choice} ${choice.hypothesisId} (source: ${choice.sourceRef})`);
  const blockedLines = blockedAuthorityChanges.map(change => `- Not adopted: ${change}`);
  const body = [
    `# Delivery reflection ${version}`,
    '',
    '## Explicit user rules',
    '',
    ...(ruleLines.length ? ruleLines : ['- No explicit user rule was added in this cycle.']),
    '',
    '## Hypotheses',
    '',
    ...(hypothesisLines.length ? hypothesisLines : ['- No unresolved hypotheses.']),
    '',
    '## Explicit choices',
    '',
    ...(choiceLines.length ? choiceLines : ['- No explicit choice promoted or rejected a hypothesis.']),
    '',
    '## Authority',
    '',
    ...(blockedLines.length ? blockedLines : ['- Existing authority remains unchanged.']),
  ].join('\n');

  return {
    type: 'reflection',
    itemId: null,
    cycleId: nonPlaceholder(cycleId) ? cycleId : null,
    version: `v${versionNumber}`,
    explicitRules: rules,
    hypotheses: [...remainingHypotheses.values()],
    explicitChoices: choices,
    authority: 'unchanged',
    blockedAuthorityChanges,
    body
  };
}

/**
 * Prepare eligible approved coordination requests without sending them. Requests
 * with the same payload digest collapse to one stable record ID. A duplicate sent
 * or uncertain payload blocks all retries until its outcome is reconciled.
 */
export function prepareLetsWorkCoordinationBatch({ deliveryRecords = [], decisions = [], botReceipts = [], botMessages = [] } = {}) {
  const records = asArray(deliveryRecords)
    .filter(record => record?.type === 'coordination')
    .slice()
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const groups = new Map();
  const blocked = [];
  const duplicates = [];

  for (const record of records) {
    const body = record.sections?.message;
    if (typeof body !== 'string' || !body.length) {
      blocked.push({ id: record.id, reason: 'exact coordination message body is missing' });
      continue;
    }
    let digest;
    try {
      digest = coordinationPayloadDigest({
        taskId: record.itemId,
        recipient: record.recipient,
        channel: record.channel,
        body
      });
    } catch (error) {
      blocked.push({ id: record.id, reason: `coordination payload is invalid: ${error.message}` });
      continue;
    }
    const group = groups.get(digest) ?? [];
    group.push({ record, digest });
    groups.set(digest, group);
  }

  const requests = [];
  for (const group of groups.values()) {
    const sent = group.find(({ record }) => record.dispatchState === 'sent');
    const uncertain = group.find(({ record }) => record.dispatchState === 'uncertain');
    if (sent || uncertain) {
      const state = sent ? 'sent' : 'uncertain';
      for (const { record } of group) {
        blocked.push({
          id: record.id,
          reason: state === 'sent'
            ? `matching payload already has a sent record (${sent.record.id}); reconcile its provider receipt before retrying`
            : `matching payload has an uncertain outcome (${uncertain.record.id}); read it back before retrying`
        });
      }
      continue;
    }

    let canonicalRequest = null;
    for (const { record, digest } of group) {
      const prepared = prepareCoordinationRequest({ record, decisions, botReceipts, botMessages });
      if (!prepared.ok) {
        blocked.push({ id: record.id, reason: prepared.reason });
        continue;
      }
      if (prepared.request.digest !== digest) {
        blocked.push({ id: record.id, reason: 'prepared request digest does not match its exact payload' });
        continue;
      }
      if (!canonicalRequest) {
        canonicalRequest = prepared.request;
        requests.push(prepared.request);
      } else {
        duplicates.push({ id: record.id, duplicateOf: canonicalRequest.id, digest });
      }
    }
  }

  return { requests, blocked, duplicates, sent: false };
}
