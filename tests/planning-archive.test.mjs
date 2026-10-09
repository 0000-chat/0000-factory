import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import {
  emptyPlanningArchive,
  loadPlanningArchive,
  PLANNING_ARCHIVE_LIMITS,
  PlanningArchiveError,
} from '../tooling/planning/archive.mjs';

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function digest(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return JSON.stringify(value.map(canonicalJsonValue));
  return JSON.stringify(canonicalJsonValue(value));
}

function canonicalJsonValue(value) {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalJsonValue(value[key])]));
  return value;
}

function fixture({ presentation = '<article><h1>Synthetic weekly plan</h1><p id="coverage">Covered synthetic inputs.</p></article>', outcomes = [], manifestOverrides = {}, indexOverrides = {}, entryOverrides = {} } = {}) {
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
    source: { sourceCommit: 'synthetic-source-revision', contentRevision: 'synthetic', inputDigest: digest('input'), policyRevision: 'sharing-v1', generatorVersion: 'synthetic', producerRevision: 'synthetic-producer' },
    coverage: { kind: 'synthetic', complete: true },
    outcomes, queues: [], gaps: [], proposals: [],
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
    producerRevision: 'synthetic-producer',
    inputDigest: digest('input'),
    planDigest: digest(planBytes),
    htmlDigest: digest(presentationBytes),
    policyRevision: 'sharing-v1',
    coverage: plan.coverage,
    artifactPaths: { manifest: manifestPath, plan: planPath, html: presentationPath },
    artifactDigests: { manifest: null, plan: digest(planBytes), html: digest(presentationBytes) },
    outcomeTaskIds: [],
    immutable: true,
    ...manifestOverrides,
  };
  manifest.artifactDigests.manifest = digest(`${canonicalJson({ ...manifest, artifactDigests: { ...manifest.artifactDigests, manifest: null } })}\n`);
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

function episodeApprovalDigest(receipts) {
  return digest(canonicalJson(receipts));
}

function addApprovedEpisode(root) {
  const planPath = join(root, 'planning', 'weeks', '2026-W42', 'r1', 'plan.json');
  const plan = JSON.parse(readFileSync(planPath, 'utf8'));
  const parts = ['task', 'assignment', 'schedule'].map(kind => ({
    partId: `${kind}:${plan.outcomes[0].taskId}`,
    kind,
    taskId: plan.outcomes[0].taskId,
    valueDigest: digest(canonicalJson({ kind, outcome: plan.outcomes[0] })),
    approved: true,
  }));
  const approvalReceipts = parts.map((part, index) => {
    const receipt = {
      episodeId: `${plan.week}:${plan.revision}`,
      revision: plan.revision,
      partId: part.partId,
      valueDigest: part.valueDigest,
      approvedBy: 'reviewer',
      approvedAt: `2026-10-12T0${index + 1}:00:00Z`,
      approvalRef: `review-${index + 1}`,
      approvalSource: 'synthetic-review',
      approvedRevision: plan.revision,
      reviewedDetail: `Approve this exact ${part.kind} part.`,
    };
    return { ...receipt, approvalDigest: digest(canonicalJson({ ...receipt })) };
  });
  const episode = {
    schemaVersion: 1,
    kind: 'weekly-episode',
    week: plan.week,
    revision: plan.revision,
    planDigest: digest(canonicalJson(plan)),
    generatedAt: '2026-10-12T03:00:00Z',
    status: 'approved',
    parts,
    approvalReceipts,
  };
  const episodePath = 'episodes/2026-W42-r1-approved.json';
  mkdirSync(join(root, 'episodes'), { recursive: true });
  const episodeBytes = `${canonicalJson(episode)}\n`;
  writeFileSync(join(root, episodePath), episodeBytes);
  const indexPath = join(root, 'planning', 'index.json');
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  index.entries[0] = {
    ...index.entries[0],
    episodePath,
    episodeDigest: digest(episodeBytes),
    episodeStatus: episode.status,
    episodePlanDigest: episode.planDigest,
    episodeApprovalDigest: episodeApprovalDigest(approvalReceipts),
    episodeGeneratedAt: episode.generatedAt,
  };
  writeFileSync(indexPath, `${canonicalJson(index)}\n`);
  return { plan, episode, episodePath };
}

