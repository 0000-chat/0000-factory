import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { parseInstanceConfig } from '../tooling/instance/config.mjs';
import { readTeamProjection, TeamProjectionInputError } from '../tooling/team-projection/reader.mjs';
import { buildTeamProjectionSnapshot } from '../tooling/team-projection/snapshot.mjs';
import { buildTeamProjectionPlanningArchive } from '../tooling/team-projection/presentation.mjs';
import { parsePlanningArchive } from '../tooling/planning/archive.mjs';
import { buildSnapshot } from '../tracker/viewer/tooling/build.mjs';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const EMPTY_DIGEST = `sha256:${'0'.repeat(64)}`;
const LINK_POLICY = {
  allowedEvidenceHosts: ['example.com', 'example.test', 'team.example.test', 'github.com'],
  forbiddenGitHubRepositories: ['synthetic-org/private-strategy'],
};

function teamSettings(overrides = {}) {
  return parseInstanceConfig({
    schemaVersion: 1,
    id: 'team-fixture',
    branding: {
      name: 'Team fixture', title: 'Team fixture', description: 'Team projection fixture',
      markText: 'TEAM', homeLabel: 'Team fixture', loadingLabel: 'Loading team fixture', faviconPath: 'assets/favicon.svg',
    },
    github: { owner: 'fixture', repo: 'team-data', branch: 'main' },
    data: {
      folderPath: '', layout: 'team-projection-v1', projectionPath: 'team/projection.json',
      evidence: { kind: 'none' }, projectionLinkPolicy: { allowedEvidenceHosts: ['example.com'], forbiddenGitHubRepositories: [] },
    },
    model: { approvalProtocol: 'don-v1' },
    browser: {
      namespace: 'team-fixture', storeId: 'team-fixture-store', themeKey: 'team-fixture-theme',
      editLockPrefix: 'team-fixture-edit', publishLockName: 'team-fixture-publish',
      unscheduledCollapsedKey: 'team-fixture.unscheduled', activityPausedKey: 'team-fixture.activity',
    },
    access: { kind: 'unconfigured' },
    publish: { kind: 'disabled' },
    deployment: {
      accountBinding: 'fixture-account', workerName: 'team-fixture', customDomain: 'team.fixture.test',
      compatibilityDate: '2026-09-30', compatibilityFlags: ['nodejs_compat'],
    },
    ...overrides,
  });
}

function projection(tasks = []) {
  return {
    schemaVersion: 1,
    kind: 'team-projection',
    projectionId: '2026-W41-r1-team',
    week: '2026-W41',
    revision: 'r1',
    policyRevision: 'sharing-v1',
    sourcePlanDigest: DIGEST,
    generatedAt: '2026-10-11T00:00:00Z',
    tasks,
    omissions: [],
  };
}

function task(taskId, overrides = {}) {
  return {
    taskId,
    title: `Task ${taskId}`,
    scope: 'A public scope',
    completionCondition: 'The public condition is met.',
    assignee: 'alexi',
    reviewer: 'don',
    status: 'started',
    nextStep: 'Continue the public next step.',
    approvedDate: null,
    forecastDate: '2026-10-18',
    checkpoint: null,
    dependencies: [{ summary: 'A public dependency summary.' }],
    evidenceLinks: ['https://example.com/evidence'],
    ...overrides,
  };
}

function standingProjection(tasks = [standingTask()]) {
  return {
    schemaVersion: 1,
    kind: 'standing-team-projection',
    projectionId: 'standing-team-projection',
    revision: 'r-standing-1',
    policyRevision: 'team-v1',
    generatedAt: '2026-10-11T00:00:00Z',
    tasks,
    gaps: tasks.length ? [{ taskId: tasks[0].taskId, field: 'description', reason: 'public-boundary', message: 'No private detail is exported.' }] : [],
    audit: {
      rule: 'assignee-approved-roster-unless-private',
      policyDigest: DIGEST,
      rosterDigest: DIGEST,
      fieldsDigest: DIGEST,
      approvalDigest: null,
      decisionId: null,
      approvalState: 'preview',
    },
    publish: {
      initialProjectionDigest: DIGEST,
      reviewed: false,
      activationEnabled: false,
    },
  };
}

