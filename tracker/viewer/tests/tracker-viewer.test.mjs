import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'bun:test';
import { buildSnapshot } from '../tooling/build.mjs';
import { buildTrackerData, extractSections, parseOwnerNames } from '../tooling/data.mjs';
import { taskApprovalDigest } from '../tooling/planning.mjs';
import { normalizeNarrativeValue } from '../../../tooling/tracker/markdown.mjs';
import { fixtureInstance, writeFixtureData } from '../../../tests/helpers/fixture-data.mjs';
import { escapeHtml, renderMarkdown } from '../src/markdown.js';
import { getScopeItems, plansForScope, workVisibility } from '../src/view-model.mjs';

const strategyRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const tempRoots = [];
const fixtureData = [];

function tempRoot(prefix = '0000-viewer-') {
  const path = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(path);
  return path;
}

function syntheticRecord(data, path = `tracker/items/product/${data.id}.md`) {
  return {
    data,
    path,
    body: `# ${data.id}\n\n## Outcome\nOutcome for ${data.id}.\n\n## Completion condition\nEvidence for ${data.id}.\n\n## Next step\nContinue ${data.id}.\n\n## Evidence\nrecorded evidence`,
    name: data.id,
  };
}

function markdownSection(markdown, heading) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex(line => line.trim() === `## ${heading}`);
  assert.notEqual(start, -1, `source Markdown should contain ## ${heading}`);
  const next = lines.findIndex((line, index) => index > start && /^##\s/.test(line));
  return lines.slice(start + 1, next === -1 ? lines.length : next).join('\n').trim();
}

afterEach(() => {
  for (const fixture of fixtureData.splice(0)) fixture.cleanup();
  for (const path of tempRoots.splice(0)) rmSync(path, { recursive: true, force: true });
});

async function builtData() {
  const fixture = writeFixtureData({ instance: fixtureInstance({ id: 'viewer-test' }), mode: 'populated' });
  fixtureData.push(fixture);
  const output = join(tempRoot(), 'dist', 'tracker-viewer');
  buildSnapshot({
    engineRoot: strategyRoot,
    dataRepo: fixture.dataRepo,
    instancePath: fixture.instancePath,
    output,
    builtAt: '2026-09-30T01:02:03.000Z',
  });
  return { fixture, output, data: JSON.parse(readFileSync(join(output, 'assets/data.json'), 'utf8')) };
}

test('builds a parent tree with a synthetic project expanded and direct child counts', async () => {
  const { fixture, data } = await builtData();
  const project = data.items.find(item => item.id === 'fixture-project');
  assert.ok(project);
  assert.deepEqual(data.defaultExpanded, []);
  assert.equal(data.rootsByBucket.other.includes('fixture-project'), true);
  assert.equal(project.childSummary.done, 0);
  assert.equal(project.childSummary.total, 4);
  assert.ok(project.childIds.includes('fixture-foundation-task'));
  const projectMarkdown = readFileSync(join(fixture.dataRepo, 'tracker/items/fixture/fixture-project.md'), 'utf8');
  assert.equal(project.sections.outcome, markdownSection(projectMarkdown, 'Outcome'));
  assert.equal(project.sections.blocker, null);
  assert.equal(data.plans[0].id, 'fixture-plan');
  assert.equal(data.decisions.length, 1);
});

test('maps synthetic team handles and reports the current approval', async () => {
  const { data } = await builtData();
  const task = data.items.find(item => item.id === 'fixture-foundation-task');
  const project = data.items.find(item => item.id === 'fixture-project');
  assert.equal(task.owner, 'fixture-don');
  assert.equal(task.ownerName, 'Fixture Don');
  assert.equal(project.ownerName, 'unassigned');
  assert.equal(task.acceptance.approved, true);
  assert.equal(task.acceptance.eligible, true);
  assert.deepEqual(task.acceptance.blockers, []);
  assert.equal(task.acceptance.legacy, true);
  assert.equal(task.acceptance.legacyDecision, 'project-alpha-delivery-schedule-2026-09-30');
  assert.equal(task.schedule.plannedStart, '2026-10-04');
  assert.equal(task.schedule.plannedEnd, '2026-10-06');
  assert.equal(task.approval.approvedBy, 'don');
  assert.equal(task.approval.source, 'codex-chat');
  assert.equal(task.approval.reference, 'fixture-approval-fixture-foundation-task');
  assert.equal(parseOwnerNames('## Private\n\n- detail').size, 0);
});

