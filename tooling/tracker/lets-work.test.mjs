import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildTrackerData } from '../../tracker/viewer/tooling/data.mjs';
import { coordinationPayloadDigest, deliveryReplayIdentity, normalizeDeliveryRecords, validateDeliveryRecords } from './delivery-records.mjs';
import { buildDiscoveryIntakeProposal, buildLetsWorkReflection, planLetsWorkCycle, prepareLetsWorkCoordinationBatch } from './lets-work.mjs';

function recommendation(action = 'continue', sourceRef = 'slack:C123/p1') {
  return { action, displacementRationale: 'This review window displaces the lower-evidence follow-up until its source is checked.', sourceRefs: [sourceRef] };
}

function handoff(taskId, fields = {}) {
  return {
    id: `handoff-${taskId}`,
    taskId,
    recommendation: recommendation(fields.action ?? 'continue', fields.sourceRef ?? `slack:${taskId}/p1`),
    deadlineRisk: fields.deadlineRisk,
    dependencyImpact: fields.dependencyImpact
  };
}

function task(id, status = 'active', extra = {}) {
  return { data: { id, type: 'task', status, commitment: 'accepted', owner: 'alice', priority: 'unknown', priority_rationale: 'No priority is recorded.', depends_on: '-', ...extra } };
}

function decision(id, affectedTaskId, state = 'proposed', extra = {}) {
  return { data: {
    id, state, owner: 'owner', approved_by: state === 'approved' ? 'owner' : '-',
    approved_at: state === 'approved' ? '2026-10-03' : '-',
    affects: Array.isArray(affectedTaskId) ? affectedTaskId.join(', ') : affectedTaskId, ...extra
  } };
}

function normalizedBriefFixture(configs) {
  const decisions = [];
  const delivery = [];
  for (const input of configs) {
    const config = typeof input === 'string' ? { itemId: input } : input;
    const { itemId } = config;
    const assignmentId = `assignment-${itemId}`;
    const nextId = `next-${itemId}`;
    const assignmentApproved = config.assignmentApproved !== false;
    const nextApproved = config.nextApproved !== false;
    const executorKind = config.executorKind ?? 'codex-handoff';
    const executorRef = config.executorRef ?? (executorKind === 'human' ? 'alexi' : executorKind === 'unknown' ? '-' : 'codex');
    decisions.push(
      { data: { id: assignmentId, state: assignmentApproved ? 'approved' : 'proposed', owner: 'owner', approved_by: assignmentApproved ? 'owner' : '-', approved_at: assignmentApproved ? '2026-10-03' : '-', affects: itemId, executor_item: itemId, executor_kind: executorKind, executor_ref: executorRef } },
      { data: { id: nextId, state: nextApproved ? 'approved' : 'proposed', owner: 'owner', approved_by: nextApproved ? 'owner' : '-', approved_at: nextApproved ? '2026-10-03' : '-', affects: itemId, next_item: itemId, next_actor: executorRef } }
    );
    const dependencies = config.dependencyText ?? 'State: complete. No unresolved dependency is recorded.';
    delivery.push({
      data: { id: `brief-${itemId}`, type: 'brief', item: itemId, updated_at: '2026-10-03', executor_kind: executorKind, executor_ref: executorRef, assignment_decision: assignmentId, next_decision: nextId },
      path: `tracker/delivery/brief/${itemId}.md`, name: `brief-${itemId}`,
      body: `# ${itemId} handoff\n\n## Outcome\n\nComplete the approved outcome for ${itemId}.\n\n## Context\n\nUse the linked source context and approved task scope.\n\n## Completion evidence\n\nReturn verified evidence tied to the completion condition.\n\n## Dependencies\n\n${dependencies}\n\n## Next action\n\nReview this proposed handoff and confirm the next actor.\n\n## Handoff\n\nReview ${itemId}, complete only the approved scope, and return evidence.\n`
    });
  }
  return { delivery, decisions };
}

function normalizedCoordinationFixture({ id, itemId = 'accepted-task', state = 'draft', body = 'Please review the exact task update.', channel = 'grok-bot:0000-cos', approvalId = `approval-${id}`, approved = true, requestDigestOverride, decisionDigestOverride } = {}) {
  const digest = coordinationPayloadDigest({ taskId: itemId, recipient: 'don', channel, body });
  const botRequestId = state === 'draft' ? null : state === 'failed' ? `20261003T090000Z-${id}-retry` : id;
  const decisionRecords = approved ? [{ data: {
    id: approvalId, state: 'approved', owner: 'owner', approved_by: 'owner', approved_at: '2026-10-03',
    approval_ref: 'codex-chat:01a0fb6d-dee1-78d3-ad98-41767b0bbb3f', approval_source: 'codex-chat', affects: itemId,
    coordination_digest: decisionDigestOverride ?? digest
  } }] : [];
  const raw = {
    data: {
      id, type: 'coordination', item: itemId, updated_at: '2026-10-03', recipient: 'don', channel,
      approval_decision: approved ? approvalId : '-', request_digest: requestDigestOverride ?? digest,
      delivery_receipt: state === 'draft' ? '-' : `grok-bot/receipts/0000-cos/${botRequestId}.md`,
      delivery_ref: state === 'sent' ? `slack:message:${id}` : '-',
      dispatch_request: state === 'draft' ? '-' : `grok-bot/inbox/0000-cos/${botRequestId}.md`, dispatch_state: state
    },
    path: `tracker/delivery/coordination/${id}.md`, name: id,
    body: `# ${id}\n\n## Message\n\n${body}\n`
  };
  const record = normalizeDeliveryRecords({ delivery: [raw], items: [{ data: { id: itemId, type: 'task' } }], people: [], decisions: decisionRecords, updates: [] })[0];
  return { record, decisionRecords, raw, digest };
}

