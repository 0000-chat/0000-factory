import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { readTeamCompanion, validateTeamCompanion } from '../tooling/team-projection/companion.mjs';
import { readTeamProjection } from '../tooling/team-projection/reader.mjs';
import { buildTeamProjectionSnapshot } from '../tooling/team-projection/snapshot.mjs';
import { buildWorkProjection } from '../tracker/viewer/src/work-activity.mjs';
import { buildWorkGanttModel } from '../tracker/viewer/src/work-gantt-model.mjs';

const CHECK_ROOT = process.env.TMPDIR && process.env.TMPDIR !== '/tmp'
  ? process.env.TMPDIR
  : join(process.cwd(), '.tmp-team-companion-checks');

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

function digest(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')}`;
}

function companion() {
  const value = {
    schemaVersion: 1,
    kind: 'team-safe-companion',
    projectionDigest: `sha256:${'1'.repeat(64)}`,
    projectionRevision: 'r-safe',
    policyRevision: 'standing-sharing-v2',
    generatedAt: '2026-10-12T00:00:00.000Z',
    directory: [{ id: 'person-1', displayName: 'Synthetic Person', avatar: 'person-1.webp' }],
    schedules: [{ taskId: 'task-safe', approvedStart: '2026-10-01', approvedEnd: '2026-10-02' }],
    proposedSchedules: [],
    taskMetadata: [{ taskId: 'task-safe', status: 'active', commitment: 'accepted', phase: 'build', healthState: 'on-track' }],
    contextMetadata: [],
    releaseMetadata: [],
    audit: {
      directoryRule: 'approved-roster-safe-display-metadata-only',
      scheduleRule: 'approved-endpoint-only-with-existing-task-proof',
      sourceTaskCount: 1,
      rosterDigest: digest(['person-1']),
    },
    publish: { reviewed: false, activationEnabled: false },
  };
  return { ...value, companionDigest: digest(value) };
}

function projection() {
  return {
    sourcePlanDigest: `sha256:${'2'.repeat(64)}`,
    projectionId: 'projection-safe',
    week: '2026-W41',
    revision: 'r-safe',
    policyRevision: 'standing-sharing-v2',
    tasks: [{
      taskId: 'task-safe',
      title: 'Safe task',
      scope: 'Public scope',
      completionCondition: 'Public completion',
      assignee: 'person-1',
      reviewer: null,
      status: 'started',
      nextStep: 'Public next step',
      approvedDate: '2026-10-02',
      forecastDate: null,
      checkpoint: null,
      dependencies: [],
      evidenceLinks: [],
      parentId: null,
    }],
    contextNodes: [],
  };
}

function fullTaskProjection() {
  const tasks = [
    {
      taskId: 'full-approved', title: 'Approved full task', description: 'Approved description', assignee: 'person-1', reviewer: null,
      status: 'active', nextStep: 'Approved next step', completionCriteria: 'Approved completion', deadline: { label: 'approved', date: '2026-10-20' }, parentId: 'full-project',
    },
    {
      taskId: 'full-forecast', title: 'Forecast full task', description: 'Forecast description', assignee: null, reviewer: 'person-1',
      status: 'queued', nextStep: 'Forecast next step', completionCriteria: 'Forecast completion', deadline: { label: 'forecast', date: '2026-10-27' }, parentId: 'full-project',
    },
  ];
  const contextNodes = [{ id: 'full-project', kind: 'project', title: 'Full project', parentId: null }];
  const fields = ['taskId', 'title', 'description', 'assignee', 'reviewer', 'status', 'nextStep', 'completionCriteria', 'deadline'];
  const scope = {
    mode: 'one-time-current-task-copy', scope: 'all-current-canonical-task-records', sourceTaskKind: 'task',
    includesDonOwned: true, includesUnassigned: true, privateRule: 'private-true-excluded',
  };
  const policy = {
    ...scope, policyRevision: 'manual-full-current-task-copy-v1', hierarchyVersion: 1,
    hierarchyContextFields: ['id', 'kind', 'title', 'parentId'], fields: [...fields].sort(),
  };
  const value = {
    schemaVersion: 1, kind: 'full-task-projection', projectionId: 'full-directory-only', revision: 'r-full-directory-only',
    policyRevision: 'manual-full-current-task-copy-v1', generatedAt: '2026-10-12T00:00:00Z', hierarchyVersion: 1,
    contextNodes, tasks, gaps: [], audit: {
      ...scope, fieldsDigest: digest([...fields].sort()), scopeDigest: digest(scope), policyDigest: digest(policy),
      selectionDigest: digest({ ...scope, taskIds: tasks.map(task => task.taskId).sort() }), taskIdsDigest: digest(tasks.map(task => task.taskId).sort()),
      taskCount: tasks.length, contextNodeCount: contextNodes.length, approvalState: 'preview', decisionId: null,
    }, publish: { initialProjectionDigest: null, reviewed: false, activationEnabled: false },
  };
  value.publish.initialProjectionDigest = digest({ ...value, publish: { ...value.publish, initialProjectionDigest: null } });
  return value;
}

