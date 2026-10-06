import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { repositoryPath } from '../instance/paths.mjs';
import { buildTrackerData } from '../../tracker/viewer/tooling/data.mjs';
import { normalizeData } from '../../tracker/viewer/src/snapshot-normalizer.js';
import {
  coordinationPayloadDigest,
  deliveryReplayIdentity,
  normalizeDeliveryRecords,
  prepareCoordinationRequest,
  resolveCoordinationApproval,
  validateDeliveryRecords,
} from './delivery-records.mjs';
import { normalizeActivityEvidence } from './activity-evidence.mjs';
import { loadTracker } from './model.mjs';
import { fixtureInstance, writeFixtureData } from '../../tests/helpers/fixture-data.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const testTempRoot = resolve(process.env.TMPDIR || tmpdir());

function markdown(data, body) {
  const frontmatter = Object.entries(data).map(([key, value]) => `${key}: ${value}`).join('\n');
  return `---\n${frontmatter}\n---\n${body}\n`;
}

function syntheticSourceRecords(t) {
  mkdirSync(testTempRoot, { recursive: true });
  const dataRepo = mkdtempSync(join(testTempRoot, 'delivery-source-'));
  const instance = fixtureInstance({
    id: 'delivery-source',
    folderPath: 'site-data',
    evidenceKind: 'grok-bot-v1',
  });
  const fixtureData = writeFixtureData({ repositoryPath: dataRepo, instance, mode: 'populated' });
  t.after(() => {
    fixtureData.cleanup();
    rmSync(dataRepo, { recursive: true, force: true });
  });

  const activityPath = 'tracker/updates/fixture-foundation-task/delivery-activity.md';
  const activityData = {
    id: 'delivery-activity',
    item: 'fixture-foundation-task',
    source: 'synthetic:delivery-activity',
    observed_at: '2026-10-03T00:00:00Z',
    occurred_at: '2026-10-03T00:00:00Z',
    activity_kind: 'work',
    activity_summary: 'Synthetic source-backed delivery activity.',
    attribution_basis: 'task-id',
    evidence_ref: 'grok-bot/inbox/synthetic-bot/fixture-observation.md',
  };
  const activityRepositoryPath = join(dataRepo, repositoryPath(fixtureData.instance, activityPath));
  writeFileSync(activityRepositoryPath, markdown(activityData, '# Synthetic delivery activity\n\nSource-backed fixture activity.'), {
    encoding: 'utf8',
    flag: 'wx',
  });
  const loaded = loadTracker({ dataRepo: fixtureData.dataRepo, instance: fixtureData.instance });
  assert.ok(loaded.items.length > 0, 'populated fixture must contain tasks');
  assert.ok(loaded.people.length > 0, 'populated fixture must contain people');
  assert.ok(loaded.updates.some(update => update.path === activityPath), 'filesystem loader must load source-backed fixture activity');
  return loaded;
}

function record(data, body = '', { path = `tracker/delivery/${data.id}.md`, name = data.id } = {}) {
  return { data, body, path, name };
}

function taskRecord(id = 'sample-task') {
  return { data: { id, type: 'task', owner: 'unassigned' }, path: `tracker/items/product/${id}.md`, name: id };
}

function baseDiscovery(id, item, overrides = {}) {
  return record({
    id,
    type: 'discovery',
    item,
    updated_at: '2026-10-03',
    origin: 'self-initiated',
    observed_executor: '-',
    requested_by: '-',
    source_refs: '-',
    evidence_ids: '-',
    suggested_parent: '-',
    candidate_parents: '-',
    attribution: 'ambiguous',
    priority_decision: '-',
    ...overrides,
  }, '# Discovery\n\n## Observation\n\nA source-backed observation.');
}