function normalizedProjection(briefs, overrides = {}) {
  return {
    byId: new Map(briefs.map(brief => [brief.itemId, {
      readiness: overrides[brief.itemId]?.readiness ?? 'ready',
      reasons: overrides[brief.itemId]?.reasons ?? [],
      dependencyState: overrides[brief.itemId]?.dependencyState ?? 'complete',
      briefId: brief.id, nextApproved: brief.nextApproved
    }])),
    coverage: [{ personId: 'alice', taskCount: briefs.length }, { personId: null, taskCount: 0 }]
  };
}

function normalizedDiscovery({ id = 'discovery-new', sourceRef = 'slack:C123/p2', itemId = 'business-a' } = {}) {
  const update = itemId ? {
    data: { id: 'activity-123', item: itemId, source: sourceRef, observed_at: '2026-10-03T00:00:00Z', occurred_at: '2026-10-02T23:40:00Z', activity_kind: 'work', activity_summary: 'Raised an additional payout-report workflow.', attribution_basis: 'task-id', evidence_ref: sourceRef },
    path: `tracker/updates/${itemId}/activity-123.md`, body: '# Observation\n\nA source-backed work update.'
  } : null;
  const raw = {
    data: { id, type: 'discovery', item: itemId ?? '-', updated_at: '2026-10-03', origin: 'requested', observed_executor: itemId ? 'alexi' : '-', requested_by: 'owner', source_refs: sourceRef, evidence_ids: itemId ? `${itemId}/activity-123` : '-', suggested_parent: 'project-alpha', candidate_parents: 'project-alpha, 0000-legacy', attribution: itemId ? 'clear' : 'ambiguous', priority_decision: '-' },
    path: `tracker/delivery/discovery/${id}.md`, name: id, body: '# Discovery\n\n## Context\n\nA source-backed requested initiative.'
  };
  const record = normalizeDeliveryRecords({ delivery: [raw], items: itemId ? [{ data: { id: itemId, type: 'task' } }] : [], people: [{ id: 'alexi' }, { id: 'owner' }], decisions: [], updates: update ? [update] : [] })[0];
  return { record, raw, update };
}