function directoryOnlyCompanion(projectionValue) {
  const value = {
    schemaVersion: 1, kind: 'team-safe-companion', mode: 'directory-only-v3',
    projectionDigest: digest({ ...projectionValue, publish: { ...projectionValue.publish, initialProjectionDigest: null } }),
    projectionRevision: projectionValue.revision, policyRevision: projectionValue.policyRevision, generatedAt: '2026-10-12T00:00:00Z',
    directory: [{ id: 'person-1', displayName: 'Synthetic Person', avatar: 'person-1.webp' }], schedules: [], proposedSchedules: [], taskMetadata: [], contextMetadata: [],
    audit: {
      directoryRule: 'approved-roster-safe-display-metadata-only', scheduleRule: 'directory-only-no-task-schedules',
      sourceTaskCount: projectionValue.tasks.length, rosterDigest: digest(['person-1']),
    }, publish: { reviewed: false, activationEnabled: false },
  };
  return { ...value, companionDigest: digest(value) };
}

function fullCurrentCompanion(projectionValue) {
  const value = {
    schemaVersion: 1, kind: 'team-safe-companion',
    projectionDigest: digest({ ...projectionValue, publish: { ...projectionValue.publish, initialProjectionDigest: null } }),
    projectionRevision: projectionValue.revision, policyRevision: projectionValue.policyRevision, generatedAt: '2026-10-12T00:00:00Z',
    directory: [{ id: 'person-1', displayName: 'Synthetic Person', avatar: 'person-1.webp' }],
    schedules: [
      { taskId: 'full-approved', approvedStart: '2026-10-18', approvedEnd: '2026-10-20' },
      { taskId: 'full-project', approvedStart: '2026-09-30', approvedEnd: '2026-10-23', provisional: true },
    ],
    proposedSchedules: [{ taskId: 'full-forecast', proposedStart: '2026-10-21', proposedEnd: '2026-10-27', proposedScheduleKind: 'span' }],
    taskMetadata: [
      { taskId: 'full-approved', status: 'active', commitment: 'accepted', phase: 'build', healthState: 'on-track' },
      { taskId: 'full-forecast', status: 'queued', commitment: 'planned', phase: 'discovery', healthState: 'unknown' },
    ],
    contextMetadata: [{ contextId: 'full-project', owner: 'person-1', ownerName: 'Synthetic Person', healthState: 'on-track', target: '2026-11-15' }],
    releaseMetadata: [{ releaseId: 'full-release', projectId: 'full-project', title: 'Synthetic release', owner: 'person-1', ownerName: 'Synthetic Person', status: 'scoping', target: '2026-11-15' }],
    activitySummaries: [
      { taskId: 'full-approved', eventCount: 3, latestOccurredAt: '2026-10-20T03:00:00Z', occurredDates: ['2026-10-18', '2026-10-20'], activityKinds: ['work'] },
      { taskId: 'full-forecast', eventCount: 0, latestOccurredAt: null, occurredDates: [], activityKinds: [] },
      { taskId: 'full-project', eventCount: 0, latestOccurredAt: null, occurredDates: [], activityKinds: [] },
    ],
    audit: {
      directoryRule: 'approved-roster-safe-display-metadata-only', scheduleRule: 'approved-endpoint-only-with-existing-task-proof',
      sourceTaskCount: projectionValue.tasks.length, rosterDigest: digest(['person-1']),
    },
    publish: { reviewed: false, activationEnabled: false },
  };
  return { ...value, companionDigest: digest(value) };
}

