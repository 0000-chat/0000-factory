import {
  lstatSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export const TEAM_PROJECTION_MAX_BYTES = 2 * 1024 * 1024;
export const TEAM_PROJECTION_MAX_DEPTH = 24;

const TOP_LEVEL_KEYS = [
  'schemaVersion', 'kind', 'projectionId', 'week', 'revision', 'policyRevision',
  'sourcePlanDigest', 'generatedAt', 'tasks', 'omissions',
];
const STANDING_TOP_LEVEL_KEYS = [
  'schemaVersion', 'kind', 'projectionId', 'revision', 'policyRevision',
  'generatedAt', 'tasks', 'gaps', 'audit', 'publish',
];
const STANDING_HIERARCHY_TOP_LEVEL_KEYS = [
  ...STANDING_TOP_LEVEL_KEYS, 'hierarchyVersion', 'contextNodes',
];
const TASK_KEYS = [
  'taskId', 'title', 'scope', 'completionCondition', 'assignee', 'reviewer',
  'status', 'nextStep', 'approvedDate', 'forecastDate', 'checkpoint',
  'dependencies', 'evidenceLinks',
];
const STANDING_TASK_KEYS = [
  'taskId', 'title', 'description', 'assignee', 'reviewer', 'status',
  'nextStep', 'completionCriteria', 'deadline',
];
const STANDING_HIERARCHY_TASK_KEYS = [...STANDING_TASK_KEYS, 'parentId'];
// Context nodes are deliberately structural-only. They use the viewer's
// generic node names so an omitted parent can be shown in a breadcrumb/tree
// without importing any task fields.
const CONTEXT_ANCESTOR_KEYS = ['id', 'title', 'kind', 'parentId'];
const CONTEXT_ANCESTOR_KINDS = new Set(['project', 'workstream', 'task']);
const DEPENDENCY_KEYS = ['summary'];
const OMISSION_KEYS = ['taskId', 'field', 'reason'];
const STANDING_GAP_KEYS = ['taskId', 'field', 'reason', 'message'];
const STANDING_AUDIT_KEYS = [
  'rule', 'policyDigest', 'rosterDigest', 'fieldsDigest', 'approvalDigest',
  'decisionId', 'approvalState',
];
const STANDING_PUBLISH_KEYS = ['initialProjectionDigest', 'reviewed', 'activationEnabled'];
const PRIVATE_KEY = /private|raw|approvalnotes|hiddenreferences|hiddenrefs|sensitiveartifacts|botcommands|sourcenotes|credential|secret|transcript|canonical|don|receipt/i;
const TEXT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
// Ordinary product language may mention meetings, Slack, OAuth, or tokens.
// Reject only credential-shaped material and explicit private-data canaries;
// private/control fields are already excluded by the exact key allowlist.
const PRIVATE_VALUE = /(?:https?:\/\/|(?:^|\s)[/~](?:home|root|private|secret)(?:\/|\b)|[?&#][\w.-]+=|-----BEGIN [^-]*PRIVATE KEY-----|\b(?:sk|pk|ghp_|github_pat_|xox[baprs]-)[a-z0-9_-]{12,}\b|\b(?:password|token|secret|credential)\s*[:=]\s*\S+|\bprivate[_ -](?:canary|sentinel|history|notes?|data)\b|\b(?:approval|receipt|don)[_ -](?:control|ref|receipt)\b)/iu;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const WEEK = /^\d{4}-W(?:0[1-9]|[1-4]\d|5[0-3])$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const EMPTY_SOURCE_DIGEST = `sha256:${'0'.repeat(64)}`;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const LEGACY_STATUSES = new Set(['queued', 'started', 'blocked', 'done', 'unknown']);
const STANDING_STATUSES = new Set(['queued', 'started', 'active', 'blocked', 'done', 'unknown']);
const GITHUB_REPOSITORY = /^[a-z0-9_.-]{1,100}\/[a-z0-9_.-]{1,100}$/u;
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/iu;
const MAX_LINK_POLICY_HOSTS = 128;
const MAX_LINK_POLICY_REPOSITORIES = 128;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isId(value) { return typeof value === 'string' && ID.test(value); }
function isSafeRelativePath(value) {
  return typeof value === 'string' && value.length > 0 && !value.includes('\\') && !value.startsWith('/')
    && !value.includes('%') && !value.includes('\0') && !value.split('/').some(part => !part || part === '.' || part === '..')
    && !/^[a-z][a-z\d+.-]*:/iu.test(value);
}

function isDate(value) {
  if (typeof value !== 'string' || !DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function isUtc(value) {
  return typeof value === 'string' && UTC.test(value) && !Number.isNaN(new Date(value).valueOf());
}

function validateLegacyProjection(value) {
  const errors = [];
  if (!isRecord(value)) return { valid: false, errors: ['projection: must be an object'] };
  if (value.schemaVersion !== 1) errors.push('schemaVersion: must be 1');
  if (value.kind !== 'team-projection') errors.push('kind: must be team-projection');
  if (!isId(value.projectionId)) errors.push('projectionId: must be an ID');
  if (!WEEK.test(value.week)) errors.push('week: must be YYYY-Www');
  if (!isId(value.revision)) errors.push('revision: must be an ID');
  if (!isId(value.policyRevision)) errors.push('policyRevision: must be an ID');
  if (typeof value.sourcePlanDigest !== 'string' || !DIGEST.test(value.sourcePlanDigest)) errors.push('sourcePlanDigest: must be sha256:<64 lowercase hex>');
  if (!isUtc(value.generatedAt)) errors.push('generatedAt: must be an ISO UTC timestamp');
  if (!Array.isArray(value.tasks)) errors.push('tasks: must be an array');
  else value.tasks.forEach((task, index) => {
    const path = `tasks[${index}]`;
    if (!isRecord(task)) { errors.push(`${path}: must be an object`); return; }
    if (!isId(task.taskId)) errors.push(`${path}.taskId: must be an ID`);
    if (!LEGACY_STATUSES.has(task.status)) errors.push(`${path}.status: invalid status`);
    for (const key of ['title', 'scope', 'completionCondition', 'nextStep']) if (task[key] !== null && task[key] !== undefined && typeof task[key] !== 'string') errors.push(`${path}.${key}: must be a string or null`);
    for (const key of ['assignee', 'reviewer']) if (task[key] !== null && task[key] !== undefined && !isId(task[key])) errors.push(`${path}.${key}: must be an ID or null`);
    for (const key of ['approvedDate', 'forecastDate']) if (task[key] !== null && task[key] !== undefined && !isDate(task[key])) errors.push(`${path}.${key}: must be a date or null`);
    if (task.checkpoint !== null && task.checkpoint !== undefined && !isUtc(task.checkpoint)) errors.push(`${path}.checkpoint: must be an ISO UTC timestamp or null`);
    if (!Array.isArray(task.dependencies) || task.dependencies.some(dependency => !isRecord(dependency) || typeof dependency.summary !== 'string')) errors.push(`${path}.dependencies: must be an array of safe summary objects`);
    if (!Array.isArray(task.evidenceLinks) || task.evidenceLinks.some(link => typeof link !== 'string')) errors.push(`${path}.evidenceLinks: must be an array of strings`);
  });
  if (!Array.isArray(value.omissions)) errors.push('omissions: must be an array');
  if (value.sourcePlanDigest === EMPTY_SOURCE_DIGEST && Array.isArray(value.tasks) && value.tasks.length > 0) {
    errors.push('sourcePlanDigest: the uninitialized zero digest is only valid with zero tasks');
  }
  return errors.length ? { valid: false, errors } : { valid: true, errors: [] };
}

function validateStandingProjection(value) {
  const errors = [];
  if (!isRecord(value)) return { valid: false, errors: ['projection: must be an object'] };
  const hierarchical = value.schemaVersion === 2;
  if (value.schemaVersion !== 1 && value.schemaVersion !== 2) errors.push('schemaVersion: must be 1 or 2');
  if (value.kind !== 'standing-team-projection') errors.push('kind: must be standing-team-projection');
  if (hierarchical && value.hierarchyVersion !== 1) errors.push('hierarchyVersion: must be 1');
  if (hierarchical && !Array.isArray(value.contextNodes)) errors.push('contextNodes: must be an array');
  if (!isId(value.projectionId)) errors.push('projectionId: must be an ID');
  if (!isId(value.revision)) errors.push('revision: must be an ID');
  if (typeof value.policyRevision !== 'string' || !value.policyRevision) errors.push('policyRevision: must be a non-empty string');
  if (hierarchical && value.policyRevision !== 'standing-sharing-v2') errors.push('policyRevision: must be standing-sharing-v2');
  if (!isUtc(value.generatedAt)) errors.push('generatedAt: must be an ISO UTC timestamp');
  if (!Array.isArray(value.tasks)) errors.push('tasks: must be an array');
  else value.tasks.forEach((task, index) => {
    const path = `tasks[${index}]`;
    if (!isRecord(task)) { errors.push(`${path}: must be an object`); return; }
    if (!isId(task.taskId)) errors.push(`${path}.taskId: must be an ID`);
    if (typeof task.title !== 'string' || !task.title.trim()) errors.push(`${path}.title: must be non-empty text`);
    if (typeof task.description !== 'string' || !task.description.trim()) errors.push(`${path}.description: must be non-empty text`);
    if (!isId(task.assignee)) errors.push(`${path}.assignee: must be an approved person ID`);
    if (task.reviewer !== null && !isId(task.reviewer)) errors.push(`${path}.reviewer: must be an approved person ID or null`);
    if (!STANDING_STATUSES.has(task.status)) errors.push(`${path}.status: invalid status`);
    if (typeof task.nextStep !== 'string' || !task.nextStep.trim()) errors.push(`${path}.nextStep: must be non-empty text`);
    if (typeof task.completionCriteria !== 'string' || !task.completionCriteria.trim()) errors.push(`${path}.completionCriteria: must be non-empty text`);
    if (task.deadline !== null) {
      if (!isRecord(task.deadline) || !['approved', 'forecast'].includes(task.deadline.label) || !isDate(task.deadline.date)) {
        errors.push(`${path}.deadline: must be null or an approved/forecast date`);
      }
    }
    if (hierarchical && task.parentId !== null && !isId(task.parentId)) {
      errors.push(`${path}.parentId: must be an ID or null`);
    }
  });
  if (!Array.isArray(value.gaps)) errors.push('gaps: must be an array');
  if (!isRecord(value.audit)) errors.push('audit: must be an object');
  if (!isRecord(value.publish)) errors.push('publish: must be an object');
  return errors.length ? { valid: false, errors } : { valid: true, errors: [] };
}

function validateStandingHierarchy(value) {
  const tasksById = new Map(value.tasks.map(task => [task.taskId, task]));
  const nodesById = new Map();
  if (!Array.isArray(value.contextNodes)) fail('contextNodes', 'must be an array');
  value.contextNodes.forEach((node, nodeIndex) => {
    const path = `contextNodes[${nodeIndex}]`;
    exactKeys(node, CONTEXT_ANCESTOR_KEYS, path);
    if (!isId(node.id)) fail(`${path}.id`, 'must be an ID');
    if (nodesById.has(node.id)) fail(`${path}.id`, 'must be unique across context nodes');
    safeText(node.title, `${path}.title`, { nullable: false });
    if (!CONTEXT_ANCESTOR_KINDS.has(node.kind)) fail(`${path}.kind`, 'must be project, workstream, or task');
    if (node.parentId !== null && !isId(node.parentId)) fail(`${path}.parentId`, 'must be an ID or null');
    nodesById.set(node.id, node);
  });

  const knownIds = new Set([...tasksById.keys(), ...nodesById.keys()]);
  value.tasks.forEach((task, index) => {
    if (task.parentId !== null && !knownIds.has(task.parentId)) {
      fail(`tasks[${index}].parentId`, 'must reference a task or context ancestor node');
    }
  });
  for (const [nodeId, node] of nodesById) {
    if (node.parentId !== null && !knownIds.has(node.parentId)) {
      fail(`contextNodes[${nodeId}].parentId`, 'must reference a task or context ancestor node');
    }
  }

  // A shared structural chain must remain acyclic so the viewer's tree and
  // breadcrumb walks cannot become unbounded on malformed input.
  for (const startId of knownIds) {
    const visited = new Set();
    let current = startId;
    while (current) {
      if (visited.has(current)) fail('contextNodes', 'must not contain a parent cycle');
      visited.add(current);
      const record = tasksById.get(current) ?? nodesById.get(current);
      current = record?.parentId ?? null;
    }
  }
}

export class TeamProjectionInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TeamProjectionInputError';
    this.code = 'team-projection-invalid';
  }
}

function fail(path, message) {
  throw new TeamProjectionInputError(`${path}: ${message}`);
}

function exactKeys(value, allowed, path, { optional = [] } = {}) {
  if (!isRecord(value)) fail(path, 'must be an object');
  const expected = new Set(allowed);
  for (const key of Object.keys(value)) if (!expected.has(key)) fail(`${path}.${key}`, 'unknown field');
  const optionalKeys = new Set(optional);
  for (const key of allowed) if (!optionalKeys.has(key) && !Object.prototype.hasOwnProperty.call(value, key)) {
    fail(`${path}.${key}`, 'required field is missing');
  }
}

function scanJson(value, path = '$', depth = 0) {
  if (depth > TEAM_PROJECTION_MAX_DEPTH) fail(path, 'exceeds the maximum JSON depth');
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanJson(entry, `${path}[${index}]`, depth + 1));
    return;
  }
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (PRIVATE_KEY.test(key)) fail(`${path}.${key}`, 'private/control field is forbidden');
      scanJson(entry, `${path}.${key}`, depth + 1);
    }
  }
}