test('cycle planning reconciles normalized pending work, ranks evidence, and applies batch limits', () => {
  const candidateTaskIds = ['business-a', 'archived-b', 'ops-c', 'gtm-d', 'platform-e', 'business-f'];
  const tasks = candidateTaskIds.map(id => task(id, 'active', id === 'platform-e'
    ? { priority: { value: 'high', rationale: 'Recorded task priority from the tracker.' } }
    : {}));
  tasks.push(task('waiting-task'), task('finished-task', 'done'));
  const briefFixture = normalizedBriefFixture([...candidateTaskIds, 'waiting-task']);
  const uncertain = normalizedCoordinationFixture({ id: 'coord-uncertain', itemId: 'archived-b', state: 'uncertain', body: 'Check the delivery.' });
  const draft = normalizedCoordinationFixture({ id: 'coord-draft', itemId: 'ops-c', state: 'draft', body: 'Draft only.', approved: false });
  const discovery = normalizedDiscovery({ itemId: 'business-a' }).raw;
  const priorCycle = {
    data: { id: 'cycle-pending', type: 'cycle', item: '-', updated_at: '2026-10-03', scope: 'all-projects', invocation_key: 'run-previous', task_ids: 'business-a', brief_ids: 'brief-business-a', decision_ids: 'decision-pending' },
    path: 'tracker/delivery/cycle/cycle-pending.md', name: 'cycle-pending',
    body: '# Previous cycle\n\n## Unresolved actions\n\nConfirm the previous source gap.\n'
  };
  const pendingDecision = decision('decision-pending', ['business-a', 'archived-b', 'ops-c', 'gtm-d', 'platform-e']);
  const decisions = [...briefFixture.decisions, ...uncertain.decisionRecords, pendingDecision];
  const deliveryRecords = normalizeDeliveryRecords({ delivery: [uncertain.raw, draft.raw, discovery, priorCycle, ...briefFixture.delivery], items: tasks, people: [{ id: 'alexi' }], decisions, updates: [] });
  const briefs = deliveryRecords.filter(record => record.type === 'brief');
  const cycle = planLetsWorkCycle({
    items: tasks,
    deliveryRecords,
    decisions,
    managerProjection: normalizedProjection(briefs),
    invocationKey: 'run-2026-10-03-morning',
    sourceRefs: ['slack:C123/p1'],
    handoffCandidates: [
      handoff('business-a'),
      handoff('archived-b', { deadlineRisk: { level: 'medium', rationale: 'The approved review checkpoint is near.', sourceRefs: ['calendar:event-12'] } }),
      handoff('ops-c', { deadlineRisk: { level: 'high', rationale: 'A source confirms the operational review is due.', sourceRefs: ['mail:message-7'] } }),
      handoff('gtm-d', { deadlineRisk: { level: 'high', rationale: 'A source confirms the launch checkpoint is due.', sourceRefs: ['calendar:event-19'] }, dependencyImpact: { level: 'high', rationale: 'Three scoped tasks depend on this outcome.', sourceRefs: ['tracker:dependency-map'] } }),
      handoff('platform-e'),
      handoff('business-f', { deadlineRisk: { level: 'critical', rationale: 'A verified blocker prevents a customer recovery path.', sourceRefs: ['slack:C456/p9'] } })
    ],
    decisionPackets: ['business-a', 'archived-b', 'ops-c', 'gtm-d'].map((id, index) => ({
      id: `packet-${index + 1}`, taskIds: [id], decisionIds: ['decision-pending'],
      outcome: `Resolve the ${id} decision with evidence.`,
      requestedChanges: [`Record Don's chosen next step for ${id}.`],
      recommendation: recommendation('narrow', `slack:${id}/decision`)
    })),
    urgentExceptions: [{ id: 'urgent-one', reason: 'A live source reports a customer-impacting incident.' }]
  });

  assert.equal(cycle.scope, 'all-projects');
  assert.deepEqual(cycle.taskIds, tasks.filter(item => item.data.status !== 'done').map(item => item.data.id));
  assert.deepEqual(cycle.pendingFirst.map(item => item.id), ['coord-uncertain', 'coord-draft', 'decision-pending', 'discovery-new', 'cycle-pending']);
  assert.deepEqual(cycle.handoffs.map(item => item.taskId), ['platform-e', 'business-f', 'gtm-d', 'ops-c', 'archived-b']);
  assert.equal(cycle.handoffs[0].rank.priority, 'high');
  assert.equal(cycle.handoffs[0].rank.priorityRationale, 'Recorded task priority from the tracker.');
  assert.equal(cycle.handoffs[1].rank.priority, 'unknown');
  assert.equal(cycle.handoffs[1].rank.deadlineRisk.level, 'critical');
  assert.deepEqual(cycle.handoffs.at(-1).rank.deadlineRisk.sourceRefs, ['calendar:event-12']);
  assert.ok(cycle.handoffs.every(item => item.delivery === 'draft' && item.sessionLaunched === false));
  assert.equal(cycle.deferredByLimit.length, 2);
  assert.equal(cycle.decisionPackets.length, 3);
  assert.equal(cycle.questionsPrepared.length, 0);
  assert.equal(cycle.urgentExceptions[0].id, 'urgent-one');
});

test('narrow scope keeps out-of-scope pending decisions visible without widening new work', () => {
  const items = [task('scope-a'), task('scope-b')];
  const briefs = normalizedBriefFixture(['scope-a', 'scope-b']);
  const pendingInScope = decision('decision-in-scope', 'scope-a');
  const pendingOutside = decision('decision-outside-scope', 'scope-b');
  const decisions = [...briefs.decisions, pendingInScope, pendingOutside];
  const records = normalizeDeliveryRecords({ delivery: briefs.delivery, items, people: [], decisions, updates: [] });
  const normalizedBriefs = records.filter(record => record.type === 'brief');
  const cycle = planLetsWorkCycle({
    items,
    deliveryRecords: records,
    decisions,
    managerProjection: normalizedProjection(normalizedBriefs),
    invocationKey: 'narrow-scope-reconcile',
    scopeTaskIds: ['scope-a'],
    handoffCandidates: [handoff('scope-a'), handoff('scope-b')],
    decisionPackets: [
      { id: 'packet-in-scope', taskIds: ['scope-a'], decisionIds: [pendingInScope.data.id], outcome: 'Resolve A.', requestedChanges: ['Record the chosen next step for A.'], recommendation: recommendation() },
      { id: 'packet-outside-scope', taskIds: ['scope-b'], decisionIds: [pendingOutside.data.id], outcome: 'Resolve B.', requestedChanges: ['Record the chosen next step for B.'], recommendation: recommendation() }
    ]
  });

  assert.deepEqual(cycle.taskIds, ['scope-a']);
  assert.deepEqual(cycle.pendingFirst.map(entry => entry.id), ['decision-in-scope', 'decision-outside-scope']);
  assert.equal(cycle.pendingFirst.find(entry => entry.id === 'decision-outside-scope').itemId, 'scope-b');
  assert.equal(cycle.pendingFirst.find(entry => entry.id === 'decision-outside-scope').inScope, false);
  assert.deepEqual(cycle.sequence[0].ids, ['decision-in-scope', 'decision-outside-scope']);
  assert.deepEqual(cycle.handoffs.map(entry => entry.taskId), ['scope-a']);
  assert.deepEqual(cycle.decisionPackets.map(entry => entry.id), ['packet-in-scope']);
  assert.ok(cycle.rejected.some(entry => entry.id === 'packet-outside-scope' && /outside/.test(entry.reason)));
});