function addSecondDraftRevision(root) {
  const firstPlanPath = join(root, 'planning', 'weeks', '2026-W42', 'r1', 'plan.json');
  const firstManifestPath = join(root, 'planning', 'weeks', '2026-W42', 'r1', 'manifest.json');
  const firstPresentationPath = join(root, 'planning', 'weeks', '2026-W42', 'r1', 'presentation.html');
  const plan = { ...JSON.parse(readFileSync(firstPlanPath, 'utf8')), revision: 'r2' };
  const planBytes = `${canonicalJson(plan)}\n`;
  const manifest = {
    ...JSON.parse(readFileSync(firstManifestPath, 'utf8')),
    revision: 'r2',
    artifactPaths: {
      manifest: 'planning/weeks/2026-W42/r2/manifest.json',
      plan: 'planning/weeks/2026-W42/r2/plan.json',
      html: 'planning/weeks/2026-W42/r2/presentation.html',
    },
    planDigest: digest(planBytes),
    artifactDigests: { ...JSON.parse(readFileSync(firstManifestPath, 'utf8')).artifactDigests, manifest: null, plan: digest(planBytes) },
  };
  manifest.artifactDigests.manifest = digest(`${canonicalJson(manifest)}\n`);
  const revisionRoot = join(root, 'planning', 'weeks', '2026-W42', 'r2');
  mkdirSync(revisionRoot, { recursive: true });
  writeFileSync(join(revisionRoot, 'plan.json'), planBytes);
  writeFileSync(join(revisionRoot, 'manifest.json'), `${canonicalJson(manifest)}\n`);
  writeFileSync(join(revisionRoot, 'presentation.html'), readFileSync(firstPresentationPath));
  const indexPath = join(root, 'planning', 'index.json');
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  index.currentDraft = '2026-W42/r2';
  index.entries.push({
    ...index.entries[0],
    revision: 'r2',
    status: 'draft',
    manifestPath: manifest.artifactPaths.manifest,
    planPath: manifest.artifactPaths.plan,
    htmlPath: manifest.artifactPaths.html,
    manifestDigest: digest(`${canonicalJson(manifest)}\n`),
    planDigest: manifest.planDigest,
    htmlDigest: manifest.htmlDigest,
    episodePath: undefined,
    episodeDigest: undefined,
    episodeStatus: undefined,
    episodePlanDigest: undefined,
    episodeApprovalDigest: undefined,
    episodeGeneratedAt: undefined,
  });
  for (const entry of index.entries) {
    for (const field of ['episodePath', 'episodeDigest', 'episodeStatus', 'episodePlanDigest', 'episodeApprovalDigest', 'episodeGeneratedAt']) {
      if (entry[field] === undefined) delete entry[field];
    }
  }
  writeFileSync(indexPath, `${canonicalJson(index)}\n`);
}

