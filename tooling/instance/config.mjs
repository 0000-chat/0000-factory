/**
 * The versioned site settings contract.
 *
 * Settings are data owned by the site repository. This module intentionally
 * uses only the Node standard library so build, Worker, and fixture code can
 * validate the same value before any application module is loaded.
 */

import { createHash } from 'node:crypto';
import { dirname, isAbsolute, resolve } from 'node:path';
import { readFileSync } from 'node:fs';

export const INSTANCE_SCHEMA_VERSION = 1;
export const INSTANCE_LAYOUT = 'tracker-v1';
export const INSTANCE_APPROVAL_PROTOCOL = 'don-v1';
export const INSTANCE_PUBLISH_OPERATIONS = 'existing-task-edits-v1';

const COMPATIBILITY_FLAGS = new Set(['nodejs_compat']);

const ROOT_KEYS = [
  'schemaVersion', 'id', 'branding', 'github', 'data', 'model', 'browser',
  'access', 'publish', 'deployment',
];
const BRANDING_KEYS = ['name', 'title', 'description', 'markText', 'homeLabel', 'loadingLabel', 'faviconPath'];
const GITHUB_KEYS = ['owner', 'repo', 'branch'];
const DATA_KEYS = ['folderPath', 'layout', 'evidence'];
const MODEL_KEYS = ['approvalProtocol'];
const BROWSER_KEYS = [
  'namespace', 'storeId', 'themeKey', 'editLockPrefix', 'publishLockName',
  'unscheduledCollapsedKey', 'activityPausedKey',
];
const EVIDENCE_KEYS = ['kind'];
const DEPLOYMENT_KEYS = ['accountBinding', 'workerName', 'customDomain', 'compatibilityDate', 'compatibilityFlags'];
const ACCESS_UNCONFIGURED_KEYS = ['kind'];
const ACCESS_READY_KEYS = ['kind', 'teamDomain', 'audience', 'readerEmails', 'service'];
const SERVICE_DISABLED_KEYS = ['kind'];
const SERVICE_ENABLED_KEYS = ['kind', 'clientId'];
const PUBLISH_DISABLED_KEYS = ['kind'];
const PUBLISH_GITHUB_APP_KEYS = ['kind', 'publisherEmail', 'recordActorId', 'operations'];

const EMAIL_PATTERN = /^[^\s@<>()[\]\\,;:]+@[^\s@<>()[\]\\,;:]+$/u;
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const REPOSITORY_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/u;
const ACTOR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,127}$/u;
const WORKER_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const DNS_LABEL_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

/** Error raised when settings do not satisfy their versioned contract. */
export class InstanceConfigError extends TypeError {
  /** @param {string} path @param {string} message */
  constructor(path, message) {
    super(`${path}: ${message}`);
    this.name = 'InstanceConfigError';
    this.path = path;
  }
}

/** @param {unknown} value */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** @param {unknown} value @param {string} path */
function object(value, path) {
  if (!isPlainObject(value)) throw new InstanceConfigError(path, 'must be an object');
  return /** @type {Record<string, unknown>} */ (value);
}

/** @param {Record<string, unknown>} value @param {readonly string[]} allowed @param {string} path */
function exactKeys(value, allowed, path) {
  const expected = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) throw new InstanceConfigError(`${path}.${key}`, 'unknown field');
  }
}

