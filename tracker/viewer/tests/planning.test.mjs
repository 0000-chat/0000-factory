import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'bun:test';
import { buildSnapshot } from '../tooling/build.mjs';
import { buildTrackerData } from '../tooling/data.mjs';
import { deriveProgress, milestonePlanApprovalDigest, taskApprovalDigest } from '../tooling/planning.mjs';
import { acceptanceState } from '../../../tooling/tracker/model.mjs';
import { isUtcTimestamp } from '../../../tooling/tracker/model.mjs';
import { loadTracker, parseRecord, validateTracker } from '../../../tooling/tracker/model.mjs';
import { fixtureInstance, writeFixtureData } from '../../../tests/helpers/fixture-data.mjs';

const roots = [];
const fixtures = [];
const appRoot = fileURLToPath(new URL('../../../', import.meta.url));
const testTempRoot = resolve(process.env.TMPDIR ?? tmpdir());
mkdirSync(testTempRoot, { recursive: true });

const root = () => {
  const path = mkdtempSync(join(testTempRoot, '0000-planning-'));
  roots.push(path);
  return path;
};

function dataFixture(id, mode = 'empty') {
  const data = writeFixtureData({
    repositoryPath: root(),
    instance: fixtureInstance({ id }),
    mode,
  });
  fixtures.push(data);
  return data;
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function record(data, body = `# ${data.id}\n\n## Outcome\nresult\n\n## Completion condition\nproof\n\n## Evidence\nlink`) {
  return { data, body, path: `tracker/items/product/${data.id}.md`, name: data.id };
}

function acceptedItem(overrides = {}, body) {
  const data = {
    id: 'accepted-item',
    type: 'task',
    status: 'queued',
    phase: 'discovery',
    owner: 'unassigned',
    parent: '-',
    depends_on: '-',
    project: 'project-orbit',
    plan: '-',
    commitment: 'accepted', accepted_from: 'planned',
    updated_at: '2026-09-30',
    revision: 'r1',
    approval_state: 'approved',
    approved_parts: 'task',
    approved_by: 'owner',
    approved_at: '2026-09-30T10:00:00Z',
    approval_ref: 'chat://approval/item/r1',
    approved_revision: 'r1',
    reviewed_detail: 'The exact task scope was reviewed.',
    approval_source: 'chatgpt-chat',
    approval_digest: '-',
    health_state: 'unknown',
    health_reason: 'scope is recorded',
    missing_information: 'evidence',
    suggested_action: 'review evidence',
    suggested_actor: 'don',
    ...overrides
  };
  const item = record(data, body ?? `# ${data.id}\n\n## Outcome\nresult\n\n## Completion condition\nproof\n\n## Next step\nnext\n\n## Evidence\nlink`);
  if (data.commitment === 'accepted' && data.approval_state === 'approved') data.approval_digest = taskApprovalDigest(item);
  return item;
}

function approvedPlan(id = 'milestone-plan', revision = 'r1') {
  return record({
    id,
    project: 'project-orbit',
    status: 'approved',
    owner: 'owner',
    updated_at: '2026-09-30',
    revision,
    approved_by: 'owner',
    approved_at: '2026-09-30T10:00:00Z',
    approval_ref: 'chat://approval/milestone-plan/r1',
    approved_revision: revision,
    reviewed_detail: 'The exact launch milestone weights were reviewed.',
    approval_source: 'chatgpt-chat',
    approval_digest: '-'
  }, '# Launch plan\n\n## Objective\nlaunch\n\n## Evidence\nchat://approval/milestone-plan/r1');
}

function milestone(id, weight, status = 'proposed', extra = {}) {
  return record({
    id,
    item: 'project-orbit',
    plan_id: 'milestone-plan',
    weight: String(weight),
    status,
    updated_at: '2026-09-30',
    approved_revision: 'r1',
    approval_state: status === 'proposed' ? 'proposed' : 'approved',
    approved_by: status === 'proposed' ? '-' : 'owner',
    approved_at: status === 'proposed' ? '-' : '2026-09-30T10:00:00Z',
    approval_ref: status === 'proposed' ? '-' : `chat://approval/${id}/r1`,
    reviewed_detail: status === 'proposed' ? '-' : 'The exact milestone scope was reviewed.',
    approval_source: status === 'proposed' ? '-' : 'chatgpt-chat',
    approval_digest: '-',
    ...extra
  }, `# ${id}\n\n## Outcome\nresult\n\n## Completion condition\nproof\n\n## Evidence\nlink`);
}

test('unapproved or empty milestone plans remain unscoped', () => {
  const plan = approvedPlan();
  const proposedPlan = { ...plan, data: { ...plan.data, status: 'draft', approved_by: '-', approved_at: '-', approval_ref: '-', approved_revision: '-', reviewed_detail: '-' } };
  const progress = deriveProgress('project-orbit', [milestone('scope', 1)], [proposedPlan]);
  assert.equal(progress.scoped, false);
  assert.equal(progress.percent, null);
  assert.equal(progress.approvedPlanId, null);
});

test('progress counts only complete Don confirmations tied to the approved revision', () => {
  const plan = approvedPlan();
  const complete = milestone('complete', 1, 'complete', {
    confirmation_state: 'confirmed',
    confirmed_by: 'owner',
    confirmed_at: '2026-09-30T11:00:00Z',
    confirmation_ref: 'grok://interaction/complete',
    confirmation_source: 'grok-ui',
    confirmed_revision: 'r1',
    evidence_ref: 'commit:abc'
  });
  const open = milestone('open', 4, 'approved');
  const planDigest = milestonePlanApprovalDigest(plan, [complete, open]);
  plan.data.approval_digest = planDigest;
  for (const item of [complete, open]) item.data.approval_digest = planDigest;
  const progress = deriveProgress('project-orbit', [complete, open], [plan]);
  assert.equal(progress.scoped, true);
  assert.equal(progress.percent, 20);
  assert.equal(progress.completedWeight, 1);
  assert.equal(progress.totalWeight, 5);
  const stale = milestone('complete', 1, 'complete', {
    confirmation_state: 'confirmed',
    confirmed_by: 'owner',
    confirmed_at: '2026-09-30T11:00:00Z',
    confirmation_ref: 'grok://interaction/stale',
    confirmation_source: 'grok-ui',
    confirmed_revision: 'old-revision',
    evidence_ref: 'commit:old'
  });
  const stalePlanDigest = milestonePlanApprovalDigest(plan, [stale, open]);
  plan.data.approval_digest = stalePlanDigest;
  stale.data.approval_digest = stalePlanDigest;
  open.data.approval_digest = stalePlanDigest;
  assert.equal(deriveProgress('project-orbit', [stale, open], [plan]).percent, 0);
});

test('approval digest changes when milestone scope, weight, or completion condition changes', () => {
  const plan = approvedPlan();
  const first = milestone('first', 1, 'approved');
  const second = milestone('second', 1, 'approved');
  const original = milestonePlanApprovalDigest(plan, [first, second]);
  second.data.weight = '99';
  assert.notEqual(milestonePlanApprovalDigest(plan, [first, second]), original);
  second.data.weight = '1';
  plan.data.revision = 'r2';
  plan.data.approved_revision = 'r2';
  assert.notEqual(milestonePlanApprovalDigest(plan, [first, second]), original);
  plan.data.revision = 'r1';
  plan.data.approved_revision = 'r1';
  second.body = second.body.replace('proof', 'different proof');
  assert.notEqual(milestonePlanApprovalDigest(plan, [first, second]), original);
  assert.notEqual(milestonePlanApprovalDigest(plan, [first]), original);
});

test('task-only approval digest excludes unapproved assignment and schedule proposals', () => {
  const task = record({
    id: 'draft-task', plan: 'milestone-plan', project: 'project-orbit', status: 'approved-held', approval_state: 'approved', approved_parts: 'task',
    owner: 'unassigned', owner_proposed: 'juan', owner_proposal_rationale: 'fit', parent: '-', depends_on: '-', updated_at: '2026-09-30', revision: 'r1',
    planned_start: '2026-10-01', planned_end: '2026-10-03', schedule_provisional: 'true',
    approved_by: 'owner', approved_at: '2026-09-30T10:00:00Z', approval_ref: 'chat://approval/task/r1', approved_revision: 'r1',
    reviewed_detail: 'Task scope only.', approval_source: 'chatgpt-chat', approval_digest: '-'
  }, '# Task\n\n## Outcome\nresult\n\n## Completion condition\nproof\n\n## Next step\nnext\n\n## Evidence\nlink');
  const original = taskApprovalDigest(task);
  task.data.owner_proposed = 'mikhail';
  task.data.planned_end = '2026-10-08';
  assert.equal(taskApprovalDigest(task), original);
  task.data.revision = 'r2';
  task.data.approved_revision = 'r2';
  assert.notEqual(taskApprovalDigest(task), original);
  task.data.revision = 'r1';
  task.data.approved_revision = '-';
  task.data.revision = 'r2';
  assert.notEqual(taskApprovalDigest(task), original);
  task.data.approved_revision = 'r1';
  task.data.revision = 'r1';
  task.data.approved_parts = 'task,assignment';
  assert.notEqual(taskApprovalDigest(task), original);
});

test('partial progress never rounds to 100 and missing confirmation revision earns no credit', () => {
  const plan = approvedPlan();
  const complete = milestone('almost', 996, 'complete', {
    confirmation_state: 'confirmed', confirmed_by: 'owner', confirmed_at: '2026-09-30T11:00:00Z',
    confirmation_ref: 'grok://interaction/almost', confirmation_source: 'grok-ui', evidence_ref: 'commit:almost', confirmed_revision: 'r1'
  });
  const open = milestone('last', 4, 'approved');
  const planDigest = milestonePlanApprovalDigest(plan, [complete, open]);
  plan.data.approval_digest = planDigest;
  complete.data.approval_digest = planDigest;
  open.data.approval_digest = planDigest;
  assert.equal(deriveProgress('project-orbit', [complete, open], [plan]).percent, 99);
  complete.data.confirmed_revision = '-';
  assert.equal(deriveProgress('project-orbit', [complete, open], [plan]).completedWeight, 0);
});

test('100 percent requires every milestone verified even when a pending weight is below float precision', () => {
  const plan = approvedPlan();
  const complete = milestone('large', 1e9, 'complete', {
    confirmation_state: 'confirmed', confirmed_by: 'owner', confirmed_at: '2026-09-30T11:00:00Z',
    confirmation_ref: 'grok://interaction/large', confirmation_source: 'grok-ui', evidence_ref: 'commit:large', confirmed_revision: 'r1'
  });
  const pending = milestone('tiny', 1e-18, 'approved');
  const planDigest = milestonePlanApprovalDigest(plan, [complete, pending]);
  plan.data.approval_digest = planDigest;
  complete.data.approval_digest = planDigest;
  pending.data.approval_digest = planDigest;
  const progress = deriveProgress('project-orbit', [complete, pending], [plan]);
  assert.equal(progress.allVerified, false);
  assert.equal(progress.percent, 99);
});

test('UTC timestamps round-trip and reject calendar overflow', () => {
  assert.equal(isUtcTimestamp('2026-09-30T11:00:00Z'), true);
  assert.equal(isUtcTimestamp('2026-09-30T11:00:00.120Z'), true);
  assert.equal(isUtcTimestamp('2026-02-30T11:00:00Z'), false);
  assert.equal(isUtcTimestamp('2026-09-30T11:00:60Z'), false);
});

test('validator rejects approved milestone mutations, proposed additions, and pending completion', () => {
  const item = acceptedItem({ id: 'project-orbit', type: 'project', status: 'active' });
  const plan = approvedPlan();
  plan.path = 'tracker/plans/milestone-plan.md';
  plan.name = 'milestone-plan';
  const first = milestone('first', 1, 'approved');
  first.path = 'tracker/milestones/project-orbit/first.md';
  first.name = 'first';
  const bind = () => {
    const digest = milestonePlanApprovalDigest(plan, [first]);
    plan.data.approval_digest = digest;
    first.data.approval_digest = digest;
  };
  bind();
  const base = () => ({ items: [item], decisions: [], updates: [], releases: [], plans: [plan], milestones: [first], capacities: [], errors: [] });
  assert.deepEqual(validateTracker(base()), []);
  first.data.weight = '99';
  assert.match(validateTracker(base()).join('\n'), /approval_digest|approved milestone scope/);
  first.data.weight = '1';
  bind();
  const extra = milestone('extra', 1, 'proposed');
  extra.path = 'tracker/milestones/project-orbit/extra.md';
  extra.name = 'extra';
  const proposedRecords = base();
  proposedRecords.milestones.push(extra);
  assert.match(validateTracker(proposedRecords).join('\n'), /approval_digest|cannot be included/);
  first.data.item = 'other-item';
  assert.match(validateTracker(base()).join('\n'), /unknown milestone item|approval_digest/);
  first.data.item = 'project-orbit';
  bind();
  first.data.status = 'complete';
  assert.match(validateTracker(base()).join('\n'), /complete milestones need a specific Don confirmation/);
  Object.assign(first.data, {
    confirmation_state: 'confirmed', confirmed_by: 'owner', confirmed_at: '2026-09-30T11:00:00Z',
    confirmation_ref: 'grok://interaction/first', confirmation_source: 'grok-ui', evidence_ref: 'commit:first', confirmed_revision: '-'
  });
  assert.match(validateTracker(base()).join('\n'), /complete milestones need a specific Don confirmation/);
  first.data.confirmed_revision = 'r1';
  first.data.confirmation_source = 'chatgpt-chat';
  assert.match(validateTracker(base()).join('\n'), /confirmation_source must be grok-ui or authenticated-edit/);
});

test('capacity free time is derived from known weekly allocation and commitments', () => {
  const records = {
    items: [], decisions: [], updates: [], releases: [], plans: [], milestones: [], errors: [],
    capacities: [{
      data: { id: 'juan-capacity', person: 'contributor', weekly_days: '5', scheduled_days: '2', free_days: '-' , updated_at: '2026-09-30' },
      body: '# Capacity\n\n## Context\nallocation\n\n## Evidence\nsource',
      path: 'tracker/capacities/juan-capacity.md', name: 'juan-capacity'
    }]
  };
  const data = buildTrackerData(records);
  assert.equal(data.capacities[0].freeDays, 3);
  assert.equal(data.capacities[0].overallocatedDays, 0);
  records.capacities[0].data.weekly_days = 'unknown';
  assert.equal(buildTrackerData(records).capacities[0].freeDays, null);
  records.capacities[0].data.free_days = '1';
  assert.match(validateTracker(records).join('\n'), /free_days must be unknown/);
  records.capacities[0].data.weekly_days = '5';
  records.capacities[0].data.scheduled_days = '7';
  records.capacities[0].data.free_days = '-';
  assert.equal(buildTrackerData(records).capacities[0].freeDays, 0);
  assert.equal(buildTrackerData(records).capacities[0].overallocatedDays, 2);
});

test('accepted scope digest rejects owner and schedule mutations', () => {
  const item = acceptedItem();
  const records = { items: [item], decisions: [], updates: [], releases: [], plans: [], milestones: [], capacities: [], errors: [] };
  assert.deepEqual(validateTracker(records), []);
  item.data.owner = 'juan';
  assert.match(validateTracker(records).join('\n'), /approval_digest does not match|accepted owner needs approved assignment/);
  item.data.owner = 'unassigned';
  item.data.planned_start = '2026-10-01';
  assert.match(validateTracker(records).join('\n'), /accepted dates need approved schedule|approval_digest does not match/);
});

test('accepted work stays held while a planned prerequisite is unresolved', () => {
  const prerequisite = record({ id: 'draft-prerequisite', plan: 'milestone-plan', status: 'queued', approval_state: 'proposed', commitment: 'planned', owner: 'unassigned', parent: '-', depends_on: '-', updated_at: '2026-09-30' });
  const child = acceptedItem({ id: 'draft-child', plan: 'milestone-plan', depends_on: 'draft-prerequisite' });
  const held = acceptanceState(child, [prerequisite, child], {}, []);
  assert.equal(held.held, true);
  assert.equal(held.eligible, false);
  assert.deepEqual(held.blockers, [{ id: 'draft-prerequisite', reason: 'prerequisite-planned' }]);
});

test('shared validator catches frontmatter, dependency cycles, and malformed scope', () => {
  assert.match(parseRecord('---\nid: x\nmeta:\n  nested: true\n---\n').error, /invalid frontmatter line/);
  const fixture = dataFixture('planning-cycle');
  const path = fixture.dataRepo;
  mkdirSync(join(path, 'tracker/items/product'), { recursive: true });
  const item = id => `---\nid: ${id}\ntype: task\nstatus: queued\nphase: discovery\nowner: unassigned\nparent: -\ndepends_on: ${id === 'a' ? 'b' : 'a'}\ncommitment: planned\napproval_state: proposed\nupdated_at: 2026-09-30\nhealth_state: unknown\nhealth_reason: needs evidence\nmissing_information: evidence\nsuggested_action: review\nsuggested_actor: don\n---\n\n# ${id}\n\n## Outcome\nx\n\n## Completion condition\nx\n\n## Next step\nx\n\n## Evidence\nx\n`;
  writeFileSync(join(path, 'tracker/items/product/a.md'), item('a'));
  writeFileSync(join(path, 'tracker/items/product/b.md'), item('b'));
  const issues = validateTracker(loadTracker({ dataRepo: fixture.dataRepo, instance: fixture.instance })).join('\n');
  assert.match(issues, /depends_on cycle/);
});

test('shared validator discovers every planning record directory', () => {
  const fixture = dataFixture('planning-directories');
  const path = fixture.dataRepo;
  const write = (relativePath, id) => {
    mkdirSync(join(path, relativePath, '..'), { recursive: true });
    writeFileSync(join(path, relativePath), `---\nid: ${id}\n---\n\n# ${id}\n`);
  };
  write('tracker/plans/example-plan.md', 'example-plan');
  write('tracker/proposals/example-proposal.md', 'example-proposal');
  write('tracker/milestones/project-orbit/example-milestone.md', 'example-milestone');
  write('tracker/capacities/example-capacity.md', 'example-capacity');
  const records = loadTracker({ dataRepo: fixture.dataRepo, instance: fixture.instance });
  assert.equal(records.plans.length, 1);
  assert.equal(records.milestones.length, 1);
  assert.equal(records.capacities.length, 1);
  const issues = validateTracker(records).join('\n');
  assert.match(issues, /tracker\/plans\/example-plan\.md/);
  assert.match(issues, /tracker\/proposals: legacy planning folder/);
  assert.match(issues, /tracker\/milestones\/project-orbit\/example-milestone\.md/);
  assert.match(issues, /tracker\/capacities\/example-capacity\.md/);
});

test('synthetic tracker snapshot retains project relationships and plan links', async () => {
  const fixture = dataFixture('planning-snapshot', 'populated');
  const output = join(root(), 'snapshot');
  buildSnapshot({
    engineRoot: appRoot,
    dataRepo: fixture.dataRepo,
    instancePath: fixture.instancePath,
    output,
    builtAt: '2026-09-30T12:00:00Z',
  });
  const data = JSON.parse(readFileSync(join(output, 'assets/data.json'), 'utf8'));
  assert.equal(data.schemaVersion, 4);

  const itemsById = new Map(data.items.map(item => [item.id, item]));
  assert.equal(itemsById.size, data.items.length, 'item ids must be unique');
  assert.ok(itemsById.has('fixture-project'));
  assert.ok(itemsById.has('fixture-foundation-task'));
  assert.equal(itemsById.get('fixture-foundation-task').parent, 'fixture-project');

  for (const item of data.items) {
    if (item.parent === null) continue;
    assert.notEqual(item.parent, item.id, `item cannot parent itself: ${item.id}`);
    assert.ok(itemsById.has(item.parent), `item parent must exist: ${item.id}`);
  }

  const fixturePlan = data.plans.find(plan => plan.id === 'fixture-plan');
  assert.ok(fixturePlan, 'synthetic plan should be present');
  assert.equal(new Set(fixturePlan.taskIds).size, fixturePlan.taskIds.length, 'plan task ids should be unique');
  assert.ok(fixturePlan.taskIds.includes('fixture-foundation-task'));
  for (const id of fixturePlan.taskIds) assert.ok(itemsById.has(id), `plan references missing item: ${id}`);
});
