import { parseRecord } from '../tooling/tracker/model-core.mjs';
import { taskApprovalDigest } from '../tooling/tracker/planning.mjs';
import { patchTaskBody, readTaskContentValues } from '../tooling/tracker/publish-markdown.mjs';
import {
  EDITABLE_FIELDS,
  buildTaskReview,
  fieldLabels,
  findFieldConflicts,
  freshApprovalParts,
  normalizeFieldValue,
  readTaskField,
  sha256Json,
} from './publish-domain.mjs';
import { createGitHubClient, GitHubApiError, GitHubConfigurationError } from './github-client.mjs';
import { loadCurrentTracker, PublishSourceError, validateCandidateFiles } from './publish-source.mjs';
import { repositoryPath as instanceRepositoryPath } from '../tooling/instance/paths.mjs';

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_TASKS = 50;
const MAX_FIELD_BYTES = 16 * 1024;
const MAX_BASELINE_BYTES = 256;
const MAX_CAS_ATTEMPTS = 3;
const MAX_GIT_TREE_ENTRIES = 20_000;
const taskIdPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const requestIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const shaPattern = /^[a-f0-9]{40}$/i;
const digestPattern = /^[a-f0-9]{64}$/;
const fieldLabelByName = fieldLabels();
const encoder = new TextEncoder();

function repositoryPathFor(github, path, instance) {
  return typeof github?.repositoryPath === 'function'
    ? github.repositoryPath(path)
    : instanceRepositoryPath(instance, path);
}

function githubForRequest(env, options) {
  if (!options.instance || typeof options.instance !== 'object') {
    throw new TypeError('instance: an explicit validated instance is required');
  }
  if (typeof options.githubFactory === 'function') return options.githubFactory(env, options.instance);
  const githubOptions = {
    ...(options.githubOptions ?? {}),
    instance: options.instance,
    testTransport: options.testTransport,
  };
  return createGitHubClient({ env, instance: options.instance, testTransport: options.testTransport }, githubOptions);
}

class PublishRequestError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'PublishRequestError';
    this.status = status;
  }
}

function jsonResponse(body, status = 200, headers = {}, method = 'GET') {
  return new Response(method === 'HEAD' ? null : JSON.stringify(body), {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
  });
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value, expected) {
  return Object.keys(value).length === expected.length
    && expected.every(key => Object.hasOwn(value, key));
}

function utf8Bytes(value) {
  return encoder.encode(value).byteLength;
}

function validateTasks(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0 || tasks.length > MAX_TASKS) {
    throw new PublishRequestError(400, `tasks must contain between 1 and ${MAX_TASKS} records.`);
  }
  const seenIds = new Set();
  let fieldCount = 0;
  let aggregateValueBytes = 0;
  for (const task of tasks) {
    if (!isRecord(task) || !hasExactKeys(task, ['id', 'fields'])) {
      throw new PublishRequestError(400, 'Each task must contain id and fields only.');
    }
    if (typeof task.id !== 'string' || !taskIdPattern.test(task.id)) throw new PublishRequestError(400, 'Task id is invalid.');
    if (seenIds.has(task.id)) throw new PublishRequestError(400, 'Task ids must be unique.');
    seenIds.add(task.id);
    if (!isRecord(task.fields)) throw new PublishRequestError(400, 'Task fields must be an object.');
    const fields = Object.keys(task.fields);
    if (fields.length === 0) throw new PublishRequestError(400, 'Each task needs at least one changed field.');
    for (const field of fields) {
      if (!EDITABLE_FIELDS.includes(field)) throw new PublishRequestError(400, 'Editable fields are restricted to the task content whitelist.');
      const change = task.fields[field];
      if (!isRecord(change) || !hasExactKeys(change, ['value', 'baseValue', 'baseSourceCommit', 'baseContentRevision'])) {
        throw new PublishRequestError(400, `Field ${field} needs value and its exact baseline.`);
      }
      if (typeof change.value !== 'string' || typeof change.baseValue !== 'string') {
        throw new PublishRequestError(400, `Field ${field} values must be strings.`);
      }
      if (field === 'title') {
        if (normalizeFieldValue(field, change.value) === '') throw new PublishRequestError(400, 'Title must contain non-whitespace text.');
        if (/[\r\n]/.test(change.value)) throw new PublishRequestError(400, 'Title must be a single line.');
      }
      for (const [key, value] of [['value', change.value], ['baseValue', change.baseValue]]) {
        const bytes = utf8Bytes(value);
        if (bytes > MAX_FIELD_BYTES) throw new PublishRequestError(413, `Field ${field} ${key} exceeds the ${MAX_FIELD_BYTES}-byte limit.`);
        aggregateValueBytes += bytes;
      }
      for (const baselineKey of ['baseSourceCommit', 'baseContentRevision']) {
        const baseline = change[baselineKey];
        if (typeof baseline !== 'string' || baseline.trim() === '' || utf8Bytes(baseline) > MAX_BASELINE_BYTES) {
          throw new PublishRequestError(400, `Field ${field} needs a valid ${baselineKey}.`);
        }
      }
      fieldCount += 1;
    }
  }
  if (aggregateValueBytes > MAX_REQUEST_BYTES / 2) {
    throw new PublishRequestError(413, 'Aggregate task field values exceed the 512 KiB limit.');
  }
  return { taskCount: tasks.length, fieldCount };
}