function rewriteManifest(root, mutate, { recalculateSelf = true } = {}) {
  const path = join(root, 'planning', 'weeks', '2026-W42', 'r1', 'manifest.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  mutate(manifest);
  if (recalculateSelf) manifest.artifactDigests.manifest = digest(`${canonicalJson({ ...manifest, artifactDigests: { ...manifest.artifactDigests, manifest: null } })}\n`);
  writeFileSync(path, `${canonicalJson(manifest)}\n`);
}

test('loads a validated immutable episode and exposes current draft metadata', () => {
  const result = loadPlanningArchive({ dataRoot: fixture(), instance: { data: { folderPath: '' } } });
  assert.equal(result.present, true);
  assert.equal(result.archive.currentDraftId, '2026-W42/r1');
  assert.equal(result.archive.entries[0].presentationHtml.includes('<script'), false);
  assert.deepEqual(result.archive.entries[0].plan.outcomes, []);
  assert.equal(result.snapshots.length, 4);
});

test('derives latest approved from a bound episode while retaining the draft plan status', () => {
  const root = fixture({ outcomes: [{ taskId: 'synthetic-task', title: 'Synthetic task', status: 'queued', owner: { personId: 'synthetic-owner', confirmation: 'unknown' }, nextStep: 'Review evidence', completionCondition: 'Evidence recorded' }] });
  const { episode } = addApprovedEpisode(root);
  const result = loadPlanningArchive({ dataRoot: root, instance: { data: { folderPath: '' } } });
  assert.equal(result.archive.entries[0].status, 'draft');
  assert.equal(result.archive.entries[0].reviewStatus, 'approved');
  assert.equal(result.archive.latestApprovedId, '2026-W42/r1');
  assert.equal(result.archive.currentDraftId, null);
  assert.equal(episode.status, 'approved');
  assert.equal(result.snapshots.length, 5);
});

test('keeps two immutable revisions and selects approved episode separately from the current draft', () => {
  const root = fixture({ outcomes: [{ taskId: 'synthetic-task', title: 'Synthetic task', status: 'queued', owner: { personId: 'synthetic-owner', confirmation: 'unknown' }, nextStep: 'Review evidence', completionCondition: 'Evidence recorded' }] });
  addApprovedEpisode(root);
  addSecondDraftRevision(root);
  const result = loadPlanningArchive({ dataRoot: root, instance: { data: { folderPath: '' } } });
  assert.deepEqual(result.archive.entries.map(entry => entry.id), ['2026-W42/r1', '2026-W42/r2']);
  assert.equal(result.archive.currentDraftId, '2026-W42/r2');
  assert.equal(result.archive.latestApprovedId, '2026-W42/r1');
  assert.equal(result.snapshots.length, 8);
});

test('rejects an episode whose approval state is not bound to its immutable parts', () => {
  const root = fixture({ outcomes: [{ taskId: 'synthetic-task', title: 'Synthetic task', status: 'queued', owner: { personId: 'synthetic-owner', confirmation: 'unknown' }, nextStep: 'Review evidence', completionCondition: 'Evidence recorded' }] });
  const { episodePath } = addApprovedEpisode(root);
  const path = join(root, episodePath);
  const episode = JSON.parse(readFileSync(path, 'utf8'));
  episode.parts[0].approved = false;
  const episodeBytes = `${canonicalJson(episode)}\n`;
  writeFileSync(path, episodeBytes);
  const indexPath = join(root, 'planning', 'index.json');
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  index.entries[0].episodeDigest = digest(episodeBytes);
  writeFileSync(indexPath, `${canonicalJson(index)}\n`);
  assert.throws(
    () => loadPlanningArchive({ dataRoot: root, instance: { data: { folderPath: '' } } }),
    error => error instanceof PlanningArchiveError && /does not match its receipt|controlled part/u.test(error.message),
  );
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

test('rejects duplicate artifact digests that do not match immutable bytes', () => {
  const root = fixture();
  rewriteManifest(root, manifest => { manifest.artifactDigests.plan = `sha256:${'0'.repeat(64)}`; });
  assert.throws(
    () => loadPlanningArchive({ dataRoot: root, instance: { data: { folderPath: '' } } }),
    error => error instanceof PlanningArchiveError && /artifactDigests\.plan|digest/u.test(error.message),
  );
});

test('rejects manifest provenance that does not match the plan source', () => {
  const root = fixture();
  rewriteManifest(root, manifest => { manifest.sourceCommit = 'different-source-revision'; });
  assert.throws(
    () => loadPlanningArchive({ dataRoot: root, instance: { data: { folderPath: '' } } }),
    error => error instanceof PlanningArchiveError && /sourceCommit/u.test(error.message),
  );
});

test('rejects a manifest self-digest that does not match canonical manifest bytes', () => {
  const root = fixture();
  rewriteManifest(root, manifest => { manifest.artifactDigests.manifest = `sha256:${'0'.repeat(64)}`; }, { recalculateSelf: false });
  assert.throws(
    () => loadPlanningArchive({ dataRoot: root, instance: { data: { folderPath: '' } } }),
    error => error instanceof PlanningArchiveError && /artifactDigests\.manifest|digest/u.test(error.message),
  );
});

test('rejects an oversized index before reading or parsing it', () => {
  const root = fixture();
  writeFileSync(join(root, 'planning', 'index.json'), Buffer.alloc(PLANNING_ARCHIVE_LIMITS.indexBytes + 1, 0x20));
  assert.throws(
    () => loadPlanningArchive({ dataRoot: root, instance: { data: { folderPath: '' } } }),
    error => error instanceof PlanningArchiveError && /file-size limit/u.test(error.message),
  );
});

test('rejects an invalid current draft reference instead of guessing', () => {
  assert.throws(
    () => fixture({ indexOverrides: { currentDraft: 'missing-entry' } }) && loadPlanningArchive({ dataRoot: roots.at(-1), instance: { data: { folderPath: '' } } }),
    error => error instanceof PlanningArchiveError && /unknown entry/u.test(error.message),
  );
});
