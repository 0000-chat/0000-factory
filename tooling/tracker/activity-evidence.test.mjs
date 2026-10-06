import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeActivityEvidence, validateActivityEvidence } from './activity-evidence.mjs';
import { validateTracker } from './model.mjs';

const observedAt = '2026-09-30T00:00:00Z';

function update(id, item = 'task-a', fields = {}) {
  const data = {
    id,
    item,
    source: `github:${id}`,
    observed_at: observedAt,
    ...fields
  };
  return { data, path: `tracker/updates/${item}/${id}.md`, name: id, body: '# Observation\n\nSource evidence.' };
}

function amendment(id, fields = {}) {
  return update(id, 'task-a', {
    target_update: 'task-a/update-1',
    activity_action: 'annotate',
    supersedes_update: '-',
    ...fields
  });
}

function item(id) {
  return { data: { id }, path: `tracker/items/product/${id}.md` };
}

function validTask(id) {
  const data = {
    id, type: 'task', status: 'queued', phase: 'discovery', owner: 'unassigned',
    parent: '-', depends_on: '-', commitment: 'draft', updated_at: '2026-09-30',
    target: 'unknown', health_state: 'unknown', health_reason: 'Fixture evidence is missing.',
    missing_information: 'No activity metadata is set.', suggested_action: 'Review the source.',
    suggested_actor: 'don', health_reviewed_at: '-', planned_start: 'unknown', planned_end: 'unknown',
    forecast_start: 'unknown', forecast_end_min: 'unknown', forecast_end_max: 'unknown',
    schedule_provisional: 'unknown', effort_min: 'unknown', effort_max: 'unknown',
    remaining_effort_min: 'unknown', remaining_effort_max: 'unknown', priority: 'unknown',
    priority_rationale: 'No priority is set.'
  };
  return {
    data,
    path: `tracker/items/product/${id}.md`,
    name: id,
    body: `# ${id}\n\n## Outcome\nOutcome.\n\n## Completion condition\nVerified.\n\n## Next step\nReview.\n\n## Evidence\nSource evidence.`
  };
}

function decision(id, affects) {
  return {
    data: {
      id,
      state: 'approved',
      approved_by: 'owner',
      approved_at: '2026-09-30',
      affects
    },
    path: `tracker/decisions/${id}.md`,
    name: id
  };
}

function activityIssues(records) {
  const issues = [];
  validateActivityEvidence(records, issues);
  return issues;
}

test('legacy updates normalize as unknown and never infer occurrence from discovery time', () => {
  const records = { updates: [update('archived-1')] };
  assert.deepEqual(activityIssues(records), []);
  assert.deepEqual(normalizeActivityEvidence(records), [{
    id: 'task-a/archived-1',
    originalItemId: 'task-a',
    originalUpdateId: 'archived-1',
    itemId: 'task-a',
    sourceEventId: 'github:archived-1',
    occurredAt: null,
    discoveredAt: observedAt,
    kind: 'unknown',
    summary: null,
    attributionBasis: null,
    evidenceRef: null,
    included: true,
    amendmentIds: [],
    approvalDecisionIds: []
  }]);
});

test('qualifying activity rejects invalid occurrence time and incomplete or multiline metadata', () => {
  const issues = activityIssues({ updates: [update('bad-activity', 'task-a', {
    occurred_at: '2026-09-31T00:00:00Z',
    activity_kind: 'work',
    activity_summary: 'line one\nline two',
    attribution_basis: 'guess'
  })] });
  assert.match(issues.join('\n'), /occurred_at must be unknown or a valid UTC second/);
  assert.match(issues.join('\n'), /activity_summary must be one line/);
  assert.match(issues.join('\n'), /attribution_basis must be task-id, linked-pr, context, or review/);
  assert.match(issues.join('\n'), /qualifying activity requires a nonempty evidence_ref/);
});

test('tracker validation invokes activity evidence checks for stored update records', () => {
  const validLegacy = {
    items: [validTask('task-a')],
    updates: [update('archived-1')],
    decisions: [],
    history: [],
    errors: []
  };
  assert.deepEqual(validateTracker(validLegacy), []);

  const invalidQualifying = {
    ...validLegacy,
    updates: [update('work-1', 'task-a', { activity_kind: 'work' })]
  };
  assert.match(validateTracker(invalidQualifying).join('\n'), /qualifying activity requires activity_summary/);
});