function validateRequestId(value) {
  if (typeof value !== 'string' || !requestIdPattern.test(value)) {
    throw new PublishRequestError(400, 'requestId must be a lowercase version 4 UUID.');
  }
  return value;
}

function validatePrepareEnvelope(value) {
  if (!isRecord(value) || !hasExactKeys(value, ['schemaVersion', 'requestId', 'tasks'])) {
    throw new PublishRequestError(400, 'Request must contain schemaVersion, requestId, and tasks only.');
  }
  if (value.schemaVersion !== 1) throw new PublishRequestError(400, 'Unsupported publish request schema.');
  const requestId = validateRequestId(value.requestId);
  const summary = validateTasks(value.tasks);
  return { requestId, tasks: value.tasks, fieldCount: summary.fieldCount };
}

function validateFinalEnvelope(value) {
  if (!isRecord(value) || !hasExactKeys(value, ['schemaVersion', 'requestId', 'tasks', 'approvals'])) {
    throw new PublishRequestError(400, 'Final request must contain schemaVersion, requestId, tasks, and approvals only.');
  }
  if (value.schemaVersion !== 2) throw new PublishRequestError(400, 'Unsupported final publish request schema.');
  const requestId = validateRequestId(value.requestId);
  const summary = validateTasks(value.tasks);
  if (!Array.isArray(value.approvals) || value.approvals.length > MAX_TASKS) {
    throw new PublishRequestError(400, 'approvals must be an array of reviewed task scopes.');
  }
  const seen = new Set();
  for (const approval of value.approvals) {
    if (!isRecord(approval) || !hasExactKeys(approval, ['taskId', 'reviewDigest'])) {
      throw new PublishRequestError(400, 'Each approval must contain taskId and reviewDigest only.');
    }
    if (typeof approval.taskId !== 'string' || !taskIdPattern.test(approval.taskId) || seen.has(approval.taskId)) {
      throw new PublishRequestError(400, 'Approval task ids must be valid and unique.');
    }
    if (typeof approval.reviewDigest !== 'string' || !digestPattern.test(approval.reviewDigest)) {
      throw new PublishRequestError(400, 'Each approval needs a valid review digest.');
    }
    seen.add(approval.taskId);
  }
  return { requestId, tasks: value.tasks, approvals: value.approvals, fieldCount: summary.fieldCount };
}

async function readBoundedBody(request) {
  const contentLength = request.headers.get('Content-Length');
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) throw new PublishRequestError(400, 'Content-Length is invalid.');
    if (Number(contentLength) > MAX_REQUEST_BYTES) throw new PublishRequestError(413, 'Publish request exceeds the 1 MiB limit.');
  }
  if (request.body === null) throw new PublishRequestError(400, 'Publish request body is required.');
  const reader = request.body.getReader();
  const chunks = [];
  let byteLength = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      byteLength += result.value.byteLength;
      if (byteLength > MAX_REQUEST_BYTES) {
        await reader.cancel();
        throw new PublishRequestError(413, 'Publish request exceeds the 1 MiB limit.');
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new PublishRequestError(400, 'Publish request must be valid UTF-8 JSON.');
  }
}

function sameOrigin(request) {
  const origin = request.headers.get('Origin');
  return Boolean(origin && origin !== 'null' && origin === new URL(request.url).origin);
}

async function parsePostBody(request) {
  if (!sameOrigin(request)) throw new PublishRequestError(403, 'Same-origin requests are required.');
  const contentType = request.headers.get('Content-Type') ?? '';
  if (!/^application\/json(?:\s*;|\s*$)/i.test(contentType)) {
    throw new PublishRequestError(415, 'Content-Type must be application/json.');
  }
  const text = await readBoundedBody(request);
  try {
    return JSON.parse(text);
  } catch {
    throw new PublishRequestError(400, 'Publish request must be valid JSON.');
  }
}

function conflictEnvelope(requestId, sourceCommit, code, error, conflicts = []) {
  return {
    schemaVersion: 2,
    status: 'conflict',
    published: false,
    requestId,
    error,
    code,
    currentSourceCommit: sourceCommit,
    conflicts,
  };
}

function sourceConflictResponse(error, requestId, sourceCommit, method) {
  if (error instanceof PublishSourceError && error.status === 409 && (error.sourceCommit || sourceCommit)) {
    const sha = error.sourceCommit ?? sourceCommit;
    return jsonResponse(conflictEnvelope(
      requestId,
      sha,
      error.code,
      `${error.message}${error.issues.length ? ` ${error.issues.slice(0, 8).join(' ')}` : ''}`,
    ), 409, {}, method);
  }
  return null;
}