test('reviewable handoffs separate assignment readiness from the pending Next designation', () => {
  const items = [task('codex-ready'), task('human-proposed'), task('unsequenced'), task('unknown-executor'), task('missing-content')];
  const fixture = normalizedBriefFixture([
    { itemId: 'codex-ready' },
    { itemId: 'human-proposed', executorKind: 'human', executorRef: 'alexi', assignmentApproved: false, nextApproved: false, dependencyText: 'State: incomplete. Wait for the linked upstream task.' },
    { itemId: 'unsequenced', assignmentApproved: true, nextApproved: false },
    { itemId: 'unknown-executor', executorKind: 'unknown', executorRef: '-' },
    { itemId: 'missing-content' }
  ]);
  fixture.delivery.find(record => record.data.item === 'missing-content').body = '# Missing\n\n## Outcome\n\nOutcome.\n\n## Context\n\nContext.\n\n## Completion evidence\n\nEvidence.\n\n## Next action\n\nNext.\n\n## Handoff\n\nHandoff.\n';
  const records = normalizeDeliveryRecords({ delivery: fixture.delivery, items, people: [{ id: 'alexi' }], decisions: fixture.decisions, updates: [] });
  const briefs = records.filter(record => record.type === 'brief');
  const cycle = planLetsWorkCycle({
    items, deliveryRecords: records, decisions: fixture.decisions,
    managerProjection: normalizedProjection(briefs, { 'human-proposed': { readiness: 'waiting', dependencyState: 'incomplete', reasons: ['upstream task is unfinished'] } }),
    invocationKey: 'run-reviewable-handoff', sourceRefs: ['tracker:brief-review'],
    handoffCandidates: items.map(item => handoff(item.data.id))
  });

  assert.deepEqual(cycle.handoffs.map(item => item.taskId), ['codex-ready', 'human-proposed', 'unsequenced']);
  const human = cycle.handoffs.find(item => item.taskId === 'human-proposed');
  assert.equal(human.executorKind, 'human');
  assert.equal(human.executorRef, 'alexi');
  assert.equal(human.assignmentApproval, 'needs-don-review');
  assert.equal(human.nextApproval, 'needs-don-review');
  assert.equal(human.readiness, 'waiting');
  assert.equal(human.dependencyState, 'incomplete');
  assert.ok(human.readinessReasons.includes('upstream task is unfinished'));
  assert.ok(human.readinessReasons.includes('assignment approval is still required'));
  assert.equal(human.sessionLaunched, false);
  const unsequenced = cycle.handoffs.find(item => item.taskId === 'unsequenced');
  assert.equal(unsequenced.assignmentApproval, 'approved');
  assert.equal(unsequenced.nextApproval, 'needs-don-review');
  assert.equal(unsequenced.dependencyState, 'complete');
  assert.equal(unsequenced.readiness, 'ready');
  assert.deepEqual(unsequenced.readinessReasons, []);
  assert.ok(cycle.rejected.some(item => item.taskId === 'unknown-executor' && item.reason.includes('explicit human, agent, or Codex')));
  assert.ok(cycle.rejected.some(item => item.taskId === 'missing-content' && item.reason.includes('dependency state')));
});