function standingTask(overrides = {}) {
  return {
    taskId: 'standing-task',
    title: 'Standing public task',
    description: 'A public standing task description.',
    assignee: 'alexi',
    reviewer: 'don',
    status: 'active',
    nextStep: 'Continue the public standing work.',
    completionCriteria: 'The public standing condition is met.',
    deadline: { label: 'approved', date: '2026-10-18' },
    ...overrides,
  };
}

function writeFixture(value) {
  const root = mkdtempSync(join(tmpdir(), 'team-projection-'));
  mkdirSync(join(root, 'assets'), { recursive: true });
  mkdirSync(join(root, 'team'), { recursive: true });
  writeFileSync(join(root, 'assets/favicon.svg'), '<svg/>\n');
  writeFileSync(join(root, 'team/projection.json'), `${JSON.stringify(value)}\n`);
  return root;
}

test('team settings use a strict projection path and disable controls', () => {
  const instance = teamSettings();
  assert.equal(instance.data.layout, 'team-projection-v1');
  assert.equal(instance.data.projectionPath, 'team/projection.json');
  assert.deepEqual(instance.data.projectionLinkPolicy, { allowedEvidenceHosts: ['example.com'], forbiddenGitHubRepositories: [] });
  assert.equal(instance.publish.kind, 'disabled');
  assert.throws(() => teamSettings({ publish: { kind: 'github-app' } }), /disabled publishing/);
  assert.throws(() => teamSettings({ access: { kind: 'ready', teamDomain: 'https://team.fixture.test', audience: 'team', readerEmails: ['reader@fixture.test'], service: { kind: 'enabled', clientId: 'svc' } } }), /disabled Access service/);
  assert.throws(() => teamSettings({ data: { folderPath: '', layout: 'team-projection-v1', projectionPath: '../private.json', evidence: { kind: 'none' } } }), /projectionPath/);
  assert.throws(() => teamSettings({ data: { folderPath: '', layout: 'team-projection-v1', projectionPath: 'team/%2e%2e/private.json', evidence: { kind: 'none' } } }), /projectionPath/);
  assert.throws(() => teamSettings({ data: { folderPath: '', layout: 'team-projection-v1', projectionPath: 'team/projection.json', evidence: { kind: 'grok-bot-v1' } } }), /must not load evidence/);
  assert.throws(() => teamSettings({ data: { folderPath: '', layout: 'team-projection-v1', projectionPath: 'team/projection.json', evidence: { kind: 'none' }, projectionLinkPolicy: { allowedEvidenceHosts: ['127.0.0.1'], forbiddenGitHubRepositories: [] } } }), /public DNS evidence host/);
  assert.throws(() => teamSettings({ data: { folderPath: '', layout: 'team-projection-v1', projectionPath: 'team/projection.json', evidence: { kind: 'none' }, projectionLinkPolicy: { allowedEvidenceHosts: ['example.com'], forbiddenGitHubRepositories: ['bad repository'] } } }), /invalid format/);
  assert.throws(() => teamSettings({ data: { folderPath: '', layout: 'team-projection-v1', projectionPath: 'team/projection.json', evidence: { kind: 'none' }, projectionLinkPolicy: { allowedEvidenceHosts: ['example.com'], forbiddenGitHubRepositories: [], extra: true } } }), /unknown field/);
});