test('annotation fills unknown source metadata while retaining immutable original identity', () => {
  const original = update('update-1', 'task-a', {
    activity_kind: 'unknown',
    occurred_at: '-',
    activity_summary: '-',
    attribution_basis: '-',
    evidence_ref: '-'
  });
  const before = structuredClone(original);
  const correction = amendment('annotate-1', {
    occurred_at: '2026-09-28T11:42:00Z',
    activity_kind: 'work',
    activity_summary: 'Added the payout retry guard.',
    attribution_basis: 'task-id',
    evidence_ref: 'github:pull/812'
  });
  const records = { items: [item('task-a')], updates: [original, correction], decisions: [] };
  assert.deepEqual(activityIssues(records), []);
  const [event] = normalizeActivityEvidence(records);
  assert.equal(event.id, 'task-a/update-1');
  assert.equal(event.sourceEventId, 'github:update-1');
  assert.equal(event.occurredAt, '2026-09-28T11:42:00Z');
  assert.equal(event.kind, 'work');
  assert.deepEqual(event.amendmentIds, ['annotate-1']);
  assert.deepEqual(original, before);
});

test('annotation cannot contradict source metadata already recorded on the original update', () => {
  const original = update('update-1', 'task-a', {
    activity_kind: 'discussion',
    activity_summary: 'Reviewed the rollout proposal.',
    attribution_basis: 'context',
    evidence_ref: 'github:issue/41'
  });
  const correction = amendment('annotate-1', {
    activity_kind: 'work',
    activity_summary: 'Reviewed the rollout proposal.',
    attribution_basis: 'context',
    evidence_ref: 'github:issue/41'
  });
  const issues = activityIssues({ items: [item('task-a')], updates: [original, correction], decisions: [] });
  assert.match(issues.join('\n'), /annotate cannot contradict existing activity_kind/);
});

test('approved replacement and exclusion form an auditable chain without changing source identity', () => {
  const original = update('update-1', 'task-a', {
    occurred_at: '2026-09-29T10:00:00Z',
    activity_kind: 'result',
    activity_summary: 'Completed the retry integration.',
    attribution_basis: 'linked-pr',
    evidence_ref: 'github:pull/810'
  });
  const before = structuredClone(original);
  const replacement = amendment('replace-1', {
    target_update: 'task-a/update-1',
    activity_action: 'replace',
    occurred_at: '2026-09-28T09:30:00Z',
    activity_kind: 'work',
    activity_summary: 'Implemented the retry integration.',
    attribution_basis: 'linked-pr',
    evidence_ref: 'github:pull/810',
    activity_item: 'task-b',
    approval_decision: 'approve-replacement'
  });
  const exclusion = amendment('exclude-1', {
    target_update: 'task-a/update-1',
    activity_action: 'exclude',
    supersedes_update: 'task-a/replace-1',
    approval_decision: 'approve-exclusion'
  });
  const records = {
    items: [item('task-a'), item('task-b')],
    updates: [original, replacement, exclusion],
    decisions: [decision('approve-replacement', 'task-a, task-b'), decision('approve-exclusion', 'task-a, task-b')]
  };
  assert.deepEqual(activityIssues(records), []);
  const [event] = normalizeActivityEvidence(records);
  assert.equal(event.id, 'task-a/update-1');
  assert.equal(event.originalItemId, 'task-a');
  assert.equal(event.originalUpdateId, 'update-1');
  assert.equal(event.itemId, 'task-b');
  assert.equal(event.sourceEventId, 'github:update-1');
  assert.equal(event.occurredAt, '2026-09-28T09:30:00Z');
  assert.equal(event.included, false);
  assert.deepEqual(event.amendmentIds, ['replace-1', 'exclude-1']);
  assert.deepEqual(event.approvalDecisionIds, ['approve-replacement', 'approve-exclusion']);
  assert.deepEqual(original, before);
});

test('source IDs remain separate across tasks and replayed effective task/source pairs deduplicate', () => {
  const first = update('update-a', 'task-a', { source: 'github:shared-sha' });
  const second = update('update-b', 'task-b', { source: 'github:shared-sha' });
  const independent = normalizeActivityEvidence({ updates: [first, second] });
  assert.equal(independent.length, 2);
  assert.ok(independent.every(event => event.included));

  const move = update('move-b', 'task-b', {
    target_update: 'task-b/update-b',
    activity_action: 'replace',
    supersedes_update: '-',
    occurred_at: '-',
    activity_kind: 'unknown',
    activity_summary: '-',
    attribution_basis: '-',
    evidence_ref: '-',
    activity_item: 'task-a',
    approval_decision: 'approve-move'
  });
  const records = {
    items: [item('task-a'), item('task-b')],
    updates: [first, second, move],
    decisions: [decision('approve-move', 'task-a, task-b')]
  };
  assert.deepEqual(activityIssues(records), []);
  const replayed = normalizeActivityEvidence(records);
  assert.equal(replayed.length, 2);
  assert.deepEqual(replayed.map(event => event.included), [true, false]);
  assert.deepEqual(replayed.map(event => event.sourceEventId), ['github:shared-sha', 'github:shared-sha']);
});