test('companion metadata drives safe identity and approved endpoint rendering', () => {
  const value = companion();
  assert.equal(validateTeamCompanion(value).valid, true);
  const snapshot = buildTeamProjectionSnapshot(projection(), {}, { ...value, staleSchedule: false });
  const [item] = snapshot.items;
  assert.equal(item.ownerName, 'Synthetic Person');
  assert.equal(item.schedule.plannedStart, '2026-10-01');
  assert.equal(item.schedule.plannedEnd, '2026-10-02');
  assert.equal(item.schedule.approved, true);
  assert.equal(item.commitment, 'accepted');
  assert.equal(item.phase, 'build');
  assert.equal(item.health.state, 'on-track');
  assert.equal(snapshot.team[0].avatarUrl, '/avatars/person-1.webp');
  const donorSnapshot = buildTeamProjectionSnapshot({ ...projection(), tasks: [{ ...projection().tasks[0], assignee: 'don' }] }, {}, { ...value, staleSchedule: false });
  assert.equal(donorSnapshot.items[0].ownerName, 'Don');
});

test('directory-only v3 binds full task input while preserving canonical task fields and dates', () => {
  const projectionValue = fullTaskProjection();
  const companionValue = directoryOnlyCompanion(projectionValue);
  const root = join(CHECK_ROOT, 'directory-only-v3');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'projection.json'), `${JSON.stringify(projectionValue)}\n`, { mode: 0o600 });
  writeFileSync(join(root, 'companion.json'), `${JSON.stringify(companionValue)}\n`, { mode: 0o600 });
  try {
    const loaded = readTeamProjection({ dataRoot: root, projectionPath: 'projection.json', linkPolicy: { allowedEvidenceHosts: [], forbiddenGitHubRepositories: [] } });
    assert.deepEqual(loaded.rawProjection, projectionValue);
    const companionRead = readTeamCompanion({
      dataRoot: root,
      companionPath: 'companion.json',
      projection: loaded.rawProjection,
      expectedRosterDigest: digest(['person-1']),
    });
    assert.equal(companionRead.directoryOnly, true);
    assert.deepEqual(companionRead.schedules, []);
    assert.deepEqual(companionRead.taskMetadata, []);
    const snapshot = buildTeamProjectionSnapshot(loaded.projection, {}, companionRead);
    assert.equal(snapshot.people.length, 1);
    assert.equal(snapshot.people[0].avatarUrl, '/avatars/person-1.webp');
    const approved = snapshot.items.find(item => item.id === 'full-approved');
    const forecast = snapshot.items.find(item => item.id === 'full-forecast');
    assert.deepEqual({
      title: approved.title, description: approved.sections.outcome, status: approved.status, nextStep: approved.sections.nextStep,
      completion: approved.sections.completionCondition, owner: approved.owner, reviewer: approved.teamProjection.reviewer,
      target: approved.target, approvedDate: approved.teamProjection.approvedDate, parent: approved.parent,
    }, {
      title: 'Approved full task', description: 'Approved description', status: 'active', nextStep: 'Approved next step',
      completion: 'Approved completion', owner: 'person-1', reviewer: null, target: '2026-10-20', approvedDate: '2026-10-20', parent: 'full-project',
    });
    assert.deepEqual({
      title: forecast.title, description: forecast.sections.outcome, status: forecast.status, nextStep: forecast.sections.nextStep,
      completion: forecast.sections.completionCondition, owner: forecast.owner, reviewer: forecast.teamProjection.reviewer,
      target: forecast.target, forecastDate: forecast.teamProjection.forecastDate, parent: forecast.parent,
    }, {
      title: 'Forecast full task', description: 'Forecast description', status: 'queued', nextStep: 'Forecast next step',
      completion: 'Forecast completion', owner: null, reviewer: 'person-1', target: null, forecastDate: '2026-10-27', parent: 'full-project',
    });
    const untrusted = readTeamCompanion({ dataRoot: root, companionPath: 'companion.json', projection: loaded.rawProjection });
    assert.deepEqual(untrusted.directory, []);
    assert.equal(untrusted.trustedRosterMismatch, true);
    const wrongRoster = readTeamCompanion({
      dataRoot: root,
      companionPath: 'companion.json',
      projection: loaded.rawProjection,
      expectedRosterDigest: digest(['different-person']),
    });
    assert.deepEqual(wrongRoster.directory, []);
    assert.equal(wrongRoster.trustedRosterMismatch, true);
  } finally {
    unlinkSync(join(root, 'projection.json'));
    unlinkSync(join(root, 'companion.json'));
  }
});

