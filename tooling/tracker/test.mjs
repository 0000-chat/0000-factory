import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readDataFiles } from '../instance/paths.mjs';
import { acceptanceState, archiveCandidates, loadTracker, validateTracker } from './model.mjs';
import { loadTrackerFromFiles, validateTracker as validateTrackerCore } from './model-core.mjs';
import { extractMarkdownSections, extractMarkdownTitle, scanMarkdownHeadings } from './markdown.mjs';
import { acceptedTaskDigest, canTransitionCommitment, taskApprovalDigest } from './planning.mjs';
import { resolveTaskReference, taskCodeForId, taskCodeIndex } from './task-codes.mjs';
import { renderViews } from './views.mjs';
import { fixtureInstance, writeFixtureData } from '../../tests/helpers/fixture-data.mjs';
import './activity-evidence.test.mjs';
import './delivery-records.test.mjs';
import './lets-work.test.mjs';

const fixtures = [];
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const testTempRoot = resolve(process.env.TMPDIR || tmpdir());
const rootInstance = {
  data: { folderPath: '', evidence: { kind: 'none' } },
  github: { owner: 'synthetic-org', repo: 'synthetic-data', branch: 'main' },
};

afterEach(() => {
  for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true });
});

const BODY = id => `# ${id}

## Outcome

Deliver ${id}.

## Completion condition

The accepted outcome is verified with evidence.

## Next step

Review the next concrete step for ${id}.

## Evidence

Evidence is recorded here.
`;

function baseData(id, overrides = {}) {
  return {
    id,
    type: 'task',
    status: 'queued',
    phase: 'discovery',
    owner: 'unassigned',
    parent: '-',
    depends_on: '-',
    project: '-',
    commitment: 'draft',
    plan: '-',
    updated_at: '2026-09-30',
    target: 'unknown',
    health_state: 'unknown',
    health_reason: 'The fixture has no health evidence yet.',
    missing_information: 'Fixture evidence.',
    suggested_action: 'Review the fixture.',
    suggested_actor: 'don',
    health_reviewed_at: '-',
    planned_start: 'unknown',
    planned_end: 'unknown',
    forecast_start: 'unknown',
    forecast_end_min: 'unknown',
    forecast_end_max: 'unknown',
    schedule_provisional: 'unknown',
    effort_min: 'unknown',
    effort_max: 'unknown',
    remaining_effort_min: 'unknown',
    remaining_effort_max: 'unknown',
    priority: 'unknown',
    priority_rationale: 'No priority is set in this fixture.',
    ...overrides
  };
}

function record(id, overrides = {}, body = BODY(id)) {
  return { data: baseData(id, overrides), body, path: `tracker/items/product/${id}.md`, name: id };
}

function approvedRecord(id, overrides = {}, body = BODY(id)) {
  const item = record(id, {
    revision: 'r1',
    commitment: 'accepted',
    accepted_from: 'planned',
    approval_state: 'approved',
    approved_by: 'owner',
    approved_at: '2026-09-30T00:00:00Z',
    approval_ref: `test:${id}`,
    approved_revision: 'r1',
    reviewed_detail: 'The exact fixture scope was reviewed.',
    approval_source: 'codex-chat',
    approved_parts: 'task',
    ...overrides
  }, body);
  item.data.approval_digest = taskApprovalDigest(item);
  return item;
}

function assignmentApprovedRecord(id, overrides = {}, body = BODY(id)) {
  return approvedRecord(id, {
    commitment: 'planned',
    accepted_from: '-',
    owner: 'alice',
    owner_proposed: 'alice',
    owner_proposal_rationale: 'Alice owns the approved fixture.',
    approved_parts: 'assignment',
    ...overrides
  }, body);
}

function frontmatter(data) {
  return Object.entries(data)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');
}

function fixture() {
  mkdirSync(testTempRoot, { recursive: true });
  const root = mkdtempSync(join(testTempRoot, 'unified-tracker-'));
  fixtures.push(root);
  mkdirSync(join(root, 'tracker/items'), { recursive: true });
  return root;
}