function safeText(value, path, { nullable = true, max = 16_384 } = {}) {
  if (value === null || value === undefined) {
    if (nullable) return;
    fail(path, 'is required');
  }
  if (typeof value !== 'string' || value.length > max || TEXT_CONTROL.test(value) || PRIVATE_VALUE.test(value)) fail(path, 'must be a team-safe string');
}

function normalizeLinkPolicy(value) {
  const policy = value ?? {};
  if (!isRecord(policy)) throw new TypeError('linkPolicy: must be an object');
  const allowedEvidenceHosts = policy.allowedEvidenceHosts ?? [];
  const forbiddenGitHubRepositories = policy.forbiddenGitHubRepositories ?? [];
  if (!Array.isArray(allowedEvidenceHosts) || allowedEvidenceHosts.length > MAX_LINK_POLICY_HOSTS) {
    throw new TypeError(`linkPolicy.allowedEvidenceHosts: must be an array of at most ${MAX_LINK_POLICY_HOSTS} hosts`);
  }
  if (!Array.isArray(forbiddenGitHubRepositories) || forbiddenGitHubRepositories.length > MAX_LINK_POLICY_REPOSITORIES) {
    throw new TypeError(`linkPolicy.forbiddenGitHubRepositories: must be an array of at most ${MAX_LINK_POLICY_REPOSITORIES} repositories`);
  }
  const hosts = allowedEvidenceHosts.map((host, index) => {
    if (typeof host !== 'string' || host.length === 0 || host !== host.trim() || /[\u0000-\u001f\u007f]/u.test(host)) {
      throw new TypeError(`linkPolicy.allowedEvidenceHosts[${index}]: must be a host name`);
    }
    const normalized = host.replace(/\.$/u, '').toLowerCase();
    if (!HOSTNAME.test(normalized) || isIP(normalized) !== 0 || normalized === 'localhost' || normalized.endsWith('.localhost') || normalized === 'local' || normalized.endsWith('.local')) {
      throw new TypeError(`linkPolicy.allowedEvidenceHosts[${index}]: must be a public host name`);
    }
    return normalized;
  });
  if (new Set(hosts).size !== hosts.length) throw new TypeError('linkPolicy.allowedEvidenceHosts: duplicate host');
  const repositories = forbiddenGitHubRepositories.map((repository, index) => {
    if (typeof repository !== 'string' || !GITHUB_REPOSITORY.test(repository.toLowerCase())) {
      throw new TypeError(`linkPolicy.forbiddenGitHubRepositories[${index}]: must be owner/repository`);
    }
    return repository.toLowerCase();
  });
  if (new Set(repositories).size !== repositories.length) throw new TypeError('linkPolicy.forbiddenGitHubRepositories: duplicate repository');
  return { allowedEvidenceHosts: new Set(hosts), forbiddenGitHubRepositories: new Set(repositories) };
}