test('amendment resolution rejects cycles and competing roots', () => {
  const original = update('update-1');
  const a = amendment('amend-a', { supersedes_update: 'task-a/amend-b' });
  const b = amendment('amend-b', { supersedes_update: 'task-a/amend-a' });
  const cycleIssues = activityIssues({ items: [item('task-a')], updates: [original, a, b], decisions: [] });
  assert.match(cycleIssues.join('\n'), /amendment chain contains a cycle/);

  const competing = activityIssues({
    items: [item('task-a')],
    updates: [original, amendment('amend-a'), amendment('amend-b')],
    decisions: []
  });
  assert.match(competing.join('\n'), /competing amendment tips/);
});

test('invalid approval, target, and cross-target amendment links fail validation', () => {
  const original = update('update-1');
  const replacement = overrides => amendment('replace-1', {
    activity_action: 'replace',
    occurred_at: '-',
    activity_kind: 'work',
    activity_summary: 'Implemented the retry guard.',
    attribution_basis: 'task-id',
    evidence_ref: 'github:pull/812',
    activity_item: 'task-b',
    approval_decision: 'approval',
    ...overrides
  });
  const cases = [
    {
      name: 'replace with a proposed decision',
      amendments: [replacement()],
      decision: { ...decision('approval', 'task-a, task-b'), data: { ...decision('approval', 'task-a, task-b').data, state: 'proposed' } },
      expected: /approval_decision approval must be approved/
    },
    {
      name: 'replace with a non-Don approver',
      amendments: [replacement()],
      decision: { ...decision('approval', 'task-a, task-b'), data: { ...decision('approval', 'task-a, task-b').data, approved_by: 'alice' } },
      expected: /approval_decision approval must be approved by Don/
    },
    {
      name: 'replace decision omitting the original task',
      amendments: [replacement()],
      decision: decision('approval', 'task-b'),
      expected: /approval_decision approval must affect item task-a/
    },
    {
      name: 'replace decision omitting the effective task',
      amendments: [replacement()],
      decision: decision('approval', 'task-a'),
      expected: /approval_decision approval must affect item task-b/
    },
    {
      name: 'exclude with a proposed decision',
      amendments: [amendment('exclude-1', { activity_action: 'exclude', approval_decision: 'approval' })],
      decision: { ...decision('approval', 'task-a'), data: { ...decision('approval', 'task-a').data, state: 'proposed' } },
      expected: /approval_decision approval must be approved/
    },
    {
      name: 'replacement to an unknown task',
      amendments: [replacement({ activity_item: 'task-z' })],
      decision: decision('approval', 'task-a, task-z'),
      expected: /unknown activity_item task-z/
    },
    {
      name: 'target to a missing original update',
      amendments: [amendment('annotate-1', { target_update: 'task-a/missing-update', occurred_at: observedAt })],
      decision: null,
      expected: /target_update task-a\/missing-update does not reference an original update/
    }
  ];

  for (const scenario of cases) {
    const issues = activityIssues({
      items: [item('task-a'), item('task-b')],
      updates: [original, ...scenario.amendments],
      decisions: scenario.decision ? [scenario.decision] : []
    });
    assert.match(issues.join('\n'), scenario.expected, scenario.name);
  }

  const secondOriginal = update('update-2', 'task-a');
  const firstAnnotation = update('amend-a', 'task-a', {
    target_update: 'task-a/update-1',
    activity_action: 'annotate',
    occurred_at: observedAt
  });
  const foreignAnnotation = update('amend-b', 'task-a', {
    target_update: 'task-a/update-2',
    activity_action: 'annotate',
    supersedes_update: 'task-a/amend-a',
    occurred_at: observedAt
  });
  const crossTargetIssues = activityIssues({
    items: [item('task-a')],
    updates: [original, secondOriginal, firstAnnotation, foreignAnnotation],
    decisions: []
  });
  assert.match(crossTargetIssues.join('\n'), /supersedes_update task-a\/amend-a belongs to a different target/);
});

test('a proposed correction remains unapplied and the tracker validation gate rejects it', () => {
  const original = update('update-1', 'task-a', {
    activity_kind: 'result',
    activity_summary: 'Confirmed the retry behavior.',
    attribution_basis: 'task-id',
    evidence_ref: 'github:pull/811'
  });
  const rejected = amendment('replace-1', {
    activity_action: 'replace',
    occurred_at: '-',
    activity_kind: 'work',
    activity_summary: 'Implemented the retry guard.',
    attribution_basis: 'task-id',
    evidence_ref: 'github:pull/812',
    activity_item: 'task-a',
    approval_decision: 'proposed-correction'
  });
  const records = {
    items: [validTask('task-a')],
    updates: [original, rejected],
    decisions: [{
      ...decision('proposed-correction', 'task-a'),
      data: { ...decision('proposed-correction', 'task-a').data, state: 'proposed' }
    }],
    history: [],
    errors: []
  };
  const normalized = normalizeActivityEvidence(records)[0];
  assert.equal(normalized.kind, 'result');
  assert.equal(normalized.summary, 'Confirmed the retry behavior.');
  assert.deepEqual(normalized.amendmentIds, []);
  assert.match(validateTracker(records).join('\n'), /approval_decision proposed-correction must be approved/);
});