test('full-current companion normalizes approved ranges, safe health, hierarchy ownership, and redacted activity', () => {
  const projectionValue = fullTaskProjection();
  const companionValue = fullCurrentCompanion(projectionValue);
  assert.equal(validateTeamCompanion(companionValue, projectionValue).valid, true);
  const root = join(CHECK_ROOT, 'full-current-companion');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'projection.json'), `${JSON.stringify(projectionValue)}\n`, { mode: 0o600 });
  writeFileSync(join(root, 'companion.json'), `${JSON.stringify(companionValue)}\n`, { mode: 0o600 });
  try {
    const loaded = readTeamProjection({ dataRoot: root, projectionPath: 'projection.json', linkPolicy: { allowedEvidenceHosts: [], forbiddenGitHubRepositories: [] } });
    const companionRead = readTeamCompanion({ dataRoot: root, companionPath: 'companion.json', projection: loaded.rawProjection, expectedRosterDigest: digest(['person-1']) });
    assert.equal(companionRead.directoryOnly, false);
    assert.equal(companionRead.staleActivity, false);
    const snapshot = buildTeamProjectionSnapshot(loaded.projection, {}, companionRead);
    const approved = snapshot.items.find(item => item.id === 'full-approved');
    const context = snapshot.items.find(item => item.id === 'full-project');
    const forecast = snapshot.items.find(item => item.id === 'full-forecast');
    assert.deepEqual({
      plannedStart: approved.schedule.plannedStart,
      plannedEnd: approved.schedule.plannedEnd,
      approved: approved.schedule.approved,
      health: approved.health.state,
      activityCount: approved.activitySummary.eventCount,
      activityEvidence: snapshot.activityEvidence,
    }, {
      plannedStart: '2026-10-18',
      plannedEnd: '2026-10-20',
      approved: true,
      health: 'on-track',
      activityCount: 3,
        activityEvidence: [{
        id: 'team-activity-summary-full-approved-1', originalItemId: 'full-approved', originalUpdateId: null,
        itemId: 'full-approved', sourceEventId: 'team-activity-summary-full-approved-2026-10-18', occurredAt: '2026-10-18', discoveredAt: '2026-10-18',
        kind: 'work', summary: '3 team activity events recorded', attributionBasis: 'team-safe-activity-summary', evidenceRef: null,
        included: true, amendmentIds: [], approvalDecisionIds: [],
      }, {
        id: 'team-activity-summary-full-approved-2', originalItemId: 'full-approved', originalUpdateId: null,
        itemId: 'full-approved', sourceEventId: 'team-activity-summary-full-approved-2026-10-20', occurredAt: '2026-10-20', discoveredAt: '2026-10-20',
        kind: 'work', summary: '3 team activity events recorded', attributionBasis: 'team-safe-activity-summary', evidenceRef: null,
        included: true, amendmentIds: [], approvalDecisionIds: [],
      }],
    });
    assert.equal(context.owner, 'person-1');
    assert.equal(context.ownerName, 'Synthetic Person');
    assert.equal(context.health.state, 'on-track');
    assert.equal(context.target, '2026-11-15');
    assert.deepEqual({ proposedStart: forecast.schedule.proposedStart, proposedEnd: forecast.schedule.proposedEnd, proposedScheduleKind: forecast.schedule.proposedScheduleKind }, {
      proposedStart: '2026-10-21', proposedEnd: '2026-10-27', proposedScheduleKind: 'span',
    });
    assert.deepEqual(snapshot.releases, [{ id: 'full-release', title: 'Synthetic release', project: 'full-project', owner: 'person-1', ownerName: 'Synthetic Person', status: 'scoping', target: '2026-11-15', sourcePath: null }]);
    assert.deepEqual({ plannedStart: context.schedule.plannedStart, plannedEnd: context.schedule.plannedEnd, provisional: context.schedule.provisional, approved: context.schedule.approved }, {
      plannedStart: '2026-09-30', plannedEnd: '2026-10-23', provisional: true, approved: true,
    });
    assert.doesNotMatch(JSON.stringify(companionRead), /sourcePath|privateNotes|transcript|credential/u);
    const workProjection = buildWorkProjection({ items: snapshot.items, evidence: snapshot.activityEvidence, now: '2026-10-21' });
    assert.equal(workProjection.get('full-approved').own.state, 'recent');

    const mismatched = readTeamCompanion({
      dataRoot: root,
      companionPath: 'companion.json',
      projection: loaded.rawProjection,
      expectedRosterDigest: digest(['different-person']),
    });
    assert.equal(mismatched.trustedRosterMismatch, true);
    assert.deepEqual(mismatched.directory, []);
    assert.deepEqual(mismatched.schedules, []);
    assert.deepEqual(mismatched.taskMetadata, []);
    assert.deepEqual(mismatched.activitySummaries, []);
    assert.deepEqual(mismatched.contextMetadata, []);
    assert.deepEqual(mismatched.releaseMetadata, []);
  } finally {
    unlinkSync(join(root, 'projection.json'));
    unlinkSync(join(root, 'companion.json'));
  }
});