function approvedCoordinationFixture({ receiptFields = {} } = {}) {
  const taskId = 'sample-task';
  const recipient = 'don';
  const channel = 'slack';
  const body = 'Please review the verified integration result.';
  const digest = coordinationPayloadDigest({ taskId, recipient, channel, body });
  const dispatchRequest = 'grok-bot/inbox/0000-cos/20261003T120000Z-review.md';
  const deliveryReceipt = 'grok-bot/receipts/0000-cos/20261003T120000Z-review.md';
  const coordination = record({
    id: 'coordinate-sample-task',
    type: 'coordination',
    item: taskId,
    updated_at: '2026-10-03',
    recipient,
    channel,
    approval_decision: 'approve-message',
    request_digest: digest,
    dispatch_request: dispatchRequest,
    delivery_receipt: deliveryReceipt,
    delivery_ref: 'slack:message-123',
    dispatch_state: 'sent',
  }, `# Coordination\n\n## Message\n\n${body}`);
  return {
    digest,
    coordination,
    records: {
      items: [taskRecord(taskId)],
      people: [{ id: 'don', name: 'FixtureDon', status: 'active' }],
      decisions: [{ data: {
        id: 'approve-message',
        state: 'approved',
        approved_by: 'don',
        approved_at: '2026-10-03',
        affects: taskId,
        coordination_digest: digest,
      } }],
      updates: [],
      delivery: [coordination],
      botMessages: [{
        data: { id: '20261003T120000Z-review', to: '0000-cos', from: 'codex', created_at: '2026-10-03T12:00:00Z' },
        body,
        path: dispatchRequest,
        name: '20261003T120000Z-review',
      }],
      botReceipts: [{
        data: {
          id: '20261003T120000Z-review',
          status: 'done',
          updated_at: '2026-10-03T12:05:00Z',
          delivery_state: 'sent',
          request_digest: digest,
          delivery_ref: 'slack:message-123',
          ...receiptFields,
        },
        body: 'Provider sent the approved message.',
        path: deliveryReceipt,
        name: '20261003T120000Z-review',
      }],
    },
  };
}

test('populated fixture loader and snapshot builder preserve source-backed delivery attribution', (t) => {
  const records = syntheticSourceRecords(t);
  const evidence = normalizeActivityEvidence(records).find(entry => entry.included
    && entry.itemId
    && records.items.some(item => item.data.id === entry.itemId && item.data.type === 'task')
    && entry.evidenceRef);
  assert.ok(evidence, 'the current tracker contains source-backed task evidence');
  const observedExecutor = records.people.find(person => person.status === 'active')?.id;
  assert.ok(observedExecutor);
  const discovery = baseDiscovery('discovery-source-backed', evidence.itemId, {
    observed_executor: observedExecutor,
    evidence_ids: evidence.id,
    source_refs: evidence.sourceEventId,
    attribution: 'clear',
    priority_decision: 'review-source-backed',
  });
  const withDelivery = {
    ...records,
    decisions: [...records.decisions, { data: {
      id: 'review-source-backed',
      state: 'proposed',
      owner: 'don',
      affects: evidence.itemId,
      updated_at: '2026-10-03',
    } }],
    delivery: [discovery],
  };
  assert.deepEqual(validateDeliveryRecords(withDelivery), []);

  const snapshot = buildTrackerData(withDelivery);
  assert.equal(snapshot.deliveryRecords.length, 1);
  assert.equal(snapshot.deliveryRecords[0].observedExecutor, observedExecutor);
  assert.equal(snapshot.deliveryRecords[0].itemId, evidence.itemId);
  assert.equal(snapshot.people.some(person => person.id === observedExecutor), true);
});

test('populated fixture metadata and ambiguous or duplicated sources never become person matches', (t) => {
  const records = syntheticSourceRecords(t);
  const evidence = normalizeActivityEvidence(records).find(entry => entry.included && entry.itemId && entry.evidenceRef);
  assert.ok(evidence);
  const personId = records.people.find(person => person.status === 'active').id;
  const ambiguous = baseDiscovery('discovery-ambiguous', evidence.itemId, {
    observed_executor: personId,
    evidence_ids: evidence.id,
    attribution: 'ambiguous',
  });
  const missing = baseDiscovery('discovery-unknown', evidence.itemId, {
    origin: 'unknown',
    observed_executor: '-',
    source_refs: '-',
    evidence_ids: '-',
    attribution: 'ambiguous',
  });
  const duplicate = baseDiscovery('discovery-duplicate-source', evidence.itemId, {
    observed_executor: personId,
    evidence_ids: '-',
    source_refs: evidence.sourceEventId,
    attribution: 'clear',
  });
  const unique = baseDiscovery('discovery-first-source', evidence.itemId, {
    observed_executor: personId,
    evidence_ids: evidence.id,
    source_refs: '-',
    attribution: 'clear',
  });
  const recordsWithDuplicate = { ...records, delivery: [ambiguous, missing, duplicate, unique] };
  const normalized = normalizeDeliveryRecords(recordsWithDuplicate);
  assert.equal(normalized.find(entry => entry.id === ambiguous.data.id).observedExecutor, null);
  assert.equal(normalized.find(entry => entry.id === missing.data.id).observedExecutor, null);
  assert.equal(normalized.find(entry => entry.id === duplicate.data.id).observedExecutor, null);
  assert.equal(normalized.find(entry => entry.id === unique.data.id).observedExecutor, null);
  assert.deepEqual(normalized.find(entry => entry.id === missing.data.id).evidenceIds, []);
});