test('projects a top-level update Observation heading into the compact update record', () => {
  const record = syntheticRecord({ id: 'observation-task', type: 'task', status: 'active', phase: 'build', owner: 'unassigned', parent: '-', depends_on: '-', updated_at: '2026-10-01', commitment: 'accepted', health_state: 'unknown', health_reason: 'review', missing_information: 'evidence', suggested_action: 'review', suggested_actor: 'don' });
  const update = {
    data: {
      id: 'email-observation',
      item: 'observation-task',
      source: 'email:test',
      observed_at: '2026-10-02T03:04:05Z',
      occurred_at: '2026-10-01T11:00:00Z',
      activity_kind: 'result',
      activity_summary: 'Confirmed the provider retry result.',
      attribution_basis: 'context',
      evidence_ref: 'email:message-41'
    },
    path: 'tracker/updates/observation-task/email-observation.md',
    body: '---\nid: email-observation\n---\n\n# Observation\n\nThe source-backed update retains its [evidence link](https://example.test/evidence).',
    name: 'email-observation'
  };
  const data = buildTrackerData({ items: [record], plans: [], history: [], migrations: [], decisions: [], releases: [], updates: [update], milestones: [], capacities: [], legacyApprovals: {} });
  assert.equal(data.items[0].linked.updates[0].sections.observation, 'The source-backed update retains its [evidence link](https://example.test/evidence).');
  assert.equal(data.items[0].linked.updates[0].occurredAt, '2026-10-01T11:00:00Z');
  assert.equal(data.items[0].linked.updates[0].activityKind, 'result');
  assert.equal(data.items[0].linked.updates[0].evidenceRef, 'email:message-41');
  assert.deepEqual(data.activityEvidence, [{
    id: 'observation-task/email-observation',
    originalItemId: 'observation-task',
    originalUpdateId: 'email-observation',
    itemId: 'observation-task',
    sourceEventId: 'email:test',
    occurredAt: '2026-10-01T11:00:00Z',
    discoveredAt: '2026-10-02T03:04:05Z',
    kind: 'result',
    summary: 'Confirmed the provider retry result.',
    attributionBasis: 'context',
    evidenceRef: 'email:message-41',
    included: true,
    amendmentIds: [],
    approvalDecisionIds: []
  }]);
});

test('ignores fenced headings when projecting task titles and narrative sections', () => {
  const record = syntheticRecord({ id: 'fenced-heading-task', type: 'task', status: 'active', phase: 'build', owner: 'unassigned', parent: '-', depends_on: '-', updated_at: '2026-10-01', commitment: 'planned', health_state: 'unknown', health_reason: 'review', missing_information: 'evidence', suggested_action: 'review', suggested_actor: 'don' });
  record.body = [
    '~~~markdown',
    '# Example title',
    '## Outcome',
    'Not the task outcome.',
    '~~~',
    '',
    '# Actual task title',
    '',
    '## Outcome',
    'Visible outcome.',
    '',
    '```markdown',
    '## Completion condition',
    'An example heading within the outcome.',
    '```',
    '',
    'Outcome continues after the example.',
    '',
    '## Completion condition',
    'The real completion condition.',
  ].join('\n');
  const data = buildTrackerData({ items: [record], plans: [], history: [], migrations: [], decisions: [], releases: [], updates: [], milestones: [], capacities: [], legacyApprovals: {} });

  assert.equal(data.items[0].title, 'Actual task title');
  assert.equal(data.items[0].sections.outcome, 'Visible outcome.\n\n```markdown\n## Completion condition\nAn example heading within the outcome.\n```\n\nOutcome continues after the example.');
  assert.equal(data.items[0].sections.completionCondition, 'The real completion condition.');
});

test('narrative projection shares publish normalization while preserving Markdown indentation and hard breaks', () => {
  const narrative = '\n  Indented first line\nInternal hard break  \nLast content line   \n\n';
  const sections = extractSections(`## Outcome${narrative}`);

  assert.equal(sections.outcome, normalizeNarrativeValue(narrative));
  assert.equal(sections.outcome, '  Indented first line\nInternal hard break  \nLast content line');
});

