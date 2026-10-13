import {
  lstatSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const MAX_BYTES = 512 * 1024;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;
const AVATAR = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(?:png|jpe?g|webp|gif)$/iu;
const SAFE_STATUSES = new Set(['queued', 'started', 'active', 'blocked', 'done', 'unknown']);
const SAFE_COMMITMENTS = new Set(['draft', 'planned', 'accepted']);
const SAFE_PHASES = new Set(['discovery', 'build', 'verify']);
const SAFE_HEALTH_STATES = new Set(['unknown', 'on-track', 'at-risk', 'blocked']);
const DIRECTORY_ONLY_MODE = 'directory-only-v3';
const FULL_CURRENT_MODE = 'full-current-v1';
const DIRECTORY_ONLY_SCHEDULE_RULE = 'directory-only-no-task-schedules';
const DIRECTORY_KEYS = ['id', 'displayName', 'avatar'];
const SCHEDULE_KEYS = ['taskId', 'approvedStart', 'approvedEnd'];
const METADATA_KEYS = ['taskId', 'status', 'commitment', 'phase', 'healthState'];
const ACTIVITY_KEYS = ['taskId', 'eventCount', 'latestOccurredAt'];
const PRIVATE_TEXT = /(?:https?:\/\/|\b(?:password|token|secret|credential)\s*[:=]|\bprivate(?:[ _-](?:note|data|history|source))?\b|\braw[ _-](?:evidence|source)\b)/iu;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, allowed, path, errors, optional = []) {
  if (!isRecord(value)) {
    errors.push(`${path}: must be an object`);
    return;
  }
  const expected = new Set([...allowed, ...optional]);
  for (const key of Object.keys(value)) if (!expected.has(key)) errors.push(`${path}.${key}: unknown field`);
  for (const key of allowed) if (!Object.hasOwn(value, key)) errors.push(`${path}.${key}: required field is missing`);
}