test('invalid canonical task, person, evidence, decision, and parent references are rejected', () => {
  const discovery = baseDiscovery('discovery-invalid-refs', 'missing-task', {
    observed_executor: 'unknown-person',
    requested_by: 'another-unknown-person',
    evidence_ids: 'missing-task/missing-update',
    suggested_parent: 'missing-parent',
    candidate_parents: 'missing-candidate',
    priority_decision: 'missing-decision',
    attribution: 'clear',
  });
  const issues = validateDeliveryRecords({
    items: [taskRecord()],
    people: [{ id: 'don' }],
    decisions: [],
    updates: [],
    delivery: [discovery],
  }).join('\n');
  assert.match(issues, /canonical task ID/);
  assert.match(issues, /unknown canonical person unknown-person/);
  assert.match(issues, /unknown canonical person another-unknown-person/);
  assert.match(issues, /unknown activity evidence missing-task\/missing-update/);
  assert.match(issues, /unknown canonical task missing-parent/);
  assert.match(issues, /unknown canonical task missing-candidate/);
  assert.match(issues, /unknown decision missing-decision/);
});

test('producer metadata outside the flat delivery contract is rejected', () => {
  const unknownMetadata = baseDiscovery('discovery-unknown-field', 'sample-task');
  unknownMetadata.data.unreviewed = 'true';
  const issues = validateDeliveryRecords({
    items: [taskRecord()],
    people: [{ id: 'don' }],
    decisions: [],
    updates: [],
    delivery: [unknownMetadata],
  }).join('\n');
  assert.match(issues, /unsupported delivery field unreviewed/);
});

test('brief approval requires exact executor binding and next task/actor binding', () => {
  const brief = record({
    id: 'brief-sample-task',
    type: 'brief',
    item: 'sample-task',
    updated_at: '2026-10-03',
    executor_kind: 'human',
    executor_ref: 'don',
    assignment_decision: 'assign-don',
    next_decision: 'next-don',
  }, '# Brief\n\n## Outcome\n\nOutcome.\n\n## Context\n\nContext.\n\n## Completion evidence\n\nEvidence.\n\n## Dependencies\n\nNone.\n\n## Next action\n\nReview.\n\n## Handoff\n\nHandoff.');
  const decisions = [
    { data: { id: 'assign-don', state: 'approved', approved_by: 'don', approved_at: '2026-10-03', affects: 'sample-task', executor_item: 'sample-task', executor_kind: 'human', executor_ref: 'don' } },
    { data: { id: 'next-don', state: 'approved', approved_by: 'don', approved_at: '2026-10-03', affects: 'sample-task', next_item: 'sample-task', next_actor: 'don' } },
  ];
  const records = { items: [taskRecord()], people: [{ id: 'don' }], decisions, delivery: [brief] };
  const normalized = normalizeDeliveryRecords(records)[0];
  assert.equal(normalized.approved, true);
  assert.equal(normalized.nextApproved, true);

  decisions[0].data.executor_ref = 'fixture-unknown-executor';
  decisions[1].data.next_item = 'another-task';
  const rejected = normalizeDeliveryRecords(records)[0];
  assert.equal(rejected.approved, false);
  assert.equal(rejected.nextApproved, false);

  const agentTask = taskRecord();
  agentTask.data.owner = 'FixtureDon Person';
  const agentBrief = record({
    ...brief.data,
    id: 'brief-agent-sample-task',
    executor_kind: 'agent',
    executor_ref: '0000-pm',
    assignment_decision: 'assign-agent',
    next_decision: 'next-dri',
  }, brief.body);
  const agentDecisions = [
    { data: { id: 'assign-agent', state: 'approved', approved_by: 'don', approved_at: '2026-10-03', affects: 'sample-task', executor_item: 'sample-task', executor_kind: 'agent', executor_ref: '0000-pm' } },
    { data: { id: 'next-dri', state: 'approved', approved_by: 'don', approved_at: '2026-10-03', affects: 'sample-task', next_item: 'sample-task', next_actor: 'owner' } },
  ];
  const executorWithDriNext = normalizeDeliveryRecords({
    items: [agentTask],
    people: [{ id: 'don', name: 'FixtureDon', fullName: 'FixtureDon Person', githubHandle: 'owner' }],
    decisions: agentDecisions,
    delivery: [agentBrief],
  })[0];
  assert.equal(executorWithDriNext.approved, true);
  assert.equal(executorWithDriNext.nextApproved, true);
});