test('completed children remain in the parent summary and tree', async () => {
  const fixture = writeFixtureData({ instance: fixtureInstance({ id: 'completed-test' }), mode: 'populated' });
  fixtureData.push(fixture);
  const baselineOutput = join(tempRoot(), 'baseline-dist');
  buildSnapshot({ engineRoot: strategyRoot, dataRepo: fixture.dataRepo, instancePath: fixture.instancePath, output: baselineOutput, builtAt: '2026-09-30T01:02:03.000Z' });
  const baselineData = JSON.parse(readFileSync(join(baselineOutput, 'assets/data.json'), 'utf8'));
  const baselineStream = baselineData.items.find(item => item.id === 'fixture-project');
  const itemPath = join(fixture.dataRepo, 'tracker/items/fixture/fixture-dependent-task.md');
  const original = readFileSync(itemPath, 'utf8');
  writeFileSync(itemPath, original.replace('status: active', 'status: done\ncompleted_at: 2026-09-20'));
  const output = join(tempRoot(), 'dist');
  buildSnapshot({ engineRoot: strategyRoot, dataRepo: fixture.dataRepo, instancePath: fixture.instancePath, output, builtAt: '2026-09-30T01:02:03.000Z' });
  const data = JSON.parse(readFileSync(join(output, 'assets/data.json'), 'utf8'));
  const stream = data.items.find(item => item.id === 'fixture-project');
  const task = data.items.find(item => item.id === 'fixture-dependent-task');
  assert.equal(task.completed, true);
  assert.equal(stream.childSummary.done, baselineStream.childSummary.done + 1);
  assert.equal(stream.childSummary.total, baselineStream.childSummary.total);
  assert.equal(stream.childSummary.total, stream.childIds.filter(id => data.items.find(item => item.id === id)?.commitment === 'accepted').length);
});

test('project scope follows current relationships and keeps draft context out of workload', async () => {
  const { data } = await builtData();
  const scoped = getScopeItems(data.items, 'fixture-project');
  const scopedIds = new Set(scoped.map(item => item.id));
  assert.ok(scopedIds.has('fixture-foundation-task'));
  assert.ok(scopedIds.has('fixture-draft-task'));
  const acceptedIds = scoped.filter(item => item.commitment === 'accepted').map(item => item.id).sort();
  const shown = workVisibility(scoped, '*', true);
  assert.deepEqual(shown.workloadItems.map(item => item.id).sort(), acceptedIds);
  const byId = new Map(scoped.map(item => [item.id, item]));
  const draftAncestorIds = new Set();
  for (const item of scoped.filter(candidate => candidate.commitment === 'accepted' || candidate.commitment === 'planned')) {
    let parent = byId.get(item.parent);
    while (parent) {
      if (parent.commitment === 'draft') draftAncestorIds.add(parent.id);
      parent = byId.get(parent.parent);
    }
  }
  for (const id of draftAncestorIds) {
    assert.ok(shown.contextualIds.has(id));
    assert.ok(shown.items.some(item => item.id === id));
  }
  assert.ok(shown.items.filter(item => item.commitment === 'draft').every(item => shown.contextualIds.has(item.id)));
  assert.ok(shown.workloadItems.every(item => item.commitment === 'accepted'));
  const hidden = workVisibility(scoped, '*', false);
  assert.deepEqual(hidden.workloadItems.map(item => item.id).sort(), acceptedIds);
  assert.ok(hidden.items.filter(item => item.commitment === 'draft').every(item => hidden.contextualIds.has(item.id)));
  const draftsShown = workVisibility(scoped, '*', true, true);
  assert.deepEqual(draftsShown.items.map(item => item.id).sort(), [...scopedIds].sort());
  assert.deepEqual(draftsShown.workloadItems.map(item => item.id).sort(), acceptedIds);
  assert.deepEqual([...draftsShown.contextualIds], []);
});