test('ranking reads the real tracker snapshot priority shape and keeps unknown priority unknown', () => {
  function trackerItem(id, priority, priorityRationale) {
    return {
      data: {
        id, type: 'task', status: 'active', phase: 'build', owner: 'unassigned', parent: '-', depends_on: '-',
        commitment: 'accepted', updated_at: '2026-10-03', target: 'unknown', health_state: 'unknown',
        health_reason: 'No current evidence is recorded.', missing_information: 'Review source evidence.',
        suggested_action: 'Review the source.', suggested_actor: 'don', health_reviewed_at: '-',
        planned_start: 'unknown', planned_end: 'unknown', forecast_start: 'unknown', forecast_end_min: 'unknown',
        forecast_end_max: 'unknown', schedule_provisional: 'unknown', effort_min: 'unknown', effort_max: 'unknown',
        remaining_effort_min: 'unknown', remaining_effort_max: 'unknown', priority, priority_rationale: priorityRationale
      },
      path: `tracker/items/product/${id}.md`,
      body: `# ${id}\n\n## Outcome\n\nOutcome.\n\n## Completion condition\n\nVerified.\n\n## Next step\n\nReview.\n\n## Evidence\n\nSource evidence.`
    };
  }
  const snapshot = buildTrackerData({ items: [
    trackerItem('priority-high', 'high', 'Explicitly recorded tracker priority.'),
    trackerItem('priority-unknown', 'unknown', 'No priority decision is recorded.')
  ], decisions: [], updates: [] });
  const briefs = normalizedBriefFixture(['priority-high', 'priority-unknown']);
  const normalizedBriefs = normalizeDeliveryRecords({ delivery: briefs.delivery, items: snapshot.items, people: [], decisions: briefs.decisions, updates: [] });
  const cycle = planLetsWorkCycle({
    items: snapshot.items, deliveryRecords: normalizedBriefs, decisions: briefs.decisions,
    managerProjection: normalizedProjection(normalizedBriefs), invocationKey: 'snapshot-priority-check',
    handoffCandidates: [handoff('priority-unknown'), handoff('priority-high')]
  });

  assert.deepEqual(snapshot.items.find(item => item.id === 'priority-high').priority, { value: 'high', rationale: 'Explicitly recorded tracker priority.' });
  assert.deepEqual(cycle.handoffs.map(item => item.taskId), ['priority-high', 'priority-unknown']);
  assert.equal(cycle.handoffs[0].rank.priority, 'high');
  assert.equal(cycle.handoffs[0].rank.priorityRationale, 'Explicitly recorded tracker priority.');
  assert.equal(cycle.handoffs[1].rank.priority, 'unknown');
  assert.match(cycle.handoffs[1].rank.priorityRationale, /remains unknown/);
});

test('a repeated cycle invocation reuses its identity and prepares no duplicate handoffs or questions', () => {
  const items = [task('task-a')];
  const fixture = normalizedBriefFixture(['task-a']);
  const briefRecords = normalizeDeliveryRecords({ delivery: fixture.delivery, items, people: [], decisions: fixture.decisions, updates: [] });
  const invocationKey = 'stable-source-window:2026-10-02';
  const sourceRefs = ['slack:C123/p1', 'github:org/repo@abc123'];
  const cycleId = `cycle-${deliveryReplayIdentity({ type: 'cycle', itemId: '-', invocationKey, sourceRefs })}`;
  const existingCycle = normalizeDeliveryRecords({
    delivery: [{
      data: { id: cycleId, type: 'cycle', item: '-', updated_at: '2026-10-03', scope: 'all-projects', invocation_key: invocationKey, task_ids: 'task-a', brief_ids: 'brief-task-a', decision_ids: '-' },
      path: `tracker/delivery/cycle/${cycleId}.md`,
      body: '# Existing cycle\n\n## Unresolved actions\n\nNo unresolved actions.\n'
    }], items, people: [], decisions: fixture.decisions, updates: []
  });
  const result = planLetsWorkCycle({
    items, deliveryRecords: [...briefRecords, ...existingCycle], decisions: fixture.decisions,
    managerProjection: normalizedProjection(briefRecords), invocationKey, sourceRefs,
    handoffCandidates: [handoff('task-a')],
    decisionPackets: [{ id: 'packet-a', taskIds: ['task-a'], decisionIds: ['proposal-a'], outcome: 'Resolve the question.', requestedChanges: ['Record a choice.'], recommendation: recommendation() }]
  });

  assert.equal(result.cycleId, cycleId);
  assert.equal(result.replayed, true);
  assert.deepEqual(result.handoffs, []);
  assert.deepEqual(result.decisionPackets, []);
  assert.deepEqual(result.questionsPrepared, []);
  assert.deepEqual(result.suppressedByReplay.map(entry => entry.kind), ['handoff', 'decision-packet']);
});