test('coordination digest binds exact payload and only exact Don approval resolves', () => {
  const fixture = approvedCoordinationFixture();
  const normalized = normalizeDeliveryRecords(fixture.records)[0];
  assert.equal(normalized.messageApproved, true);
  assert.equal(fixture.records.delivery[0].data.request_digest, fixture.digest);
  assert.notEqual(coordinationPayloadDigest({ taskId: 'sample-task', recipient: 'don', channel: 'slack', body: 'Please review.' }), fixture.digest);
  assert.equal(resolveCoordinationApproval({ record: normalized, decisions: fixture.records.decisions }).approved, true);

  const snapshot = buildTrackerData(fixture.records);
  assert.equal(resolveCoordinationApproval({ record: snapshot.deliveryRecords[0], decisions: snapshot.decisions }).approved, true);

  const decision = fixture.records.decisions[0].data;
  decision.approved_by = 'someone-else';
  assert.equal(normalizeDeliveryRecords(fixture.records)[0].messageApproved, false);
  assert.equal(resolveCoordinationApproval({ record: normalized, decisions: fixture.records.decisions }).approved, false);
});

test('sent coordination needs exact bot dispatch proof beyond a done receipt', () => {
  const fixture = approvedCoordinationFixture({ receiptFields: { delivery_state: undefined, request_digest: undefined, delivery_ref: undefined } });
  const issues = validateDeliveryRecords(fixture.records).join('\n');
  assert.match(issues, /delivery_state must match dispatch_state: sent/);
  assert.match(issues, /request_digest must match the exact coordination payload/);
  assert.match(issues, /valid provider reference matching the receipt/);
});

test('coordination retries block sent and uncertain states and prepare only an approved exact request', () => {
  const fixture = approvedCoordinationFixture();
  const normalized = normalizeDeliveryRecords(fixture.records)[0];
  assert.match(prepareCoordinationRequest({ record: normalized, decisions: fixture.records.decisions }).reason, /already sent/);
  const uncertain = { ...normalized, dispatchState: 'uncertain' };
  assert.match(prepareCoordinationRequest({ record: uncertain, decisions: fixture.records.decisions }).reason, /blind retry is blocked/);

  const draft = { ...normalized, dispatchState: 'draft', deliveryReceipt: null, deliveryRef: null, dispatchRequest: null };
  const prepared = prepareCoordinationRequest({ record: draft, decisions: fixture.records.decisions });
  assert.equal(prepared.ok, true);
  assert.equal(prepared.request.digest, fixture.digest);
  assert.equal(prepared.request.body, 'Please review the verified integration result.');
  const alreadyQueued = { ...draft, dispatchRequest: normalized.dispatchRequest };
  assert.match(prepareCoordinationRequest({ record: alreadyQueued, decisions: fixture.records.decisions }).reason, /reconcile its delivery state/);

  const unresolved = {
    ...fixture.coordination,
    data: { ...fixture.coordination.data, dispatch_state: 'uncertain', delivery_receipt: '-', delivery_ref: '-' },
  };
  assert.deepEqual(validateDeliveryRecords({ ...fixture.records, delivery: [unresolved], botReceipts: [] }), []);
});

