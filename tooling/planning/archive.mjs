import {
  lstatSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import {
  isAbsolute,
  join,
  resolve,
  sep,
} from 'node:path';
import { createHash } from 'node:crypto';

/**
 * Weekly planning is a presentation archive alongside the canonical tracker.
 * It intentionally has no dependency on the tracker model: the archive is a
 * collection of immutable, already-rendered episodes.
 */
export const PLANNING_ARCHIVE_SCHEMA_VERSION = 1;
export const PLANNING_ARCHIVE_LIMITS = Object.freeze({
  indexBytes: 512 * 1024,
  artifactBytes: 2 * 1024 * 1024,
  totalBytes: 16 * 1024 * 1024,
  entries: 256,
  jsonDepth: 32,
  presentationCharacters: 1_500_000,
});

const STATUSES = new Set(['draft', 'approved', 'superseded', 'blocked']);
const EPISODE_STATUSES = new Set(['draft', 'approved']);
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const WEEK = /^\d{4}-W(?:0[1-9]|[1-4]\d|5[0-3])$/u;
const REVISION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;

const SAFE_TAGS = new Set([
  'a', 'article', 'aside', 'blockquote', 'body', 'br', 'code', 'dd', 'details',
  'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'footer', 'h1', 'h2', 'h3',
  'h4', 'h5', 'h6', 'head', 'header', 'hr', 'html', 'li', 'main', 'ol', 'p',
  'meta', 'pre', 'section', 'small', 'span', 'strong', 'style', 'summary', 'table',
  'tbody', 'td', 'tfoot', 'th', 'thead', 'time', 'title', 'tr', 'ul',
]);
const SAFE_ATTRS = new Set([
  'charset', 'class', 'colspan', 'content', 'datetime', 'dir', 'http-equiv',
  'id', 'lang', 'name', 'role', 'rowspan', 'scope', 'title',
]);
const URL_ATTRS = new Set(['action', 'formaction', 'href', 'src', 'xlink:href']);

export class PlanningArchiveError extends Error {
  /** @param {string} message @param {string[]} [issues] */
  constructor(message, issues = []) {
    super(message);
    this.name = 'PlanningArchiveError';
    this.issues = issues;
    this.code = 'planning-archive-invalid';
  }
}

function fail(message, issues = []) {
  throw new PlanningArchiveError(message, issues.length ? issues : [message]);
}

function record(value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${path}: must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(`${path}: must be a plain object`);
  return /** @type {Record<string, unknown>} */ (value);
}

function text(value, path, { max = 512, pattern } = {}) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    fail(`${path}: must be a non-empty string of at most ${max} characters`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) fail(`${path}: contains a control character`);
  if (pattern && !pattern.test(value)) fail(`${path}: has an invalid format`);
  return value;
}

function digest(value, path) {
  return text(value, path, { max: 71, pattern: DIGEST });
}

function jsonSize(value, path, max = 512 * 1024) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    fail(`${path}: must be JSON serializable`);
  }
  if (serialized.length > max) fail(`${path}: exceeds the archive size limit`);
  return serialized;
}

function jsonDepth(value, path, depth = 0) {
  if (depth > PLANNING_ARCHIVE_LIMITS.jsonDepth) fail(`${path}: exceeds the archive nesting limit`);
  if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) jsonDepth(child, `${path}[${index}]`, depth + 1);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) jsonDepth(child, `${path}.${key}`, depth + 1);
  }
}