function githubRepository(pathname) {
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length < 2) return null;
  const repository = `${segments[0]}/${segments[1]}`.toLowerCase();
  return GITHUB_REPOSITORY.test(repository) ? repository : null;
}

function safeEvidenceLink(value, path, linkPolicy) {
  if (typeof value !== 'string') fail(path, 'must be a string');
  let url;
  try { url = new URL(value); } catch { fail(path, 'must be an HTTPS URL'); }
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { fail(path, 'must not contain malformed URL encoding'); }
  const hostname = url.hostname.replace(/\.$/u, '').toLowerCase();
  const networkHost = hostname.replace(/^\[|\]$/gu, '');
  const privateNetworkHost = isIP(networkHost) !== 0
    || hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname === 'local'
    || hostname.endsWith('.local');
  const forbiddenRepository = hostname === 'github.com' ? githubRepository(pathname) : null;
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || privateNetworkHost
    || !linkPolicy.allowedEvidenceHosts.has(hostname)
    || (forbiddenRepository !== null && linkPolicy.forbiddenGitHubRepositories.has(forbiddenRepository))) {
    fail(path, 'must be HTTPS, query-free, credential-free, and on an explicitly allowed evidence host');
  }
}

function validateStandingMetadata(value) {
  const taskIds = new Set(value.tasks.map(task => task.taskId));
  value.gaps.forEach((gap, index) => {
    const path = `gaps[${index}]`;
    exactKeys(gap, STANDING_GAP_KEYS, path);
    if (!isId(gap.taskId) || !taskIds.has(gap.taskId)) fail(`${path}.taskId`, 'must reference a known task ID');
    safeText(gap.field, `${path}.field`, { nullable: false, max: 128 });
    safeText(gap.reason, `${path}.reason`, { nullable: false, max: 256 });
    safeText(gap.message, `${path}.message`, { nullable: false, max: 2_000 });
  });

  const auditPath = 'audit';
  exactKeys(value.audit, STANDING_AUDIT_KEYS, auditPath);
  if (value.audit.rule !== 'assignee-approved-roster-unless-private') fail(`${auditPath}.rule`, 'has an invalid rule');
  for (const key of ['policyDigest', 'rosterDigest', 'fieldsDigest']) {
    if (!DIGEST.test(value.audit[key])) fail(`${auditPath}.${key}`, 'must be a digest');
  }
  if (value.audit.approvalDigest !== null && !DIGEST.test(value.audit.approvalDigest)) fail(`${auditPath}.approvalDigest`, 'must be a digest or null');
  if (value.audit.decisionId !== null && !isId(value.audit.decisionId)) fail(`${auditPath}.decisionId`, 'must be an ID or null');
  if (!['preview', 'trusted-canonical'].includes(value.audit.approvalState)) fail(`${auditPath}.approvalState`, 'has an invalid approval state');

  const publishPath = 'publish';
  exactKeys(value.publish, STANDING_PUBLISH_KEYS, publishPath);
  if (!DIGEST.test(value.publish.initialProjectionDigest)) fail(`${publishPath}.initialProjectionDigest`, 'must be a digest');
  if (value.publish.reviewed !== false || value.publish.activationEnabled !== false) {
    fail(publishPath, 'must retain the disabled initial publish barrier');
  }
}