test('discovery intake keeps observed attribution separate and creates or reuses one task-bound priority review', () => {
  const { record, raw, update } = normalizedDiscovery();
  const proposal = buildDiscoveryIntakeProposal(record);
  assert.equal(proposal.observedExecutor, 'alexi');
  assert.equal(proposal.intakeDefaults.status, 'queued');
  assert.equal(proposal.intakeDefaults.owner, 'unassigned');
  assert.equal(proposal.intakeDefaults.commitment, 'draft');
  assert.equal(proposal.intakeDefaults.accepted, false);
  assert.equal(proposal.intakeDefaults.assignmentApproved, false);
  assert.equal(proposal.priorityReview.state, 'proposed');
  assert.equal(proposal.priorityReview.owner, 'don');
  assert.deepEqual(proposal.priorityReview.affects, ['business-a']);
  assert.ok(proposal.priorityDecisionId);

  const replayedRecord = normalizeDeliveryRecords({
    delivery: [{ ...raw, data: { ...raw.data, id: 'discovery-replayed' } }],
    items: [{ data: { id: 'business-a', type: 'task' } }], people: [{ id: 'alexi' }], decisions: [], updates: [update]
  })[0];
  const replayed = buildDiscoveryIntakeProposal(replayedRecord);
  assert.equal(replayed.replayIdentity, proposal.replayIdentity);
  assert.equal(replayed.priorityDecisionId, proposal.priorityDecisionId);

  const existing = decision(proposal.priorityDecisionId, 'business-a');
  const reused = buildDiscoveryIntakeProposal(record, { existingDecisions: [existing] });
  assert.equal(reused.priorityReview.reused, true);
  assert.equal(reused.priorityReview.id, proposal.priorityDecisionId);
  assert.equal(reused.intakeDefaults.accepted, false);
  const unlinked = buildDiscoveryIntakeProposal(normalizedDiscovery({ id: 'unlinked', itemId: null }).record);
  assert.equal(unlinked.taskDisposition, 'create-draft-intake');
  assert.equal(unlinked.priorityReview.state, 'proposed');
  assert.equal(unlinked.priorityReview.owner, 'don');
  assert.deepEqual(unlinked.priorityReview.affects, [unlinked.taskProposal.id]);
});

test('discovery replay upserts one canonical draft task, stable evidence, and one Don priority review through validation', () => {
  const observedAt = '2026-10-03T09:00:00Z';
  const { record } = normalizedDiscovery({ id: 'requested-work', itemId: null });
  const first = buildDiscoveryIntakeProposal(record, { items: [], observedAt });
  assert.equal(first.taskDisposition, 'create-draft-intake');
  assert.equal(first.taskProposal.status, 'queued');
  assert.equal(first.taskProposal.owner, 'unassigned');
  assert.equal(first.taskProposal.commitment, 'draft');
  assert.equal(first.taskProposal.priority, 'unknown');
  assert.equal(first.sourceUpdateRecords.length, 1);
  assert.equal(first.priorityReview.state, 'proposed');
  assert.equal(first.priorityReview.owner, 'don');
  assert.deepEqual(first.priorityReview.affects, [first.taskProposal.id]);
  assert.ok(first.proposedDiscovery);

  const taskId = first.taskProposal.id;
  const taskRecord = {
    data: {
      id: taskId, type: 'task', status: 'queued', phase: 'discovery', owner: 'unassigned', parent: '-', depends_on: '-',
      commitment: 'draft', updated_at: '2026-10-03', target: 'unknown', health_state: 'unknown',
      health_reason: 'This is untriaged requested work.', missing_information: 'Don must review the scope.',
      suggested_action: 'Triage the source-backed request.', suggested_actor: 'don', health_reviewed_at: '-',
      planned_start: 'unknown', planned_end: 'unknown', forecast_start: 'unknown', forecast_end_min: 'unknown',
      forecast_end_max: 'unknown', schedule_provisional: 'unknown', effort_min: 'unknown', effort_max: 'unknown',
      remaining_effort_min: 'unknown', remaining_effort_max: 'unknown', priority: 'unknown',
      priority_rationale: 'No priority decision is recorded.'
    },
    path: 'tracker/items/intake/' + taskId + '.md', name: taskId,
    body: '# Requested work\n\n## Outcome\n\nTriage the requested workflow.\n\n## Completion condition\n\nDon accepts or declines the scoped proposal.\n\n## Next step\n\nReview the linked source.\n\n## Evidence\n\n' + record.sourceRefs[0]
  };
  const reviewRecords = {
    items: [taskRecord],
    people: [{ id: 'owner' }],
    updates: first.sourceUpdateRecords,
    decisions: [first.priorityReview.decisionRecord],
    delivery: [first.proposedDiscovery]
  };
  assert.deepEqual(validateDeliveryRecords(reviewRecords), []);
  const normalized = normalizeDeliveryRecords(reviewRecords);
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].itemId, taskId);
  assert.deepEqual(normalized[0].evidenceIds, first.sourceEvidenceIds);
  assert.equal(normalized[0].priorityDecision, first.priorityDecisionId);
  assert.equal(normalized[0].observedExecutor, null);

  const viewer = buildTrackerData(reviewRecords);
  const canonicalItem = viewer.items.find(item => item.id === taskId);
  assert.equal(canonicalItem.status, 'queued');
  assert.equal(canonicalItem.owner, 'unassigned');
  assert.deepEqual(canonicalItem.priority, { value: null, rationale: 'No priority decision is recorded.' });
  assert.equal(taskRecord.data.priority, 'unknown');
  assert.ok(canonicalItem.linked.updates.some(update => update.source === record.sourceRefs[0]));

  const replay = buildDiscoveryIntakeProposal(normalized[0], {
    items: viewer.items,
    updates: first.sourceUpdateRecords,
    existingDecisions: reviewRecords.decisions,
    observedAt
  });
  assert.equal(replay.replayIdentity, first.replayIdentity);
  assert.equal(replay.canonicalTaskId, taskId);
  assert.equal(replay.taskDisposition, 'reuse');
  assert.equal(replay.taskProposal, null);
  assert.equal(replay.priorityReview.reused, true);
  assert.equal(replay.priorityDecisionId, first.priorityDecisionId);
  assert.equal(replay.sourceUpdateRecords.length, 0);
  assert.deepEqual(replay.sourceEvidenceIds, first.sourceEvidenceIds);
  assert.equal(replay.proposedDiscovery.data.id, first.proposedDiscovery.data.id);

  const replayRecords = {
    ...reviewRecords,
    items: new Map([...reviewRecords.items.map(item => [item.data.id, item]), ...(replay.taskProposal ? [[replay.taskProposal.id, replay.taskProposal]] : [])]).values(),
    updates: new Map([...reviewRecords.updates, ...replay.sourceUpdateRecords].map(update => [update.data.item + '/' + update.data.id, update])).values(),
    decisions: new Map([...reviewRecords.decisions, replay.priorityReview.decisionRecord].filter(Boolean).map(item => [item.data.id, item])).values(),
    delivery: new Map([...reviewRecords.delivery, replay.proposedDiscovery].filter(Boolean).map(item => [item.data.id, item])).values()
  };
  assert.equal([...replayRecords.items].length, 1);
  assert.equal([...replayRecords.updates].length, 1);
  assert.equal([...replayRecords.decisions].length, 1);
  assert.equal([...replayRecords.delivery].length, 1);
  const replayNormalized = {
    ...replayRecords,
    items: [...replayRecords.items], updates: [...replayRecords.updates],
    decisions: [...replayRecords.decisions], delivery: [...replayRecords.delivery]
  };
  assert.deepEqual(validateDeliveryRecords(replayNormalized), []);
});