function isDate(value) {
  if (typeof value !== 'string' || !DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function isUtc(value) {
  return typeof value === 'string' && UTC.test(value) && !Number.isNaN(new Date(value).valueOf());
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (isRecord(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalValue(value[key])]));
  return value;
}

function digest(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(canonicalValue(value))).digest('hex')}`;
}

function companionWithoutDigest(value) {
  const { companionDigest: _ignored, ...rest } = value;
  return rest;
}

function standingProjectionDigest(projection) {
  if (!isRecord(projection) || projection.kind !== 'standing-team-projection') return null;
  return digest({
    ...projection,
    publish: projection.publish ? { ...projection.publish, initialProjectionDigest: null } : projection.publish,
  });
}

function fullTaskProjectionDigest(projection) {
  if (!isRecord(projection) || projection.kind !== 'full-task-projection') return null;
  return digest({
    ...projection,
    publish: projection.publish ? { ...projection.publish, initialProjectionDigest: null } : projection.publish,
  });
}

function projectionDigest(projection) {
  return standingProjectionDigest(projection) ?? fullTaskProjectionDigest(projection);
}

function validateCompanion(value, projection, { enforceTaskIds = Boolean(projection), expectedRosterDigest = null } = {}) {
  const errors = [];
  const topLevel = ['schemaVersion', 'kind', 'projectionDigest', 'projectionRevision', 'policyRevision', 'generatedAt', 'directory', 'schedules', 'taskMetadata', 'audit', 'publish', 'companionDigest'];
  exactKeys(value, topLevel, '$', errors, ['mode', 'activitySummaries']);
  if (!isRecord(value)) return errors;
  if (value.schemaVersion !== 1) errors.push('schemaVersion: must be 1');
  if (value.kind !== 'team-safe-companion') errors.push('kind: invalid');
  const directoryOnly = value.mode === DIRECTORY_ONLY_MODE;
  if (value.mode !== undefined && value.mode !== DIRECTORY_ONLY_MODE && value.mode !== FULL_CURRENT_MODE) errors.push('mode: invalid');
  if (!DIGEST.test(String(value.projectionDigest ?? ''))) errors.push('projectionDigest: invalid');
  if (!ID.test(String(value.projectionRevision ?? ''))) errors.push('projectionRevision: invalid');
  if (typeof value.policyRevision !== 'string' || value.policyRevision.length === 0) errors.push('policyRevision: invalid');
  if (!isUtc(value.generatedAt)) errors.push('generatedAt: invalid UTC timestamp');
  const directoryIds = new Set();
  if (!Array.isArray(value.directory)) errors.push('directory: must be an array');
  else value.directory.forEach((entry, index) => {
    const path = `directory[${index}]`;
    exactKeys(entry, DIRECTORY_KEYS, path, errors);
    if (!isRecord(entry)) return;
    if (!ID.test(String(entry.id)) || directoryIds.has(entry.id)) errors.push(`${path}.id: must be a unique roster ID`);
    directoryIds.add(entry.id);
    if (typeof entry.displayName !== 'string' || entry.displayName.trim().length === 0 || entry.displayName.length > 160 || /[\u0000-\u001f\u007f]/u.test(entry.displayName) || PRIVATE_TEXT.test(entry.displayName)) errors.push(`${path}.displayName: unsafe display text`);
    if (entry.avatar !== null && (!AVATAR.test(String(entry.avatar)) || String(entry.avatar).includes('..'))) errors.push(`${path}.avatar: must be a local avatar basename or null`);
  });
  const taskIds = projection && Array.isArray(projection.tasks) ? new Set(projection.tasks.map(task => task.taskId)) : null;
  const projectedTasks = projection && Array.isArray(projection.tasks)
    ? new Map(projection.tasks.map(task => [task.taskId, task]))
    : null;
  const scheduleIds = new Set();
  if (!Array.isArray(value.schedules)) errors.push('schedules: must be an array');
  else value.schedules.forEach((entry, index) => {
    const path = `schedules[${index}]`;
    exactKeys(entry, SCHEDULE_KEYS, path, errors);
    if (!isRecord(entry)) return;
    if (!ID.test(String(entry.taskId)) || scheduleIds.has(entry.taskId) || (enforceTaskIds && taskIds && !taskIds.has(entry.taskId))) errors.push(`${path}.taskId: must be a unique projected task ID`);
    scheduleIds.add(entry.taskId);
    if (entry.approvedStart !== null && !isDate(entry.approvedStart)) errors.push(`${path}.approvedStart: must be a date or null`);
    if (!isDate(entry.approvedEnd)) errors.push(`${path}.approvedEnd: must be a date`);
    if (isDate(entry.approvedStart) && entry.approvedEnd < entry.approvedStart) errors.push(`${path}: approved end precedes start`);
    if (enforceTaskIds && projectedTasks?.has(entry.taskId)) {
      const projectedTask = projectedTasks.get(entry.taskId);
      const projectedEnd = projectedTask.approvedDate
        ?? (projectedTask.deadline?.label === 'approved' ? projectedTask.deadline.date : null);
      if (projectedEnd !== entry.approvedEnd) errors.push(`${path}.approvedEnd: must match the existing approved projection deadline`);
    }
  });
  const metadataIds = new Set();
  if (!Array.isArray(value.taskMetadata)) errors.push('taskMetadata: must be an array');
  else value.taskMetadata.forEach((entry, index) => {
    const path = `taskMetadata[${index}]`;
    exactKeys(entry, METADATA_KEYS, path, errors);
    if (!isRecord(entry)) return;
    if (!ID.test(String(entry.taskId)) || metadataIds.has(entry.taskId) || (enforceTaskIds && taskIds && !taskIds.has(entry.taskId))) errors.push(`${path}.taskId: must be a unique projected task ID`);
    metadataIds.add(entry.taskId);
    if (enforceTaskIds && projectedTasks?.has(entry.taskId) && projectedTasks.get(entry.taskId).status !== entry.status) errors.push(`${path}.status: must match the anchored projection status`);
    if (!SAFE_STATUSES.has(entry.status)) errors.push(`${path}.status: invalid safe status`);
    if (entry.commitment !== null && !SAFE_COMMITMENTS.has(entry.commitment)) errors.push(`${path}.commitment: invalid safe commitment`);
    if (entry.phase !== null && !SAFE_PHASES.has(entry.phase)) errors.push(`${path}.phase: invalid safe phase`);
    if (entry.healthState !== null && !SAFE_HEALTH_STATES.has(entry.healthState)) errors.push(`${path}.healthState: invalid safe health state`);
  });
  const activityIds = new Set();
  if (value.activitySummaries === undefined) {
    if (projection?.kind === 'full-task-projection' && value.mode !== DIRECTORY_ONLY_MODE) errors.push('activitySummaries: required for full-current companions');
  } else if (!Array.isArray(value.activitySummaries)) errors.push('activitySummaries: must be an array');
  else value.activitySummaries.forEach((entry, index) => {
    const path = `activitySummaries[${index}]`;
    exactKeys(entry, ACTIVITY_KEYS, path, errors);
    if (!isRecord(entry)) return;
    if (!ID.test(String(entry.taskId)) || activityIds.has(entry.taskId) || (enforceTaskIds && taskIds && !taskIds.has(entry.taskId))) errors.push(`${path}.taskId: must be a unique projected task ID`);
    activityIds.add(entry.taskId);
    if (!Number.isInteger(entry.eventCount) || entry.eventCount < 0) errors.push(`${path}.eventCount: must be a non-negative integer`);
    if (entry.latestOccurredAt !== null && !isUtc(entry.latestOccurredAt)) errors.push(`${path}.latestOccurredAt: must be a UTC timestamp or null`);
  });
  exactKeys(value.audit, ['directoryRule', 'scheduleRule', 'sourceTaskCount', 'rosterDigest'], '$.audit', errors);
  if (isRecord(value.audit)) {
    if (value.audit.directoryRule !== 'approved-roster-safe-display-metadata-only') errors.push('audit.directoryRule: invalid');
    const expectedScheduleRule = directoryOnly ? DIRECTORY_ONLY_SCHEDULE_RULE : 'approved-endpoint-only-with-existing-task-proof';
    if (value.audit.scheduleRule !== expectedScheduleRule) errors.push('audit.scheduleRule: invalid');
    if (!Number.isInteger(value.audit.sourceTaskCount) || value.audit.sourceTaskCount < 0) errors.push('audit.sourceTaskCount: invalid');
    if (directoryOnly && (!Array.isArray(value.schedules) || !Array.isArray(value.taskMetadata)
      || value.schedules.length !== 0 || value.taskMetadata.length !== 0)) {
      errors.push('directory-only companion: schedules and taskMetadata must be empty');
    }
    if (!DIGEST.test(String(value.audit.rosterDigest ?? ''))) errors.push('audit.rosterDigest: invalid');
    if (Array.isArray(value.directory) && value.audit.rosterDigest !== digest(value.directory.map(entry => entry.id).sort())) errors.push('audit.rosterDigest: does not bind directory');
  }
  if (projection?.kind === 'full-task-projection') {
    if (value.mode !== undefined && value.mode !== DIRECTORY_ONLY_MODE && value.mode !== FULL_CURRENT_MODE) errors.push('mode: invalid full-current companion mode');
    if (value.projectionDigest !== fullTaskProjectionDigest(projection)) errors.push('projectionDigest: does not bind the full task projection');
    if (value.projectionRevision !== projection.revision) errors.push('projectionRevision: does not bind the full task projection');
    if (value.policyRevision !== projection.policyRevision) errors.push('policyRevision: does not bind the full task projection');
    if (value.audit?.sourceTaskCount !== projection.tasks.length) errors.push('audit.sourceTaskCount: must match the raw full task projection');
    if (value.mode === DIRECTORY_ONLY_MODE && (!Array.isArray(value.schedules) || !Array.isArray(value.taskMetadata)
      || value.schedules.length !== 0 || value.taskMetadata.length !== 0)) {
      errors.push('directory-only companion: task metadata and schedules are not allowed');
    }
    if (value.mode !== DIRECTORY_ONLY_MODE && (!Array.isArray(value.activitySummaries) || value.activitySummaries.length !== projection.tasks.length)) {
      errors.push('activitySummaries: full-current companion must cover every projected task');
    }
  }
  if (expectedRosterDigest !== null
    && (!DIGEST.test(String(expectedRosterDigest)) || value.audit?.rosterDigest !== expectedRosterDigest)) {
    errors.push('audit.rosterDigest: does not match the trusted directory roster constraint in every companion mode');
  }
  exactKeys(value.publish, ['reviewed', 'activationEnabled'], '$.publish', errors);
  if (!isRecord(value.publish) || value.publish.reviewed !== false || value.publish.activationEnabled !== false) errors.push('publish: must remain disabled');
  if (!DIGEST.test(String(value.companionDigest ?? '')) || value.companionDigest !== digest(companionWithoutDigest(value))) errors.push('companionDigest: does not bind content');
  return errors;
}

function resolveCompanionPath(root, path) {
  if (typeof path !== 'string' || path.length === 0 || path.includes('\\') || path.includes('%') || path.startsWith('/') || path.split('/').some(segment => !segment || segment === '.' || segment === '..')) {
    throw new Error('team companion path must be a safe relative path');
  }
  const rootAbsolute = resolve(root);
  const rootStat = lstatSync(rootAbsolute, { throwIfNoEntry: false });
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) throw new Error('team companion data root must be a real directory');
  const absolute = resolve(rootAbsolute, ...path.split('/'));
  const candidate = relative(rootAbsolute, absolute);
  if (candidate === '..' || candidate.startsWith(`..${sep}`) || isAbsolute(candidate)) throw new Error('team companion path escapes data root');
  let current = rootAbsolute;
  for (const segment of path.split('/')) {
    current = join(current, segment);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (!stat || stat.isSymbolicLink()) throw new Error('team companion path must not contain symlinks');
  }
  const stat = lstatSync(absolute, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.isSymbolicLink() || (stat.mode & 0o111) !== 0) throw new Error('team companion must be a regular non-executable file');
  if (stat.size > MAX_BYTES) throw new Error('team companion exceeds the file-size limit');
  const physical = realpathSync(absolute);
  const rootReal = realpathSync(rootAbsolute);
  if (physical !== rootReal && !physical.startsWith(`${rootReal}${sep}`)) throw new Error('team companion escapes data root');
  return { absolute, bytes: readFileSync(absolute) };
}

/** Read an optional safe companion without extending the standing projection contract. */
export function readTeamCompanion({ dataRoot, companionPath, projection, expectedRosterDigest = null } = {}) {
  if (companionPath === null || companionPath === undefined || companionPath === '') return null;
  const artifact = resolveCompanionPath(resolve(dataRoot), companionPath);
  let value;
  try {
    value = JSON.parse(artifact.bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`team companion: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  const errors = validateCompanion(value, null);
  if (errors.length) throw new Error(`team companion is invalid: ${errors.join('; ')}`);
  const currentDigest = projectionDigest(projection);
  const currentRosterDigest = projection?.audit?.rosterDigest ?? null;
  const standingProjection = projection?.kind === 'standing-team-projection';
  const fullTaskProjection = projection?.kind === 'full-task-projection';
  const directoryOnly = value.mode === DIRECTORY_ONLY_MODE;
  const trustedRosterMismatch = !DIGEST.test(String(expectedRosterDigest ?? ''))
    || value.audit.rosterDigest !== expectedRosterDigest;
  const unsupportedProjection = !standingProjection && !fullTaskProjection;
  const rosterMismatch = Boolean(standingProjection)
    && (!DIGEST.test(String(currentRosterDigest)) || currentRosterDigest !== value.audit.rosterDigest);
  const policyMismatch = Boolean(standingProjection || fullTaskProjection)
    && projection.policyRevision !== value.policyRevision;
  const projectionMismatch = Boolean(projection)
    && (!currentDigest || currentDigest !== value.projectionDigest || projection.revision !== value.projectionRevision);
  if (!projectionMismatch && !unsupportedProjection && !rosterMismatch && !policyMismatch && !trustedRosterMismatch) {
    const bindingErrors = validateCompanion(value, projection, { expectedRosterDigest });
    if (bindingErrors.length) throw new Error(`team companion task binding is invalid: ${bindingErrors.join('; ')}`);
    return Object.freeze({
      ...value,
      directoryOnly,
      // Directory-only supplements never authorize task dates, metadata, or activity.
      staleSchedule: directoryOnly,
      staleMetadata: directoryOnly,
      staleActivity: directoryOnly,
      activitySummaries: directoryOnly ? [] : (value.activitySummaries ?? []),
      fileDigest: `sha256:${createHash('sha256').update(artifact.bytes).digest('hex')}`,
    });
  }
  if (unsupportedProjection || rosterMismatch || policyMismatch || trustedRosterMismatch || projectionMismatch) return Object.freeze({
    ...value,
    directory: [],
    schedules: [],
    taskMetadata: [],
    activitySummaries: [],
    staleSchedule: true,
    staleMetadata: true,
    staleActivity: true,
    ...(unsupportedProjection ? { unsupportedProjection: true } : {}),
    ...(rosterMismatch ? { rosterMismatch: true } : {}),
    ...(policyMismatch ? { policyMismatch: true } : {}),
    ...(trustedRosterMismatch ? { trustedRosterMismatch: true } : {}),
    ...(projectionMismatch ? { projectionMismatch: true } : {}),
    fileDigest: `sha256:${createHash('sha256').update(artifact.bytes).digest('hex')}`,
  });
  return Object.freeze({
    ...value,
    ...(unsupportedProjection || rosterMismatch || policyMismatch || projectionMismatch ? { directory: [] } : {}),
    schedules: [],
    taskMetadata: [],
    activitySummaries: [],
    staleSchedule: true,
    staleMetadata: true,
    staleActivity: true,
    ...(unsupportedProjection ? { unsupportedProjection: true } : {}),
    ...(rosterMismatch ? { rosterMismatch: true } : {}),
    ...(policyMismatch ? { policyMismatch: true } : {}),
    ...(trustedRosterMismatch ? { trustedRosterMismatch: true } : {}),
    ...(projectionMismatch ? { projectionMismatch: true } : {}),
    currentProjectionDigest: currentDigest,
    fileDigest: `sha256:${createHash('sha256').update(artifact.bytes).digest('hex')}`,
  });
}

export function validateTeamCompanion(value, projection = null) {
  const errors = validateCompanion(value, projection);
  return errors.length ? { valid: false, errors } : { valid: true, value };
}