/** @param {unknown} value @param {string} path @param {{min?: number, max?: number, pattern?: RegExp}} [options] */
function text(value, path, { min = 1, max = 256, pattern } = {}) {
  if (typeof value !== 'string') throw new InstanceConfigError(path, 'must be a string');
  if (value.length < min || value.length > max) {
    throw new InstanceConfigError(path, `must contain between ${min} and ${max} characters`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) throw new InstanceConfigError(path, 'contains a control character');
  if (pattern && !pattern.test(value)) throw new InstanceConfigError(path, 'has an invalid format');
  return value;
}

/** @param {unknown} value @param {string} path @param {unknown} expected */
function literal(value, path, expected) {
  if (value !== expected) throw new InstanceConfigError(path, `must be ${JSON.stringify(expected)}`);
  return expected;
}

/**
 * Validate and return a normalized repository-relative POSIX path. Percent
 * escapes are rejected entirely so a later URL/GitHub decode cannot change
 * the selected repository boundary.
 *
 * @param {unknown} value
 * @param {string} path
 * @param {{allowEmpty?: boolean, assets?: boolean}} [options]
 */
export function normalizeRepositoryPath(value, path = 'path', { allowEmpty = false, assets = false } = {}) {
  if (typeof value !== 'string') throw new InstanceConfigError(path, 'must be a string');
  if (value.length === 0 && allowEmpty) return '';
  if (value.length === 0) throw new InstanceConfigError(path, 'must not be empty');
  if (value !== value.trim()) throw new InstanceConfigError(path, 'must not have surrounding whitespace');
  if (value.includes('\\') || value.includes('%') || value.includes('\u0000')) {
    throw new InstanceConfigError(path, 'must use unencoded POSIX path segments');
  }
  if (isAbsolute(value) || value.startsWith('/') || /^[A-Za-z]:/u.test(value)) {
    throw new InstanceConfigError(path, 'must be repository-relative');
  }
  const segments = value.split('/');
  if (segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new InstanceConfigError(path, 'contains an empty, current, or parent segment');
  }
  if (segments.some(segment => /[\u0000-\u001f\u007f]/u.test(segment))) {
    throw new InstanceConfigError(path, 'contains a control character');
  }
  if (assets && (segments[0] !== 'assets' || segments.length < 2)) {
    throw new InstanceConfigError(path, 'must be inside the assets directory');
  }
  return segments.join('/');
}

/** @param {unknown} value @param {string} path */
function instanceId(value, path) {
  return text(value, path, { min: 1, max: 63, pattern: SLUG_PATTERN });
}

/** @param {unknown} value @param {string} path */
function repositoryName(value, path) {
  const result = text(value, path, { min: 1, max: 100, pattern: REPOSITORY_NAME_PATTERN });
  if (result === '.' || result === '..') throw new InstanceConfigError(path, 'must not be a dot path');
  return result;
}

/** @param {unknown} value @param {string} path */
function gitRef(value, path) {
  const result = text(value, path, { min: 1, max: 255 });
  const segments = result.split('/');
  if (
    result.startsWith('-') || result.startsWith('/') || result.endsWith('/') || result.endsWith('.')
    || result.includes('//') || result.includes('..') || result.includes('@{')
    || /[\u0000-\u0020~^:?*[\\]/u.test(result)
    || segments.some(segment => (
      segment === '' || segment === '.' || segment === '..'
      || segment.startsWith('.') || segment.endsWith('.lock')
    ))
  ) throw new InstanceConfigError(path, 'is not a valid Git ref');
  return result;
}

/** @param {unknown} value @param {string} path */
function email(value, path) {
  const result = text(value, path, { min: 3, max: 254 });
  if (result !== result.trim() || !EMAIL_PATTERN.test(result) || result.toLowerCase() !== result) {
    throw new InstanceConfigError(path, 'must be a lowercase email address');
  }
  return result;
}

/** @param {unknown} value @param {string} path */
function emailSet(value, path) {
  if (!Array.isArray(value) || value.length === 0) throw new InstanceConfigError(path, 'must be a non-empty email array');
  const result = value.map((candidate, index) => email(candidate, `${path}[${index}]`));
  if (new Set(result).size !== result.length) throw new InstanceConfigError(path, 'must not contain duplicate email addresses');
  return result;
}

/** @param {unknown} value @param {string} path */
function dnsName(value, path) {
  const result = text(value, path, { min: 1, max: 253 });
  if (result.endsWith('.') || result.includes('..')) throw new InstanceConfigError(path, 'must be a DNS host name');
  const labels = result.split('.');
  if (labels.some(label => label.length > 63 || !DNS_LABEL_PATTERN.test(label))) {
    throw new InstanceConfigError(path, 'must be a DNS host name');
  }
  return result.toLowerCase();
}

/** @param {unknown} value @param {string} path */
function accessTeamDomain(value, path) {
  const result = text(value, path, { min: 8, max: 512 });
  let url;
  try {
    url = new URL(result);
  } catch {
    throw new InstanceConfigError(path, 'must be an HTTPS Access team URL');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash || (url.pathname !== '' && url.pathname !== '/')) {
    throw new InstanceConfigError(path, 'must be an HTTPS Access team URL without credentials or a path');
  }
  const hostname = dnsName(url.hostname, path);
  return `${url.protocol}//${hostname}`;
}

/** @param {unknown} value @param {string} path */
function actorId(value, path) {
  return text(value, path, { min: 1, max: 128, pattern: ACTOR_PATTERN });
}

/** @param {unknown} value @param {string} path @param {string} namespace @param {{separator?: string}} [options] */
function browserKey(value, path, namespace, { separator = '' } = {}) {
  const result = text(value, path, { min: 1, max: 160 });
  if (result.includes('/') || result.includes('\\') || result.includes('%')) {
    throw new InstanceConfigError(path, 'must be a browser storage/lock key');
  }
  const expected = `${namespace}${separator}`;
  if (!result.startsWith(expected)) throw new InstanceConfigError(path, `must use the ${namespace} namespace`);
  return result;
}

/** @param {Record<string, unknown>} value @param {string} path */
function parseEvidence(value, path) {
  const record = object(value, path);
  exactKeys(record, EVIDENCE_KEYS, path);
  if (record.kind !== 'none' && record.kind !== 'grok-bot-v1') {
    throw new InstanceConfigError(`${path}.kind`, 'must be none or grok-bot-v1');
  }
  return { kind: record.kind };
}

/** @param {Record<string, unknown>} value @param {string} path */
function parseService(value, path) {
  const record = object(value, path);
  if (record.kind === 'disabled') {
    exactKeys(record, SERVICE_DISABLED_KEYS, path);
    return { kind: 'disabled' };
  }
  if (record.kind === 'enabled') {
    exactKeys(record, SERVICE_ENABLED_KEYS, path);
    return { kind: 'enabled', clientId: actorId(record.clientId, `${path}.clientId`) };
  }
  throw new InstanceConfigError(`${path}.kind`, 'must be disabled or enabled');
}

/** @param {Record<string, unknown>} value @param {string} path */
function parseAccess(value, path) {
  const record = object(value, path);
  if (record.kind === 'unconfigured') {
    exactKeys(record, ACCESS_UNCONFIGURED_KEYS, path);
    return { kind: 'unconfigured' };
  }
  if (record.kind !== 'ready') throw new InstanceConfigError(`${path}.kind`, 'must be unconfigured or ready');
  exactKeys(record, ACCESS_READY_KEYS, path);
  return {
    kind: 'ready',
    teamDomain: accessTeamDomain(record.teamDomain, `${path}.teamDomain`),
    audience: text(record.audience, `${path}.audience`, { min: 1, max: 512 }),
    readerEmails: emailSet(record.readerEmails, `${path}.readerEmails`),
    service: parseService(record.service, `${path}.service`),
  };
}

/** @param {Record<string, unknown>} value @param {string} path @param {{kind:string, readerEmails?:string[]}} access */
function parsePublish(value, path, access) {
  const record = object(value, path);
  if (record.kind === 'disabled') {
    exactKeys(record, PUBLISH_DISABLED_KEYS, path);
    return { kind: 'disabled' };
  }
  if (record.kind !== 'github-app') throw new InstanceConfigError(`${path}.kind`, 'must be disabled or github-app');
  exactKeys(record, PUBLISH_GITHUB_APP_KEYS, path);
  if (access.kind !== 'ready') throw new InstanceConfigError(path, 'github-app publishing requires ready Access');
  const publisherEmail = email(record.publisherEmail, `${path}.publisherEmail`);
  if (!access.readerEmails.includes(publisherEmail)) {
    throw new InstanceConfigError(`${path}.publisherEmail`, 'must be a member of access.readerEmails');
  }
  literal(record.operations, `${path}.operations`, INSTANCE_PUBLISH_OPERATIONS);
  return {
    kind: 'github-app',
    publisherEmail,
    recordActorId: actorId(record.recordActorId, `${path}.recordActorId`),
    operations: INSTANCE_PUBLISH_OPERATIONS,
  };
}

/** @param {unknown} value @param {string} path */
function accountBinding(value, path) {
  const result = text(value, path, { min: 1, max: 128 });
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(result)) throw new InstanceConfigError(path, 'has an invalid account binding');
  return result;
}

/** @param {unknown} value @param {string} path */
function compatibilityDate(value, path) {
  const result = text(value, path, { min: 10, max: 10, pattern: DATE_PATTERN });
  const parsed = new Date(`${result}T00:00:00Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== result) {
    throw new InstanceConfigError(path, 'must be a real calendar date');
  }
  return result;
}

/** @param {unknown} value @param {string} path */
function compatibilityFlags(value, path) {
  if (!Array.isArray(value) || value.length === 0) throw new InstanceConfigError(path, 'must be a non-empty array');
  const result = value.map((flag, index) => text(flag, `${path}[${index}]`, { min: 1, max: 64 }));
  if (new Set(result).size !== result.length) throw new InstanceConfigError(path, 'must not contain duplicate flags');
  for (const flag of result) if (!COMPATIBILITY_FLAGS.has(flag)) throw new InstanceConfigError(path, `unsupported compatibility flag ${flag}`);
  return result;
}

/** @param {unknown} value */
function freezeDeep(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

/** @param {unknown} value */
export function parseInstanceConfig(value) {
  const input = object(value, 'settings');
  exactKeys(input, ROOT_KEYS, 'settings');
  literal(input.schemaVersion, 'settings.schemaVersion', INSTANCE_SCHEMA_VERSION);
  const id = instanceId(input.id, 'settings.id');

  const brandingInput = object(input.branding, 'settings.branding');
  exactKeys(brandingInput, BRANDING_KEYS, 'settings.branding');
  const githubInput = object(input.github, 'settings.github');
  exactKeys(githubInput, GITHUB_KEYS, 'settings.github');
  const dataInput = object(input.data, 'settings.data');
  exactKeys(dataInput, DATA_KEYS, 'settings.data');
  const modelInput = object(input.model, 'settings.model');
  exactKeys(modelInput, MODEL_KEYS, 'settings.model');
  const browserInput = object(input.browser, 'settings.browser');
  exactKeys(browserInput, BROWSER_KEYS, 'settings.browser');
  const deploymentInput = object(input.deployment, 'settings.deployment');
  exactKeys(deploymentInput, DEPLOYMENT_KEYS, 'settings.deployment');

  const namespace = instanceId(browserInput.namespace, 'settings.browser.namespace');
  if (namespace !== id) throw new InstanceConfigError('settings.browser.namespace', 'must match settings.id');
  const access = parseAccess(input.access, 'settings.access');
  const instance = {
    schemaVersion: INSTANCE_SCHEMA_VERSION,
    id,
    branding: {
      name: text(brandingInput.name, 'settings.branding.name', { max: 96 }),
      title: text(brandingInput.title, 'settings.branding.title', { max: 160 }),
      description: text(brandingInput.description, 'settings.branding.description', { max: 512 }),
      markText: text(brandingInput.markText, 'settings.branding.markText', { max: 32 }),
      homeLabel: text(brandingInput.homeLabel, 'settings.branding.homeLabel', { max: 96 }),
      loadingLabel: text(brandingInput.loadingLabel, 'settings.branding.loadingLabel', { max: 160 }),
      faviconPath: normalizeRepositoryPath(brandingInput.faviconPath, 'settings.branding.faviconPath', { assets: true }),
    },
    github: {
      owner: repositoryName(githubInput.owner, 'settings.github.owner'),
      repo: repositoryName(githubInput.repo, 'settings.github.repo'),
      branch: gitRef(githubInput.branch, 'settings.github.branch'),
    },
    data: {
      folderPath: normalizeRepositoryPath(dataInput.folderPath, 'settings.data.folderPath', { allowEmpty: true }),
      layout: literal(dataInput.layout, 'settings.data.layout', INSTANCE_LAYOUT),
      evidence: parseEvidence(dataInput.evidence, 'settings.data.evidence'),
    },
    model: {
      approvalProtocol: literal(modelInput.approvalProtocol, 'settings.model.approvalProtocol', INSTANCE_APPROVAL_PROTOCOL),
    },
    browser: {
      namespace,
      storeId: browserKey(browserInput.storeId, 'settings.browser.storeId', namespace, { separator: '-' }),
      themeKey: browserKey(browserInput.themeKey, 'settings.browser.themeKey', namespace, { separator: '-' }),
      editLockPrefix: browserKey(browserInput.editLockPrefix, 'settings.browser.editLockPrefix', namespace, { separator: '-' }),
      publishLockName: browserKey(browserInput.publishLockName, 'settings.browser.publishLockName', namespace, { separator: '-' }),
      unscheduledCollapsedKey: browserKey(browserInput.unscheduledCollapsedKey, 'settings.browser.unscheduledCollapsedKey', namespace, { separator: '.' }),
      activityPausedKey: browserKey(browserInput.activityPausedKey, 'settings.browser.activityPausedKey', namespace, { separator: '.' }),
    },
    access,
    publish: null,
    deployment: {
      accountBinding: accountBinding(deploymentInput.accountBinding, 'settings.deployment.accountBinding'),
      workerName: text(deploymentInput.workerName, 'settings.deployment.workerName', { min: 1, max: 63, pattern: WORKER_NAME_PATTERN }),
      customDomain: dnsName(deploymentInput.customDomain, 'settings.deployment.customDomain'),
      compatibilityDate: compatibilityDate(deploymentInput.compatibilityDate, 'settings.deployment.compatibilityDate'),
      compatibilityFlags: compatibilityFlags(deploymentInput.compatibilityFlags, 'settings.deployment.compatibilityFlags'),
    },
  };
  instance.publish = parsePublish(input.publish, 'settings.publish', access);
  return /** @type {Readonly<InstanceConfig>} */ (freezeDeep(instance));
}

/**
 * Load an explicit settings file. The containing directory is returned for
 * resolving site-owned assets; no engine-local settings fallback is used.
 *
 * @param {{path: string}} options
 */
export function loadInstanceConfig({ path }) {
  if (typeof path !== 'string' || path.length === 0) throw new TypeError('path: must be a non-empty settings path');
  const absolutePath = resolve(path);
  let raw;
  try {
    raw = readFileSync(absolutePath, 'utf8');
  } catch {
    throw new Error(`settings: could not read ${absolutePath}`);
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new InstanceConfigError('settings', 'must contain valid JSON');
  }
  const instance = parseInstanceConfig(value);
  const configDigest = createHash('sha256').update(raw, 'utf8').digest('hex');
  return Object.freeze({ instance, manifestDir: dirname(absolutePath), configDigest });
}

/**
 * Project only values safe to serve to a browser. Runtime Access policy,
 * reader emails, publisher actor policy, account binding, and credentials are
 * intentionally absent.
 *
 * @param {Readonly<InstanceConfig>} instance
 */
export function publicInstanceConfig(instance) {
  const parsed = parseInstanceConfig(instance);
  return freezeDeep({
    schemaVersion: INSTANCE_SCHEMA_VERSION,
    id: parsed.id,
    branding: { ...parsed.branding },
    source: {
      owner: parsed.github.owner,
      repo: parsed.github.repo,
      branch: parsed.github.branch,
      folderPath: parsed.data.folderPath,
    },
    browser: { ...parsed.browser },
    publishing: { kind: parsed.publish.kind === 'github-app' ? 'enabled' : 'disabled' },
  });
}

const PUBLIC_ROOT_KEYS = ['schemaVersion', 'id', 'branding', 'source', 'browser', 'publishing'];
const PUBLIC_BRANDING_KEYS = BRANDING_KEYS;
const PUBLIC_SOURCE_KEYS = ['owner', 'repo', 'branch', 'folderPath'];
const PUBLIC_BROWSER_KEYS = BROWSER_KEYS;

/** @param {unknown} value */
export function parsePublicInstanceConfig(value) {
  const input = object(value, 'publicInstance');
  exactKeys(input, PUBLIC_ROOT_KEYS, 'publicInstance');
  literal(input.schemaVersion, 'publicInstance.schemaVersion', INSTANCE_SCHEMA_VERSION);
  const branding = object(input.branding, 'publicInstance.branding');
  exactKeys(branding, PUBLIC_BRANDING_KEYS, 'publicInstance.branding');
  const source = object(input.source, 'publicInstance.source');
  exactKeys(source, PUBLIC_SOURCE_KEYS, 'publicInstance.source');
  const browser = object(input.browser, 'publicInstance.browser');
  exactKeys(browser, PUBLIC_BROWSER_KEYS, 'publicInstance.browser');
  const publishing = object(input.publishing, 'publicInstance.publishing');
  exactKeys(publishing, ['kind'], 'publicInstance.publishing');
  if (publishing.kind !== 'enabled' && publishing.kind !== 'disabled') {
    throw new InstanceConfigError('publicInstance.publishing.kind', 'must be enabled or disabled');
  }
  const id = instanceId(input.id, 'publicInstance.id');
  const namespace = instanceId(browser.namespace, 'publicInstance.browser.namespace');
  if (namespace !== id) throw new InstanceConfigError('publicInstance.browser.namespace', 'must match publicInstance.id');
  return /** @type {Readonly<PublicInstanceConfig>} */ (freezeDeep({
    schemaVersion: INSTANCE_SCHEMA_VERSION,
    id,
    branding: {
      name: text(branding.name, 'publicInstance.branding.name', { max: 96 }),
      title: text(branding.title, 'publicInstance.branding.title', { max: 160 }),
      description: text(branding.description, 'publicInstance.branding.description', { max: 512 }),
      markText: text(branding.markText, 'publicInstance.branding.markText', { max: 32 }),
      homeLabel: text(branding.homeLabel, 'publicInstance.branding.homeLabel', { max: 96 }),
      loadingLabel: text(branding.loadingLabel, 'publicInstance.branding.loadingLabel', { max: 160 }),
      faviconPath: normalizeRepositoryPath(branding.faviconPath, 'publicInstance.branding.faviconPath', { assets: true }),
    },
    source: {
      owner: repositoryName(source.owner, 'publicInstance.source.owner'),
      repo: repositoryName(source.repo, 'publicInstance.source.repo'),
      branch: gitRef(source.branch, 'publicInstance.source.branch'),
      folderPath: normalizeRepositoryPath(source.folderPath, 'publicInstance.source.folderPath', { allowEmpty: true }),
    },
    browser: {
      namespace,
      storeId: browserKey(browser.storeId, 'publicInstance.browser.storeId', namespace, { separator: '-' }),
      themeKey: browserKey(browser.themeKey, 'publicInstance.browser.themeKey', namespace, { separator: '-' }),
      editLockPrefix: browserKey(browser.editLockPrefix, 'publicInstance.browser.editLockPrefix', namespace, { separator: '-' }),
      publishLockName: browserKey(browser.publishLockName, 'publicInstance.browser.publishLockName', namespace, { separator: '-' }),
      unscheduledCollapsedKey: browserKey(browser.unscheduledCollapsedKey, 'publicInstance.browser.unscheduledCollapsedKey', namespace, { separator: '.' }),
      activityPausedKey: browserKey(browser.activityPausedKey, 'publicInstance.browser.activityPausedKey', namespace, { separator: '.' }),
    },
    publishing: { kind: publishing.kind },
  }));
}

/**
 * Validate a catalog and reject duplicate site identities before any build is
 * selected. The catalog itself is not a runtime configuration surface.
 *
 * @param {unknown} value
 * @returns {ReadonlyArray<Readonly<InstanceConfig>>}
 */
export function parseInstanceCatalog(value) {
  if (!Array.isArray(value)) throw new InstanceConfigError('catalog', 'must be an array');
  const instances = value.map(candidate => parseInstanceConfig(candidate));
  const fields = [
    ['id', instance => instance.id],
    ['namespace', instance => instance.browser.namespace],
    ['storeId', instance => instance.browser.storeId],
    ['themeKey', instance => instance.browser.themeKey],
    ['editLockPrefix', instance => instance.browser.editLockPrefix],
    ['publishLockName', instance => instance.browser.publishLockName],
    ['unscheduledCollapsedKey', instance => instance.browser.unscheduledCollapsedKey],
    ['activityPausedKey', instance => instance.browser.activityPausedKey],
  ];
  for (const [field, get] of fields) {
    const seen = new Set();
    for (let index = 0; index < instances.length; index += 1) {
      const valueAtField = get(instances[index]);
      if (seen.has(valueAtField)) throw new InstanceConfigError(`catalog[${index}].${field}`, `duplicates another instance ${field}`);
      seen.add(valueAtField);
    }
  }
  return Object.freeze(instances);
}

/** @typedef {object} InstanceConfig
 * @property {1} schemaVersion
 * @property {string} id
 * @property {{name:string,title:string,description:string,markText:string,homeLabel:string,loadingLabel:string,faviconPath:string}} branding
 * @property {{owner:string,repo:string,branch:string}} github
 * @property {{folderPath:string,layout:'tracker-v1',evidence:{kind:'none'}|{kind:'grok-bot-v1'}}} data
 * @property {{approvalProtocol:'don-v1'}} model
 * @property {{namespace:string,storeId:string,themeKey:string,editLockPrefix:string,publishLockName:string,unscheduledCollapsedKey:string,activityPausedKey:string}} browser
 * @property {{kind:'unconfigured'}|{kind:'ready',teamDomain:string,audience:string,readerEmails:string[],service:{kind:'disabled'}|{kind:'enabled',clientId:string}}} access
 * @property {{kind:'disabled'}|{kind:'github-app',publisherEmail:string,recordActorId:string,operations:'existing-task-edits-v1'}} publish
 * @property {{accountBinding:string,workerName:string,customDomain:string,compatibilityDate:string,compatibilityFlags:string[]}} deployment
 */

/** @typedef {object} PublicInstanceConfig
 * @property {1} schemaVersion
 * @property {string} id
 * @property {{name:string,title:string,description:string,markText:string,homeLabel:string,loadingLabel:string,faviconPath:string}} branding
 * @property {{owner:string,repo:string,branch:string,folderPath:string}} source
 * @property {{namespace:string,storeId:string,themeKey:string,editLockPrefix:string,publishLockName:string,unscheduledCollapsedKey:string,activityPausedKey:string}} browser
 * @property {{kind:'enabled'|'disabled'}} publishing
 */
