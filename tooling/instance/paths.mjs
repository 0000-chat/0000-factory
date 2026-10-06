/**
 * Canonical tracker paths and the site repository boundary.
 *
 * Canonical paths are always rooted at the data repository's logical root.
 * `folderPath` is the only site-specific physical prefix.  This keeps model,
 * publishing, source links, and build inputs in agreement for both a root
 * layout and a nested 0000 layout.
 */

import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { normalizeRepositoryPath } from './config.mjs';

const RECORD_DIRECTORIES = Object.freeze([
  'tracker/items', 'tracker/history', 'tracker/decisions', 'tracker/updates',
  'tracker/releases', 'tracker/plans', 'tracker/milestones', 'tracker/capacities',
  'tracker/capacity', 'tracker/delivery', 'tracker/active', 'tracker/intake',
  'tracker/archive', 'tracker/proposals',
]);

/** @param {string} path */
function canonicalInput(path) {
  return normalizeRepositoryPath(path, 'canonicalPath');
}

/** @param {Readonly<{data:{folderPath:string}}>} instance */
function folderPrefix(instance) {
  if (!instance || !instance.data || typeof instance.data.folderPath !== 'string') throw new TypeError('instance.data.folderPath: expected validated instance settings');
  return instance.data.folderPath;
}

/**
 * Translate a canonical tracker path to its physical path in the data
 * repository.  The empty canonical path represents the repository root.
 *
 * @param {Readonly<{data:{folderPath:string}}>} instance
 * @param {string} path
 */
export function repositoryPath(instance, path) {
  const canonical = path === '' ? '' : canonicalInput(path);
  const prefix = folderPrefix(instance);
  return prefix ? (canonical ? `${prefix}/${canonical}` : prefix) : canonical;
}

/**
 * Translate a physical repository path to canonical tracker coordinates.  A
 * sibling prefix returns null instead of silently falling back to the root;
 * callers can therefore fail closed on a GitHub tree or local checkout.
 *
 * @param {Readonly<{data:{folderPath:string}}>} instance
 * @param {string} path
 * @returns {string|null}
 */
export function canonicalPath(instance, path) {
  if (typeof path !== 'string') return null;
  let physical;
  try {
    physical = path === '' ? '' : canonicalInput(path);
  } catch {
    return null;
  }
  const prefix = folderPrefix(instance);
  if (!prefix) return physical;
  if (physical === prefix) return '';
  if (!physical.startsWith(`${prefix}/`)) return null;
  const candidate = physical.slice(prefix.length + 1);
  try {
    return candidate === '' ? '' : canonicalInput(candidate);
  } catch {
    return null;
  }
}

function isRecordPath(path) {
  return RECORD_DIRECTORIES.some(directory => path.startsWith(`${directory}/`)) && path.endsWith('.md');
}

function isMigrationPath(path) {
  return /^tracker\/migrations\/[^/]+\.json$/u.test(path);
}

function isEvidencePath(path) {
  return /^grok-bot\/(?:inbox|receipts)\/[^/]+\/[^/]+\.md$/u.test(path);
}

function isChangelogPath(path) {
  return /^tracker\/changelog\/[^/]+\.md$/u.test(path);
}

function isReceiptPath(path) {
  return /^tracker\/publish-receipts\/[^/]+\.json$/u.test(path);
}

/**
 * Identify a canonical input role.  Returned paths are stable and suitable
 * for maps/fingerprints; `repositoryPath` is the exact path to read or write.
 *
 * @param {Readonly<{data:{folderPath:string,evidence:{kind:string}},github:{owner:string,repo:string,branch:string}}>} instance
 * @param {string} path
 * @returns {{role:'registry'|'team'|'records'|'migrations'|'evidence'|'changelog'|'receipts',canonicalPath:string,repositoryPath:string,sourceUrl:string}|null}
 */
export function selectDataPath(instance, path) {
  let canonical;
  try {
    canonical = path === '' ? '' : canonicalInput(path);
  } catch {
    return null;
  }
  if (canonical === null || canonical === '') return null;
  let role = null;
  if (canonical === 'tracker/people.json') role = 'registry';
  else if (canonical === 'team.md') role = 'team';
  else if (isRecordPath(canonical)) role = 'records';
  else if (isMigrationPath(canonical)) role = 'migrations';
  else if (instance.data?.evidence?.kind === 'grok-bot-v1' && isEvidencePath(canonical)) role = 'evidence';
  else if (isChangelogPath(canonical)) role = 'changelog';
  else if (isReceiptPath(canonical)) role = 'receipts';
  if (role === null) return null;
  return {
    role,
    canonicalPath: canonical,
    repositoryPath: repositoryPath(instance, canonical),
    sourceUrl: sourceUrl(instance, canonical),
  };
}

