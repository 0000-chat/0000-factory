import { loadTrackerFromFiles, validateTracker } from './model-core.mjs';
import { selectDataPath } from '../instance/paths.mjs';
import { buildTeamProfiles, validatePeopleRegistry } from '../../tracker/viewer/tooling/team.mjs';

/**
 * Limits inherited from the existing publish-source reader.  Keep these
 * values in the data-only validator so local builds and the publisher apply
 * the same source-read policy.
 */
export const SOURCE_READ_LIMITS = Object.freeze({
  maxFiles: 750,
  maxFileBytes: 256 * 1024,
  maxTotalBytes: 24 * 1024 * 1024,
});

// Named exports make the policy easy for the Worker adapter to consume while
// retaining the old publish-source constant vocabulary for callers that need
// to report a bound in an error message.
export const MAX_TRACKER_FILES = SOURCE_READ_LIMITS.maxFiles;
export const MAX_FILE_BYTES = SOURCE_READ_LIMITS.maxFileBytes;
export const MAX_TOTAL_SOURCE_BYTES = SOURCE_READ_LIMITS.maxTotalBytes;

const encoder = new TextEncoder();

/** A data source failed validation before it could be used by the engine. */
export class DataSourceError extends Error {
  constructor(message, { code = 'source-unavailable', status = 503, issues = [] } = {}) {
    super(message);
    this.name = 'DataSourceError';
    this.code = code;
    this.status = status;
    this.issues = [...issues];
  }
}

function entriesOf(files) {
  if (files instanceof Map) return [...files.entries()].sort(([left], [right]) => String(left).localeCompare(String(right)));
  if (typeof files !== 'object' || files === null || Array.isArray(files)) {
    throw new TypeError('source files must be a Map or object');
  }
  return Object.entries(files).sort(([left], [right]) => left.localeCompare(right));
}

function requireInstance(instance) {
  if (!instance || typeof instance !== 'object') throw new TypeError('instance: an explicit validated instance is required');
  return instance;
}

/**
 * Return whether a canonical file participates in source validation.
 * Publish receipts remain a separately selected role and therefore do not
 * count toward the source-read limits or domain validation input.
 *
 * Evidence selection and exact record/changelog boundaries are delegated to
 * the shared canonical path selector.  Publish receipts remain a separately
 * selected role and are excluded from source validation.
 */
export function isSourceFilePath(path, instance) {
  const selection = selectDataPath(requireInstance(instance), path);
  return selection !== null && selection.role !== 'receipts';
}

function sourceEntries(files, instance) {
  const sourceInstance = requireInstance(instance);
  return entriesOf(files).filter(([path]) => isSourceFilePath(path, sourceInstance));
}

/**
 * Apply the bounded source-read policy and return a canonical text map of the
 * selected inputs.  Unknown paths are ignored, so a data checkout can contain
 * application files without the engine loading or evaluating them.
 */
export function selectSourceFiles(files, instance) {
  const entries = sourceEntries(files, requireInstance(instance));
  if (entries.length === 0 || entries.length > MAX_TRACKER_FILES) {
    throw new DataSourceError('The candidate tracker source is outside the supported file-count limit.', {
      code: 'validation-failed',
      status: 409,
    });
  }

  let totalBytes = 0;
  const selected = new Map();
  for (const [path, content] of entries) {
    if (typeof content !== 'string') {
      throw new DataSourceError(`Candidate tracker source is not text: ${path}.`, {
        code: 'validation-failed',
        status: 409,
      });
    }
    const size = encoder.encode(content).byteLength;
    if (size > MAX_FILE_BYTES) {
      throw new DataSourceError(`Candidate tracker source file exceeds the ${MAX_FILE_BYTES}-byte file limit: ${path}.`, {
        code: 'validation-failed',
        status: 409,
      });
    }
    totalBytes += size;
    selected.set(path, content);
  }
  if (totalBytes > MAX_TOTAL_SOURCE_BYTES) {
    throw new DataSourceError('Candidate tracker source exceeds the 24 MiB aggregate file limit.', {
      code: 'validation-failed',
      status: 409,
    });
  }
  return selected;
}