test('reflection keeps hypotheses separate and requires an explicit sourced choice to promote one', () => {
  const draft = buildLetsWorkReflection({
    version: 'v1', cycleId: 'cycle-a',
    explicitRules: [{ id: 'draft-only-messages', statement: 'Prepare external messages as drafts.', sourceRef: 'codex-chat:01a0fb6d-dee1-78d3-ad98-41767b0bbb3f' }],
    hypotheses: [{ id: 'hypothesis-batching', statement: 'A weekly batch may reduce review overhead.', evidenceRefs: ['cycle:cycle-a'] }],
    requestedAuthorityChanges: ['Allow automatic session launch after handoff approval.']
  });
  assert.equal(draft.version, 'v1');
  assert.equal(draft.hypotheses.length, 1);
  assert.equal(draft.explicitRules.length, 1);
  assert.equal(draft.authority, 'unchanged');
  assert.deepEqual(draft.blockedAuthorityChanges, ['Allow automatic session launch after handoff approval.']);

  const adopted = buildLetsWorkReflection({
    version: 2, previousVersion: 'v1', hypotheses: draft.hypotheses,
    explicitChoices: [{ hypothesisId: 'hypothesis-batching', choice: 'adopt', sourceRef: 'codex-chat:01a0fb6d-dee1-78d3-ad98-41767b0bbb3f' }]
  });
  assert.equal(adopted.version, 'v2');
  assert.equal(adopted.hypotheses.length, 0);
  assert.equal(adopted.explicitRules[0].provenance, 'explicit-user-choice');
  assert.equal(adopted.explicitRules[0].sourceRef, 'codex-chat:01a0fb6d-dee1-78d3-ad98-41767b0bbb3f');
  assert.equal(adopted.authority, 'unchanged');
  assert.throws(() => buildLetsWorkReflection({ version: 'v1', previousVersion: 'v1' }), /advance/);
});

test('coordination preparation requires exact Don approval, binds the body, and collapses duplicate drafts', () => {
  const first = normalizedCoordinationFixture({ id: 'coord-z' });
  const duplicate = normalizedCoordinationFixture({ id: 'coord-a' });
  const result = prepareLetsWorkCoordinationBatch({ deliveryRecords: [first.record, duplicate.record], decisions: [...first.decisionRecords, ...duplicate.decisionRecords] });

  assert.equal(result.sent, false);
  assert.deepEqual(result.requests.map(request => request.id), ['coord-a']);
  assert.deepEqual(result.duplicates, [{ id: 'coord-z', duplicateOf: 'coord-a', digest: first.digest }]);
  assert.deepEqual(result.blocked, []);
  assert.equal(result.requests[0].dispatchRequest, null);

  const noApproval = normalizedCoordinationFixture({ id: 'coord-no-approval', approved: false });
  const withoutApproval = prepareLetsWorkCoordinationBatch({ deliveryRecords: [noApproval.record] });
  assert.equal(withoutApproval.requests.length, 0);
  assert.match(withoutApproval.blocked[0].reason, /approval|approved|decision/i);

  const wrongDigest = normalizedCoordinationFixture({ id: 'coord-wrong-digest', requestDigestOverride: '0'.repeat(64) });
  const mismatched = prepareLetsWorkCoordinationBatch({ deliveryRecords: [wrongDigest.record], decisions: wrongDigest.decisionRecords });
  assert.equal(mismatched.requests.length, 0);
  assert.ok(mismatched.blocked.length > 0);

  const changedBody = normalizeDeliveryRecords({
    delivery: [{ ...first.raw, body: `${first.raw.body}changed\n` }],
    items: [{ data: { id: 'accepted-task', type: 'task' } }], people: [], decisions: first.decisionRecords, updates: []
  })[0];
  const bodyMismatch = prepareLetsWorkCoordinationBatch({ deliveryRecords: [changedBody], decisions: first.decisionRecords });
  assert.equal(bodyMismatch.requests.length, 0);
  assert.match(bodyMismatch.blocked[0].reason, /digest|payload/i);
});