/**
 * Build a GitHub source URL for a canonical path.  Every segment is encoded
 * independently so a data filename can never create a URL path prefix.
 *
 * @param {Readonly<{data:{folderPath:string},github:{owner:string,repo:string,branch:string}}>} instance
 * @param {string} path
 */
export function sourceUrl(instance, path) {
  const canonical = path === '' ? '' : canonicalInput(path);
  const physical = repositoryPath(instance, canonical);
  const encodedPath = physical.split('/').map(segment => encodeURIComponent(segment)).join('/');
  return `https://github.com/${encodeURIComponent(instance.github.owner)}/${encodeURIComponent(instance.github.repo)}/blob/${encodeURIComponent(instance.github.branch)}/${encodedPath}`;
}

/** @param {string} root @param {string} current @param {string[]} output */
function walkSelected(root, current, output) {
  const directory = join(root, current);
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    return;
  }
  for (const entry of entries) {
    const child = current ? `${current}/${entry.name}` : entry.name;
    const absolute = join(root, child);
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error(`data path escapes repository through symlink: ${child}`);
    if (stat.isDirectory()) walkSelected(root, child, output);
    else if (stat.isFile()) output.push(child);
    else throw new Error(`data path is not a regular file: ${child}`);
  }
}

/** @param {string} dataRepo @param {Readonly<{data:{folderPath:string,evidence:{kind:string}},github:{owner:string,repo:string,branch:string}}>} instance */
function selectedLocalPhysicalFiles(dataRepo, instance) {
  const root = resolve(dataRepo);
  if (!isAbsolute(root)) throw new TypeError('dataRepo: must resolve to an absolute repository path');
  const rootReal = realpathSync(root);
  const candidates = ['team.md', 'tracker/people.json', 'tracker/migrations', 'tracker/changelog', 'tracker/publish-receipts', ...RECORD_DIRECTORIES];
  if (instance.data?.evidence?.kind === 'grok-bot-v1') candidates.push('grok-bot');
  const physical = [];
  for (const candidate of candidates) {
    const absolute = join(root, repositoryPath(instance, candidate));
    let stat;
    try {
      stat = lstatSync(absolute);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) throw new Error(`data path escapes repository through symlink: ${candidate}`);
    if (stat.isDirectory()) walkSelected(root, repositoryPath(instance, candidate), physical);
    else if (stat.isFile()) physical.push(repositoryPath(instance, candidate));
    else throw new Error(`data path is not a regular file: ${candidate}`);
  }
  const seen = new Set();
  const selected = [];
  for (const repository of physical.sort()) {
    const absolute = join(root, repository);
    const stat = lstatSync(absolute);
    if (!stat.isFile() || (stat.mode & 0o111) !== 0) throw new Error(`data input must be a non-executable regular file: ${repository}`);
    const real = realpathSync(absolute);
    if (real !== rootReal && !real.startsWith(`${rootReal}/`)) throw new Error(`data path escapes repository: ${repository}`);
    const canonical = canonicalPath(instance, repository);
    const selection = canonical === null ? null : selectDataPath(instance, canonical);
    if (!selection) continue;
    if (seen.has(selection.canonicalPath)) throw new Error(`duplicate canonical data path: ${selection.canonicalPath}`);
    seen.add(selection.canonicalPath);
    selected.push(selection);
  }
  return selected;
}

/**
 * List selected data files sorted by role and canonical path.
 *
 * @param {{dataRepo:string,instance:Readonly<object>}} options
 */
export function selectedDataPaths({ dataRepo, instance }) {
  return selectedLocalPhysicalFiles(dataRepo, instance)
    .sort((left, right) => left.role.localeCompare(right.role) || left.canonicalPath.localeCompare(right.canonicalPath));
}

/**
 * Read selected text inputs without loading application Markdown or executing
 * any data-repository code.  The returned map is keyed by canonical path.
 *
 * @param {{dataRepo:string,instance:Readonly<object>}} options
 */
export function readDataFiles({ dataRepo, instance }) {
  const root = resolve(dataRepo);
  const files = new Map();
  for (const selection of selectedDataPaths({ dataRepo: root, instance })) {
    const text = readFileSync(join(root, selection.repositoryPath), 'utf8');
    if (files.has(selection.canonicalPath)) throw new Error(`duplicate canonical data path: ${selection.canonicalPath}`);
    files.set(selection.canonicalPath, text);
  }
  return files;
}

export const CANONICAL_RECORD_DIRECTORIES = RECORD_DIRECTORIES;
