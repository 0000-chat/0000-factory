import { canonicalPath as instanceCanonicalPath } from '../tooling/instance/paths.mjs';
import {
  DataSourceError,
  MAX_FILE_BYTES,
  MAX_TOTAL_SOURCE_BYTES,
  MAX_TRACKER_FILES,
  isSourceFilePath as sharedIsSourceFilePath,
  validateDataSource,
} from '../tooling/tracker/source-validation.mjs';

const encoder = new TextEncoder();

function requireInstance(instance) {
  if (!instance || typeof instance !== 'object') {
    throw new TypeError('instance: an explicit validated instance is required');
  }
  return instance;
}

export class PublishSourceError extends Error {
  constructor(message, { code = 'source-unavailable', status = 503, issues = [] } = {}) {
    super(message);
    this.name = 'PublishSourceError';
    this.code = code;
    this.status = status;
    this.issues = issues;
  }
}

function validateRecords(files, instance) {
  try {
    return validateDataSource({ files, instance });
  } catch (error) {
    if (error instanceof DataSourceError) {
      throw new PublishSourceError(error.message, {
        code: error.code,
        status: error.status,
        issues: error.issues,
      });
    }
    throw error;
  }
}

function sourceEntries(tree, { instance } = {}) {
  const sourceInstance = requireInstance(instance);
  const paths = new Set();
  const treePathByCanonical = new Map();
  let totalBytes = 0;
  for (const entry of tree) {
    if (typeof entry?.path !== 'string') throw new PublishSourceError('The GitHub tree contains an entry with no valid path.');
    const canonicalPath = instanceCanonicalPath(sourceInstance, entry.path);
    if (canonicalPath === null || !sharedIsSourceFilePath(canonicalPath, sourceInstance)) continue;
    if (entry.type !== 'blob' || entry.mode !== '100644') {
      throw new PublishSourceError('The tracker source tree contains an unsupported record entry.');
    }
    if (paths.has(canonicalPath)) throw new PublishSourceError('The tracker source tree contains duplicate record paths.');
    paths.add(canonicalPath);
    treePathByCanonical.set(canonicalPath, entry.path);
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_FILE_BYTES) {
      throw new PublishSourceError(`Tracker source file exceeds the ${MAX_FILE_BYTES}-byte file limit.`);
    }
    totalBytes += entry.size;
  }
  if (paths.size === 0 || paths.size > MAX_TRACKER_FILES || totalBytes > MAX_TOTAL_SOURCE_BYTES) {
    throw new PublishSourceError('The tracker source tree is outside its supported size limits.');
  }
  for (const requiredPath of ['team.md', 'tracker/people.json']) {
    if (!paths.has(requiredPath)) throw new PublishSourceError(`Required tracker source file is missing: ${requiredPath}.`);
  }
  return { paths: [...paths].sort(), treePathByCanonical };
}

export async function loadCurrentTracker(github, requestedSha = null, instance) {
  const sourceInstance = requireInstance(instance);
  const sourceCommit = requestedSha ?? await github.getRef();
  const commit = await github.getCommit(sourceCommit);
  const tree = await github.getTree(commit.tree.sha);
  if (!Array.isArray(tree) || tree.length > 20_000) {
    throw new PublishSourceError('The GitHub source tree exceeded its supported entry limit.');
  }
  const selection = sourceEntries(tree, { instance: sourceInstance });
  const paths = selection.paths;
  const treeByPath = new Map(paths.map(path => [path, tree.find(entry => entry.path === selection.treePathByCanonical.get(path))]));
  if (treeByPath.size !== paths.length) throw new PublishSourceError('The pinned tracker tree returned an unexpected file count.');

  const files = new Map();
  let totalBytes = 0;
  for (let offset = 0; offset < paths.length; offset += 50) {
    const batchCanonicalPaths = paths.slice(offset, offset + 50);
    const batchPaths = batchCanonicalPaths.map(path => selection.treePathByCanonical.get(path));
    const batch = await github.readBlobs(sourceCommit, batchPaths);
    if (!(batch instanceof Map) || batch.size !== batchPaths.length) {
      throw new PublishSourceError('GitHub returned an incomplete pinned source-file batch.');
    }
    for (let index = 0; index < batchCanonicalPaths.length; index += 1) {
      const path = batchCanonicalPaths[index];
      const repositoryPath = batchPaths[index];
      const text = batch.get(repositoryPath);
      const expectedSize = treeByPath.get(path)?.size;
      if (typeof text !== 'string' || !Number.isSafeInteger(expectedSize)) {
        throw new PublishSourceError(`GitHub did not return exact source text for ${path}.`);
      }
      const byteLength = encoder.encode(text).byteLength;
      if (byteLength !== expectedSize || byteLength > MAX_FILE_BYTES) {
        throw new PublishSourceError(`GitHub source bytes do not match the pinned tree for ${path}.`);
      }
      totalBytes += byteLength;
      files.set(path, text);
    }
  }
  if (files.size !== paths.length || totalBytes > MAX_TOTAL_SOURCE_BYTES) {
    throw new PublishSourceError('GitHub returned an unexpected tracker source size.');
  }
  const { records, registry, guide, teamProfiles } = validateRecords(files, sourceInstance);
  return {
    sourceCommit,
    treeSha: commit.tree.sha.toLowerCase(),
    tree,
    files,
    records,
    registry,
    guide,
    teamProfiles,
  };
}

export function validateCandidateFiles(files, instance) {
  return validateRecords(files, requireInstance(instance));
}

export function isSourceFilePath(path, instance) {
  return sharedIsSourceFilePath(path, requireInstance(instance));
}
