export interface PlanningArchiveEntry {
  readonly id: string;
  readonly week: string;
  readonly date: string | null;
  readonly revision: string;
  readonly status: 'draft' | 'approved' | 'superseded' | 'blocked';
  readonly reviewStatus: 'draft' | 'approved' | 'superseded' | 'blocked';
  readonly coverage: unknown;
  readonly hash: string | null;
  readonly paths: Record<string, string>;
  readonly manifest: Record<string, unknown>;
  readonly plan: Record<string, unknown>;
  readonly presentationHtml: string;
}

export interface PlanningArchive {
  readonly schemaVersion: 1;
  readonly entries: readonly PlanningArchiveEntry[];
  readonly currentDraftId: string | null;
  readonly latestApprovedId: string | null;
}

const STATUSES = new Set(['draft', 'approved', 'superseded', 'blocked']);
const WEEK = /^\d{4}-W(?:0[1-9]|[1-4]\d|5[0-3])$/u;
const REVISION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Array.isArray(value) === false;
}

function text(value: unknown, path: string, max = 512): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${path}: invalid text`);
  }
  return value;
}

function episodeId(value: unknown, path: string): string {
  return text(value, path, 128).match(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u)?.[0] ?? (() => { throw new Error(`${path}: invalid id`); })();
}

function archivePath(value: unknown, path: string): string {
  const normalized = text(value, path, 512);
  if (normalized.includes('\\') || normalized.includes('%') || normalized.startsWith('/') || !normalized.startsWith('planning/weeks/')) {
    throw new Error(`${path}: unsafe archive path`);
  }
  const segments = normalized.split('/');
  if (segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) throw new Error(`${path}: unsafe archive path`);
  return normalized;
}

function digest(value: unknown, path: string): string {
  const normalized = text(value, path, 71);
  if (!DIGEST.test(normalized)) throw new Error(`${path}: invalid digest`);
  return normalized;
}

function validatePlanAndManifest(candidate: Record<string, unknown>, path: string, week: string, revision: string, status: string, paths: Record<string, string>) {
  const plan = candidate.plan;
  if (!isRecord(plan)) throw new Error(`${path}.plan: required`);
  if (plan.schemaVersion !== 1 || plan.kind !== 'weekly-plan') throw new Error(`${path}.plan: invalid schema`);
  if (plan.week !== week || plan.revision !== revision || plan.status !== status) throw new Error(`${path}.plan: identity does not match entry`);
  if (plan.timezone !== 'Asia/Manila' || typeof plan.asOf !== 'string') throw new Error(`${path}.plan: invalid time metadata`);
  if (!isRecord(plan.source) || !Array.isArray(plan.outcomes) || !Array.isArray(plan.queues) || !Array.isArray(plan.gaps) || !Array.isArray(plan.proposals)) {
    throw new Error(`${path}.plan: invalid planning fields`);
  }
  for (const field of ['sourceCommit', 'contentRevision', 'policyRevision', 'generatorVersion', 'producerRevision']) text(plan.source[field], `${path}.plan.source.${field}`);
  digest(plan.source.inputDigest, `${path}.plan.source.inputDigest`);

  const manifest = candidate.manifest;
  if (!isRecord(manifest)) throw new Error(`${path}.manifest: required`);
  if (manifest.schemaVersion !== 1 || manifest.kind !== 'weekly-plan-manifest') throw new Error(`${path}.manifest: invalid schema`);
  if (manifest.week !== week || manifest.revision !== revision || manifest.status !== status) throw new Error(`${path}.manifest: identity does not match entry`);
  for (const field of ['generatorVersion', 'producerRevision', 'sourceCommit', 'sourceContentRevision', 'policyRevision']) text(manifest[field], `${path}.manifest.${field}`);
  for (const field of ['inputDigest', 'planDigest', 'htmlDigest']) digest(manifest[field], `${path}.manifest.${field}`);
  if (manifest.immutable !== true) throw new Error(`${path}.manifest.immutable: must be true`);
  if (!isRecord(manifest.artifactPaths) || !isRecord(manifest.artifactDigests)) throw new Error(`${path}.manifest: artifact bindings are missing`);
  if (archivePath(manifest.artifactPaths.manifest, `${path}.manifest.artifactPaths.manifest`) !== paths.manifest ||
      archivePath(manifest.artifactPaths.plan, `${path}.manifest.artifactPaths.plan`) !== paths.plan ||
      archivePath(manifest.artifactPaths.html, `${path}.manifest.artifactPaths.html`) !== paths.presentation) {
    throw new Error(`${path}.manifest.artifactPaths: do not match entry`);
  }
  for (const field of ['manifest', 'plan', 'html']) digest(manifest.artifactDigests[field], `${path}.manifest.artifactDigests.${field}`);
  if (manifest.planDigest !== manifest.artifactDigests.plan) throw new Error(`${path}.manifest: plan digest bindings disagree`);
  if (manifest.htmlDigest !== manifest.artifactDigests.html) throw new Error(`${path}.manifest: presentation digest bindings disagree`);
  if (manifest.sourceCommit !== plan.source.sourceCommit ||
      manifest.sourceContentRevision !== plan.source.contentRevision ||
      manifest.policyRevision !== plan.source.policyRevision ||
      manifest.generatorVersion !== plan.source.generatorVersion ||
      manifest.producerRevision !== plan.source.producerRevision ||
      manifest.inputDigest !== plan.source.inputDigest) {
    throw new Error(`${path}.manifest: provenance does not match plan source`);
  }
  if (!Array.isArray(manifest.outcomeTaskIds)) throw new Error(`${path}.manifest.outcomeTaskIds: must be an array`);
}

function safePresentationHtml(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1_500_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new Error(`${path}: invalid HTML`);
  }
  const html = value;
  if (/<\s*(?:script|iframe|object|embed|base|form|input|button|textarea|select|svg|math|link|video|audio|canvas)\b/iu.test(html)) {
    throw new Error(`${path}: active or navigable HTML is not allowed`);
  }
  if (/<\s*meta\b[^>]*\bhttp-equiv\s*=\s*["']?\s*refresh\b/iu.test(html)) {
    throw new Error(`${path}: meta refresh navigation is not allowed`);
  }
  if (/(?:https?:|file:|javascript:|vbscript:|data:|\/\/)/iu.test(html)) {
    throw new Error(`${path}: external navigation or resources are not allowed`);
  }
  if (/<\s*[a-z][^>]*\bon[a-z]+\s*=/iu.test(html)) throw new Error(`${path}: event handlers are not allowed`);
  return html;
}

export function emptyPlanningArchive(): PlanningArchive {
  return { schemaVersion: 1, entries: [], currentDraftId: null, latestApprovedId: null };
}

export function parsePlanningArchive(value: unknown): PlanningArchive {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.entries) || value.entries.length > 256) {
    throw new Error('Weekly planning archive is invalid.');
  }
  const identities = new Set<string>();
  const entries = value.entries.map((candidate, index) => {
    const path = `planning archive entry ${index + 1}`;
    if (!isRecord(candidate)) throw new Error(`${path}: must be an object`);
    const week = text(candidate.week, `${path}.week`, 8);
    if (!WEEK.test(week)) throw new Error(`${path}.week: invalid week`);
    const revision = text(candidate.revision, `${path}.revision`, 128);
    if (!REVISION.test(revision)) throw new Error(`${path}.revision: invalid revision`);
    const derivedId = `${week}/${revision}`;
    const id = candidate.id === undefined ? derivedId : episodeId(candidate.id, `${path}.id`);
    if (id !== derivedId) throw new Error(`${path}.id: must identify week/revision`);
    const status = text(candidate.status, `${path}.status`, 16);
    if (!STATUSES.has(status)) throw new Error(`${path}.status: unsupported status`);
    const reviewStatus = candidate.reviewStatus === undefined ? status : text(candidate.reviewStatus, `${path}.reviewStatus`, 16);
    if (!STATUSES.has(reviewStatus)) throw new Error(`${path}.reviewStatus: unsupported status`);
    const identity = `${week}/${revision}`;
    if (identities.has(identity)) throw new Error(`${path}: duplicate week/revision`);
    identities.add(identity);
    if (!('coverage' in candidate)) throw new Error(`${path}.coverage: required`);
    const hash = candidate.hash === null || candidate.hash === undefined ? null : text(candidate.hash, `${path}.hash`, 71);
    if (hash !== null && !/^sha256:[a-f0-9]{64}$/u.test(hash)) throw new Error(`${path}.hash: invalid digest`);
    if (!isRecord(candidate.paths) || !isRecord(candidate.manifest) || !isRecord(candidate.plan)) throw new Error(`${path}: artifact metadata is missing`);
    const paths = {
      manifest: archivePath(candidate.paths.manifest, `${path}.paths.manifest`),
      plan: archivePath(candidate.paths.plan, `${path}.paths.plan`),
      presentation: archivePath(candidate.paths.presentation, `${path}.paths.presentation`),
    };
    validatePlanAndManifest(candidate, path, week, revision, status, paths);
    return {
      id,
      week,
      date: candidate.date === null || candidate.date === undefined ? null : text(candidate.date, `${path}.date`, 64),
      revision,
      status: status as PlanningArchiveEntry['status'],
      reviewStatus: reviewStatus as PlanningArchiveEntry['reviewStatus'],
      coverage: candidate.coverage,
      hash,
      paths,
      manifest: candidate.manifest,
      plan: candidate.plan,
      presentationHtml: safePresentationHtml(candidate.presentationHtml, `${path}.presentationHtml`),
    } satisfies PlanningArchiveEntry;
  });
  const currentDraftId = value.currentDraftId === null || value.currentDraftId === undefined ? null : episodeId(value.currentDraftId, 'planning archive.currentDraftId');
  const latestApprovedId = value.latestApprovedId === null || value.latestApprovedId === undefined ? null : episodeId(value.latestApprovedId, 'planning archive.latestApprovedId');
  const ids = new Set(entries.map(entry => entry.id));
  if (currentDraftId !== null && !ids.has(currentDraftId)) throw new Error('planning archive.currentDraftId: unknown entry');
  if (latestApprovedId !== null && !ids.has(latestApprovedId)) throw new Error('planning archive.latestApprovedId: unknown entry');
  if (currentDraftId !== null && entries.find(entry => entry.id === currentDraftId)?.reviewStatus !== 'draft') throw new Error('planning archive.currentDraftId: entry is not draft');
  if (latestApprovedId !== null && entries.find(entry => entry.id === latestApprovedId)?.reviewStatus !== 'approved') throw new Error('planning archive.latestApprovedId: entry is not approved');
  return { schemaVersion: 1, entries, currentDraftId, latestApprovedId };
}

export async function fetchPlanningArchive(signal?: AbortSignal): Promise<PlanningArchive> {
  const response = await fetch('/planning/archive.json', { cache: 'no-store', signal });
  if (response.status === 404) return emptyPlanningArchive();
  if (!response.ok) throw new Error(`Weekly planning archive unavailable (${response.status}).`);
  try {
    return parsePlanningArchive(await response.json());
  } catch (error) {
    throw new Error(`Weekly planning archive is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}