test('reader accepts only the public projection and adapter returns an empty-canonical snapshot', () => {
  const root = writeFixture(projection([task('public-task')]));
  const loaded = readTeamProjection({ dataRoot: root, projectionPath: 'team/projection.json', linkPolicy: LINK_POLICY });
  assert.equal(loaded.projection.tasks[0].taskId, 'public-task');
  const snapshot = buildTeamProjectionSnapshot(loaded.projection, { commit: 'unknown', builtAt: '2026-10-11T00:00:00Z' });
  assert.equal(snapshot.schemaVersion, 4);
  assert.equal(snapshot.source.layout, 'team-projection-v1');
  assert.equal(snapshot.items.length, 1);
  assert.equal(snapshot.items[0].sections.outcome, 'A public scope');
  assert.equal(snapshot.items[0].updatedAt, null);
  assert.equal(snapshot.items[0].completedAt, null);
  assert.equal(snapshot.items[0].sections.reviewer, 'don');
  assert.deepEqual(snapshot.items[0].teamProjection.dependencies, ['A public dependency summary.']);
  assert.equal(snapshot.items[0].approval.approvalRef, undefined);
  assert.equal(snapshot.decisions.length, 0);
  assert.equal(snapshot.history.length, 0);
  assert.equal(snapshot.deliveryRecords.length, 0);
  assert.equal(snapshot.items[0].sourcePath, null);
  const archive = buildTeamProjectionPlanningArchive(loaded.projection);
  assert.equal(archive.entries.length, 1);
  assert.equal(archive.currentDraftId, null);
  assert.equal(archive.latestApprovedId, null);
  assert.equal(archive.entries[0].status, 'blocked');
  assert.equal(archive.entries[0].presentationKind, 'team-projection');
  assert.equal(archive.entries[0].plan.presentationKind, 'team-projection');
  assert.equal(archive.entries[0].coverage.complete, false);
  assert.equal(Object.hasOwn(archive.entries[0], 'approvalReceipts'), false);
  assert.equal(Object.hasOwn(archive.entries[0].plan, 'canonicalTaskRefs'), false);
  assert.equal(archive.entries[0].plan.outcomes[0].projectionTaskId, 'public-task');
  assert.deepEqual(archive.entries[0].plan.approvalRefs, []);
  assert.doesNotThrow(() => parsePlanningArchive(archive));
});