function parseJson(bytes, path, maxBytes) {
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) fail(`${path}: must be bytes`);
  if (bytes.byteLength > maxBytes) fail(`${path}: exceeds the archive file-size limit`);
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch (error) {
    fail(`${path}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  jsonDepth(parsed, path);
  jsonSize(parsed, path, maxBytes);
  return parsed;
}

function normalizeRepositoryPath(value, path) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    fail(`${path}: must be a non-empty repository-relative path`);
  }
  if (value.includes('\\') || value.includes('%') || value.includes('\u0000') || isAbsolute(value)) {
    fail(`${path}: must use unencoded POSIX relative path segments`);
  }
  const segments = value.split('/');
  if (segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) {
    fail(`${path}: contains an unsafe path segment`);
  }
  if (!value.startsWith('planning/weeks/')) fail(`${path}: must be under planning/weeks`);
  return segments.join('/');
}

function normalizeEpisodePath(value, path) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    fail(`${path}: must be a non-empty repository-relative episode path`);
  }
  if (value.includes('\\') || value.includes('%') || value.includes('\u0000') || isAbsolute(value)) {
    fail(`${path}: must use unencoded POSIX relative path segments`);
  }
  const segments = value.split('/');
  if (segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) {
    fail(`${path}: contains an unsafe path segment`);
  }
  if (!value.startsWith('episodes/')) fail(`${path}: must be under episodes`);
  return segments.join('/');
}

function revisionNumber(value, path) {
  const normalized = text(value, path, { max: 128, pattern: REVISION });
  const numeric = /^r(0|[1-9]\d{0,5})$/u.exec(normalized);
  return numeric ? Number(numeric[1]) : 0;
}

function id(value, path) {
  return text(value, path, { max: 128, pattern: ID });
}

function status(value, path) {
  const normalized = text(value, path, { max: 16 });
  if (!STATUSES.has(normalized)) fail(`${path}: unsupported status ${JSON.stringify(normalized)}`);
  return normalized;
}

function week(value, path) {
  return text(value, path, { max: 8, pattern: WEEK });
}

function utcTimestamp(value, path) {
  const normalized = text(value, path, { max: 24, pattern: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u });
  if (Number.isNaN(new Date(normalized).valueOf())) fail(`${path}: must be a valid UTC timestamp`);
  return normalized;
}

function artifactDigest(value, path, bytes) {
  if (value === undefined) return null;
  const expected = digest(value, path);
  const actual = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  if (expected !== actual) fail(`${path}: does not match the artifact SHA-256 digest`);
  return expected;
}

function pathField(entry, names, path) {
  for (const name of names) {
    if (typeof entry[name] === 'string') return normalizeRepositoryPath(entry[name], `${path}.${name}`);
  }
  fail(`${path}: missing ${names.join(' or ')}`);
}

function nestedDigest(value, names) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  for (const name of names) if (typeof value[name] === 'string') return value[name];
  return undefined;
}

function declaredArtifactDigests(manifest, kind) {
  const declarations = [];
  const names = kind === 'plan'
    ? ['planDigest', 'planHash', 'plan_sha256']
    : ['presentationDigest', 'presentationHash', 'presentation_sha256', 'htmlDigest', 'htmlHash'];
  for (const name of names) {
    if (typeof manifest[name] === 'string') declarations.push({ value: manifest[name], path: `manifest.${name}` });
  }
  for (const containerName of ['hashes', 'digests', 'artifacts', 'files']) {
    const container = manifest[containerName];
    if (container === null || typeof container !== 'object' || Array.isArray(container)) continue;
    const candidates = kind === 'plan' ? ['plan', 'plan.json'] : ['presentation', 'presentation.html', 'html'];
    for (const name of candidates) {
      const candidate = container[name];
      if (typeof candidate === 'string') declarations.push({ value: candidate, path: `manifest.${containerName}.${name}` });
      const nested = nestedDigest(candidate, ['sha256', 'digest', 'hash']);
      if (nested !== undefined) declarations.push({ value: nested, path: `manifest.${containerName}.${name}` });
    }
  }
  if (manifest.artifactDigests !== undefined && manifest.artifactDigests !== null && typeof manifest.artifactDigests === 'object' && !Array.isArray(manifest.artifactDigests)) {
    const field = kind === 'plan' ? 'plan' : 'html';
    if (typeof manifest.artifactDigests[field] === 'string') declarations.push({ value: manifest.artifactDigests[field], path: `manifest.artifactDigests.${field}` });
  }
  return declarations;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return JSON.stringify(value.map(canonicalJsonValue));
  return JSON.stringify(canonicalJsonValue(value));
}

function canonicalJsonValue(value) {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalJsonValue(value[key])]));
  }
  return value;
}

function manifestSelfDigest(manifest) {
  const withoutSelfDigest = {
    ...manifest,
    artifactDigests: { ...manifest.artifactDigests, manifest: null },
  };
  return `sha256:${createHash('sha256').update(`${canonicalJson(withoutSelfDigest)}\n`).digest('hex')}`;
}

function canonicalDigest(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function declaredArchiveDigest(manifest) {
  for (const name of ['hash', 'digest', 'contentHash', 'contentDigest', 'inputHash', 'inputDigest']) {
    if (typeof manifest[name] === 'string') return { value: manifest[name], path: `manifest.${name}` };
  }
  return undefined;
}

function safePresentationHtml(html, path = 'presentation.html') {
  if (typeof html !== 'string' || html.length === 0 || html.length > PLANNING_ARCHIVE_LIMITS.presentationCharacters) {
    fail(`${path}: must be non-empty HTML of at most ${PLANNING_ARCHIVE_LIMITS.presentationCharacters} characters`);
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(html)) fail(`${path}: contains a control character`);
  const value = html;
  // A sandbox is defense in depth. Refuse active content and all network or
  // parent-navigation primitives before bytes ever reach the browser.
  if (/<\s*(?:script|iframe|object|embed|base|form|input|button|textarea|select|svg|math|link|video|audio|canvas)\b/iu.test(value)) {
    fail(`${path}: active or navigable HTML is not allowed`);
  }
  if (/<\s*meta\b[^>]*\bhttp-equiv\s*=\s*["']?\s*refresh\b/iu.test(value)) {
    fail(`${path}: meta refresh navigation is not allowed`);
  }
  if (/<\s*style\b[^>]*>[^<]*(?:@import|url\s*\()/iu.test(value)) {
    fail(`${path}: external CSS is not allowed`);
  }
  if (/(?:https?:|file:|javascript:|vbscript:|data:|\/\/)/iu.test(value)) {
    fail(`${path}: external navigation or resource references are not allowed`);
  }
  if (/<\s*[a-z][^>]*\bon[a-z]+\s*=/iu.test(value)) {
    fail(`${path}: event-handler attributes are not allowed`);
  }

  const tagPattern = /<\/?([a-z][a-z0-9-]*)([^>]*)>/giu;
  for (const match of value.matchAll(tagPattern)) {
    const tag = match[1].toLowerCase();
    if (!SAFE_TAGS.has(tag)) fail(`${path}: tag <${tag}> is not allowed`);
    const attrs = match[2];
    const attrPattern = /([:\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/gu;
    for (const attr of attrs.matchAll(attrPattern)) {
      const name = attr[1].toLowerCase();
      const attrValue = attr[2] ?? attr[3] ?? attr[4] ?? '';
      if (name.startsWith('on')) fail(`${path}: event-handler attributes are not allowed`);
      if (name.startsWith('aria-') || name.startsWith('data-')) continue;
      if (URL_ATTRS.has(name)) {
        if (name !== 'href' || !attrValue.startsWith('#') || attrValue.length > 256) {
          fail(`${path}: only local fragment links are allowed`);
        }
        continue;
      }
      if (!SAFE_ATTRS.has(name)) fail(`${path}: attribute ${name} is not allowed`);
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(attrValue)) {
        fail(`${path}: attribute ${name} contains a control character`);
      }
    }
  }
  return value;
}

function validateEpisodeMetadata(entry, path) {
  const value = record(entry, path);
  const weekValue = week(value.week, `${path}.week`);
  const revision = text(value.revision, `${path}.revision`, { max: 128, pattern: REVISION });
  const derivedId = `${weekValue}/${revision}`;
  const episodeId = value.id === undefined ? derivedId : id(value.id, `${path}.id`);
  if (episodeId !== derivedId && value.id !== undefined) fail(`${path}.id: must identify week/revision as ${derivedId}`);
  revisionNumber(revision, `${path}.revision`);
  const episodeStatus = status(value.status, `${path}.status`);
  if (value.date !== undefined) text(value.date, `${path}.date`, { max: 64 });
  if (value.coverage === undefined) fail(`${path}.coverage: is required`);
  jsonDepth(value.coverage, `${path}.coverage`);
  jsonSize(value.coverage, `${path}.coverage`, 128 * 1024);
  for (const field of ['hash', 'manifestDigest', 'planDigest', 'htmlDigest']) {
    if (value[field] !== undefined) digest(value[field], `${path}.${field}`);
  }
  const episodeFields = ['episodePath', 'episodeDigest', 'episodeStatus', 'episodePlanDigest', 'episodeApprovalDigest', 'episodeGeneratedAt'];
  const episodeFieldPresence = episodeFields.map(field => value[field] !== undefined);
  const hasEpisode = episodeFieldPresence.some(Boolean);
  if (hasEpisode && !episodeFieldPresence.every(Boolean)) fail(`${path}: episode metadata must be complete`);
  const episode = hasEpisode
    ? {
      path: normalizeEpisodePath(value.episodePath, `${path}.episodePath`),
      digest: digest(value.episodeDigest, `${path}.episodeDigest`),
      status: (() => {
        const normalized = text(value.episodeStatus, `${path}.episodeStatus`, { max: 16 });
        if (!EPISODE_STATUSES.has(normalized)) fail(`${path}.episodeStatus: unsupported status ${JSON.stringify(normalized)}`);
        return normalized;
      })(),
      planDigest: digest(value.episodePlanDigest, `${path}.episodePlanDigest`),
      approvalDigest: digest(value.episodeApprovalDigest, `${path}.episodeApprovalDigest`),
      generatedAt: utcTimestamp(value.episodeGeneratedAt, `${path}.episodeGeneratedAt`),
    }
    : null;
  return { id: episodeId, week: weekValue, revision, revisionNumber: revisionNumber(revision, `${path}.revision`), status: episodeStatus, coverage: value.coverage, episode };
}

function validatePlan(plan, metadata, path) {
  const value = record(plan, path);
  if (value.schemaVersion !== PLANNING_ARCHIVE_SCHEMA_VERSION) fail(`${path}.schemaVersion: must be ${PLANNING_ARCHIVE_SCHEMA_VERSION}`);
  if (value.kind !== 'weekly-plan') fail(`${path}.kind: must be weekly-plan`);
  if (value.id !== undefined && value.id !== metadata.id) fail(`${path}.id: does not match index entry`);
  if (value.week !== metadata.week) fail(`${path}.week: does not match index entry`);
  if (value.revision !== metadata.revision) fail(`${path}.revision: does not match index entry`);
  if (value.status !== metadata.status) fail(`${path}.status: does not match index entry`);
  if (value.timezone !== 'Asia/Manila') fail(`${path}.timezone: must be Asia/Manila`);
  utcTimestamp(value.asOf, `${path}.asOf`);
  const source = record(value.source, `${path}.source`);
  for (const field of ['sourceCommit', 'contentRevision', 'policyRevision', 'generatorVersion', 'producerRevision']) text(source[field], `${path}.source.${field}`, { max: 512 });
  digest(source.inputDigest, `${path}.source.inputDigest`);
  if (value.coverage === undefined) fail(`${path}.coverage: is required`);
  jsonDepth(value.coverage, `${path}.coverage`);
  jsonSize(value.coverage, `${path}.coverage`, 128 * 1024);
  if (value.hash !== undefined) digest(value.hash, `${path}.hash`);
  if (value.canonicalTaskRefs !== undefined) {
    if (!Array.isArray(value.canonicalTaskRefs) || value.canonicalTaskRefs.length > 4096) fail(`${path}.canonicalTaskRefs: must be a bounded array`);
    for (const [index, taskId] of value.canonicalTaskRefs.entries()) id(taskId, `${path}.canonicalTaskRefs[${index}]`);
  }
  for (const field of ['outcomes', 'queues', 'gaps', 'proposals']) {
    if (!Array.isArray(value[field])) fail(`${path}.${field}: must be an array`);
  }
  jsonSize(value, path, PLANNING_ARCHIVE_LIMITS.artifactBytes);
  return value;
}

function validateManifest(manifest, metadata, paths, path) {
  const value = record(manifest, path);
  if (value.schemaVersion !== PLANNING_ARCHIVE_SCHEMA_VERSION) fail(`${path}.schemaVersion: must be ${PLANNING_ARCHIVE_SCHEMA_VERSION}`);
  if (value.kind !== 'weekly-plan-manifest') fail(`${path}.kind: must be weekly-plan-manifest`);
  if (value.id !== undefined && value.id !== metadata.id) fail(`${path}.id: does not match index entry`);
  if (value.week !== metadata.week) fail(`${path}.week: does not match index entry`);
  if (value.revision !== metadata.revision) fail(`${path}.revision: does not match index entry`);
  if (value.status !== metadata.status) fail(`${path}.status: does not match index entry`);
  utcTimestamp(value.generatedAt, `${path}.generatedAt`);
  for (const field of ['generatorVersion', 'producerRevision', 'sourceCommit', 'sourceContentRevision', 'policyRevision']) text(value[field], `${path}.${field}`, { max: 512 });
  for (const field of ['inputDigest', 'planDigest', 'htmlDigest']) digest(value[field], `${path}.${field}`);
  const expectedPaths = { manifest: paths.manifest, plan: paths.plan, html: paths.presentation };
  for (const [field, expected] of Object.entries(expectedPaths)) {
    const candidate = value[`${field}Path`] ?? value[field];
    if (candidate !== undefined) {
      const normalized = normalizeRepositoryPath(candidate, `${path}.${field}Path`);
      if (normalized !== expected) fail(`${path}.${field}Path: does not match index entry`);
    }
  }
  if (value.artifactPaths !== undefined) {
    const artifactPaths = record(value.artifactPaths, `${path}.artifactPaths`);
    for (const [field, expected] of Object.entries(expectedPaths)) {
      const candidate = artifactPaths[field];
      if (candidate === undefined) fail(`${path}.artifactPaths.${field}: is required`);
      const normalized = normalizeRepositoryPath(candidate, `${path}.artifactPaths.${field}`);
      if (normalized !== expected) fail(`${path}.artifactPaths.${field}: does not match index entry`);
    }
  } else {
    fail(`${path}.artifactPaths: is required`);
  }
  if (value.artifactDigests !== undefined) {
    const artifactDigests = record(value.artifactDigests, `${path}.artifactDigests`);
    for (const field of ['manifest', 'plan', 'html']) digest(artifactDigests[field], `${path}.artifactDigests.${field}`);
  } else {
    fail(`${path}.artifactDigests: is required`);
  }
  if (value.immutable !== true) fail(`${path}.immutable: must be true`);
  if (!Array.isArray(value.outcomeTaskIds) || value.outcomeTaskIds.some((candidate) => typeof candidate !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(candidate))) {
    fail(`${path}.outcomeTaskIds: must be an array of IDs`);
  }
  jsonSize(value, path, PLANNING_ARCHIVE_LIMITS.artifactBytes);
  return value;
}

function validateEpisode(episode, metadata, plan, episodeBytes, metadataPath) {
  const value = record(episode, metadataPath);
  if (value.schemaVersion !== PLANNING_ARCHIVE_SCHEMA_VERSION) fail(`${metadataPath}.schemaVersion: must be ${PLANNING_ARCHIVE_SCHEMA_VERSION}`);
  if (value.kind !== 'weekly-episode') fail(`${metadataPath}.kind: must be weekly-episode`);
  if (value.week !== metadata.week || value.revision !== metadata.revision) fail(`${metadataPath}: does not match the indexed plan identity`);
  const episodeStatus = text(value.status, `${metadataPath}.status`, { max: 16 });
  if (!EPISODE_STATUSES.has(episodeStatus)) fail(`${metadataPath}.status: unsupported status ${JSON.stringify(episodeStatus)}`);
  if (episodeStatus !== metadata.episode.status) fail(`${metadataPath}.status: does not match planning index episodeStatus`);
  utcTimestamp(value.generatedAt, `${metadataPath}.generatedAt`);
  if (value.generatedAt !== metadata.episode.generatedAt) fail(`${metadataPath}.generatedAt: does not match planning index episodeGeneratedAt`);
  const planDigest = canonicalDigest(plan);
  if (value.planDigest !== planDigest || value.planDigest !== metadata.episode.planDigest) fail(`${metadataPath}.planDigest: does not match the immutable plan`);
  if (!Array.isArray(value.parts) || value.parts.length > 4096) fail(`${metadataPath}.parts: must be a bounded array`);
  if (!Array.isArray(value.approvalReceipts) || value.approvalReceipts.length > 4096) fail(`${metadataPath}.approvalReceipts: must be a bounded array`);
  const expected = [];
  if (!Array.isArray(plan.outcomes) || plan.outcomes.length > 4096) fail(`${metadataPath}: plan outcomes are not bounded`);
  for (const [outcomeIndex, rawOutcome] of plan.outcomes.entries()) {
    const outcome = record(rawOutcome, `${metadataPath}.plan.outcomes[${outcomeIndex}]`);
    const taskId = id(outcome.taskId, `${metadataPath}.plan.outcomes[${outcomeIndex}].taskId`);
    for (const kind of ['task', 'assignment', 'schedule']) {
      expected.push({
        partId: `${kind}:${taskId}`,
        kind,
        taskId,
        valueDigest: canonicalDigest({ kind, outcome }),
      });
    }
  }
  if (value.parts.length !== expected.length) fail(`${metadataPath}.parts: must contain exactly one controlled part per plan outcome and approval kind`);
  const expectedById = new Map(expected.map(part => [part.partId, part]));
  const partsById = new Map();
  for (const [partIndex, rawPart] of value.parts.entries()) {
    const part = record(rawPart, `${metadataPath}.parts[${partIndex}]`);
    const partId = text(part.partId, `${metadataPath}.parts[${partIndex}].partId`, { max: 256 });
    const reference = expectedById.get(partId);
    if (!reference) fail(`${metadataPath}.parts[${partIndex}]: unknown controlled part`);
    if (partsById.has(partId)) fail(`${metadataPath}.parts[${partIndex}]: duplicate controlled part`);
    if (part.kind !== reference.kind || part.taskId !== reference.taskId || part.valueDigest !== reference.valueDigest) fail(`${metadataPath}.parts[${partIndex}]: controlled part does not match the immutable plan value`);
    if (typeof part.approved !== 'boolean') fail(`${metadataPath}.parts[${partIndex}].approved: must be boolean`);
    partsById.set(partId, part);
  }
  const receiptsByPart = new Map();
  for (const [receiptIndex, rawReceipt] of value.approvalReceipts.entries()) {
    const receipt = record(rawReceipt, `${metadataPath}.approvalReceipts[${receiptIndex}]`);
    const partId = text(receipt.partId, `${metadataPath}.approvalReceipts[${receiptIndex}].partId`, { max: 256 });
    const part = expectedById.get(partId);
    if (!part) fail(`${metadataPath}.approvalReceipts[${receiptIndex}]: references an unknown controlled part`);
    if (receiptsByPart.has(partId)) fail(`${metadataPath}.approvalReceipts[${receiptIndex}]: more than one receipt for a controlled part`);
    if (receipt.episodeId !== `${metadata.week}:${metadata.revision}` || receipt.revision !== metadata.revision) fail(`${metadataPath}.approvalReceipts[${receiptIndex}]: does not bind to episode revision`);
    text(receipt.approvedBy, `${metadataPath}.approvalReceipts[${receiptIndex}].approvedBy`, { max: 128 });
    utcTimestamp(receipt.approvedAt, `${metadataPath}.approvalReceipts[${receiptIndex}].approvedAt`);
    id(receipt.approvalRef, `${metadataPath}.approvalReceipts[${receiptIndex}].approvalRef`);
    text(receipt.approvalSource, `${metadataPath}.approvalReceipts[${receiptIndex}].approvalSource`, { max: 128 });
    if (receipt.approvedRevision !== metadata.revision) fail(`${metadataPath}.approvalReceipts[${receiptIndex}].approvedRevision: does not match episode revision`);
    text(receipt.reviewedDetail, `${metadataPath}.approvalReceipts[${receiptIndex}].reviewedDetail`, { max: 4096 });
    if (receipt.valueDigest !== part.valueDigest) fail(`${metadataPath}.approvalReceipts[${receiptIndex}].valueDigest: does not match the immutable plan part`);
    const receiptCore = {
      episodeId: receipt.episodeId,
      revision: receipt.revision,
      partId: receipt.partId,
      valueDigest: receipt.valueDigest,
      approvedBy: receipt.approvedBy,
      approvedAt: receipt.approvedAt,
      approvalRef: receipt.approvalRef,
      approvalSource: receipt.approvalSource,
      approvedRevision: receipt.approvedRevision,
      reviewedDetail: receipt.reviewedDetail,
    };
    if (receipt.approvalDigest !== canonicalDigest(receiptCore)) fail(`${metadataPath}.approvalReceipts[${receiptIndex}].approvalDigest: does not match the exact receipt`);
    receiptsByPart.set(partId, receipt);
  }
  for (const [partId, part] of partsById) {
    if (part.approved !== receiptsByPart.has(partId)) fail(`${metadataPath}.parts.${partId}.approved: does not match its receipt`);
  }
  if (episodeStatus === 'approved' && (!expected.length || expected.some(part => !partsById.get(part.partId)?.approved))) fail(`${metadataPath}: approved episode must have every controlled part approved`);
  if (metadata.episode.approvalDigest !== canonicalDigest(value.approvalReceipts)) fail(`${metadataPath}.approvalReceipts: does not match planning index episodeApprovalDigest`);
  artifactDigest(metadata.episode.digest, `${metadataPath}.artifactDigest`, episodeBytes);
  return value;
}

function validateIndex(index) {
  const value = record(index, 'planning/index.json');
  if (value.schemaVersion !== PLANNING_ARCHIVE_SCHEMA_VERSION) fail(`planning/index.json.schemaVersion: must be ${PLANNING_ARCHIVE_SCHEMA_VERSION}`);
  if (value.kind !== 'weekly-plan-index') fail('planning/index.json.kind: must be weekly-plan-index');
  if (!Array.isArray(value.entries) || value.entries.length > PLANNING_ARCHIVE_LIMITS.entries) {
    fail('planning/index.json.entries: must be a bounded array');
  }
  return value;
}

function resolveArtifact(root, relativePath, label, maxBytes) {
  const absolute = resolve(root, relativePath);
  if (!absolute.startsWith(`${resolve(root)}${sep}`)) fail(`${label}: escapes the data root`);
  const stat = lstatSync(absolute, { throwIfNoEntry: false });
  if (!stat || !stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o111) !== 0) {
    fail(`${label}: must be a non-executable regular file`);
  }
  if (stat.size > maxBytes) fail(`${label}: exceeds the archive file-size limit`);
  const rootReal = realpathSync(root);
  const artifactReal = realpathSync(absolute);
  if (artifactReal !== rootReal && !artifactReal.startsWith(`${rootReal}${sep}`)) fail(`${label}: escapes the data root`);
  return { absolute, bytes: readFileSync(absolute) };
}

function archiveIdentity(entry) {
  return `${entry.week}/${entry.revision}`;
}

/**
 * Load and validate the archive from an explicit data root. Missing planning
 * data is a valid empty archive for existing tracker instances; a present but
 * malformed archive always fails closed.
 */
export function loadPlanningArchive({ dataRoot, instance }) {
  if (typeof dataRoot !== 'string' || dataRoot.length === 0) throw new TypeError('dataRoot: must be a non-empty path');
  const root = resolve(dataRoot, instance?.data?.folderPath ?? '');
  const indexPath = join(root, 'planning/index.json');
  const indexStat = lstatSync(indexPath, { throwIfNoEntry: false });
  if (!indexStat) return { archive: emptyPlanningArchive(), snapshots: [], present: false };
  if (!indexStat.isFile() || indexStat.isSymbolicLink() || (indexStat.mode & 0o111) !== 0) {
    fail('planning/index.json: must be a non-executable regular file');
  }

  const indexArtifact = resolveArtifact(root, 'planning/index.json', 'planning/index.json', PLANNING_ARCHIVE_LIMITS.indexBytes);
  const index = validateIndex(parseJson(indexArtifact.bytes, 'planning/index.json', PLANNING_ARCHIVE_LIMITS.indexBytes));
  const entries = [];
  const snapshots = [{ path: 'planning/index.json', digest: createHash('sha256').update(indexArtifact.bytes).digest('hex'), bytes: indexArtifact.bytes.byteLength }];
  const identities = new Set();
  let totalBytes = indexArtifact.bytes.byteLength;

  for (const [indexEntry, rawEntry] of index.entries.entries()) {
    const path = `planning/index.json.entries[${indexEntry}]`;
    const metadata = validateEpisodeMetadata(rawEntry, path);
    const identity = archiveIdentity(metadata);
    if (identities.has(identity)) fail(`${path}: duplicate week/revision ${identity}`);
    identities.add(identity);
    const entry = record(rawEntry, path);
    const paths = {
      manifest: pathField(entry, ['manifestPath', 'manifest'], path),
      plan: pathField(entry, ['planPath', 'plan'], path),
      presentation: pathField(entry, ['htmlPath', 'html', 'presentationPath', 'presentation', 'presentationHtml'], path),
    };
    const artifacts = {
      manifest: resolveArtifact(root, paths.manifest, `${path}.manifest`, PLANNING_ARCHIVE_LIMITS.artifactBytes),
      plan: resolveArtifact(root, paths.plan, `${path}.plan`, PLANNING_ARCHIVE_LIMITS.artifactBytes),
      presentation: resolveArtifact(root, paths.presentation, `${path}.presentation`, PLANNING_ARCHIVE_LIMITS.artifactBytes),
    };
    if (metadata.episode) artifacts.episode = resolveArtifact(root, metadata.episode.path, `${path}.episode`, PLANNING_ARCHIVE_LIMITS.artifactBytes);
    totalBytes += Object.values(artifacts).reduce((sum, artifact) => sum + artifact.bytes.byteLength, 0);
    if (totalBytes > PLANNING_ARCHIVE_LIMITS.totalBytes) fail('planning archive exceeds the total size limit');
    const plan = validatePlan(parseJson(artifacts.plan.bytes, paths.plan, PLANNING_ARCHIVE_LIMITS.artifactBytes), metadata, paths.plan);
    const manifest = validateManifest(parseJson(artifacts.manifest.bytes, paths.manifest, PLANNING_ARCHIVE_LIMITS.artifactBytes), metadata, paths, paths.manifest);
    const presentationHtml = safePresentationHtml(Buffer.from(artifacts.presentation.bytes).toString('utf8'), paths.presentation);
    if (metadata.episode) validateEpisode(parseJson(artifacts.episode.bytes, metadata.episode.path, PLANNING_ARCHIVE_LIMITS.artifactBytes), metadata, plan, artifacts.episode.bytes, metadata.episode.path);
    if (entry.manifestDigest !== undefined) artifactDigest(entry.manifestDigest, `${path}.manifestDigest`, artifacts.manifest.bytes);
    if (entry.planDigest !== undefined) artifactDigest(entry.planDigest, `${path}.planDigest`, artifacts.plan.bytes);
    if (entry.htmlDigest !== undefined) artifactDigest(entry.htmlDigest, `${path}.htmlDigest`, artifacts.presentation.bytes);
    for (const declaration of declaredArtifactDigests(manifest, 'plan')) artifactDigest(declaration.value, declaration.path, artifacts.plan.bytes);
    for (const declaration of declaredArtifactDigests(manifest, 'presentation')) artifactDigest(declaration.value, declaration.path, artifacts.presentation.bytes);
    if (manifest.artifactDigests.manifest !== manifestSelfDigest(manifest)) {
      fail(`${paths.manifest}.artifactDigests.manifest: does not match the canonical manifest self-digest`);
    }
    for (const [manifestField, planField] of [
      ['sourceCommit', 'sourceCommit'],
      ['sourceContentRevision', 'contentRevision'],
      ['policyRevision', 'policyRevision'],
      ['generatorVersion', 'generatorVersion'],
      ['producerRevision', 'producerRevision'],
    ]) {
      if (manifest[manifestField] !== plan.source[planField]) fail(`${paths.manifest}.${manifestField}: does not match ${paths.plan}.source.${planField}`);
    }
    if (manifest.inputDigest !== plan.source.inputDigest) fail(`${paths.manifest}.inputDigest: does not match ${paths.plan}.source.inputDigest`);
    const archiveDeclared = declaredArchiveDigest(manifest);
    if (archiveDeclared) digest(archiveDeclared.value, archiveDeclared.path);
    for (const [kind, artifact] of Object.entries(artifacts)) {
      snapshots.push({
        path: kind === 'episode' ? metadata.episode.path : paths[kind],
        digest: createHash('sha256').update(artifact.bytes).digest('hex'),
        bytes: artifact.bytes.byteLength,
      });
    }
    entries.push(Object.freeze({
      id: metadata.id,
      week: metadata.week,
      date: typeof entry.date === 'string' ? entry.date : null,
      revision: metadata.revision,
      status: metadata.status,
      reviewStatus: metadata.episode?.status ?? metadata.status,
      coverage: metadata.coverage,
      hash: typeof entry.hash === 'string' ? entry.hash : null,
      paths: Object.freeze(paths),
      manifest,
      plan,
      presentationHtml,
    }));
  }

  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const byIdentity = new Map(entries.map(entry => [archiveIdentity(entry), entry]));
  const reference = (field) => {
    const value = index[field];
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') fail(`planning/index.json.${field}: must be an entry id`);
    const resolved = byId.get(value) ?? byIdentity.get(value);
    if (!resolved) fail(`planning/index.json.${field}: references an unknown entry`);
    return resolved.id;
  };
  const newestFirst = (left, right) => right.revisionNumber - left.revisionNumber || entries.indexOf(right) - entries.indexOf(left);
  const drafts = entries.filter(entry => entry.reviewStatus === 'draft').sort(newestFirst);
  const approved = entries.filter(entry => entry.reviewStatus === 'approved').sort(newestFirst);
  const currentDraftId = reference('currentDraft') ?? drafts[0]?.id ?? null;
  const latestApprovedId = reference('latestApproved') ?? approved[0]?.id ?? null;
  if (currentDraftId !== null && byId.get(currentDraftId)?.reviewStatus !== 'draft') fail('planning/index.json.currentDraft: must reference a draft entry');
  if (latestApprovedId !== null && byId.get(latestApprovedId)?.reviewStatus !== 'approved') fail('planning/index.json.latestApproved: must reference an approved entry');

  return {
    archive: Object.freeze({
      schemaVersion: PLANNING_ARCHIVE_SCHEMA_VERSION,
      entries: Object.freeze(entries),
      currentDraftId,
      latestApprovedId,
    }),
    snapshots,
    present: true,
  };
}

export function emptyPlanningArchive() {
  return Object.freeze({
    schemaVersion: PLANNING_ARCHIVE_SCHEMA_VERSION,
    entries: Object.freeze([]),
    currentDraftId: null,
    latestApprovedId: null,
  });
}

/** Browser-side boundary for the generated archive payload. */
export function parsePlanningArchive(value) {
  const archive = record(value, 'planning archive');
  if (archive.schemaVersion !== PLANNING_ARCHIVE_SCHEMA_VERSION) fail(`planning archive schemaVersion: must be ${PLANNING_ARCHIVE_SCHEMA_VERSION}`);
  if (!Array.isArray(archive.entries) || archive.entries.length > PLANNING_ARCHIVE_LIMITS.entries) fail('planning archive entries: must be a bounded array');
  const seen = new Set();
  const entries = archive.entries.map((entry, index) => {
    const metadata = validateEpisodeMetadata(entry, `planning archive.entries[${index}]`);
    const identity = archiveIdentity(metadata);
    if (seen.has(identity)) fail(`planning archive.entries[${index}]: duplicate week/revision`);
    seen.add(identity);
    const valueEntry = record(entry, `planning archive.entries[${index}]`);
    if (typeof valueEntry.presentationHtml !== 'string') fail(`planning archive.entries[${index}].presentationHtml: is required`);
    safePresentationHtml(valueEntry.presentationHtml, `planning archive.entries[${index}].presentationHtml`);
    if (valueEntry.plan === null || typeof valueEntry.plan !== 'object') fail(`planning archive.entries[${index}].plan: is required`);
    if (valueEntry.manifest === null || typeof valueEntry.manifest !== 'object') fail(`planning archive.entries[${index}].manifest: is required`);
    return Object.freeze(valueEntry);
  });
  const ids = new Set(entries.map(entry => entry.id));
  for (const field of ['currentDraftId', 'latestApprovedId']) {
    const value = archive[field];
    if (value !== null && value !== undefined && (typeof value !== 'string' || !ids.has(value))) fail(`planning archive.${field}: references an unknown entry`);
  }
  return Object.freeze({
    schemaVersion: PLANNING_ARCHIVE_SCHEMA_VERSION,
    entries: Object.freeze(entries),
    currentDraftId: archive.currentDraftId ?? null,
    latestApprovedId: archive.latestApprovedId ?? null,
  });
}