test('Plans retain every linked task when Work scope filters change', async () => {
  const { data } = await builtData();
  const orbitScope = new Set(getScopeItems(data.items, 'fixture-project').map(item => item.id));
  const orbitPlans = plansForScope(data.plans, orbitScope);
  assert.deepEqual(orbitPlans, data.plans);
  const canonicalOrbitPlan = data.plans.find(plan => plan.project === 'fixture-project');
  assert.ok(canonicalOrbitPlan);
  const canonicalTaskIds = [...canonicalOrbitPlan.taskIds].sort();
  assert.ok(canonicalTaskIds.includes('fixture-foundation-task'));
  assert.ok(canonicalTaskIds.includes('fixture-dependent-task'));
  for (const scope of [orbitScope, new Set(['fixture-foundation-task']), new Set(getScopeItems(data.items, 'fixture-project').map(item => item.id))]) {
    const visiblePlan = plansForScope(data.plans, scope).find(plan => plan.project === 'fixture-project');
    assert.ok(visiblePlan);
    assert.deepEqual([...visiblePlan.taskIds].sort(), canonicalTaskIds);
  }
});

test('carries an explicit blocker from frontmatter without inventing one', async () => {
  const fixture = writeFixtureData({ instance: fixtureInstance({ id: 'blocker-test' }), mode: 'populated' });
  fixtureData.push(fixture);
  const itemPath = join(fixture.dataRepo, 'tracker/items/fixture/fixture-project.md');
  const original = readFileSync(itemPath, 'utf8');
  const withBlocker = original.replace(/^updated_at:[^\r\n]*$/m, line => `${line}\nblocker: Waiting for launch scope approval`);
  assert.notEqual(withBlocker, original, 'fixture should add blocker independent of updated_at date');
  writeFileSync(itemPath, withBlocker);
  const output = join(tempRoot(), 'dist');
  buildSnapshot({ engineRoot: strategyRoot, dataRepo: fixture.dataRepo, instancePath: fixture.instancePath, output, builtAt: '2026-09-30T01:02:03.000Z' });
  const data = JSON.parse(readFileSync(join(output, 'assets/data.json'), 'utf8'));
  const project = data.items.find(item => item.id === 'fixture-project');
  assert.equal(project.sections.blocker, 'Waiting for launch scope approval');
  assert.equal(data.items.find(item => item.id === 'fixture-foundation-task').sections.blocker, null);
});

test('limited Markdown rendering escapes raw HTML and rejects unsafe links', () => {
  const markdown = '<script>alert("x")</script> [run](javascript:alert(1)) **safe**';
  const output = renderMarkdown(markdown);
  assert.equal(output.includes('<script>'), false);
  assert.match(output, /&lt;script&gt;alert/);
  assert.equal(output.includes('javascript:'), false);
  assert.match(output, /<strong>safe<\/strong>/);
  assert.equal(escapeHtml('"<&>'), '&quot;&lt;&amp;&gt;');
});

test('Markdown link resolvers expose internal routes to the router and keep external links isolated', () => {
  const output = renderMarkdown('[decision](orbit-direction.md) [external](https://example.test/record) [unsafe](javascript:alert(1))', {
    resolveLink: href => href.endsWith('.md') ? '/decisions/orbit-direction' : null
  });
  assert.match(output, /href="\/decisions\/orbit-direction"/);
  assert.match(output, /href="\/decisions\/orbit-direction">decision/);
  assert.match(output, /href="https:\/\/example\.test\/record" target="_blank" rel="noreferrer">external/);
  assert.match(output, />decision<\/a>/);
  assert.equal(output.includes('javascript:'), false);
});

test('invalid source preserves the previous generated snapshot', async () => {
  const fixture = writeFixtureData({ instance: fixtureInstance({ id: 'invalid-test' }), mode: 'populated' });
  fixtureData.push(fixture);
  const output = join(tempRoot(), 'dist', 'tracker-viewer');
  buildSnapshot({ engineRoot: strategyRoot, dataRepo: fixture.dataRepo, instancePath: fixture.instancePath, output, builtAt: '2026-09-30T01:02:03.000Z' });
  const before = readFileSync(join(output, 'assets/data.json'), 'utf8');
  const itemPath = join(fixture.dataRepo, 'tracker/items/fixture/fixture-project.md');
  writeFileSync(itemPath, readFileSync(itemPath, 'utf8').replace('## Evidence', '## Outcome'));

  let validationFailure;
  try {
    buildSnapshot({ engineRoot: strategyRoot, dataRepo: fixture.dataRepo, instancePath: fixture.instancePath, output, builtAt: '2026-09-30T04:05:06.000Z' });
  } catch (error) {
    validationFailure = error;
  }
  assert.ok(validationFailure);
  assert.ok(validationFailure.issues.some(issue => String(issue).toLowerCase().includes('duplicate ## outcome section')));
  assert.equal(existsSync(join(output, 'assets/index.html')), true);
  assert.equal(existsSync(join(output, 'assets/favicon.svg')), true);
  assert.equal(readFileSync(join(output, 'assets/data.json'), 'utf8'), before);
});