async function validCurrentSource(github, sourceCommit = null, instance) {
  const pinned = sourceCommit ?? await github.getRef();
  try {
    return await loadCurrentTracker(github, pinned, instance);
  } catch (error) {
    if (error instanceof PublishSourceError && error.status === 409) error.sourceCommit = pinned;
    throw error;
  }
}

function taskMap(source) {
  return new Map(source.records.items.map(item => [item.data.id, item]));
}

function collectFieldConflicts(tasks, itemsById) {
  const conflicts = [];
  for (const task of tasks) {
    const item = itemsById.get(task.id);
    if (!item) {
      for (const field of Object.keys(task.fields)) {
        const change = task.fields[field];
        conflicts.push({
          taskId: task.id,
          field,
          baseValue: normalizeFieldValue(field, change.baseValue),
          currentValue: '',
          proposedValue: normalizeFieldValue(field, change.value),
          message: 'This task no longer exists in the latest tracker source.',
        });
      }
      continue;
    }
    conflicts.push(...findFieldConflicts(task, item));
  }
  return conflicts;
}

function reviewsFor(tasks, source) {
  const itemsById = taskMap(source);
  const reviews = [];
  for (const task of tasks) {
    const item = itemsById.get(task.id);
    if (!item) continue;
    reviews.push(buildTaskReview(item, task, source.records));
  }
  return reviews;
}

function validateApprovalRevisions(reviews, source) {
  const itemsById = taskMap(source);
  for (const review of reviews) {
    if (!review.requiresApproval) continue;
    const item = itemsById.get(review.taskId);
    try {
      revisionAfter(item?.data.revision);
    } catch (error) {
      if (error instanceof PublishSourceError) error.sourceCommit = source.sourceCommit;
      throw error;
    }
  }
}

function validateTaskPatches(tasks, source) {
  const itemsById = taskMap(source);
  for (const task of tasks) {
    const item = itemsById.get(task.id);
    if (!item) continue;
    const raw = source.files.get(item.path);
    if (typeof raw !== 'string') throw new PublishSourceError(`Trusted source file is missing for task ${task.id}.`, { status: 409, code: 'validation-failed' });
    const body = splitRawRecord(raw).body;
    try {
      // Validate current source structure before applying proposed values. The
      // baseline check happens before this call, so absent sections require an
      // explicitly empty submitted base value.
      const currentValues = readTaskContentValues(body);
      if (currentValues.title === '') throw new Error('task body has no usable H1 title');
      patchTaskBody(body, Object.fromEntries(Object.entries(task.fields).map(([field, change]) => [field, change.value])));
    } catch {
      throw new PublishSourceError(
        `The Markdown edit for task ${task.id} cannot be applied safely. Check its title heading, duplicate sections, fenced code blocks, and top-level headings in the proposed text.`,
        { status: 409, code: 'validation-failed' },
      );
    }
  }
}

function canonicalFinalPayload(payload) {
  return {
    schemaVersion: 2,
    requestId: payload.requestId,
    tasks: [...payload.tasks].sort((left, right) => left.id.localeCompare(right.id)).map(task => ({
      id: task.id,
      fields: Object.fromEntries(Object.keys(task.fields).sort().map(field => [field, task.fields[field]])),
    })),
    approvals: [...payload.approvals].sort((left, right) => left.taskId.localeCompare(right.taskId)),
  };
}

function parseCommitMarkers(message) {
  const values = new Map();
  for (const line of String(message ?? '').split(/\r?\n/)) {
    const match = /^(Publish-Request-ID|Publish-Payload-SHA256|Publish-Original-SHA): ([^\s]+)$/.exec(line);
    if (match) values.set(match[1], match[2]);
  }
  return {
    requestId: values.get('Publish-Request-ID') ?? null,
    payloadHash: values.get('Publish-Payload-SHA256') ?? null,
    originalSourceCommit: values.get('Publish-Original-SHA') ?? null,
  };
}

function validReceiptFile(value, requestId) {
  return isRecord(value)
    && hasExactKeys(value, ['schemaVersion', 'status', 'published', 'requestId', 'payloadHash', 'originalSourceCommit', 'fields'])
    && value.schemaVersion === 2
    && value.status === 'committed'
    && value.published === true
    && value.requestId === requestId
    && typeof value.payloadHash === 'string'
    && digestPattern.test(value.payloadHash)
    && typeof value.originalSourceCommit === 'string'
    && shaPattern.test(value.originalSourceCommit)
    && Array.isArray(value.fields)
    && value.fields.length > 0
    && value.fields.every(field => isRecord(field)
      && hasExactKeys(field, ['taskId', 'field', 'publishedValue'])
      && typeof field.taskId === 'string'
      && taskIdPattern.test(field.taskId)
      && EDITABLE_FIELDS.includes(field.field)
      && typeof field.publishedValue === 'string')
    && new Set(value.fields.map(field => `${field.taskId}\u0000${field.field}`)).size === value.fields.length;
}