test('a valid companion schedule allowlist clears omitted baseline deadlines', () => {
  const base = projection();
  const value = companion();
  const boundProjection = {
    kind: 'standing-team-projection',
    ...base,
    policyRevision: value.policyRevision,
    audit: { rosterDigest: value.audit.rosterDigest },
    tasks: [
      ...base.tasks.map(task => ({ ...task, status: 'active' })),
      { ...base.tasks[0], taskId: 'task-end-only-one', title: 'End-only one', status: 'active', approvedDate: '2026-10-04' },
      { ...base.tasks[0], taskId: 'task-end-only-two', title: 'End-only two', status: 'active', approvedDate: '2026-10-05' },
    ],
  };
  const allowlisted = {
    ...value,
    projectionDigest: digest(boundProjection),
    schedules: [
      { taskId: 'task-end-only-one', approvedStart: null, approvedEnd: '2026-10-04' },
      { taskId: 'task-end-only-two', approvedStart: null, approvedEnd: '2026-10-05' },
    ],
    taskMetadata: [],
  };
  delete allowlisted.companionDigest;
  allowlisted.companionDigest = digest(allowlisted);
  const path = join(CHECK_ROOT, 'team-safe-companion-allowlist.json');
  mkdirSync(CHECK_ROOT, { recursive: true });
  writeFileSync(path, `${JSON.stringify(allowlisted)}\n`, { mode: 0o600 });
  try {
    const read = readTeamCompanion({ dataRoot: CHECK_ROOT, companionPath: 'team-safe-companion-allowlist.json', projection: boundProjection, expectedRosterDigest: digest(['person-1']) });
    assert.equal(read.staleSchedule, false);
    const snapshot = buildTeamProjectionSnapshot(boundProjection, {}, read);
    const omitted = snapshot.items.find(item => item.id === 'task-safe');
    assert.equal(omitted.sections.outcome, 'Public scope');
    assert.equal(omitted.target, null);
    assert.equal(omitted.teamProjection.approvedDate, null);
    assert.equal(omitted.teamProjection.approvedStart, null);
    assert.equal(omitted.teamProjection.approvedEnd, null);
    assert.equal(omitted.schedule.plannedStart, null);
    assert.equal(omitted.schedule.plannedEnd, null);
    assert.equal(omitted.schedule.approved, false);
    assert.equal(omitted.schedule.provisional, true);
    const workProjection = buildWorkProjection({ items: snapshot.items, evidence: snapshot.activityEvidence, now: '2026-10-12' });
    const gantt = buildWorkGanttModel({
      projection: workProjection,
      visibleIds: new Set(workProjection.keys()),
      expandedIds: new Set(),
    });
    assert.equal(gantt.rows.find(row => row.id === 'task-safe').marks.some(mark => mark.sourceKind === 'approved'), false);
    for (const [taskId, end] of [['task-end-only-one', '2026-10-04'], ['task-end-only-two', '2026-10-05']]) {
      const item = snapshot.items.find(candidate => candidate.id === taskId);
      assert.equal(item.target, end);
      assert.equal(item.teamProjection.approvedDate, end);
      assert.equal(item.teamProjection.approvedStart, null);
      assert.equal(item.teamProjection.approvedEnd, end);
      assert.equal(item.schedule.plannedStart, null);
      assert.equal(item.schedule.plannedEnd, end);
      assert.equal(item.schedule.approved, true);
      assert.equal(item.schedule.provisional, false);
      const approvedMark = gantt.rows.find(row => row.id === taskId).marks.find(mark => mark.sourceKind === 'approved');
      assert.deepEqual([approvedMark?.startDay, approvedMark?.endDay, approvedMark?.point], [end, end, true]);
    }
  } finally {
    unlinkSync(path);
  }
});