test('failed coordination retry needs a matching completed failure receipt and digest', () => {
  const fixture = approvedCoordinationFixture();
  const normalized = normalizeDeliveryRecords(fixture.records)[0];
  const failed = { ...normalized, dispatchState: 'failed', deliveryRef: null };
  assert.equal(prepareCoordinationRequest({ record: failed, decisions: fixture.records.decisions }).ok, false);

  const receipt = {
    ...fixture.records.botReceipts[0],
    data: {
      ...fixture.records.botReceipts[0].data,
      delivery_state: 'failed',
      delivery_ref: undefined,
    },
  };
  const prepared = prepareCoordinationRequest({
    record: failed,
    decisions: fixture.records.decisions,
    botReceipts: [receipt],
    botMessages: fixture.records.botMessages,
  });
  assert.equal(prepared.ok, true);
  assert.equal(prepared.request.id, failed.id);
  assert.equal(prepared.request.dispatchRequest, null);

  assert.equal(prepareCoordinationRequest({
    record: failed,
    decisions: fixture.records.decisions,
    botReceipts: [receipt],
    botMessages: [],
  }).ok, false);
  const crossBotReceipt = {
    ...receipt,
    path: receipt.path.replace('0000-cos', '0000-pm'),
  };
  assert.equal(prepareCoordinationRequest({
    record: { ...failed, deliveryReceipt: crossBotReceipt.path },
    decisions: fixture.records.decisions,
    botReceipts: [crossBotReceipt],
    botMessages: fixture.records.botMessages,
  }).ok, false);
});

test('snapshot normalization never promotes missing or false producer approval flags', () => {
  const decisions = [
    { id: 'priority', state: 'approved', approvedBy: 'don', approvedAt: '2026-10-03', affects: ['sample-task'] },
    { id: 'assignment', state: 'approved', approvedBy: 'don', approvedAt: '2026-10-03', affects: ['sample-task'], executorItem: 'sample-task', executorKind: 'human', executorRef: 'don' },
    { id: 'next', state: 'approved', approvedBy: 'don', approvedAt: '2026-10-03', affects: ['sample-task'], nextItem: 'sample-task', nextActor: 'don' },
    { id: 'message', state: 'approved', approvedBy: 'don', approvedAt: '2026-10-03', affects: ['sample-task'], coordinationDigest: 'a'.repeat(64) },
  ];
  const sourceRecords = [
    { id: 'discovery', type: 'discovery', itemId: 'sample-task', priorityDecision: 'priority', approved: false },
    { id: 'brief', type: 'brief', itemId: 'sample-task', executorKind: 'human', executorRef: 'don', assignmentDecision: 'assignment', nextDecision: 'next', approved: false, nextApproved: false },
    { id: 'coordination', type: 'coordination', itemId: 'sample-task', approvalDecision: 'message', requestDigest: 'a'.repeat(64), messageApproved: false, sections: { message: 'Changed after approval.' } },
  ];
  const rejected = normalizeData({
    items: [{ id: 'sample-task', owner: 'don' }],
      people: [{ id: 'don', name: 'FixtureDon', status: 'active' }],
    decisions,
    deliveryRecords: sourceRecords,
  });
  assert.deepEqual(rejected.deliveryRecords.map(record => [record.approved, record.nextApproved, record.messageApproved]), [
    [false, undefined, undefined],
    [false, false, undefined],
    [undefined, undefined, false],
  ]);

  const missingFlags = normalizeData({
    items: [{ id: 'sample-task', owner: 'don' }],
      people: [{ id: 'don', name: 'FixtureDon', status: 'active' }],
    decisions,
    deliveryRecords: sourceRecords.map(({ approved: _approved, nextApproved: _nextApproved, messageApproved: _messageApproved, ...record }) => record),
  });
  assert.equal(missingFlags.deliveryRecords[0].approved, false);
  assert.equal(missingFlags.deliveryRecords[1].approved, false);
  assert.equal(missingFlags.deliveryRecords[1].nextApproved, false);
  assert.equal(missingFlags.deliveryRecords[2].messageApproved, false);
});

test('replay identities are stable across source order and change with invocation keys', () => {
  const first = deliveryReplayIdentity({ itemId: '-', invocationKey: '2026-10-03', sourceRefs: ['source:b', 'source:a'] });
  const same = deliveryReplayIdentity({ itemId: '-', invocationKey: '2026-10-03', sourceRefs: ['source:a', 'source:b'] });
  const changed = deliveryReplayIdentity({ itemId: '-', invocationKey: '2026-10-04', sourceRefs: ['source:a', 'source:b'] });
  assert.equal(first, same);
  assert.notEqual(first, changed);
});