async function lookupCommittedReceipt(github, requestId, sourceCommit, instance) {
  const path = `tracker/publish-receipts/${requestId}.json`;
  const repositoryPath = repositoryPathFor(github, path, instance);
  const publishedCommit = await github.receiptCommit(requestId, sourceCommit);
  if (publishedCommit === null) return null;
  const marker = parseCommitMarkers(publishedCommit.message);
  if (
    marker.requestId !== requestId
    || !digestPattern.test(marker.payloadHash ?? '')
    || !shaPattern.test(marker.originalSourceCommit ?? '')
    || publishedCommit.parent?.toLowerCase() !== marker.originalSourceCommit.toLowerCase()
  ) throw new Error('The publish request marker in Git history is invalid.');
  const blobs = await github.readBlobs(publishedCommit.commit, [repositoryPath]);
  const raw = blobs.get(repositoryPath);
  if (typeof raw !== 'string') throw new Error('The durable publish receipt is missing from the current source tree.');
  let receipt;
  try {
    receipt = JSON.parse(raw);
  } catch {
    throw new Error('The durable publish receipt is invalid JSON.');
  }
  if (!validReceiptFile(receipt, requestId)
    || receipt.payloadHash !== marker.payloadHash
    || receipt.originalSourceCommit !== marker.originalSourceCommit) {
    throw new Error('The durable publish receipt does not match its Git commit marker.');
  }
  return {
    ...receipt,
    commit: publishedCommit.commit,
  };
}

function idempotencyConflict(requestId, sourceCommit) {
  return conflictEnvelope(
    requestId,
    sourceCommit,
    'idempotency-conflict',
    'This request ID is already bound to a different publish payload. Start a new publish request after reviewing the current source.',
  );
}

function receiptFileValue({ requestId, payloadHash, originalSourceCommit, fields }) {
  return {
    schemaVersion: 2,
    status: 'committed',
    published: true,
    requestId,
    payloadHash,
    originalSourceCommit,
    fields,
  };
}

function splitRawRecord(source) {
  const lines = [];
  let start = 0;
  while (start < source.length) {
    const newline = source.indexOf('\n', start);
    if (newline < 0) {
      const raw = source.slice(start);
      lines.push({ raw, content: raw, eol: '' });
      break;
    }
    const contentEnd = newline > start && source[newline - 1] === '\r' ? newline - 1 : newline;
    lines.push({ raw: source.slice(start, newline + 1), content: source.slice(start, contentEnd), eol: source.slice(contentEnd, newline + 1) });
    start = newline + 1;
  }
  if (lines.length === 0 || lines[0].content !== '---') throw new Error('Task source has invalid frontmatter.');
  const closingIndex = lines.findIndex((line, index) => index > 0 && line.content === '---');
  if (closingIndex < 0) throw new Error('Task source has an unclosed frontmatter fence.');
  return {
    lines,
    closingIndex,
    body: lines.slice(closingIndex + 1).map(line => line.raw).join(''),
  };
}

function replaceFrontmatter(source, replacements) {
  const split = splitRawRecord(source);
  const { lines, closingIndex } = split;
  const newline = lines.find(line => line.eol)?.eol ?? '\n';
  const remaining = new Map(Object.entries(replacements));
  const frontmatter = lines.slice(0, closingIndex + 1);
  const seen = new Set();
  for (let index = 1; index < closingIndex; index += 1) {
    const match = /^([a-z][a-z0-9_]*):/.exec(frontmatter[index].content);
    if (!match) continue;
    const key = match[1];
    if (seen.has(key)) throw new Error(`Task source has duplicate frontmatter key ${key}.`);
    seen.add(key);
    if (!remaining.has(key)) continue;
    const value = remaining.get(key);
    if (typeof value !== 'string' || /[\r\n]/.test(value)) throw new Error(`Task frontmatter field ${key} must be a single-line string.`);
    frontmatter[index] = { raw: `${key}: ${value}${frontmatter[index].eol}`, content: `${key}: ${value}`, eol: frontmatter[index].eol };
    remaining.delete(key);
  }
  const additions = [...remaining].map(([key, value]) => {
    if (typeof value !== 'string' || /[\r\n]/.test(value)) throw new Error(`Task frontmatter field ${key} must be a single-line string.`);
    return { raw: `${key}: ${value}${newline}`, content: `${key}: ${value}`, eol: newline };
  });
  frontmatter.splice(closingIndex, 0, ...additions);
  return `${frontmatter.map(line => line.raw).join('')}${lines.slice(closingIndex + 1).map(line => line.raw).join('')}`;
}