function writeItem(root, item, bucket = 'product') {
  const path = join(root, 'tracker/items', bucket, `${item.data.id}.md`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `---\n${frontmatter(item.data)}\n---\n${item.body}\n`);
  return path;
}

test('task reference codes are stable, searchable, and collision checked', () => {
  const first = 'collision-canonical-13753';
  const second = 'collision-canonical-34460';
  assert.equal(taskCodeForId('fixture-project'), 'T-RTUDWH');
  const baseline = taskCodeIndex([{ data: { id: 'fixture-project', title: 'Original title' } }]);
  const reordered = taskCodeIndex([
    { data: { id: 'synthetic-alpha', title: 'Another task' } },
    { data: { id: 'fixture-project', title: 'Renamed title' } },
  ]);
  assert.equal(baseline.get('T-RTUDWH'), 'fixture-project');
  assert.equal(reordered.get('T-RTUDWH'), 'fixture-project');
  assert.equal(taskCodeForId(first), taskCodeForId(second));
  assert.throws(() => taskCodeIndex([{ id: first }, { id: second }]), /task reference code collision: T-47XGK6/);
  assert.equal(resolveTaskReference('T-rtudwh', [{ id: 'fixture-project' }]), 'fixture-project');
  assert.equal(resolveTaskReference('fixture-project', [{ id: 'fixture-project' }]), 'fixture-project');
});

test('tracker validation reports task reference-code collisions', () => {
  const records = [record('collision-canonical-13753'), record('collision-canonical-34460')];
  assert.match(validateTrackerCore({ items: records }).join('\n'), /task reference code validation failed: task reference code collision: T-47XGK6/);
});

test('the unified loader validates planned and accepted items and renders planned context', () => {
  const root = fixture();
  const plannedParent = record('planned-parent', { type: 'workstream' });
  const acceptedPrerequisite = approvedRecord('accepted-prerequisite', {
    commitment: 'accepted', accepted_from: 'planned',
    owner: 'unassigned'
  });
  const acceptedChild = approvedRecord('accepted-child', {
    commitment: 'accepted', accepted_from: 'planned',
    parent: 'planned-parent',
    depends_on: 'accepted-prerequisite',
    owner: 'unassigned'
  });
  writeItem(root, plannedParent);
  writeItem(root, acceptedPrerequisite);
  writeItem(root, acceptedChild);

  const records = loadTracker({ dataRepo: root, instance: rootInstance });
  assert.deepEqual(validateTracker(records), []);
  assert.equal(records.items.length, 3);
  assert.equal(records.planTasks, undefined);

  const views = renderViews(records);
  assert.match(views['tracker/views/now.md'], /planned-parent.*draft context/);
  assert.match(views['tracker/views/now.md'], /accepted-child/);
  assert.doesNotMatch(views['tracker/views/owners.md'], /planned-parent/);
  assert.match(views['tracker/views/dependencies.md'], /planned-parent.*planned/);
});

test('the filesystem adapter and pure file-map loader share full populated fixture validation', () => {
  const instance = fixtureInstance({ id: 'model-populated', folderPath: 'site-data' });
  mkdirSync(testTempRoot, { recursive: true });
  const dataRepo = mkdtempSync(join(testTempRoot, 'model-adapter-'));
  const fixtureData = writeFixtureData({ repositoryPath: dataRepo, instance, mode: 'populated' });
  try {
    const records = loadTracker({ dataRepo: fixtureData.dataRepo, instance: fixtureData.instance });
    assert.ok(records.items.length > 0, 'populated fixture must load tracker records');
    assert.ok(records.people.length > 0, 'populated fixture must load people');

    const fileMap = readDataFiles({ dataRepo: fixtureData.dataRepo, instance: fixtureData.instance });
    const loadedFromFiles = loadTrackerFromFiles(fileMap);
    assert.ok(loadedFromFiles.items.length > 0, 'pure file-map loader must load tracker records');
    assert.ok(loadedFromFiles.people.length > 0, 'pure file-map loader must load people');
    assert.deepEqual(validateTrackerCore(loadedFromFiles), validateTracker(records));
    assert.deepEqual(loadedFromFiles.items.map(item => item.data.id), records.items.map(item => item.data.id));
    assert.deepEqual(loadedFromFiles.people.map(person => person.id), records.people.map(person => person.id));
  } finally {
    fixtureData.cleanup();
    rmSync(dataRepo, { recursive: true, force: true });
  }
});