test('frontend compilation failure preserves the prior output and removes the staged build', async () => {
  const fixture = writeFixtureData({ instance: fixtureInstance({ id: 'frontend-failure' }), mode: 'empty' });
  fixtureData.push(fixture);
  const output = join(tempRoot(), 'dist', 'tracker-viewer');
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, 'sentinel.txt'), 'last valid\n');
  const beforeSentinel = readFileSync(join(output, 'sentinel.txt'), 'utf8');
  const failingBun = join(tempRoot(), 'bun-fails-build');
  writeFileSync(failingBun, `#!/bin/sh
if [ "$1" = "build" ]; then
  echo 'simulated frontend compilation failure' >&2
  exit 41
fi
exit 42
`);
  chmodSync(failingBun, 0o755);
  const priorBunBin = process.env.BUN_BIN;
  process.env.BUN_BIN = failingBun;
  try {
    let frontendFailure;
    try {
      buildSnapshot({ engineRoot: strategyRoot, dataRepo: fixture.dataRepo, instancePath: fixture.instancePath, output });
    } catch (error) {
      frontendFailure = error;
    }
    assert.ok(frontendFailure);
  } finally {
    if (priorBunBin === undefined) delete process.env.BUN_BIN;
    else process.env.BUN_BIN = priorBunBin;
  }

  assert.equal(readFileSync(join(output, 'sentinel.txt'), 'utf8'), beforeSentinel);
  assert.deepEqual(readdirSync(dirname(output)).filter(name => name.startsWith('.tracker-viewer.next-')), []);
});

test('unified snapshots keep commitment stages, plan links, and history outside the common item collection', () => {
  const accepted = syntheticRecord({ id: 'accepted-task', type: 'task', status: 'active', phase: 'build', owner: 'don', parent: '-', depends_on: '-', updated_at: '2026-10-01', commitment: 'accepted', accepted_from: 'planned', plan: 'delivery-plan', health_state: 'unknown', health_reason: 'review', missing_information: 'none', suggested_action: 'review', suggested_actor: 'don' });
  const planned = syntheticRecord({ id: 'planned-task', type: 'task', status: 'queued', phase: 'build', owner: 'unassigned', parent: '-', depends_on: '-', updated_at: '2026-10-01', commitment: 'planned', plan: 'delivery-plan', health_state: 'unknown', health_reason: 'review', missing_information: 'none', suggested_action: 'review', suggested_actor: 'don' });
  const history = syntheticRecord({ id: 'old-task', type: 'task', status: 'done', owner: 'don', parent: '-', depends_on: '-', updated_at: '2026-09-01', superseded_by: 'accepted-task' }, 'tracker/history/old-task.md');
  const plan = syntheticRecord({ id: 'delivery-plan', project: 'accepted-task', status: 'proposed', owner: 'don', updated_at: '2026-10-01' }, 'tracker/plans/delivery-plan.md');
  const data = buildTrackerData({ items: [accepted, planned], plans: [plan], history: [history], migrations: [], decisions: [], releases: [], updates: [], milestones: [], capacities: [], legacyApprovals: {} }, { ownerNames: new Map() });
  assert.equal(data.schemaVersion, 4);
  assert.deepEqual(data.items.map(item => [item.id, item.commitment]), [['accepted-task', 'accepted'], ['planned-task', 'planned']]);
  assert.equal(data.items.every(item => !Object.hasOwn(item, 'planned')), true);
  assert.deepEqual(data.plans[0].taskIds, ['accepted-task', 'planned-task']);
  assert.equal(Object.hasOwn(data.plans[0], 'tasks'), false);
  assert.equal(data.history.length, 1);
  assert.equal(data.history[0].supersededBy, 'accepted-task');
  assert.equal(data.history[0].evidence, 'recorded evidence');
});