/** Validate source file count and byte bounds without parsing domain records. */
export function validateSourceLimits(files, instance) {
  return selectSourceFiles(files, instance);
}

function parseRegistry(files) {
  const raw = files.get('tracker/people.json');
  if (typeof raw !== 'string') {
    throw new DataSourceError('The tracker people registry is missing.', {
      code: 'validation-failed',
      status: 409,
    });
  }
  let registry;
  try {
    registry = JSON.parse(raw);
  } catch {
    throw new DataSourceError('The tracker people registry is invalid JSON.', {
      code: 'validation-failed',
      status: 409,
    });
  }
  const issues = validatePeopleRegistry(registry);
  if (issues.length) {
    throw new DataSourceError('The tracker people registry did not pass validation.', {
      code: 'validation-failed',
      status: 409,
      issues,
    });
  }
  return registry;
}

function validateTaskOwners(records, registry) {
  const identities = new Map();
  const normalizeIdentity = value => String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  for (const person of registry.people) {
    const values = [person.id, person.githubHandle, person.name, person.fullName, ...(person.aliases ?? [])];
    for (const value of values) {
      const identity = normalizeIdentity(value);
      if (!identity) continue;
      const matches = identities.get(identity) ?? new Set();
      matches.add(String(person.id));
      identities.set(identity, matches);
    }
  }
  const issues = [];
  for (const item of records.items) {
    for (const field of ['owner', 'owner_proposed', 'suggested_actor']) {
      const value = item.data[field];
      if (typeof value !== 'string' || !value.trim() || ['-', 'unknown', 'unassigned'].includes(value.trim().toLowerCase())) continue;
      const matches = identities.get(normalizeIdentity(value));
      if (!matches || matches.size !== 1) issues.push(`${item.path}: ${field} must resolve to exactly one person in the validated people registry`);
    }
  }
  return issues;
}

/**
 * Validate a canonical text map and return the existing domain record shape
 * together with the validated roster and guide projection inputs.
 *
 * This function is deliberately pure: it performs no filesystem reads, Git
 * operations, dynamic imports, or Worker work.  Callers own acquisition and
 * may pass a Map or a plain object keyed by canonical tracker paths.
 */
export function validateDataSource({ files, instance } = {}) {
  const sourceInstance = requireInstance(instance);
  const selected = selectSourceFiles(files, sourceInstance);
  const registry = parseRegistry(selected);
  const guide = selected.get('team.md');
  if (typeof guide !== 'string') {
    throw new DataSourceError('The team guide is missing.', {
      code: 'validation-failed',
      status: 409,
    });
  }

  let teamProfiles;
  try {
    teamProfiles = buildTeamProfiles(registry, guide);
  } catch (error) {
    throw new DataSourceError('The tracker people registry and team guide did not pass validation.', {
      code: 'validation-failed',
      status: 409,
      issues: [error instanceof Error ? error.message : String(error)],
    });
  }

  const records = loadTrackerFromFiles(selected);
  const issues = [...validateTracker(records), ...validateTaskOwners(records, registry)];
  if (records.items.length > 0 && records.migrations.length !== 1) {
    issues.push('Expected current items and exactly one unified-work migration manifest.');
  }
  if (issues.length) {
    throw new DataSourceError('The current tracker source did not pass full domain validation.', {
      code: 'validation-failed',
      status: 409,
      issues,
    });
  }
  return { records, registry, guide, teamProfiles };
}

/** Parse and validate the registry without exposing filesystem concerns. */
export function validateRegistry(files, instance) {
  const selected = selectSourceFiles(files, requireInstance(instance));
  return parseRegistry(selected);
}