test('configured approver aliases and linked migration decisions remain instance-neutral', () => {
  const instance = fixtureInstance({ id: 'migration-compatibility', folderPath: '' });
  mkdirSync(testTempRoot, { recursive: true });
  const dataRepo = mkdtempSync(join(testTempRoot, 'migration-compatibility-'));
  const fixtureData = writeFixtureData({ repositoryPath: dataRepo, instance, mode: 'populated' });
  const fixtureDecision = 'project-alpha-delivery-schedule-2026-09-30';
  const configuredDecision = 'synthetic-delivery-decision';
  try {
    const decisionPath = join(fixtureData.dataPath, 'tracker/decisions', `${fixtureDecision}.md`);
    const decisionText = readFileSync(decisionPath, 'utf8')
      .replace(`id: ${fixtureDecision}`, `id: ${configuredDecision}`);
    const migrationPath = join(fixtureData.dataPath, 'tracker/migrations/unified-work.json');
    const migration = JSON.parse(readFileSync(migrationPath, 'utf8'));
    for (const entry of Object.values(migration.legacyApprovals)) entry.decision = configuredDecision;
    writeFileSync(join(fixtureData.dataPath, 'tracker/decisions', `${configuredDecision}.md`), decisionText);
    rmSync(decisionPath);
    writeFileSync(migrationPath, `${JSON.stringify(migration, null, 2)}\n`);
    const records = loadTracker({ dataRepo: fixtureData.dataPath, instance: fixtureData.instance });
    for (const decision of records.decisions) {
      decision.data.owner = 'team-lead';
      decision.data.approved_by = 'team-lead';
    }
    for (const record of [...records.items, ...records.plans, ...records.milestones]) {
      if (record.data.approved_by) record.data.approved_by = 'team-lead';
      if (record.data.confirmed_by) record.data.confirmed_by = 'team-lead';
    }
    assert.match(validateTracker(records).join('\n'), /approved decisions need approver and date|legacy accepted item needs its approved Don decision/);
    assert.deepEqual(validateTracker(records, { approverIds: ['team-lead'] }), []);
  } finally {
    fixtureData.cleanup();
    rmSync(dataRepo, { recursive: true, force: true });
  }
});

test('Markdown title and narrative extraction ignores H1/H2 text inside backtick and tilde fences', () => {
  const body = [
    '# Real title', '', '## Outcome', '', 'Before the example.', '', '~~~md', '# Example title',
    '## Next step', 'not a real section', '~~~', '', 'After the example.', '', '## Completion condition',
    '', 'Verified.', '', '## Evidence', '', '```md', '## Outcome', 'Not a second outcome.', '```', ''
  ].join('\n');
  const expectedOutcome = ['Before the example.', '', '~~~md', '# Example title', '## Next step', 'not a real section', '~~~', '', 'After the example.'].join('\n');
  assert.equal(extractMarkdownTitle(body), 'Real title');
  assert.equal(extractMarkdownSections(body).outcome, expectedOutcome);
  assert.equal(extractMarkdownSections(body)['next step'], undefined);
  assert.equal(scanMarkdownHeadings(body).unclosedFence, false);
});