function weekFromTimestamp(value) {
  const local = new Date(new Date(value).getTime() + 8 * 60 * 60 * 1_000);
  const day = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()));
  const weekday = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() + 4 - weekday);
  const yearStart = new Date(Date.UTC(day.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((day - yearStart) / 86_400_000) + 1) / 7);
  return `${day.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function normalizeStandingProjection(value, rawDigest) {
  const hierarchical = value.schemaVersion === 2;
  return {
    schemaVersion: 1,
    kind: 'team-projection',
    projectionId: value.projectionId,
    week: weekFromTimestamp(value.generatedAt),
    revision: value.revision,
    policyRevision: value.policyRevision,
    sourcePlanDigest: `sha256:${rawDigest}`,
    generatedAt: value.generatedAt,
    ...(hierarchical ? { contextNodes: value.contextNodes.map(node => ({ ...node })) } : {}),
    tasks: value.tasks.map(task => ({
      taskId: task.taskId,
      title: task.title,
      scope: task.description,
      completionCondition: task.completionCriteria,
      assignee: task.assignee,
      reviewer: task.reviewer,
      status: task.status,
      nextStep: task.nextStep,
      approvedDate: task.deadline?.label === 'approved' ? task.deadline.date : null,
      forecastDate: task.deadline?.label === 'forecast' ? task.deadline.date : null,
      checkpoint: null,
      dependencies: [],
      evidenceLinks: [],
      ...(hierarchical ? { parentId: task.parentId } : {}),
    })),
    omissions: [],
  };
}

function validateStrictProjection(value, linkPolicy) {
  scanJson(value);
  const standing = value?.kind === 'standing-team-projection';
  const hierarchical = standing && value.schemaVersion === 2;
  exactKeys(value, hierarchical ? STANDING_HIERARCHY_TOP_LEVEL_KEYS : standing ? STANDING_TOP_LEVEL_KEYS : TOP_LEVEL_KEYS, '$');
  const result = standing ? validateStandingProjection(value) : validateLegacyProjection(value);
  if (!result.valid) throw new TeamProjectionInputError(`team projection is invalid: ${result.errors.join('; ')}`);
  if (standing) {
    validateStandingMetadata(value);
    if (hierarchical) validateStandingHierarchy(value);
  }

  const ids = new Set();
  value.tasks.forEach((task, index) => {
    const path = `tasks[${index}]`;
    exactKeys(task, hierarchical ? STANDING_HIERARCHY_TASK_KEYS : standing ? STANDING_TASK_KEYS : TASK_KEYS, path);
    if (standing && task.deadline !== null) exactKeys(task.deadline, ['label', 'date'], `${path}.deadline`);
    if (ids.has(task.taskId)) fail(`${path}.taskId`, `duplicate task ID ${task.taskId}`);
    ids.add(task.taskId);
    for (const key of standing ? ['title', 'description', 'completionCriteria', 'nextStep'] : ['title', 'scope', 'completionCondition', 'nextStep']) safeText(task[key], `${path}.${key}`);
    if (!standing) for (const key of ['dependencies', 'evidenceLinks']) {
      if (!Array.isArray(task[key])) fail(`${path}.${key}`, 'must be an array');
    }
    if (!standing) task.dependencies.forEach((dependency, dependencyIndex) => {
      const dependencyPath = `${path}.dependencies[${dependencyIndex}]`;
      exactKeys(dependency, DEPENDENCY_KEYS, dependencyPath);
      safeText(dependency.summary, `${dependencyPath}.summary`, { nullable: false, max: 500 });
    });
    if (!standing) task.evidenceLinks.forEach((link, linkIndex) => safeEvidenceLink(link, `${path}.evidenceLinks[${linkIndex}]`, linkPolicy));
  });

  if (!standing) value.omissions.forEach((omission, index) => {
    const path = `omissions[${index}]`;
    exactKeys(omission, OMISSION_KEYS, path, { optional: ['taskId'] });
    if (omission.taskId !== undefined && omission.taskId !== null) {
      if (!isId(omission.taskId)) fail(`${path}.taskId`, 'must be a task ID or null');
      if (!ids.has(omission.taskId)) fail(`${path}.taskId`, 'references an unknown task');
    }
    safeText(omission.field, `${path}.field`, { nullable: false, max: 128 });
    if (PRIVATE_KEY.test(omission.field)) fail(`${path}.field`, 'private/control field is forbidden');
    safeText(omission.reason, `${path}.reason`, { nullable: false, max: 256 });
  });
  return value;
}

function resolveProjectionPath(root, path) {
  if (!isSafeRelativePath(path) || isAbsolute(path)) fail('settings.data.projectionPath', 'must be a safe relative path');
  const rootAbsolute = resolve(root);
  const rootStat = lstatSync(rootAbsolute, { throwIfNoEntry: false });
  if (!rootStat || !rootStat.isDirectory() || rootStat.isSymbolicLink()) fail('team projection data root', 'must be a real directory');
  const absolute = resolve(rootAbsolute, ...path.split('/'));
  const candidate = relative(rootAbsolute, absolute);
  if (candidate === '..' || candidate.startsWith(`..${sep}`) || isAbsolute(candidate)) {
    fail('settings.data.projectionPath', 'escapes the selected data root');
  }
  const rootReal = realpathSync(rootAbsolute);
  let current = rootAbsolute;
  for (const segment of path.split('/')) {
    const next = join(current, segment);
    const stat = lstatSync(next, { throwIfNoEntry: false });
    if (!stat) fail('team projection', 'projection file does not exist');
    if (stat.isSymbolicLink()) fail('team projection', 'symlinks are not allowed');
    current = next;
  }
  const stat = lstatSync(absolute, { throwIfNoEntry: false });
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) fail('team projection', 'must be a regular file');
  if ((stat.mode & 0o111) !== 0) fail('team projection', 'must not be executable');
  const physical = realpathSync(absolute);
  if (physical !== rootReal && !physical.startsWith(`${rootReal}${sep}`)) fail('team projection', 'escapes the selected data root');
  if (stat.size > TEAM_PROJECTION_MAX_BYTES) fail('team projection', 'exceeds the file-size limit');
  return { absolute, bytes: readFileSync(absolute) };
}

/** Read one immutable, team-safe projection from the selected data root. */
export function readTeamProjection({ dataRoot, projectionPath, linkPolicy } = {}) {
  if (typeof dataRoot !== 'string' || dataRoot.length === 0) throw new TypeError('dataRoot: must be a non-empty path');
  if (typeof projectionPath !== 'string' || projectionPath.length === 0) throw new TypeError('projectionPath: must be a non-empty path');
  const artifact = resolveProjectionPath(resolve(dataRoot), projectionPath);
  let value;
  try {
    value = JSON.parse(artifact.bytes.toString('utf8'));
  } catch (error) {
    throw new TeamProjectionInputError(`team projection: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  const normalizedLinkPolicy = normalizeLinkPolicy(linkPolicy);
  validateStrictProjection(value, normalizedLinkPolicy);
  const projection = value.kind === 'standing-team-projection'
    ? normalizeStandingProjection(value, createHash('sha256').update(artifact.bytes).digest('hex'))
    : value;
  return Object.freeze({
    projection: Object.freeze(projection),
    path: projectionPath,
    digest: createHash('sha256').update(artifact.bytes).digest('hex'),
    bytes: artifact.bytes.byteLength,
  });
}