test('companion rejects private fields and avatar traversal', () => {
  const value = companion();
  assert.equal(validateTeamCompanion({ ...value, privateNotes: 'secret' }).valid, false);
  assert.equal(validateTeamCompanion({ ...value, directory: [{ ...value.directory[0], avatar: '../../secret.webp' }] }).valid, false);
  assert.equal(validateTeamCompanion({ ...value, taskMetadata: [{ ...value.taskMetadata[0], healthState: 'private' }] }).valid, false);
});

test('migrates v1 directory-only companions without context metadata to an empty bounded section', () => {
  const root = join(CHECK_ROOT, 'legacy-directory-only-companion');
  mkdirSync(root, { recursive: true });
  const legacy = directoryOnlyCompanion(fullTaskProjection());
  delete legacy.contextMetadata;
  delete legacy.companionDigest;
  legacy.companionDigest = digest(legacy);
  writeFileSync(join(root, 'companion.json'), `${JSON.stringify(legacy)}\n`, { mode: 0o600 });
  try {
    const read = readTeamCompanion({ dataRoot: root, companionPath: 'companion.json', projection: fullTaskProjection(), expectedRosterDigest: digest(['person-1']) });
    assert.deepEqual(read.contextMetadata, []);
    const { companionDigest: _legacyDigest, ...legacyWithoutDigest } = legacy;
    assert.equal(read.companionDigest, digest({ ...legacyWithoutDigest, contextMetadata: [], releaseMetadata: [] }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('legacy full-current context rows may omit the additive owner display label', () => {
  const projectionValue = fullTaskProjection();
  const legacy = fullCurrentCompanion(projectionValue);
  delete legacy.contextMetadata[0].ownerName;
  delete legacy.companionDigest;
  legacy.companionDigest = digest(legacy);
  assert.equal(validateTeamCompanion(legacy, projectionValue).valid, true);
  const viewerProjection = {
    ...projectionValue,
    tasks: projectionValue.tasks.map(task => ({
      ...task,
      scope: task.description,
      completionCondition: task.completionCriteria,
      approvedDate: task.deadline?.label === 'approved' ? task.deadline.date : null,
      forecastDate: task.deadline?.label === 'forecast' ? task.deadline.date : null,
      checkpoint: null,
      dependencies: [],
      evidenceLinks: [],
    })),
  };
  const snapshot = buildTeamProjectionSnapshot(viewerProjection, {}, { ...legacy, staleSchedule: false, staleActivity: false });
  assert.equal(snapshot.items.find(item => item.id === 'full-project').ownerName, 'Synthetic Person');
});

test('migrates legacy full-current payloads before enforcing context and activity coverage', () => {
  const projectionValue = fullTaskProjection();
  const legacy = fullCurrentCompanion(projectionValue);
  legacy.mode = 'full-current-v1';
  legacy.schedules = legacy.schedules.map(({ provisional: _provisional, ...entry }) => entry);
  legacy.activitySummaries = legacy.activitySummaries.map(({ occurredDates: _dates, activityKinds: _kinds, ...entry }) => entry);
  delete legacy.contextMetadata;
  delete legacy.releaseMetadata;
  delete legacy.proposedSchedules;
  delete legacy.companionDigest;
  legacy.companionDigest = digest(legacy);
  const root = join(CHECK_ROOT, 'legacy-full-current-companion');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'projection.json'), `${JSON.stringify(projectionValue)}\n`, { mode: 0o600 });
  writeFileSync(join(root, 'companion.json'), `${JSON.stringify(legacy)}\n`, { mode: 0o600 });
  try {
    const loaded = readTeamCompanion({ dataRoot: root, companionPath: 'companion.json', projection: projectionValue, expectedRosterDigest: digest(['person-1']) });
    assert.equal(loaded.legacyContract, true);
    assert.equal(loaded.legacyCompanionDigest, legacy.companionDigest);
    assert.deepEqual(loaded.contextMetadata, []);
    assert.deepEqual(loaded.releaseMetadata, []);
    assert.deepEqual(loaded.proposedSchedules, []);
    assert.equal(loaded.schedules[0].provisional, false);
    assert.deepEqual(loaded.activitySummaries[0].occurredDates, []);
    assert.deepEqual(loaded.activitySummaries[0].activityKinds, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects context metadata in a directory-only companion', () => {
  const root = join(CHECK_ROOT, 'directory-only-context-metadata');
  mkdirSync(root, { recursive: true });
  const invalid = directoryOnlyCompanion(fullTaskProjection());
  invalid.contextMetadata = [{ contextId: 'full-project', owner: null, healthState: 'unknown', target: null }];
  delete invalid.companionDigest;
  invalid.companionDigest = digest(invalid);
  writeFileSync(join(root, 'companion.json'), `${JSON.stringify(invalid)}\n`, { mode: 0o600 });
  try {
    assert.throws(() => readTeamCompanion({ dataRoot: root, companionPath: 'companion.json', projection: fullTaskProjection(), expectedRosterDigest: digest(['person-1']) }), /directory-only companion/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('roster binding is data-driven and status metadata cannot contradict the projection', () => {
  const value = companion();
  const generic = {
    ...value,
    directory: [{ id: 'person-1', displayName: 'Synthetic Person One', avatar: null }],
    audit: { ...value.audit, rosterDigest: digest(['person-1']) },
  };
  delete generic.companionDigest;
  generic.companionDigest = digest(generic);
  assert.equal(validateTeamCompanion(generic).valid, true);
  const rawProjection = {
    kind: 'standing-team-projection',
    audit: { rosterDigest: digest(['different-roster']) },
    tasks: [],
  };
  const path = join(CHECK_ROOT, 'team-safe-companion-roster.json');
  mkdirSync(CHECK_ROOT, { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  try {
    const read = readTeamCompanion({ dataRoot: CHECK_ROOT, companionPath: 'team-safe-companion-roster.json', projection: rawProjection });
    assert.equal(read.rosterMismatch, true);
    assert.deepEqual(read.directory, []);
    assert.deepEqual(read.schedules, []);
  } finally {
    unlinkSync(path);
  }
});

test('stale companion schedules fail soft and unsafe paths never resolve', () => {
  mkdirSync(CHECK_ROOT, { recursive: true });
  const path = join(CHECK_ROOT, 'team-safe-companion-stale.json');
  const value = companion();
  value.contextMetadata = [{ contextId: 'task-safe', owner: 'person-1', ownerName: 'Synthetic Person', healthState: 'on-track', target: '2026-10-02' }];
  value.releaseMetadata = [{ releaseId: 'release-safe', projectId: 'task-safe', title: 'Synthetic release', owner: 'person-1', ownerName: 'Synthetic Person', status: 'planned', target: '2026-10-02' }];
  value.proposedSchedules = [{ taskId: 'task-safe', proposedStart: '2026-10-01', proposedEnd: '2026-10-03', proposedScheduleKind: 'span' }];
  value.activitySummaries = [{ taskId: 'task-safe', eventCount: 2, latestOccurredAt: '2026-10-02T03:00:00Z' }];
  delete value.companionDigest;
  value.companionDigest = digest(value);
  writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  try {
    const stale = readTeamCompanion({
      dataRoot: CHECK_ROOT,
      companionPath: 'team-safe-companion-stale.json',
      projection: { kind: 'standing-team-projection', tasks: [] },
    });
    assert.equal(stale.staleSchedule, true);
    assert.deepEqual(stale.schedules, []);
    assert.deepEqual(stale.taskMetadata, []);
    assert.deepEqual(stale.contextMetadata, []);
    assert.deepEqual(stale.releaseMetadata, []);
    assert.deepEqual(stale.proposedSchedules, []);
    assert.deepEqual(stale.activitySummaries, []);
    assert.deepEqual(stale.directory, []);
    const policyStale = readTeamCompanion({
      dataRoot: CHECK_ROOT,
      companionPath: 'team-safe-companion-stale.json',
      projection: {
        kind: 'standing-team-projection',
        policyRevision: 'different-policy',
        audit: { rosterDigest: digest(value.directory.map(entry => entry.id)) },
        tasks: [],
      },
    });
    assert.equal(policyStale.policyMismatch, true);
    assert.deepEqual(policyStale.directory, []);
    const legacy = readTeamCompanion({
      dataRoot: CHECK_ROOT,
      companionPath: 'team-safe-companion-stale.json',
      projection: { kind: 'team-projection', tasks: [] },
    });
    assert.equal(legacy.unsupportedProjection, true);
    assert.deepEqual(legacy.directory, []);
    assert.deepEqual(legacy.schedules, []);
    assert.deepEqual(legacy.taskMetadata, []);
    assert.deepEqual(legacy.directory.flatMap(entry => entry.avatar ? [entry.avatar] : []), []);
    const missingProjection = readTeamCompanion({
      dataRoot: CHECK_ROOT,
      companionPath: 'team-safe-companion-stale.json',
      projection: null,
    });
    assert.equal(missingProjection.unsupportedProjection, true);
    assert.deepEqual(missingProjection.directory, []);
    assert.deepEqual(missingProjection.schedules, []);
    assert.deepEqual(missingProjection.taskMetadata, []);
    assert.deepEqual(missingProjection.activitySummaries, []);
    assert.deepEqual(missingProjection.directory.flatMap(entry => entry.avatar ? [entry.avatar] : []), []);
    assert.throws(() => readTeamCompanion({ dataRoot: CHECK_ROOT, companionPath: '../secret.json', projection: null }), /safe relative path/);
  } finally {
    unlinkSync(path);
  }
});