test('item content sections may be absent when empty but duplicate target headings fail validation', () => {
  const missing = record('missing-empty-section', {}, `# missing-empty-section\n\n## Outcome\n\nDeliver the fixture.\n\n## Completion condition\n\nVerified.\n\n## Evidence\n\nEvidence is recorded here.\n`);
  assert.deepEqual(validateTracker({ items: [missing] }), []);

  const duplicate = record('duplicate-section', {}, `${BODY('duplicate-section')}\n## Outcome\n\nSecond outcome.\n`);
  assert.match(validateTracker({ items: [duplicate] }).join('\n'), /duplicate ## outcome section/);
});

test('commitment transitions require the planned readiness stage before acceptance', () => {
  assert.equal(canTransitionCommitment('draft', 'planned'), true);
  assert.equal(canTransitionCommitment('planned', 'accepted'), true);
  assert.equal(canTransitionCommitment('draft', 'accepted'), false);
});

test('planned status and accepted approval rules are enforced independently', () => {
  const root = fixture();
  writeItem(root, record('bad-planned-status', {
    status: 'active',
    commitment: 'planned'
  }));
  writeItem(root, record('blocked-planned-status', {
    status: 'blocked',
    commitment: 'planned'
  }));
  writeItem(root, record('unassigned-planned-owner', {
    owner: '-',
    commitment: 'planned'
  }));
  writeItem(root, record('invalid-approval-state', {
    approval_state: 'bogus'
  }));
  writeItem(root, record('unapproved-accepted', {
    commitment: 'accepted', accepted_from: 'planned',
    owner: 'unassigned'
  }));
  writeItem(root, record('direct-draft-accept', {
    commitment: 'accepted',
    owner: 'unassigned'
  }));
  const issues = validateTracker(loadTracker({ dataRepo: root, instance: rootInstance })).join('\n');
  assert.match(issues, /bad-planned-status\.md: planned items must remain queued/);
  assert.match(issues, /blocked-planned-status\.md: planned items must remain queued/);
  assert.match(issues, /unassigned-planned-owner\.md: planned items must keep owner unassigned unless an exact assignment approval is valid/);
  assert.match(issues, /invalid-approval-state\.md: invalid approval_state/);
  assert.match(issues, /unapproved-accepted\.md: accepted item needs approval_state approved/);
  assert.match(issues, /direct-draft-accept\.md: accepted item needs accepted_from: planned/);

  const malformedApproval = approvedRecord('malformed-approved');
  malformedApproval.data.approval_digest = '0'.repeat(64);
  writeItem(root, malformedApproval);
  writeItem(root, record('approved-without-fields', {
    commitment: 'planned',
    approval_state: 'approved'
  }));
  const malformedIssues = validateTracker(loadTracker({ dataRepo: root, instance: rootInstance })).join('\n');
  assert.match(malformedIssues, /malformed-approved\.md: approval_digest does not match the exact approved task scope/);
  assert.match(malformedIssues, /approved-without-fields\.md: approved records need Don as approved_by/);
});

test('exact assignment approval can attribute a queued draft or planned item without approving scope', () => {
  const draft = assignmentApprovedRecord('assigned-draft', { commitment: 'draft' });
  assert.deepEqual(validateTracker({ items: [draft] }), []);
  const draftState = acceptanceState(draft, [draft], {}, []);
  assert.equal(draftState.approved, false);
  assert.deepEqual(draftState.blockers, []);

  const planned = assignmentApprovedRecord('assigned-planned');
  assert.deepEqual(validateTracker({ items: [planned] }), []);
  const plannedState = acceptanceState(planned, [planned], {}, []);
  assert.equal(plannedState.approved, false);
  assert.deepEqual(plannedState.blockers, [{ id: 'assigned-planned', reason: 'approval-required' }]);
});

test('draft and planned owner attribution reject missing, stale, forged, and mismatched assignment approvals', () => {
  const unapproved = record('unapproved-assignee', {
    commitment: 'planned',
    owner: 'alice',
    owner_proposed: 'alice',
    owner_proposal_rationale: 'Alice is only a proposal in this fixture.'
  });
  const unapprovedIssues = validateTracker({ items: [unapproved] }).join('\n');
  assert.match(unapprovedIssues, /unapproved-assignee\.md: planned items must keep owner unassigned unless an exact assignment approval is valid/);

  const mismatched = assignmentApprovedRecord('mismatched-assignee', { owner: 'bob' });
  const mismatchedIssues = validateTracker({ items: [mismatched] }).join('\n');
  assert.match(mismatchedIssues, /mismatched-assignee\.md: planned items must keep owner unassigned unless an exact assignment approval is valid/);

  const stale = assignmentApprovedRecord('stale-assignment');
  stale.data.owner = 'bob';
  const staleIssues = validateTracker({ items: [stale] }).join('\n');
  assert.match(staleIssues, /stale-assignment\.md: planned items must keep owner unassigned unless an exact assignment approval is valid/);
  assert.match(staleIssues, /stale-assignment\.md: approval_digest does not match the exact approved task scope/);

  const forged = assignmentApprovedRecord('forged-assignment', { approved_by: 'alice' });
  const forgedIssues = validateTracker({ items: [forged] }).join('\n');
  assert.match(forgedIssues, /forged-assignment\.md: approved_by must identify Don/);
  assert.match(forgedIssues, /forged-assignment\.md: planned items must keep owner unassigned unless an exact assignment approval is valid/);
});

test('task-only approval remains valid while proposed dates and operational fields change', () => {
  const prerequisite = approvedRecord('accepted-prerequisite', { commitment: 'accepted', accepted_from: 'planned' });
  const item = approvedRecord('planned-scope', {
    commitment: 'planned',
    owner_proposed: 'alice',
    owner_proposal_rationale: 'The likely owner is recorded as a proposal.',
    planned_start: '2026-10-01',
    planned_end: '2026-10-03',
    schedule_provisional: 'true'
  });
  const originalDigest = item.data.approval_digest;
  const initial = acceptanceState(item, [item, prerequisite], {}, []);
  assert.equal(initial.approved, true);
  assert.equal(initial.eligible, true);
  assert.equal(initial.held, false);
  assert.equal(initial.scheduleApproved, false);

  const plannedPrerequisite = record('planned-prerequisite', { commitment: 'planned' });
  const heldItem = approvedRecord('held-scope', { depends_on: 'planned-prerequisite' });
  const held = acceptanceState(heldItem, [heldItem, plannedPrerequisite], {}, []);
  assert.equal(held.approved, true);
  assert.equal(held.eligible, false);
  assert.equal(held.held, true);
  assert.deepEqual(held.blockers, [{ id: 'planned-prerequisite', reason: 'prerequisite-planned' }]);

  item.data.status = 'blocked';
  item.data.health_state = 'at-risk';
  item.data.health_reason = 'Operational fixture state changed.';
  item.data.missing_information = 'New operational evidence.';
  item.data.suggested_action = 'Review the new evidence.';
  item.data.suggested_actor = 'alice';
  item.data.forecast_start = '2026-10-02';
  item.data.forecast_end_min = '2026-10-05';
  item.data.forecast_end_max = '2026-10-06';
  item.data.remaining_effort_min = '2';
  item.data.remaining_effort_max = '4';
  item.body = item.body.replace('Review the next concrete step', 'Record the operational next step');
  item.body = item.body.replace('Evidence is recorded here.', 'A new operational observation is recorded here.');
  assert.equal(taskApprovalDigest(item), originalDigest);
  assert.equal(acceptanceState(item, [item, prerequisite], {}, []).approved, true);
});

test('accepted tasks may carry explicit proposed dates without changing approval digests', () => {
  const item = approvedRecord('accepted-proposal', {
    commitment: 'accepted',
    accepted_from: 'planned',
    proposed_start: '2026-10-10',
    proposed_end: '2026-10-12',
    proposed_schedule_kind: 'checkpoint'
  });
  const digest = item.data.approval_digest;
  assert.equal(acceptanceState(item, [item], {}, []).approved, true);
  assert.equal(taskApprovalDigest(item), digest);

  item.data.proposed_end = '2026-10-14';
  item.data.proposed_schedule_kind = 'span';
  assert.equal(taskApprovalDigest(item), digest);
  assert.equal(acceptanceState(item, [item], {}, []).approved, true);

  const invalidKind = record('invalid-proposal-kind', {
    proposed_start: '2026-10-10',
    proposed_end: '2026-10-12',
    proposed_schedule_kind: 'slice'
  });
  assert.match(validateTracker({ items: [invalidKind] }).join('\n'), /proposed_schedule_kind must be span or checkpoint/);

  const invalidRange = record('invalid-proposal-range', {
    proposed_start: '2026-10-12',
    proposed_end: '2026-10-10'
  });
  assert.match(validateTracker({ items: [invalidRange] }).join('\n'), /proposed_end must be >= proposed_start/);
});

test('the same item advances from approved draft readiness to planned and then accepted', () => {
  const unapprovedPlanned = record('unapproved-planned', { commitment: 'planned' });
  const unapprovedState = acceptanceState(unapprovedPlanned, [unapprovedPlanned], {}, []);
  assert.equal(unapprovedState.eligible, false);
  assert.deepEqual(unapprovedState.blockers, [{ id: 'unapproved-planned', reason: 'approval-required' }]);

  const item = record('lifecycle-item', {
    revision: 'r1',
    approval_state: 'approved',
    approved_by: 'owner',
    approved_at: '2026-09-30T00:00:00Z',
    approval_ref: 'test:lifecycle-item',
    approved_revision: 'r1',
    reviewed_detail: 'The exact fixture scope was reviewed.',
    approval_source: 'codex-chat',
    approved_parts: 'task'
  });
  item.data.approval_digest = taskApprovalDigest(item);
  let state = acceptanceState(item, [item], {}, []);
  assert.equal(state.commitment, 'draft');
  assert.equal(state.approved, true);
  assert.equal(state.eligible, false);

  item.data.commitment = 'planned';
  state = acceptanceState(item, [item], {}, []);
  assert.equal(state.commitment, 'planned');
  assert.equal(state.eligible, true);

  item.data.commitment = 'accepted';
  item.data.accepted_from = 'planned';
  state = acceptanceState(item, [item], {}, []);
  assert.equal(state.commitment, 'accepted');
  assert.equal(state.approved, true);
  assert.equal(state.eligible, true);
  assert.deepEqual(state.blockers, []);
});

test('approved assignment and schedule bind the actual owner and dates', () => {
  const item = approvedRecord('assigned-scope', {
    approved_parts: 'task,assignment,schedule',
    owner: 'alice',
    owner_proposed: 'alice',
    owner_proposal_rationale: 'Alice owns the approved fixture.',
    planned_start: '2026-10-01',
    planned_end: '2026-10-03',
    schedule_provisional: 'true'
  });
  item.data.approval_digest = taskApprovalDigest(item);
  assert.equal(acceptanceState(item, [item], {}, []).approved, true);

  const ownerChanged = { ...item, data: { ...item.data, owner: 'bob' } };
  assert.notEqual(taskApprovalDigest(ownerChanged), item.data.approval_digest);
  assert.equal(acceptanceState(ownerChanged, [ownerChanged], {}, []).approved, false);

  const dateChanged = { ...item, data: { ...item.data, planned_end: '2026-10-04' } };
  assert.notEqual(taskApprovalDigest(dateChanged), item.data.approval_digest);
  assert.equal(acceptanceState(dateChanged, [dateChanged], {}, []).approved, false);

  const targetChanged = { ...item, data: { ...item.data, target: '2026-10-31' } };
  assert.notEqual(taskApprovalDigest(targetChanged), item.data.approval_digest);
  const revisionChanged = { ...item, data: { ...item.data, revision: 'r2' } };
  assert.notEqual(taskApprovalDigest(revisionChanged), item.data.approval_digest);
});

test('accepted legacy approval binds the frozen scope and exposes approved owner and schedule', () => {
  const item = record('archived-item', {
    commitment: 'accepted', accepted_from: 'planned',
    owner: 'alice',
    planned_start: '2026-10-01',
    planned_end: '2026-10-03',
    schedule_provisional: 'true',
    target: '2026-10-31'
  });
  const digest = acceptedTaskDigest(item);
  const decision = {
    data: {
      id: 'project-alpha-delivery-schedule-2026-09-30',
      state: 'approved',
      approved_by: 'owner',
      affects: 'archived-item'
    }
  };
  const approval = {
    'archived-item': { digest, decision: decision.data.id }
  };
  const state = acceptanceState(item, [item], approval, [decision]);
  assert.equal(state.legacyApproved, true);
  assert.equal(state.approved, true);
  assert.equal(state.accepted, true);
  assert.equal(state.eligible, true);
  assert.equal(state.scheduleApproved, true);
  assert.deepEqual(state.approvedParts, ['task', 'assignment', 'schedule']);

  const partialSchedule = { ...item, data: { ...item.data, planned_end: '-' } };
  const partialState = acceptanceState(partialSchedule, [partialSchedule], {
    'archived-item': { digest: acceptedTaskDigest(partialSchedule), decision: decision.data.id }
  }, [decision]);
  assert.equal(partialState.approved, true);
  assert.equal(partialState.scheduleApproved, false);
  assert.deepEqual(partialState.approvedParts, ['task', 'assignment']);

  item.data.status = 'blocked';
  item.data.health_state = 'at-risk';
  item.data.health_reason = 'Operational state changed.';
  item.data.missing_information = 'Operational fixture evidence.';
  item.data.suggested_action = 'Review the fixture.';
  item.data.suggested_actor = 'alice';
  item.data.forecast_end_max = '2026-10-07';
  item.data.remaining_effort_min = '1';
  item.data.remaining_effort_max = '2';
  item.body = item.body.replace('Review the next concrete step', 'Record the current next step');
  item.body = item.body.replace('Evidence is recorded here.', 'The operational evidence changed.');
  assert.equal(acceptedTaskDigest(item), digest);
  assert.equal(acceptanceState(item, [item], approval, [decision]).approved, true);

  const scopeChanged = { ...item, data: { ...item.data, target: '2026-11-01' } };
  assert.notEqual(acceptedTaskDigest(scopeChanged), digest);
  assert.equal(acceptanceState(scopeChanged, [scopeChanged], approval, [decision]).approved, false);
});

test('history records are loaded separately and do not become live prerequisites', () => {
  const root = fixture();
  writeItem(root, approvedRecord('live-item', { commitment: 'accepted', accepted_from: 'planned' }));
  const historyPath = join(root, 'tracker/history/old-item.md');
  mkdirSync(dirname(historyPath), { recursive: true });
  writeFileSync(historyPath, `---\n${frontmatter({
    id: 'old-item',
    type: 'task',
    status: 'done',
    phase: 'verify',
    owner: 'alice',
    parent: '-',
    depends_on: '-',
    updated_at: '2026-09-30',
    superseded_by: 'live-item'
  })}\n---\n${BODY('old-item')}`);
  const records = loadTracker({ dataRepo: root, instance: rootInstance });
  assert.equal(records.items.length, 1);
  assert.equal(records.history.length, 1);
  assert.equal(records.items.some(item => item.data.id === 'old-item'), false);
  assert.deepEqual(validateTracker(records), []);
});

test('canonical archived items remain readable and are not offered for archiving again', () => {
  const root = fixture();
  const archived = approvedRecord('archived-item', {
    commitment: 'accepted', accepted_from: 'planned',
    status: 'done',
    phase: 'verify',
    completed_at: '2026-09-01'
  });
  writeItem(root, archived, 'archive/2026');
  const records = loadTracker({ dataRepo: root, instance: rootInstance });
  assert.deepEqual(validateTracker(records), []);
  assert.equal(records.items.length, 1);
  assert.deepEqual(archiveCandidates(records, new Date('2026-09-30T00:00:00Z')), []);
});

test('legacy folders are reported instead of silently ignored', () => {
  const root = fixture();
  const legacyPath = join(root, 'tracker/active/product/archived-item.md');
  mkdirSync(dirname(legacyPath), { recursive: true });
  writeFileSync(legacyPath, '# Legacy item\n');
  const records = loadTracker({ dataRepo: root, instance: rootInstance });
  assert.match(records.errors.join('\n'), /tracker\/active: legacy item folder is not supported/);
});
