import { createHash } from 'node:crypto';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { readTeamCompanion, validateTeamCompanion } from '../tooling/team-projection/companion.mjs';
import { buildTeamProjectionSnapshot } from '../tooling/team-projection/snapshot.mjs';

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
    taskMetadata: [{ taskId: 'task-safe', status: 'active', commitment: 'accepted', phase: 'build', healthState: 'on-track' }],
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

test('companion metadata drives safe identity and approved endpoint rendering', () => {
  const value = companion();
  assert.equal(validateTeamCompanion(value).valid, true);
  const snapshot = buildTeamProjectionSnapshot(projection(), {}, value);
  const [item] = snapshot.items;
  assert.equal(item.ownerName, 'Synthetic Person');
  assert.equal(item.schedule.plannedStart, '2026-10-01');
  assert.equal(item.schedule.plannedEnd, '2026-10-02');
  assert.equal(item.schedule.approved, true);
  assert.equal(item.commitment, 'accepted');
  assert.equal(item.phase, 'build');
  assert.equal(item.health.state, 'on-track');
  assert.equal(snapshot.team[0].avatarUrl, '/avatars/person-1.webp');
});

test('companion rejects private fields and avatar traversal', () => {
  const value = companion();
  assert.equal(validateTeamCompanion({ ...value, privateNotes: 'secret' }).valid, false);
  assert.equal(validateTeamCompanion({ ...value, directory: [{ ...value.directory[0], avatar: '../../secret.webp' }] }).valid, false);
  assert.equal(validateTeamCompanion({ ...value, taskMetadata: [{ ...value.taskMetadata[0], healthState: 'private' }] }).valid, false);
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
    assert.deepEqual(missingProjection.directory.flatMap(entry => entry.avatar ? [entry.avatar] : []), []);
    assert.throws(() => readTeamCompanion({ dataRoot: CHECK_ROOT, companionPath: '../secret.json', projection: null }), /safe relative path/);
  } finally {
    unlinkSync(path);
  }
});