test('fresh approval replaces stale legacy provenance and keeps its approved schedule', () => {
  const fresh = syntheticRecord({
    id: 'fresh-approval',
    type: 'task',
    status: 'queued',
    phase: 'build',
    owner: 'unassigned',
    parent: '-',
    depends_on: '-',
    updated_at: '2026-10-01',
    commitment: 'accepted',
    accepted_from: 'planned',
    revision: 'r2',
    approval_state: 'approved',
    approved_parts: 'task,schedule',
    approved_by: 'owner',
    approved_at: '2026-10-01T10:00:00Z',
    approval_ref: 'chat://fresh/fresh-approval/r2',
    approved_revision: 'r2',
    reviewed_detail: 'The fresh task scope and schedule were reviewed.',
    approval_source: 'chatgpt-chat',
    planned_start: '2026-10-02',
    planned_end: '2026-10-05',
    health_state: 'unknown',
    health_reason: 'scope is recorded',
    missing_information: 'evidence',
    suggested_action: 'review evidence',
    suggested_actor: 'don'
  });
  fresh.data.approval_digest = taskApprovalDigest(fresh);
  const decision = syntheticRecord({
    id: 'old-approval',
    state: 'approved',
    approved_by: 'owner',
    approved_at: '2026-09-30',
    approval_ref: 'chat://old/fresh-approval',
    approval_source: 'old-chat',
    affects: 'fresh-approval'
  }, '# old-approval\n\n## Evidence\nold evidence');
  const data = buildTrackerData({
    items: [fresh],
    plans: [],
    history: [],
    migrations: [],
    decisions: [decision],
    releases: [],
    updates: [],
    milestones: [],
    capacities: [],
    legacyApprovals: {
      'fresh-approval': { digest: 'a'.repeat(64), decision: 'old-approval' }
    }
  });
  const item = data.items[0];
  assert.equal(item.acceptance.approved, true);
  assert.equal(item.acceptance.legacy, false);
  assert.equal(item.acceptance.legacyDecision, null);
  assert.equal(item.approval.source, 'chatgpt-chat');
  assert.equal(item.approval.reference, 'chat://fresh/fresh-approval/r2');
  assert.equal(item.approval.digest, fresh.data.approval_digest);
  assert.equal(item.schedule.approved, true);
  assert.equal(item.schedule.plannedStart, '2026-10-02');
  assert.equal(item.schedule.plannedEnd, '2026-10-05');
});

test('planned dates stay proposed and scope-only accepted dates cannot become baselines', () => {
  const planned = syntheticRecord({ id: 'planned-dates', type: 'task', status: 'queued', phase: 'build', owner: 'unassigned', parent: '-', depends_on: '-', updated_at: '2026-10-01', commitment: 'planned', planned_start: '2026-10-01', planned_end: '2026-10-03', health_state: 'unknown', health_reason: 'review', missing_information: 'none', suggested_action: 'review', suggested_actor: 'don' });
  const accepted = syntheticRecord({ id: 'scope-only-dates', type: 'task', status: 'queued', phase: 'build', owner: 'unassigned', parent: '-', depends_on: '-', updated_at: '2026-10-01', commitment: 'accepted', accepted_from: 'planned', planned_start: '2026-10-01', planned_end: '2026-10-03', approval_state: 'approved', approved_parts: 'task', health_state: 'unknown', health_reason: 'review', missing_information: 'none', suggested_action: 'review', suggested_actor: 'don' });
  const data = buildTrackerData({ items: [planned, accepted], plans: [], history: [], migrations: [], decisions: [], releases: [], updates: [], milestones: [], capacities: [], legacyApprovals: {} });
  assert.deepEqual(data.items.find(item => item.id === 'planned-dates').schedule, {
    plannedStart: '2026-10-01', plannedEnd: '2026-10-03', forecastStart: null, forecastEndMin: null, forecastEndMax: null, provisional: null, approved: false
  });
  assert.equal(data.items.find(item => item.id === 'scope-only-dates').schedule.plannedStart, null);
  assert.equal(data.items.find(item => item.id === 'scope-only-dates').schedule.approved, false);
});