test('sent and uncertain matching payloads require readback and block blind retry', () => {
  const draft = normalizedCoordinationFixture({ id: 'coord-draft' });
  const sent = normalizedCoordinationFixture({ id: 'coord-sent', state: 'sent' });
  const sentResult = prepareLetsWorkCoordinationBatch({ deliveryRecords: [draft.record, sent.record], decisions: [...draft.decisionRecords, ...sent.decisionRecords] });
  assert.equal(sentResult.requests.length, 0);
  assert.equal(sentResult.blocked.length, 2);
  assert.ok(sentResult.blocked.every(item => item.reason.includes('sent record')));

  const uncertain = normalizedCoordinationFixture({ id: 'coord-uncertain', state: 'uncertain' });
  const uncertainResult = prepareLetsWorkCoordinationBatch({ deliveryRecords: [draft.record, uncertain.record], decisions: [...draft.decisionRecords, ...uncertain.decisionRecords] });
  assert.equal(uncertainResult.requests.length, 0);
  assert.ok(uncertainResult.blocked.every(item => item.reason.includes('uncertain outcome')));

  const standalone = prepareLetsWorkCoordinationBatch({ deliveryRecords: [uncertain.record], decisions: uncertain.decisionRecords });
  assert.equal(standalone.requests.length, 0);
  assert.match(standalone.blocked[0].reason, /uncertain|blind retry/i);
});

test('different channels stay separate and failed retry needs a matching owning receipt', () => {
  const slack = normalizedCoordinationFixture({ id: 'coord-slack', channel: 'slack:#team' });
  const email = normalizedCoordinationFixture({ id: 'coord-email', channel: 'email', approvalId: 'approval-email' });
  const separate = prepareLetsWorkCoordinationBatch({ deliveryRecords: [slack.record, email.record], decisions: [...slack.decisionRecords, ...email.decisionRecords] });
  assert.equal(separate.requests.length, 2);
  assert.notEqual(separate.requests[0].digest, separate.requests[1].digest);

  const failed = normalizedCoordinationFixture({ id: 'coord-failed', state: 'failed' });
  const noReceipt = prepareLetsWorkCoordinationBatch({ deliveryRecords: [failed.record], decisions: failed.decisionRecords });
  assert.equal(noReceipt.requests.length, 0);
  const receipt = {
    path: failed.record.deliveryReceipt,
    data: { id: failed.record.deliveryReceipt.split('/').at(-1).replace(/\.md$/, ''), status: 'done', delivery_state: 'failed', request_digest: failed.digest },
    body: '# Failure receipt\n'
  };
  const botMessage = {
    path: failed.record.dispatchRequest,
    data: { id: failed.record.dispatchRequest.split('/').at(-1).replace(/\.md$/, '') },
    body: failed.record.sections.message
  };
  const retry = prepareLetsWorkCoordinationBatch({ deliveryRecords: [failed.record], decisions: failed.decisionRecords, botReceipts: [receipt], botMessages: [botMessage] });
  assert.equal(retry.requests.length, 1);
  assert.equal(retry.sent, false);
  assert.equal(retry.requests[0].id, 'coord-failed');
  assert.equal(retry.requests[0].dispatchRequest, null);
  const wrongReceipt = { ...receipt, data: { ...receipt.data, request_digest: '0'.repeat(64) } };
  const mismatchedReceipt = prepareLetsWorkCoordinationBatch({ deliveryRecords: [failed.record], decisions: failed.decisionRecords, botReceipts: [wrongReceipt], botMessages: [botMessage] });
  assert.equal(mismatchedReceipt.requests.length, 0);
  const wrongBodyMessage = { ...botMessage, body: 'A similar but different message.' };
  const mismatchedMessage = prepareLetsWorkCoordinationBatch({ deliveryRecords: [failed.record], decisions: failed.decisionRecords, botReceipts: [receipt], botMessages: [wrongBodyMessage] });
  assert.equal(mismatchedMessage.requests.length, 0);
});