function replaceRawBody(source, body, frontmatterValues = {}) {
  const split = splitRawRecord(source);
  const frontmatter = split.lines.slice(0, split.closingIndex + 1).map(line => line.raw).join('');
  return replaceFrontmatter(`${frontmatter}${body}`, frontmatterValues);
}

function manilaDate(date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function utcSecond(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function revisionAfter(value) {
  if (value === undefined || value === null || value === '' || value === '-') return 'r1';
  const match = /^r(\d+)$/.exec(String(value));
  const revision = Number(match?.[1]);
  if (!match || !Number.isSafeInteger(revision) || revision >= Number.MAX_SAFE_INTEGER) {
    throw new PublishSourceError('The approved task revision cannot be advanced safely. Use a supported rN revision before reviewing this edit.', {
      code: 'validation-failed', status: 409,
    });
  }
  return `r${revision + 1}`;
}

function safeChangeValue(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('|', '\\|').replaceAll('\r', '\\r').replaceAll('\n', '\\n');
}

function updateRecord(taskId, changedLabels, requestId, timestamp) {
  const observation = changedLabels.length === 0
    ? 'The submitted task-content values already matched the current source; this authenticated request recorded the exact-value acknowledgment.'
    : `Don published these task-content fields through the authenticated tracker viewer: ${changedLabels.join(', ')}.`;
  const id = `authenticated-edit-${requestId}`;
  return {
    path: `tracker/updates/${taskId}/${id}.md`,
    content: [
      '---',
      `id: ${id}`,
      `item: ${taskId}`,
      `source: authenticated-edit:${requestId}`,
      `observed_at: ${timestamp}`,
      '---',
      '',
      '# Observation',
      '',
      observation,
      '',
    ].join('\n'),
  };
}

function appendChangelog(files, changes, requestId, date, now) {
  if (changes.length === 0) return;
  const path = `tracker/changelog/${date}.md`;
  const existing = files.get(path);
  const eol = existing?.includes('\r\n') ? '\r\n' : '\n';
  const base = existing ?? '# Tracker change log\n\nOne file per Manila day.\n';
  const prefix = base === '' || /(?:\r\n|\n)$/.test(base) ? '' : eol;
  const time = `${now.toISOString().slice(11, 16)}Z`;
  const lines = changes.map(change =>
    `- ${time} don-authenticated-edit ${change.taskId} ${change.label}: ${safeChangeValue(change.before)} -> ${safeChangeValue(change.after)} | approved: authenticated-edit:${requestId} | source: /api/publish/${requestId}`
  );
  files.set(path, `${base}${prefix}${lines.join(eol)}${eol}`);
}

function validateCandidateTreeSize(github, source, files, instance) {
  const paths = new Set(source.tree.map(entry => entry.path));
  let count = source.tree.length;
  for (const [path, content] of files) {
    if (source.files.get(path) === content) continue;
    const repositoryPath = repositoryPathFor(github, path, instance);
    const segments = repositoryPath.split('/');
    const additions = [...segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join('/')), repositoryPath];
    for (const candidatePath of additions) {
      if (paths.has(candidatePath)) continue;
      paths.add(candidatePath);
      count += 1;
      if (count > MAX_GIT_TREE_ENTRIES) {
        throw new PublishSourceError('The candidate Git tree would exceed the 20,000-entry source limit.', {
          code: 'validation-failed', status: 409,
        });
      }
    }
  }
}

function applyTaskEdits(github, source, finalRequest, reviewById, payloadHash, now, instance) {
  const files = new Map(source.files);
  const itemsById = taskMap(source);
  const receiptPath = `tracker/publish-receipts/${finalRequest.requestId}.json`;
  if (source.tree.some(entry => entry.path === repositoryPathFor(github, receiptPath, instance))) {
    throw new PublishSourceError('A publish receipt path already exists without a matching request marker.', {
      code: 'idempotency-conflict', status: 409,
    });
  }

  const timestamp = utcSecond(now);
  const date = manilaDate(now);
  const loggedChanges = [];
  const updateFiles = [];
  const receiptFields = [];
  const labelsByTask = new Map();

  for (const task of finalRequest.tasks) {
    const item = itemsById.get(task.id);
    if (!item) throw new PublishSourceError(`Task ${task.id} no longer exists in the current source.`, { code: 'validation-failed', status: 409 });
    const review = reviewById.get(task.id);
    const sourceText = files.get(item.path);
    if (typeof sourceText !== 'string') throw new PublishSourceError(`Trusted source file is missing for task ${task.id}.`);
    const rawRecord = splitRawRecord(sourceText);
    const replacementValues = Object.fromEntries(Object.entries(task.fields).map(([field, change]) => [field, change.value]));
    const patchedBody = patchTaskBody(rawRecord.body, replacementValues);
    let updatedSource = replaceRawBody(sourceText, patchedBody);
    const changedForTask = [];
    for (const [field, change] of Object.entries(task.fields)) {
      const before = readTaskField(item, field);
      const after = normalizeFieldValue(field, change.value);
      receiptFields.push({ taskId: task.id, field, publishedValue: after });
      if (before === after) continue;
      changedForTask.push({ taskId: task.id, field, label: fieldLabelByName[field], before, after });
      loggedChanges.push(changedForTask.at(-1));
    }

    const frontmatterValues = {};
    if (changedForTask.length > 0 || review?.requiresApproval) frontmatterValues.updated_at = date;
    if (review?.requiresApproval) {
      const legacyParts = freshApprovalParts(item, source.records);
      const nextRevision = revisionAfter(item.data.revision);
      frontmatterValues.revision = nextRevision;
      frontmatterValues.approval_state = 'approved';
      frontmatterValues.approved_by = 'owner';
      frontmatterValues.approved_at = timestamp;
      frontmatterValues.approval_ref = `authenticated-edit:${finalRequest.requestId}`;
      frontmatterValues.approved_revision = nextRevision;
      frontmatterValues.reviewed_detail = 'Don explicitly reviewed the proposed task content and retained approval parts, assignment, dates, and scope details in the authenticated tracker viewer.';
      frontmatterValues.approval_source = 'authenticated-edit';
      if (item.data.commitment === 'accepted' && source.records.legacyApprovals?.[task.id]
        && (!item.data.approval_state || !item.data.approved_parts)) {
        frontmatterValues.approved_parts = legacyParts.join(',');
      }
      updatedSource = replaceRawBody(sourceText, patchedBody, frontmatterValues);
      const parsed = parseRecord(updatedSource);
      if (parsed.error) throw new Error(`Updated task source did not parse: ${parsed.error}`);
      frontmatterValues.approval_digest = taskApprovalDigest({ ...item, data: parsed.data, body: parsed.body });
    }
    if (Object.keys(frontmatterValues).length > 0) updatedSource = replaceRawBody(sourceText, patchedBody, frontmatterValues);
    if (updatedSource !== sourceText) files.set(item.path, updatedSource);

    const labels = changedForTask.map(change => change.label);
    labelsByTask.set(task.id, labels);
    updateFiles.push(updateRecord(task.id, labels, finalRequest.requestId, timestamp));
  }

  for (const update of updateFiles) {
    if (files.has(update.path)) {
      throw new PublishSourceError('An immutable update path already exists for this publish request.', {
        code: 'idempotency-conflict', status: 409,
      });
    }
    files.set(update.path, update.content);
  }
  appendChangelog(files, loggedChanges, finalRequest.requestId, date, now);
  const receipt = receiptFileValue({
    requestId: finalRequest.requestId,
    payloadHash,
    originalSourceCommit: source.sourceCommit,
    fields: receiptFields,
  });
  files.set(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

  validateCandidateTreeSize(github, source, files, instance);
  const validationFiles = new Map([...files].filter(([path]) => !path.startsWith('tracker/publish-receipts/')));
  try {
    validateCandidateFiles(validationFiles, instance);
  } catch (error) {
    if (error instanceof PublishSourceError) {
      error.sourceCommit = source.sourceCommit;
      throw error;
    }
    throw error;
  }
  return { files, receipt, receiptPath, loggedChanges, labelsByTask };
}

function expectedApprovalConflicts(finalRequest, reviews) {
  const required = reviews.filter(review => review.requiresApproval);
  const submitted = new Map(finalRequest.approvals.map(approval => [approval.taskId, approval.reviewDigest]));
  const requiredIds = new Set(required.map(review => review.taskId));
  const conflicts = [];
  for (const review of required) {
    const digest = submitted.get(review.taskId);
    if (digest !== review.reviewDigest) {
      conflicts.push({
        taskId: review.taskId,
        field: 'reviewDigest',
        baseValue: digest ?? '',
        currentValue: review.reviewDigest,
        proposedValue: digest ?? '',
        message: 'The retained approved scope or its proposed task content changed after review.',
      });
    }
  }
  for (const [taskId, digest] of submitted) {
    if (!requiredIds.has(taskId)) {
      conflicts.push({
        taskId,
        field: 'reviewDigest',
        baseValue: digest,
        currentValue: '',
        proposedValue: digest,
        message: 'This task does not have a current scope change that requires approval.',
      });
    }
  }
  return conflicts;
}

function commitMessage(requestId, payloadHash, originalSourceCommit) {
  return [
    'Publish authenticated tracker task edits',
    '',
    `Publish-Request-ID: ${requestId}`,
    `Publish-Payload-SHA256: ${payloadHash}`,
    `Publish-Original-SHA: ${originalSourceCommit}`,
  ].join('\n');
}

async function createGitCommit(github, source, changedFiles, message, instance) {
  const baseRef = await github.getRef();
  if (baseRef !== source.sourceCommit) return null;
  const updates = [...changedFiles].filter(([path, content]) => source.files.get(path) !== content);
  const treeEntries = updates.map(([path, content]) => ({ path: repositoryPathFor(github, path, instance), mode: '100644', type: 'blob', content }));
  const treeSha = await github.createTree(source.treeSha, treeEntries);
  const commitSha = await github.createCommit(message, treeSha, source.sourceCommit);
  const advancedTo = await github.advanceMain(commitSha);
  if (advancedTo === null) return null;
  const mainAfter = await github.getRef();
  const ancestry = await github.compareCommits(commitSha, mainAfter);
  if (ancestry.status !== 'identical' && !(ancestry.status === 'ahead' && (ancestry.aheadBy ?? 0) > 0)) return null;
  return { commit: commitSha, main: mainAfter };
}

function githubUnavailable(error) {
  if (error instanceof GitHubConfigurationError) {
    return 'GitHub publishing is not configured. Add GITHUB_APP_ID, GITHUB_INSTALLATION_ID, and GITHUB_PRIVATE_KEY for the repository-scoped GitHub App.';
  }
  if (error instanceof GitHubApiError && (error.status === 401 || error.status === 403)) {
    return `GitHub ${error.operation} failed with HTTP ${error.status}. Check the GitHub App installation, credentials, and required repository access.`;
  }
  return 'GitHub publishing could not be confirmed. Your saved publish request is safe to retry.';
}

async function handlePrepare(request, env, options) {
  let requestId = '';
  let sourceCommit = null;
  let envelope;
  try {
    envelope = validatePrepareEnvelope(await parsePostBody(request));
    requestId = envelope.requestId;
    const github = githubForRequest(env, options);
    const source = await validCurrentSource(github, null, options.instance);
    sourceCommit = source.sourceCommit;
    const conflicts = collectFieldConflicts(envelope.tasks, taskMap(source));
    if (conflicts.length > 0) {
      return jsonResponse(conflictEnvelope(
        envelope.requestId, source.sourceCommit, 'field-conflict',
        'Some task fields changed in the latest Markdown source. Review those values before preparing a publish.', conflicts,
      ), 409, {}, request.method);
    }
    validateTaskPatches(envelope.tasks, source);
    const reviews = reviewsFor(envelope.tasks, source);
    validateApprovalRevisions(reviews, source);
    return jsonResponse({
      schemaVersion: 2,
      status: 'ready-for-review',
      published: false,
      requestId: envelope.requestId,
      currentSourceCommit: source.sourceCommit,
      reviews,
    }, 200, {}, request.method);
  } catch (error) {
    if (error instanceof PublishRequestError) return jsonResponse({ error: error.message }, error.status, {}, request.method);
    const sourceConflict = sourceConflictResponse(error, requestId, error?.sourceCommit ?? sourceCommit, request.method);
    if (sourceConflict) return sourceConflict;
    return jsonResponse({ error: githubUnavailable(error) }, 503, {}, request.method);
  }
}

async function handleFinal(request, env, options) {
  let envelope;
  let sourceCommit = null;
  try {
    envelope = validateFinalEnvelope(await parsePostBody(request));
    const finalPayload = canonicalFinalPayload(envelope);
    const payloadHash = sha256Json(finalPayload);
    const github = githubForRequest(env, options);

    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      sourceCommit = await github.getRef();
      const existing = await lookupCommittedReceipt(github, envelope.requestId, sourceCommit, options.instance);
      if (existing !== null) {
        if (existing.payloadHash !== payloadHash) return jsonResponse(idempotencyConflict(envelope.requestId, sourceCommit), 409, {}, request.method);
        return jsonResponse(existing, 200, {}, request.method);
      }

      const source = await validCurrentSource(github, sourceCommit, options.instance);
      sourceCommit = source.sourceCommit;
      const conflicts = collectFieldConflicts(envelope.tasks, taskMap(source));
      if (conflicts.length > 0) {
        return jsonResponse(conflictEnvelope(
          envelope.requestId, source.sourceCommit, 'field-conflict',
          'Some task fields changed in the latest Markdown source. Resolve the conflicts before publishing.', conflicts,
        ), 409, {}, request.method);
      }
      validateTaskPatches(envelope.tasks, source);
      const reviews = reviewsFor(envelope.tasks, source);
      validateApprovalRevisions(reviews, source);
      const approvalConflicts = expectedApprovalConflicts(envelope, reviews);
      if (approvalConflicts.length > 0) {
        return jsonResponse(conflictEnvelope(
          envelope.requestId, source.sourceCommit, 'review-stale',
          'The approved scope or retained approval data changed after review. Prepare and explicitly review the latest values before publishing.',
          approvalConflicts,
        ), 409, {}, request.method);
      }
      const reviewById = new Map(reviews.map(review => [review.taskId, review]));
      const now = (options.now ?? (() => new Date()))();
      let candidate;
      try {
        candidate = applyTaskEdits(github, source, envelope, reviewById, payloadHash, now, options.instance);
      } catch (error) {
        if (error instanceof PublishSourceError) throw error;
        throw new PublishSourceError(
          'The Markdown edit could not be applied safely. Check the source heading structure and proposed field text, then prepare a new review.',
          { status: 409, code: 'validation-failed', issues: [] },
        );
      }
      const created = await createGitCommit(
        github,
        source,
        candidate.files,
        commitMessage(envelope.requestId, payloadHash, source.sourceCommit),
        options.instance,
      );
      if (created === null) continue;
      return jsonResponse({ ...candidate.receipt, commit: created.commit }, 200, {}, request.method);
    }
    const current = await github.getRef();
    return jsonResponse(conflictEnvelope(
      envelope.requestId, current, 'branch-raced',
      'The main branch changed repeatedly while this request was publishing. Review the current source and retry.',
    ), 409, {}, request.method);
  } catch (error) {
    if (error instanceof PublishRequestError) return jsonResponse({ error: error.message }, error.status, {}, request.method);
    const sourceConflict = sourceConflictResponse(error, envelope?.requestId ?? '', error?.sourceCommit ?? sourceCommit, request.method);
    if (sourceConflict) return sourceConflict;
    if (error instanceof PublishSourceError && error.status === 409 && sourceCommit) {
      return jsonResponse(conflictEnvelope(envelope?.requestId ?? '', sourceCommit, error.code, error.message), 409, {}, request.method);
    }
    return jsonResponse({ error: githubUnavailable(error) }, 503, {}, request.method);
  }
}

async function handleStatus(request, env, requestId, options) {
  if (request.method !== 'GET') return jsonResponse({ error: 'GET is required.' }, 405, { Allow: 'GET' }, request.method);
  const url = new URL(request.url);
  const sourceCommit = url.searchParams.get('sourceCommit');
  if (url.searchParams.size !== 1 || !sourceCommit || !shaPattern.test(sourceCommit)) {
    return jsonResponse({ error: 'A single 40-character sourceCommit query value is required.' }, 400, {}, request.method);
  }
  try {
    const github = githubForRequest(env, options);
    const main = await github.getRef();
    const receipt = await lookupCommittedReceipt(github, requestId, main, options.instance);
    if (receipt === null) {
      return jsonResponse({
        schemaVersion: 2,
        status: 'not-found',
        published: false,
        requestId,
        error: 'Publish request was not found.',
        code: 'request-not-found',
      }, 404, {}, request.method);
    }
    const comparison = await github.compareCommits(receipt.commit, sourceCommit.toLowerCase());
    const includesPublishedCommit = comparison.status === 'identical'
      || comparison.status === 'ahead' && (comparison.aheadBy ?? 0) > 0;
    return jsonResponse({
      ...receipt,
      source: { commit: sourceCommit.toLowerCase(), includesPublishedCommit },
    }, 200, {}, request.method);
  } catch (error) {
    return jsonResponse({ error: githubUnavailable(error) }, 503, {}, request.method);
  }
}

function apiPath(request) {
  return new URL(request.url).pathname;
}

export async function handlePublishRequest(request, verifiedActor, env = {}, options = {}) {
  const publishPolicy = options.instance?.publish;
  if (publishPolicy?.kind === 'disabled') {
    return jsonResponse({
      error: 'Publishing is disabled for this instance.',
      code: 'publishing-disabled',
    }, 403, {}, request.method);
  }
  if (publishPolicy?.kind !== 'github-app') {
    return jsonResponse({ error: 'Publishing is not configured for this instance.' }, 503, {}, request.method);
  }
  const publisherEmail = publishPolicy.publisherEmail;
  if (typeof verifiedActor !== 'string' || verifiedActor.trim().toLowerCase() !== publisherEmail) {
    return jsonResponse({ error: 'Only the verified Don Access identity can review or publish tracker edits.' }, 403, {}, request.method);
  }
  const path = apiPath(request);
  if (path === '/api/publish/prepare') {
    if (request.method !== 'POST') return jsonResponse({ error: 'POST is required.' }, 405, { Allow: 'POST' }, request.method);
    return handlePrepare(request, env, options);
  }
  if (path === '/api/publish') {
    if (request.method !== 'POST') return jsonResponse({ error: 'POST is required.' }, 405, { Allow: 'POST' }, request.method);
    return handleFinal(request, env, options);
  }
  const match = /^\/api\/publish\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.exec(path);
  if (match) return handleStatus(request, env, match[1], options);
  return jsonResponse({ error: 'Not found.' }, 404, {}, request.method);
}

export function apiJsonError(message, status, headers = {}, method = 'GET', code = undefined) {
  return jsonResponse({
    error: message,
    ...(code === undefined ? {} : { code }),
  }, status, headers, method);
}