test('reader normalizes the standing projection contract without exporting audit or publish metadata', () => {
  const root = writeFixture(standingProjection());
  const loaded = readTeamProjection({ dataRoot: root, projectionPath: 'team/projection.json' });
  assert.equal(loaded.projection.kind, 'team-projection');
  assert.equal(loaded.projection.week, '2026-W41');
  assert.match(loaded.projection.sourcePlanDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(loaded.projection.tasks[0].scope, 'A public standing task description.');
  assert.equal(loaded.projection.tasks[0].completionCondition, 'The public standing condition is met.');
  assert.equal(loaded.projection.tasks[0].status, 'active');
  assert.equal(loaded.projection.tasks[0].approvedDate, '2026-10-18');
  assert.equal(loaded.projection.tasks[0].forecastDate, null);
  assert.deepEqual(loaded.projection.tasks[0].dependencies, []);
  assert.deepEqual(loaded.projection.tasks[0].evidenceLinks, []);

  const snapshot = buildTeamProjectionSnapshot(loaded.projection);
  assert.equal(snapshot.items[0].status, 'active');
  assert.equal(snapshot.items[0].sections.outcome, 'A public standing task description.');
  assert.equal(snapshot.items[0].schedule.plannedEnd, '2026-10-18');
  assert.equal(JSON.stringify(snapshot).includes('approvalDigest'), false);
  assert.equal(JSON.stringify(snapshot).includes('activationEnabled'), false);
  assert.equal(snapshot.history.length, 0);
  assert.equal(snapshot.decisions.length, 0);

  const archive = buildTeamProjectionPlanningArchive(loaded.projection);
  assert.equal(archive.entries[0].week, '2026-W41');
  assert.equal(archive.entries[0].plan.outcomes[0].status, 'active');
  assert.equal(archive.entries[0].plan.outcomes[0].approvedDate, '2026-10-18');
  assert.equal(JSON.stringify(archive).includes('approvalDigest'), false);
  assert.doesNotThrow(() => parsePlanningArchive(archive));
});

test('standing hierarchy preserves safe ancestor context while keeping task fields explicit', () => {
  const project = { id: 'project-alpha', title: 'Project Alpha', kind: 'project', parentId: null };
  const workstream = { id: 'workstream-alpha', title: 'Workstream Alpha', kind: 'workstream', parentId: project.id };
  const hierarchical = {
    ...standingProjection([standingTask({ taskId: 'task-alpha', parentId: workstream.id })]),
    schemaVersion: 2,
    policyRevision: 'standing-sharing-v2',
    hierarchyVersion: 1,
    contextNodes: [project, workstream],
  };
  const root = writeFixture(hierarchical);
  const loaded = readTeamProjection({ dataRoot: root, projectionPath: 'team/projection.json' });
  assert.equal(loaded.projection.tasks[0].parentId, workstream.id);
  assert.deepEqual(loaded.projection.contextNodes, [project, workstream]);

  const snapshot = buildTeamProjectionSnapshot(loaded.projection);
  assert.deepEqual(snapshot.rootsByBucket.other, [project.id]);
  assert.deepEqual(snapshot.defaultExpanded, [project.id, workstream.id]);
  const projectItem = snapshot.items.find(item => item.id === project.id);
  const workstreamItem = snapshot.items.find(item => item.id === workstream.id);
  const taskItem = snapshot.items.find(item => item.id === 'task-alpha');
  assert.equal(projectItem.contextOnly, true);
  assert.equal(projectItem.status, '');
  assert.equal(projectItem.type, 'project');
  assert.equal(projectItem.parent, null);
  assert.deepEqual(projectItem.childIds, [workstream.id]);
  assert.equal(workstreamItem.contextOnly, true);
  assert.equal(workstreamItem.parent, project.id);
  assert.deepEqual(workstreamItem.childIds, ['task-alpha']);
  assert.equal(taskItem.contextOnly, undefined);
  assert.equal(taskItem.type, 'task');
  assert.equal(taskItem.parent, workstream.id);
  assert.equal(taskItem.teamProjection.parentId, workstream.id);
});

test('standing hierarchy accepts a mixed task and context ancestor chain', () => {
  const hierarchical = {
    ...standingProjection([
      standingTask({ taskId: 'eligible-grandparent', parentId: null }),
      standingTask({ taskId: 'eligible-child', parentId: 'context-parent' }),
    ]),
    schemaVersion: 2,
    policyRevision: 'standing-sharing-v2',
    hierarchyVersion: 1,
    contextNodes: [{ id: 'context-parent', title: 'Parent Context', kind: 'task', parentId: 'eligible-grandparent' }],
  };
  const root = writeFixture(hierarchical);
  const loaded = readTeamProjection({ dataRoot: root, projectionPath: 'team/projection.json' });
  const snapshot = buildTeamProjectionSnapshot(loaded.projection);
  assert.deepEqual(snapshot.rootsByBucket.other, ['eligible-grandparent']);
  assert.deepEqual(snapshot.items.find(item => item.id === 'eligible-grandparent')?.childIds, ['context-parent']);
  assert.deepEqual(snapshot.items.find(item => item.id === 'context-parent')?.childIds, ['eligible-child']);
  assert.equal(snapshot.items.find(item => item.id === 'context-parent')?.parent, 'eligible-grandparent');
  assert.equal(snapshot.items.find(item => item.id === 'eligible-child')?.parent, 'context-parent');
});

test('standing projection validates its explicit public contract and disabled publish barrier', () => {
  const invalidTaskField = standingProjection();
  invalidTaskField.tasks[0].scope = 'legacy field is not standing input';
  const invalidFieldRoot = writeFixture(invalidTaskField);
  assert.throws(() => readTeamProjection({ dataRoot: invalidFieldRoot, projectionPath: 'team/projection.json' }), /unknown field/u);

  const v1HierarchyField = standingProjection();
  v1HierarchyField.tasks[0].parentId = null;
  const v1HierarchyFieldRoot = writeFixture(v1HierarchyField);
  assert.throws(() => readTeamProjection({ dataRoot: v1HierarchyFieldRoot, projectionPath: 'team/projection.json' }), /unknown field/u);

  const invalidPublish = standingProjection();
  invalidPublish.publish.activationEnabled = true;
  const invalidPublishRoot = writeFixture(invalidPublish);
  assert.throws(() => readTeamProjection({ dataRoot: invalidPublishRoot, projectionPath: 'team/projection.json' }), /disabled initial publish barrier/u);

  const invalidDeadline = standingProjection();
  invalidDeadline.tasks[0].deadline.privateNotes = 'must not be accepted';
  const invalidDeadlineRoot = writeFixture(invalidDeadline);
  assert.throws(() => readTeamProjection({ dataRoot: invalidDeadlineRoot, projectionPath: 'team/projection.json' }), /unknown field|private\/control/u);

  const invalidGap = standingProjection();
  invalidGap.gaps[0].taskId = 'missing-standing-task';
  const invalidGapRoot = writeFixture(invalidGap);
  assert.throws(() => readTeamProjection({ dataRoot: invalidGapRoot, projectionPath: 'team/projection.json' }), /known task ID/u);

  const privateStanding = standingProjection();
  privateStanding.tasks[0].description = 'password: private-value';
  const privateStandingRoot = writeFixture(privateStanding);
  assert.throws(() => readTeamProjection({ dataRoot: privateStandingRoot, projectionPath: 'team/projection.json' }), /team-safe string/u);

  const unknownParent = {
    ...standingProjection([standingTask({ parentId: 'missing-parent' })]),
    schemaVersion: 2,
    policyRevision: 'standing-sharing-v2',
    hierarchyVersion: 1,
    contextNodes: [],
  };
  const unknownParentRoot = writeFixture(unknownParent);
  assert.throws(() => readTeamProjection({ dataRoot: unknownParentRoot, projectionPath: 'team/projection.json' }), /must reference a task or context ancestor node/u);

  const cyclicContext = {
    ...standingProjection([standingTask({ parentId: 'context-a' })]),
    schemaVersion: 2,
    policyRevision: 'standing-sharing-v2',
    hierarchyVersion: 1,
    contextNodes: [
      { id: 'context-a', title: 'Context A', kind: 'workstream', parentId: 'context-b' },
      { id: 'context-b', title: 'Context B', kind: 'project', parentId: 'context-a' },
    ],
  };
  const cyclicContextRoot = writeFixture(cyclicContext);
  assert.throws(() => readTeamProjection({ dataRoot: cyclicContextRoot, projectionPath: 'team/projection.json' }), /parent cycle/u);

  const unreferencedContext = {
    ...standingProjection([standingTask({ taskId: 'task-without-context', parentId: null })]),
    schemaVersion: 2,
    policyRevision: 'standing-sharing-v2',
    hierarchyVersion: 1,
    contextNodes: [{ id: 'unreferenced-context', title: 'Unreferenced Context', kind: 'project', parentId: null }],
  };
  const unreferencedContextRoot = writeFixture(unreferencedContext);
  assert.throws(() => readTeamProjection({ dataRoot: unreferencedContextRoot, projectionPath: 'team/projection.json' }), /must be an ancestor of a shared task/u);

  const taskContextCollision = {
    ...standingProjection([standingTask({ taskId: 'same-node', parentId: null })]),
    schemaVersion: 2,
    policyRevision: 'standing-sharing-v2',
    hierarchyVersion: 1,
    contextNodes: [{ id: 'same-node', title: 'Same Node', kind: 'project', parentId: null }],
  };
  const taskContextCollisionRoot = writeFixture(taskContextCollision);
  assert.throws(() => readTeamProjection({ dataRoot: taskContextCollisionRoot, projectionPath: 'team/projection.json' }), /collides with task or context ID/u);

  const privateContext = {
    ...standingProjection([standingTask({})]),
    schemaVersion: 2,
    policyRevision: 'standing-sharing-v2',
    hierarchyVersion: 1,
    contextNodes: [{ id: 'context-private', title: 'Private', kind: 'project', parentId: null, privateNotes: 'must not cross boundary' }],
  };
  const privateContextRoot = writeFixture(privateContext);
  assert.throws(() => readTeamProjection({ dataRoot: privateContextRoot, projectionPath: 'team/projection.json' }), /unknown field|private\/control/u);
});

test('standing projection builds the production viewer payload and browser archive contract', () => {
  const root = writeFixture(standingProjection());
  const output = mkdtempSync(join(tmpdir(), 'standing-projection-output-'));
  try {
    writeFileSync(join(root, 'settings.json'), `${JSON.stringify(teamSettings(), null, 2)}\n`);
    const result = buildSnapshot({
      engineRoot: resolve(import.meta.dir, '..'),
      instancePath: join(root, 'settings.json'),
      dataRepo: root,
      output,
      builtAt: '2026-10-11T00:00:00Z',
    });
    const dataText = readFileSync(join(output, 'assets/data.json'), 'utf8');
    const data = JSON.parse(dataText);
    const archive = parsePlanningArchive(JSON.parse(readFileSync(join(output, 'assets/planning/archive.json'), 'utf8')));
    assert.equal(result.data.source.week, '2026-W41');
    assert.equal(data.items.length, 1);
    assert.equal(data.items[0].status, 'active');
    assert.equal(data.items[0].sections.outcome, 'A public standing task description.');
    assert.equal(dataText.includes('approvalDigest'), false);
    assert.equal(dataText.includes('activationEnabled'), false);
    assert.equal(archive.entries.length, 1);
    assert.equal(archive.entries[0].plan.outcomes[0].approvedDate, '2026-10-18');
    assert.equal(archive.entries[0].plan.outcomes[0].status, 'active');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(output, { recursive: true, force: true });
  }
});

test('hierarchical standing projection builds context rows and breadcrumbs without private task data', () => {
  const hierarchical = {
    ...standingProjection([standingTask({ taskId: 'task-alpha', parentId: 'workstream-alpha' })]),
    schemaVersion: 2,
    policyRevision: 'standing-sharing-v2',
    hierarchyVersion: 1,
    contextNodes: [
      { id: 'project-alpha', title: 'Project Alpha', kind: 'project', parentId: null },
      { id: 'workstream-alpha', title: 'Workstream Alpha', kind: 'workstream', parentId: 'project-alpha' },
    ],
  };
  const root = writeFixture(hierarchical);
  const output = mkdtempSync(join(tmpdir(), 'standing-hierarchy-output-'));
  try {
    writeFileSync(join(root, 'settings.json'), `${JSON.stringify(teamSettings(), null, 2)}\n`);
    buildSnapshot({
      engineRoot: resolve(import.meta.dir, '..'),
      instancePath: join(root, 'settings.json'),
      dataRepo: root,
      output,
      builtAt: '2026-10-11T00:00:00Z',
    });
    const dataText = readFileSync(join(output, 'assets/data.json'), 'utf8');
    const data = JSON.parse(dataText);
    const byId = new Map(data.items.map(item => [item.id, item]));
    assert.deepEqual(data.rootsByBucket.other, ['project-alpha']);
    assert.deepEqual(data.defaultExpanded, ['project-alpha', 'workstream-alpha']);
    assert.equal(byId.get('project-alpha').contextOnly, true);
    assert.equal(byId.get('project-alpha').parent, null);
    assert.equal(byId.get('workstream-alpha').parent, 'project-alpha');
    assert.equal(byId.get('task-alpha').parent, 'workstream-alpha');
    assert.equal(byId.get('task-alpha').contextOnly, undefined);
    assert.equal(dataText.includes('approvalDigest'), false);
    assert.equal(dataText.includes('activationEnabled'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(output, { recursive: true, force: true });
  }
});

test('reader rejects private fields, duplicate IDs, bad references, unsafe links, and symlinks', () => {
  const cases = [
    [projection([task('private-task', { privateNotes: 'sentinel' })]), /unknown field|private\/control/],
    [projection([task('same'), task('same')]), /duplicate task ID/],
    [{ ...projection([task('refs')]), omissions: [{ taskId: 'missing', field: 'title', reason: 'private' }] }, /unknown task/],
    [{ ...projection([task('omitted-private')]), omissions: [{ field: 'privateNotes', reason: 'private-by-default' }] }, /private\/control/],
    [projection([task('link', { evidenceLinks: ['https://example.com/?private=1'] })]), /query-free/],
    [projection([task('private-link', { evidenceLinks: ['https://private.example.test/work/task-1'] })]), /allowed evidence host/],
    [projection([task('private-link-trailing-dot', { evidenceLinks: ['https://private.example.test./work/task-1'] })]), /allowed evidence host/],
    [projection([task('private-source', { evidenceLinks: ['https://github.com/synthetic-org/private-strategy/blob/main/README.md'] })]), /allowed evidence host/],
    [projection([task('private-source-encoded', { evidenceLinks: ['https://github.com/synthetic-org/%70rivate-strategy/blob/main/README.md'] })]), /allowed evidence host/],
    [projection([task('private-ipv6', { evidenceLinks: ['https://[::1]/task-1'] })]), /allowed evidence host/],
    [projection([task('private-linklocal', { evidenceLinks: ['https://[fe80::1]/task-1'] })]), /allowed evidence host/],
    [projection([task('private-localhost-dot', { evidenceLinks: ['https://localhost./task-1'] })]), /allowed evidence host/],
    [projection([task('private-local-domain', { evidenceLinks: ['https://build.local/task-1'] })]), /allowed evidence host/],
  ];
  for (const [value, expected] of cases) {
    const root = writeFixture(value);
    assert.throws(() => readTeamProjection({ dataRoot: root, projectionPath: 'team/projection.json', linkPolicy: LINK_POLICY }), error => error instanceof TeamProjectionInputError && expected.test(error.message));
  }

  const root = writeFixture(projection([task('symlink')]));
  const outside = mkdtempSync(join(tmpdir(), 'team-projection-outside-'));
  writeFileSync(join(outside, 'projection.json'), JSON.stringify(projection([task('outside')])));
  symlinkSync(join(outside, 'projection.json'), join(root, 'team/projection.json.tmp'));
  assert.throws(() => readTeamProjection({ dataRoot: root, projectionPath: 'team/projection.json.tmp', linkPolicy: LINK_POLICY }), /symlinks/);
});

test('reader preserves ordinary product language and Markdown whitespace', () => {
  const root = writeFixture(projection([task('oauth', {
    title: 'Ship Slack OAuth token refresh',
    scope: 'Support the integration.\nDocument the customer handoff.',
    nextStep: 'Review the meeting notes shared in the public project channel.',
  })]));
  assert.doesNotThrow(() => readTeamProjection({ dataRoot: root, projectionPath: 'team/projection.json', linkPolicy: LINK_POLICY }));
  const teamHostRoot = writeFixture(projection([task('team-host', { evidenceLinks: ['https://team.example.test/evidence'] })]));
  assert.doesNotThrow(() => readTeamProjection({ dataRoot: teamHostRoot, projectionPath: 'team/projection.json', linkPolicy: LINK_POLICY }));
  const secretRoot = writeFixture(projection([task('secret', { nextStep: 'password: super-secret-value' })]));
  assert.throws(() => readTeamProjection({ dataRoot: secretRoot, projectionPath: 'team/projection.json', linkPolicy: LINK_POLICY }), /team-safe string/);
  const defaultPolicyRoot = writeFixture(projection([task('default-link')]));
  assert.throws(() => readTeamProjection({ dataRoot: defaultPolicyRoot, projectionPath: 'team/projection.json' }), /allowed evidence host/);
});

test('empty projection builds a real empty snapshot', () => {
  const root = writeFixture(projection());
  const loaded = readTeamProjection({ dataRoot: root, projectionPath: 'team/projection.json' });
  const snapshot = buildTeamProjectionSnapshot(loaded.projection);
  assert.deepEqual(snapshot.items, []);
  assert.deepEqual(snapshot.rootsByBucket, { other: [] });
  assert.equal(snapshot.source.layout, 'team-projection-v1');
  const archive = buildTeamProjectionPlanningArchive(loaded.projection);
  assert.equal(archive.entries[0].plan.outcomes.length, 0);
  assert.doesNotThrow(() => parsePlanningArchive(archive));
});

test('bootstrap projection is explicitly uninitialized and has no stale weekly episode', () => {
  const root = writeFixture(projection());
  const bootstrap = JSON.parse(String(readFileSync(join(root, 'team/projection.json'))));
  bootstrap.sourcePlanDigest = EMPTY_DIGEST;
  writeFileSync(join(root, 'team/projection.json'), `${JSON.stringify(bootstrap)}\n`);
  const loaded = readTeamProjection({ dataRoot: root, projectionPath: 'team/projection.json' });
  const snapshot = buildTeamProjectionSnapshot(loaded.projection, { builtAt: '2026-10-11T00:00:00Z' });
  assert.equal(snapshot.source.projectionState, 'uninitialized');
  assert.equal(snapshot.source.exportedAt, null);
  assert.equal(snapshot.source.builtAt, null);
  assert.deepEqual(buildTeamProjectionPlanningArchive(loaded.projection).entries, []);
  const nonEmpty = projection([task('real')]);
  nonEmpty.sourcePlanDigest = EMPTY_DIGEST;
  const nonEmptyRoot = writeFixture(nonEmpty);
  assert.throws(() => readTeamProjection({ dataRoot: nonEmptyRoot, projectionPath: 'team/projection.json' }), /zero digest/);
});
