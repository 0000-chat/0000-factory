import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import {
  emptyPlanningArchive,
  loadPlanningArchive,
  PlanningArchiveError,
} from '../tooling/planning/archive.mjs';

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function digest(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function fixture({ presentation = '<article><h1>Synthetic weekly plan</h1><p id="coverage">Covered synthetic inputs.</p></article>', manifestOverrides = {}, indexOverrides = {}, entryOverrides = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'factory-planning-archive-'));
  roots.push(root);
  const week = '2026-W42';
  const revision = 'r1';
  const directory = join(root, 'planning', 'weeks', week, revision);
  mkdirSync(directory, { recursive: true });
  const planPath = `planning/weeks/${week}/${revision}/plan.json`;
  const manifestPath = `planning/weeks/${week}/${revision}/manifest.json`;
  const presentationPath = `planning/weeks/${week}/${revision}/presentation.html`;
  const plan = {
    schemaVersion: 1,
    kind: 'weekly-plan',
    week,
    revision,
    status: 'draft',
    timezone: 'Asia/Manila',
    asOf: '2026-10-12T00:00:00Z',
    source: { sourceCommit: 'synthetic-source-revision', contentRevision: 'synthetic', inputDigest: digest('input'), policyRevision: 'sharing-v1', generatorVersion: 'synthetic' },
    coverage: { kind: 'synthetic', complete: true },
    outcomes: [], queues: [], gaps: [], proposals: [],
  };
  const planBytes = `${JSON.stringify(plan)}\n`;
  const presentationBytes = `${presentation}\n`;
  const manifest = {
    schemaVersion: 1,
    kind: 'weekly-plan-manifest',
    week,
    revision,
    status: 'draft',
    generatedAt: '2026-10-12T00:00:00Z',
    generatorVersion: 'synthetic',
    sourceCommit: 'synthetic-source-revision',
    sourceContentRevision: 'synthetic',
    inputDigest: digest('input'),
    planDigest: digest(planBytes),
    htmlDigest: digest(presentationBytes),
    policyRevision: 'sharing-v1',
    coverage: plan.coverage,
    artifactPaths: { manifest: manifestPath, plan: planPath, html: presentationPath },
    artifactDigests: { manifest: digest('manifest-placeholder'), plan: digest(planBytes), html: digest(presentationBytes) },
    outcomeTaskIds: [],
    immutable: true,
    ...manifestOverrides,
  };
  const entry = {
    week,
    revision,
    status: 'draft',
    coverage: plan.coverage,
    manifestPath,
    planPath,
    htmlPath: presentationPath,
    ...entryOverrides,
  };
  writeFileSync(join(root, planPath), planBytes);
  writeFileSync(join(root, manifestPath), JSON.stringify(manifest));
  writeFileSync(join(root, presentationPath), presentationBytes);
  writeFileSync(join(root, 'planning', 'index.json'), JSON.stringify({ schemaVersion: 1, kind: 'weekly-plan-index', entries: [entry], ...indexOverrides }));
  return root;
}

test('loads a validated immutable episode and exposes current draft metadata', () => {
  const result = loadPlanningArchive({ dataRoot: fixture(), instance: { data: { folderPath: '' } } });
  assert.equal(result.present, true);
  assert.equal(result.archive.currentDraftId, '2026-W42/r1');
  assert.equal(result.archive.entries[0].presentationHtml.includes('<script'), false);
  assert.deepEqual(result.archive.entries[0].plan.outcomes, []);
  assert.equal(result.snapshots.length, 4);
});

test('missing planning index is an explicit empty archive', () => {
  const root = mkdtempSync(join(tmpdir(), 'factory-planning-empty-'));
  roots.push(root);
  const result = loadPlanningArchive({ dataRoot: root, instance: { data: { folderPath: '' } } });
  assert.equal(result.present, false);
  assert.deepEqual(result.archive, emptyPlanningArchive());
  assert.deepEqual(result.snapshots, []);
});

test('rejects traversal paths instead of reading outside the selected data root', () => {
  assert.throws(
    () => fixture({ entryOverrides: { htmlPath: '../outside.html' } }) && loadPlanningArchive({ dataRoot: roots.at(-1), instance: { data: { folderPath: '' } } }),
    error => error instanceof PlanningArchiveError && /unsafe path|under planning\/weeks/u.test(error.message),
  );
});

test('rejects active content and external resources in archived HTML', () => {
  assert.throws(
    () => fixture({ presentation: '<article><script>alert(1)</script></article>' }) && loadPlanningArchive({ dataRoot: roots.at(-1), instance: { data: { folderPath: '' } } }),
    error => error instanceof PlanningArchiveError && /active|navigable/u.test(error.message),
  );
  assert.throws(
    () => fixture({ presentation: '<article><a href="https://private.invalid">private</a></article>' }) && loadPlanningArchive({ dataRoot: roots.at(-1), instance: { data: { folderPath: '' } } }),
    error => error instanceof PlanningArchiveError && /external/u.test(error.message),
  );
  assert.throws(
    () => fixture({ presentation: '<meta http-equiv="refresh" content="0;url=/private"><article>private</article>' }) && loadPlanningArchive({ dataRoot: roots.at(-1), instance: { data: { folderPath: '' } } }),
    error => error instanceof PlanningArchiveError && /refresh|navigable/u.test(error.message),
  );
});

test('rejects a declared artifact digest that does not match immutable bytes', () => {
  assert.throws(
    () => fixture({ manifestOverrides: { presentationDigest: `sha256:${'0'.repeat(64)}` } }) && loadPlanningArchive({ dataRoot: roots.at(-1), instance: { data: { folderPath: '' } } }),
    error => error instanceof PlanningArchiveError && /digest/u.test(error.message),
  );
});

test('rejects an invalid current draft reference instead of guessing', () => {
  assert.throws(
    () => fixture({ indexOverrides: { currentDraft: 'missing-entry' } }) && loadPlanningArchive({ dataRoot: roots.at(-1), instance: { data: { folderPath: '' } } }),
    error => error instanceof PlanningArchiveError && /unknown entry/u.test(error.message),
  );
});
