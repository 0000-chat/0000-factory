import { createHash } from 'node:crypto';
import { extractMarkdownSections } from './markdown.mjs';
import { normalizeActivityEvidence } from './activity-evidence.mjs';
import { DEFAULT_DON_APPROVER_IDS } from './planning.mjs';

export const DELIVERY_TYPES = new Set(['discovery', 'brief', 'coordination', 'cycle', 'reflection']);
export const DISPATCH_STATES = new Set(['draft', 'sent', 'uncertain', 'failed']);
export const DELIVERY_DIGEST_PATTERN = /^[a-f0-9]{64}$/;

const PLACEHOLDERS = new Set(['', '-', 'unknown', 'tbd', 'unset', 'none', 'n/a']);
const ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const BOT_MESSAGE_ID_PATTERN = /^(?:\d{8}T\d{6}Z|[0-9A-HJKMNP-TV-Z]{26})-[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '')) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function isUtcSecond(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value ?? '')) return false;
  const date = new Date(value);
  return !Number.isNaN(date.valueOf()) && date.toISOString().replace('.000Z', 'Z') === value;
}

function isDonIdentity(value, approverIds = DEFAULT_DON_APPROVER_IDS) {
  const ids = approverIds instanceof Set ? approverIds : new Set(approverIds);
  return ids.has(String(value ?? '').trim().toLowerCase());
}

function dataOf(record) {
  return record?.data && typeof record.data === 'object' ? record.data : record ?? {};
}

function meaningful(value) {
  if (value === undefined || value === null) return false;
  return !PLACEHOLDERS.has(String(value).trim().toLowerCase());
}

function nullable(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized && normalized !== '-' ? normalized : null;
}

function recordsOf(records, key) {
  return Array.isArray(records?.[key]) ? records[key] : [];
}

function list(value) {
  if (!meaningful(value)) return [];
  if (Array.isArray(value)) return value.flatMap(entry => list(entry));
  return [...new Set(String(value).split(',').map(entry => entry.trim()).filter(meaningful))];
}

function markdownSections(record) {
  return extractMarkdownSections(String(record?.body ?? ''));
}

function peopleById(records) {
  return new Map(recordsOf(records, 'people').map(person => [String(person?.id ?? ''), person]));
}

function decisionsById(records) {
  return new Map(recordsOf(records, 'decisions').map(record => {
    const data = dataOf(record);
    return [String(data.id ?? ''), data];
  }));
}

function itemsById(records) {
  return new Map(recordsOf(records, 'items').map(record => {
    const data = dataOf(record);
    return [String(data.id ?? ''), data];
  }));
}

function approvalsAreDon(decision, approverIds) {
  return decision?.state === 'approved'
    && isDonIdentity(decision?.approved_by ?? decision?.approvedBy, approverIds)
    && isDate(String(decision?.approved_at ?? decision?.approvedAt ?? ''));
}

function decisionValue(decision, snakeCase, camelCase) {
  return decision?.[snakeCase] ?? decision?.[camelCase];
}

function decisionAffects(decision, itemId) {
  return list(decision?.affects).includes(itemId);
}

function normalizeIdentity(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function personIdForIdentity(value, people) {
  const identity = normalizeIdentity(value);
  if (!identity) return null;
  const matches = [...people.values()].filter(person => [
    person?.id,
    person?.githubHandle,
    person?.name,
    person?.fullName,
    ...(Array.isArray(person?.aliases) ? person.aliases : []),
  ].some(candidate => normalizeIdentity(candidate) === identity));
  return matches.length === 1 ? String(matches[0]?.id ?? '') || null : null;
}

function ownerPersonId(task, people) {
  return personIdForIdentity(nullable(task?.owner), people);
}

function deliveryProjection(record, decisions, evidence, people, items, duplicateDiscoveryLinks, options = {}) {
  const data = dataOf(record);
  const sections = markdownSections(record);
  const common = {
    id: data.id ?? null,
    type: data.type ?? null,
    itemId: nullable(data.item),
    updatedAt: data.updated_at ?? null,
    sourcePath: record?.path ?? null,
    sections: Object.fromEntries(Object.entries(sections).map(([key, value]) => [key, String(value ?? '')])),
  };

  if (data.type === 'discovery') {
    const evidenceIds = list(data.evidence_ids);
    const linkedEvidence = evidenceIds.map(id => evidence.get(id)).filter(Boolean);
    const sourceBacked = linkedEvidence.some(entry => entry.included === true
      && entry.itemId === common.itemId
      && meaningful(entry.evidenceRef)
      && !duplicateDiscoveryLinks.has(`${common.itemId}\u0000evidence:${entry.id}`)
      && !duplicateDiscoveryLinks.has(`${common.itemId}\u0000source:${entry.sourceEventId}`)
      && !duplicateDiscoveryLinks.has(`${common.itemId}\u0000source:${entry.evidenceRef}`));
    const observedExecutor = nullable(data.observed_executor);
    const clearObserved = data.attribution === 'clear' && sourceBacked && people.has(observedExecutor)
      ? observedExecutor
      : null;
    return {
      ...common,
      origin: nullable(data.origin),
      observedExecutor: clearObserved,
      requestedBy: nullable(data.requested_by),
      sourceRefs: list(data.source_refs),
      evidenceIds,
      suggestedParent: nullable(data.suggested_parent),
      candidateParents: list(data.candidate_parents),
      attribution: nullable(data.attribution),
      priorityDecision: nullable(data.priority_decision),
      approved: approvalsAreDon(decisions.get(nullable(data.priority_decision)), options.approverIds)
        && decisionAffects(decisions.get(nullable(data.priority_decision)), common.itemId),
    };
  }

  if (data.type === 'brief') {
    const executorKind = nullable(data.executor_kind);
    const executorRef = nullable(data.executor_ref);
    const assignmentDecision = nullable(data.assignment_decision);
    const nextDecision = nullable(data.next_decision);
    const assignment = decisions.get(assignmentDecision);
    const next = decisions.get(nextDecision);
    const taskDri = ownerPersonId(items.get(common.itemId), people);
    const nextActor = decisionValue(next, 'next_actor', 'nextActor');
    const assignmentApproved = approvalsAreDon(assignment, options.approverIds)
      && decisionAffects(assignment, common.itemId)
      && decisionValue(assignment, 'executor_item', 'executorItem') === common.itemId
      && decisionValue(assignment, 'executor_kind', 'executorKind') === executorKind
      && decisionValue(assignment, 'executor_ref', 'executorRef') === executorRef;
    const nextApproved = approvalsAreDon(next, options.approverIds)
      && decisionValue(next, 'next_item', 'nextItem') === common.itemId
      && ((meaningful(executorRef) && nextActor === executorRef)
        || (Boolean(taskDri) && personIdForIdentity(nextActor, people) === taskDri))
      && decisionAffects(next, common.itemId);
    return {
      ...common,
      executorKind,
      executorRef,
      assignmentDecision,
      nextDecision,
      approved: assignmentApproved,
      nextApproved,
    };
  }

  if (data.type === 'coordination') {
    const approvalDecision = nullable(data.approval_decision);
    const decision = decisions.get(approvalDecision);
    const body = String(sections.message ?? '');
    const expectedDigest = coordinationPayloadDigest({
      taskId: common.itemId,
      recipient: nullable(data.recipient),
      channel: nullable(data.channel),
      body,
    });
    const messageApproved = approvalsAreDon(decision, options.approverIds)
      && decisionAffects(decision, common.itemId)
      && decisionValue(decision, 'coordination_digest', 'coordinationDigest') === expectedDigest
      && data.request_digest === expectedDigest;
    return {
      ...common,
      recipient: nullable(data.recipient),
      channel: nullable(data.channel),
      approvalDecision,
      requestDigest: nullable(data.request_digest),
      deliveryReceipt: nullable(data.delivery_receipt),
      deliveryRef: nullable(data.delivery_ref),
      dispatchRequest: nullable(data.dispatch_request),
      dispatchState: nullable(data.dispatch_state),
      messageApproved,
    };
  }

  if (data.type === 'cycle') {
    return {
      ...common,
      scope: nullable(data.scope),
      invocationKey: nullable(data.invocation_key),
      taskIds: list(data.task_ids),
      briefIds: list(data.brief_ids),
      decisionIds: list(data.decision_ids),
    };
  }

  return {
    ...common,
    cycleId: nullable(data.cycle_id),
    decisionIds: list(data.decision_ids),
    version: nullable(data.version),
  };
}

/** Normalize parsed tracker delivery records for the generated snapshot. */
export function normalizeDeliveryRecords(records = {}, options = {}) {
  if (!Array.isArray(records.delivery)) return [];
  const evidence = new Map(normalizeActivityEvidence(records, options).map(entry => [entry.id, entry]));
  const counts = new Map();
  for (const record of records.delivery) {
    const data = dataOf(record);
    if (data.type !== 'discovery') continue;
    const evidenceIds = list(data.evidence_ids);
    const keys = new Set([
      ...evidenceIds.map(id => `evidence:${id}`),
      ...list(data.source_refs).map(ref => `source:${ref}`),
    ]);
    for (const id of evidenceIds) {
      const linkedEvidence = evidence.get(id);
      if (meaningful(linkedEvidence?.sourceEventId)) keys.add(`source:${linkedEvidence.sourceEventId}`);
      if (meaningful(linkedEvidence?.evidenceRef)) keys.add(`source:${linkedEvidence.evidenceRef}`);
    }
    for (const key of keys) {
      const identity = `${data.item}\u0000${key}`;
      counts.set(identity, (counts.get(identity) ?? 0) + 1);
    }
  }
  const duplicateDiscoveryLinks = new Set([...counts].filter(([, count]) => count > 1).map(([identity]) => identity));
  const decisions = decisionsById(records);
  const people = peopleById(records);
  const items = itemsById(records);
  return records.delivery.map(record => deliveryProjection(record, decisions, evidence, people, items, duplicateDiscoveryLinks, options));
}

/** Bind exact payload content to the canonical task, recipient, and channel. */
export function coordinationPayloadDigest({ taskId, recipient, channel, body }) {
  const payload = JSON.stringify({ taskId, recipient, channel, body });
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

/** Return a stable identity for replaying one delivery cycle invocation. */
export function deliveryReplayIdentity({ type = 'cycle', itemId = '-', invocationKey, sourceRefs = [] } = {}) {
  const sources = [...new Set(list(sourceRefs))].sort();
  const payload = JSON.stringify({ type, itemId, invocationKey: String(invocationKey ?? ''), sourceRefs: sources });
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

/** Resolve only a canonical roster ID; aliases and handles are never written as person IDs. */
export function canonicalPersonId(records, value) {
  const id = nullable(value);
  return id && peopleById(records).has(id) ? id : null;
}

/** Resolve approval for a normalized coordination record without dispatching it. */
export function resolveCoordinationApproval({ record, decisions = [], approverIds } = {}) {
  const source = record && typeof record === 'object' ? record : {};
  const itemId = source.itemId ?? null;
  const body = String(source.sections?.message ?? '');
  const digest = coordinationPayloadDigest({
    taskId: itemId,
    recipient: source.recipient ?? null,
    channel: source.channel ?? null,
    body,
  });
  const decision = recordsOf({ decisions }, 'decisions').map(dataOf).find(candidate => candidate.id === source.approvalDecision);
  const decisionDigest = decisionValue(decision, 'coordination_digest', 'coordinationDigest');
  const approvedBy = decision?.approved_by ?? decision?.approvedBy;
  const approved = source.type === 'coordination'
    && Boolean(itemId && source.approvalDecision)
    && source.requestDigest === digest
    && decisionDigest === digest
    && approvalsAreDon(decision, approverIds)
    && decisionAffects(decision, itemId);
  const reason = approved
    ? null
    : source.type !== 'coordination' ? 'record is not a coordination record'
      : !itemId ? 'coordination task ID is missing'
        : !source.approvalDecision ? 'approval decision is missing'
          : source.requestDigest !== digest ? 'request digest does not match the exact payload'
            : !decision ? 'approval decision does not exist'
              : decision.state !== 'approved' || !isDonIdentity(approvedBy, approverIds) ? 'approval is not an approved Don decision'
                : !decisionAffects(decision, itemId) ? 'approval decision does not affect the exact task'
                  : 'approval decision digest does not match the exact payload';
  return { approved, digest, decisionId: source.approvalDecision ?? null, reason };
}

function hasFailedReceiptProof(record, receipts, botMessages, digest) {
  const requestPath = record.dispatchRequest;
  const receiptPath = record.deliveryReceipt;
  if (!requestPath || !receiptPath || record.deliveryRef) return false;
  if (!validBotReference(requestPath, 'inbox') || !validBotReference(receiptPath, 'receipts')) return false;
  const requestBot = requestPath.split('/')[2];
  const receiptBot = receiptPath.split('/')[2];
  const requestId = requestPath.split('/').at(-1)?.replace(/\.md$/, '');
  const receiptId = receiptPath.split('/').at(-1)?.replace(/\.md$/, '');
  if (!requestId || requestId !== receiptId || requestBot !== receiptBot) return false;
  const inbox = recordsOf({ botMessages }, 'botMessages').find(candidate => candidate.path === requestPath);
  const inboxData = dataOf(inbox);
  if (!inbox || inboxData.id !== requestId || String(inbox.body ?? '') !== String(record.sections?.message ?? '')) return false;
  const receipt = recordsOf({ receipts }, 'receipts').find(candidate => candidate.path === receiptPath);
  const receiptData = dataOf(receipt);
  return Boolean(receipt)
    && receiptData.id === requestId
    && receiptData.status === 'done'
    && receiptData.delivery_state === 'failed'
    && receiptData.request_digest === digest
    && !meaningful(receiptData.delivery_ref);
}

/** Build durable handoff data after exact approval; this function never sends it. */
export function prepareCoordinationRequest({ record, decisions = [], botReceipts = [], botMessages = [], approverIds } = {}) {
  const source = record && typeof record === 'object' ? record : {};
  if (source.dispatchState === 'sent') return { ok: false, request: null, reason: 'coordination is already sent' };
  if (source.dispatchState === 'uncertain') return { ok: false, request: null, reason: 'delivery state is uncertain; blind retry is blocked' };
  if (!['draft', 'failed'].includes(source.dispatchState)) return { ok: false, request: null, reason: 'dispatch state must be draft or definitively failed' };
  if (source.dispatchState === 'draft' && (source.dispatchRequest || source.deliveryReceipt || source.deliveryRef)) {
    return { ok: false, request: null, reason: 'draft already has dispatch evidence; reconcile its delivery state before retrying' };
  }
  const body = source.sections?.message;
  if (typeof body !== 'string' || !body.trim()) return { ok: false, request: null, reason: 'exact message body is missing' };
  const approval = resolveCoordinationApproval({ record: source, decisions, approverIds });
  if (!approval.approved) return { ok: false, request: null, reason: approval.reason };
  if (source.dispatchState === 'failed' && !hasFailedReceiptProof(source, botReceipts, botMessages, approval.digest)) {
    return { ok: false, request: null, reason: 'retry requires a matching completed delivery failure receipt with the exact payload digest' };
  }
  return {
    ok: true,
    request: {
      id: source.id,
      taskId: source.itemId,
      recipient: source.recipient,
      channel: source.channel,
      body,
      digest: approval.digest,
      approvalDecision: approval.decisionId,
      dispatchRequest: source.dispatchState === 'failed' ? null : source.dispatchRequest ?? null,
    },
    reason: null,
  };
}

function pathText(value) {
  return nullable(value);
}

function validBotReference(path, kind) {
  if (typeof path !== 'string' || !path.startsWith(`grok-bot/${kind}/`)) return false;
  const match = path.match(/^grok-bot\/(?:inbox|receipts)\/([a-z0-9]+(?:-[a-z0-9]+)*)\/([^/]+)\.md$/);
  return Boolean(match && BOT_MESSAGE_ID_PATTERN.test(match[2]));
}

function validProviderDeliveryRef(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  if (/^(?:slack|whatsapp):[A-Za-z0-9._:/-]+$/.test(value)) return true;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && Boolean(parsed.hostname) && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

function recordByPath(records, collection, path) {
  return recordsOf(records, collection).find(record => record.path === path) ?? null;
}

function validateCoordinationDelivery(record, records, path, issues, digest, options = {}) {
  const data = record.data;
  const state = data.dispatch_state;
  if (!DISPATCH_STATES.has(state)) issues.push(`${path}: dispatch_state must be draft, sent, uncertain, or failed`);
  const dispatchRequest = pathText(data.dispatch_request);
  const deliveryReceipt = pathText(data.delivery_receipt);
  const deliveryRef = pathText(data.delivery_ref);
  const approvalDecisionId = nullable(data.approval_decision);
  const approvalDecision = decisionsById(records).get(approvalDecisionId);
  if (!meaningful(data.recipient) || !peopleById(records).has(String(data.recipient))) {
    issues.push(`${path}: recipient must be an existing canonical person ID`);
  }
  if (!meaningful(data.channel)) issues.push(`${path}: channel is required`);
  if (!meaningful(extractMarkdownSections(record.body ?? '').message)) issues.push(`${path}: Message section must contain the exact non-placeholder body`);
  if (['sent', 'uncertain', 'failed'].includes(state)) {
    if (!isSha256(data.request_digest) || data.request_digest !== digest) issues.push(`${path}: dispatched coordination needs the exact request_digest`);
    if (!approvalsAreDon(approvalDecision, options.approverIds) || !decisionAffects(approvalDecision, data.item)
      || approvalDecision?.coordination_digest !== digest) {
      issues.push(`${path}: dispatched coordination needs an exact Don-approved payload decision`);
    }
  }
  const hasDispatchProof = Boolean(dispatchRequest || deliveryReceipt || deliveryRef);
  if (dispatchRequest && !validBotReference(dispatchRequest, 'inbox')) issues.push(`${path}: dispatch_request must reference a valid Grok bot inbox message`);
  if (deliveryReceipt && !validBotReference(deliveryReceipt, 'receipts')) issues.push(`${path}: delivery_receipt must reference a valid Grok bot receipt`);
  if (dispatchRequest && !recordByPath(records, 'botMessages', dispatchRequest)) issues.push(`${path}: dispatch_request references a missing inbox message`);
  if (deliveryReceipt && !recordByPath(records, 'botReceipts', deliveryReceipt)) issues.push(`${path}: delivery_receipt references a missing receipt`);
  const referencedInbox = dispatchRequest && recordByPath(records, 'botMessages', dispatchRequest);
  if (referencedInbox) {
    const requestId = dispatchRequest.split('/').at(-1)?.replace(/\.md$/, '');
    if (referencedInbox.data?.id !== requestId) issues.push(`${path}: dispatch request ID must match the inbox filename`);
    if (!isUtcSecond(String(referencedInbox.data?.created_at ?? ''))) issues.push(`${path}: dispatch request created_at must be a valid UTC second`);
  }
  const referencedReceipt = deliveryReceipt && recordByPath(records, 'botReceipts', deliveryReceipt);
  if (referencedReceipt) {
    const receiptId = deliveryReceipt.split('/').at(-1)?.replace(/\.md$/, '');
    if (referencedReceipt.data?.id !== receiptId) issues.push(`${path}: delivery receipt ID must match the receipt filename`);
    if (!['read', 'done'].includes(referencedReceipt.data?.status)) issues.push(`${path}: delivery receipt status must be read or done`);
    if (!isUtcSecond(String(referencedReceipt.data?.updated_at ?? ''))) issues.push(`${path}: delivery receipt updated_at must be a valid UTC second`);
  }
  if (deliveryReceipt && dispatchRequest) {
    const inbox = recordByPath(records, 'botMessages', dispatchRequest);
    const receipt = recordByPath(records, 'botReceipts', deliveryReceipt);
    const inboxId = dispatchRequest.split('/').at(-1)?.replace(/\.md$/, '');
    const receiptId = deliveryReceipt.split('/').at(-1)?.replace(/\.md$/, '');
    if (inboxId !== receiptId) issues.push(`${path}: delivery receipt must match the dispatch request ID`);
    if (!inbox) issues.push(`${path}: dispatch_request references a missing inbox message`);
    if (!receipt) issues.push(`${path}: delivery_receipt references a missing receipt`);
    if (inbox && receipt && data.type === 'coordination') {
      if (String(inbox.body ?? '') !== extractMarkdownSections(record.body ?? '').message) {
        issues.push(`${path}: dispatch_request body must match the exact Message section`);
      }
      if (receipt.data?.id !== inbox.data?.id) issues.push(`${path}: delivery receipt ID must match the dispatch request ID`);
      const inboxBot = dispatchRequest.split('/')[2];
      if (deliveryReceipt.split('/')[2] !== inboxBot) issues.push(`${path}: delivery receipt must belong to the same bot as the dispatch request`);
      if (state === 'sent' || state === 'failed') {
        if (receipt.data?.status !== 'done') issues.push(`${path}: resolved coordination needs a done delivery receipt`);
        if (receipt.data?.delivery_state !== state) issues.push(`${path}: receipt delivery_state must match dispatch_state: ${state}`);
        if (receipt.data?.request_digest !== digest) issues.push(`${path}: delivery receipt request_digest must match the exact coordination payload`);
        if (state === 'sent' && (!validProviderDeliveryRef(deliveryRef) || receipt.data?.delivery_ref !== deliveryRef)) issues.push(`${path}: delivery_ref must be a valid provider reference matching the receipt`);
        if (state === 'failed' && (deliveryRef || receipt.data?.delivery_ref)) issues.push(`${path}: failed coordination cannot claim a provider delivery_ref`);
      }
    }
  }
  if (state === 'sent') {
    if (!isSha256(data.request_digest)) issues.push(`${path}: sent coordination needs a valid request_digest`);
    if (!dispatchRequest || !deliveryReceipt || !validProviderDeliveryRef(deliveryRef)) issues.push(`${path}: sent coordination needs dispatch_request, delivery_receipt, and a valid provider delivery_ref`);
  }
  if (state === 'failed' && (!dispatchRequest || !deliveryReceipt)) {
    issues.push(`${path}: failed coordination needs dispatch_request and a delivery failure receipt`);
  }
  if (state === 'uncertain' && !dispatchRequest) {
    issues.push(`${path}: uncertain coordination needs a dispatch_request to reconcile`);
  }
  if (state === 'draft' && hasDispatchProof) issues.push(`${path}: draft coordination cannot contain dispatch proof; use uncertain until delivery is resolved`);
}

function isSha256(value) {
  return typeof value === 'string' && DELIVERY_DIGEST_PATTERN.test(value);
}

/** Validate producer records and all references without reading from disk. */
export function validateDeliveryRecords(records, issues = [], options = {}) {
  const delivery = recordsOf(records, 'delivery');
  const itemIds = itemsById(records);
  const people = peopleById(records);
  const decisions = decisionsById(records);
  const evidence = new Map(normalizeActivityEvidence(records, options).map(entry => [entry.id, entry]));
  const seenIds = new Set();
  for (const [id, decision] of decisions) {
    if (meaningful(decision.coordination_digest) && !isSha256(decision.coordination_digest)) {
      issues.push(`tracker/decisions/${id}.md: coordination_digest must be a lowercase SHA-256 digest`);
    }
  }
  const allowedFields = new Set([
    'id', 'type', 'item', 'updated_at',
    'origin', 'observed_executor', 'requested_by', 'source_refs', 'evidence_ids', 'suggested_parent', 'candidate_parents', 'attribution', 'priority_decision',
    'executor_kind', 'executor_ref', 'assignment_decision', 'next_decision',
    'recipient', 'channel', 'approval_decision', 'request_digest', 'delivery_receipt', 'delivery_ref', 'dispatch_request', 'dispatch_state',
    'scope', 'invocation_key', 'task_ids', 'brief_ids', 'decision_ids',
    'cycle_id', 'version',
  ]);
  for (const record of delivery) {
    const path = record.path ?? `tracker/delivery/${record.name ?? 'unknown'}.md`;
    const d = dataOf(record);
    const id = String(d.id ?? '');
    const type = String(d.type ?? '');
    if (!ID_PATTERN.test(id) || record.name !== id) issues.push(`${path}: id must be kebab-case filename`);
    if (seenIds.has(id)) issues.push(`${path}: duplicate delivery record id ${id}`);
    seenIds.add(id);
    if (!DELIVERY_TYPES.has(type)) issues.push(`${path}: type must be discovery, brief, coordination, cycle, or reflection`);
    if (type !== 'cycle' && type !== 'reflection') {
      const itemId = String(d.item ?? '');
      if (!ID_PATTERN.test(itemId) || !itemIds.has(itemId)) issues.push(`${path}: item must reference an existing canonical task ID`);
      else if (itemIds.get(itemId)?.type !== 'task') issues.push(`${path}: item must reference a task, not a project or workstream`);
    } else if (String(d.item ?? '') !== '-') {
      issues.push(`${path}: cycle and reflection records must use item: -`);
    }
    if (!isDate(String(d.updated_at ?? ''))) issues.push(`${path}: updated_at must be a valid YYYY-MM-DD date`);
    for (const key of Object.keys(d)) {
      if (!allowedFields.has(key)) issues.push(`${path}: unsupported delivery field ${key}`);
    }
    for (const key of ['approved', 'message_approved', 'next_approved']) {
      if (Object.hasOwn(d, key)) issues.push(`${path}: ${key} is derived and cannot be provided by a producer`);
    }

    if (type === 'discovery') {
      if (!['self-initiated', 'requested', 'unknown'].includes(d.origin)) issues.push(`${path}: origin must be self-initiated, requested, or unknown`);
      if (!['clear', 'ambiguous'].includes(d.attribution)) issues.push(`${path}: attribution must be clear or ambiguous`);
      for (const field of ['observed_executor', 'requested_by']) {
        const value = nullable(d[field]);
        if (value && !people.has(value)) issues.push(`${path}: ${field} references unknown canonical person ${value}`);
      }
      for (const field of ['suggested_parent', ...list(d.candidate_parents)]) {
        const value = nullable(field === 'suggested_parent' ? d[field] : field);
        if (value && (!itemIds.has(value) || itemIds.get(value)?.type !== 'task')) issues.push(`${path}: parent candidate references unknown canonical task ${value}`);
      }
      for (const id of list(d.evidence_ids)) if (!evidence.has(id)) issues.push(`${path}: evidence_ids references unknown activity evidence ${id}`);
      const validSourceBacked = list(d.evidence_ids).some(id => {
        const entry = evidence.get(id);
        return entry?.included === true && entry.itemId === d.item && meaningful(entry.evidenceRef);
      });
      if (d.attribution === 'clear' && meaningful(d.observed_executor) && !validSourceBacked) {
        issues.push(`${path}: clear observed attribution needs included source-backed evidence_ids for the item`);
      }
      const priorityDecision = nullable(d.priority_decision);
      if (!priorityDecision) {
        issues.push(`${path}: priority_decision must reference a Don-owned priority review decision`);
      } else {
        const decision = decisions.get(priorityDecision);
        if (!decision) issues.push(`${path}: priority_decision references unknown decision ${priorityDecision}`);
        else {
          if (!decisionAffects(decision, d.item)) issues.push(`${path}: priority_decision must affect the exact task`);
          if (!isDonIdentity(decision.owner, options.approverIds)) issues.push(`${path}: priority_decision owner must be Don`);
          if (decision.state === 'superseded') issues.push(`${path}: priority_decision cannot reference a superseded decision`);
        }
      }
    }

    if (type === 'brief') {
      if (!['human', 'agent', 'codex-handoff', 'unknown'].includes(d.executor_kind)) issues.push(`${path}: executor_kind must be human, agent, codex-handoff, or unknown`);
      const executorRef = nullable(d.executor_ref);
      if (d.executor_kind === 'human' && executorRef && !people.has(executorRef)) issues.push(`${path}: executor_ref references unknown canonical person ${executorRef}`);
      for (const field of ['assignment_decision', 'next_decision']) {
        const decisionId = nullable(d[field]);
        if (decisionId && !decisions.has(decisionId)) issues.push(`${path}: ${field} references unknown decision ${decisionId}`);
      }
      const sections = markdownSections(record);
      for (const section of ['outcome', 'context', 'completion evidence', 'dependencies', 'next action', 'handoff']) {
        if (!meaningful(sections[section])) issues.push(`${path}: actionable brief needs non-placeholder ## ${section === 'completion evidence' ? 'Completion evidence' : section.replace(/\b\w/g, character => character.toUpperCase())} content`);
      }
    }

    if (type === 'coordination') {
      const body = String(markdownSections(record).message ?? '');
      const messageDigest = coordinationPayloadDigest({
        taskId: nullable(d.item),
        recipient: nullable(d.recipient),
        channel: nullable(d.channel),
        body,
      });
      const approvalDecision = nullable(d.approval_decision);
  if (approvalDecision && !decisions.has(approvalDecision)) issues.push(`${path}: approval_decision references unknown decision ${approvalDecision}`);
      if (meaningful(d.request_digest) && !isSha256(d.request_digest)) issues.push(`${path}: request_digest must be a lowercase SHA-256 digest`);
      const decision = decisions.get(approvalDecision);
      if (meaningful(decision?.coordination_digest) && !isSha256(decision.coordination_digest)) {
        issues.push(`${path}: approval decision coordination_digest must be a lowercase SHA-256 digest`);
      }
      if (meaningful(d.request_digest) && d.request_digest !== messageDigest) issues.push(`${path}: request_digest does not match the exact task, recipient, channel, and Message body`);
      if (approvalDecision && decision && meaningful(decision.coordination_digest)
        && decision.coordination_digest !== messageDigest) {
        issues.push(`${path}: approval decision coordination_digest does not match the exact payload`);
      }
      if (approvalDecision && decision?.state === 'approved' && decision.coordination_digest !== messageDigest) {
        issues.push(`${path}: approved decision coordination_digest does not match the exact payload`);
      }
      validateCoordinationDelivery(record, records, path, issues, messageDigest, options);
    }

    if (type === 'cycle') {
      if (!meaningful(d.scope)) issues.push(`${path}: cycle scope is required`);
      if (!meaningful(d.invocation_key)) issues.push(`${path}: cycle invocation_key is required for replay identity`);
      for (const field of ['task_ids', 'brief_ids', 'decision_ids']) {
        const refs = list(d[field]);
        for (const ref of refs) {
          if (field === 'task_ids' && (!itemIds.has(ref) || itemIds.get(ref)?.type !== 'task')) issues.push(`${path}: task_ids references unknown canonical task ${ref}`);
          if (field === 'brief_ids' && !delivery.some(candidate => dataOf(candidate).id === ref && dataOf(candidate).type === 'brief')) issues.push(`${path}: brief_ids references unknown brief ${ref}`);
          if (field === 'decision_ids' && !decisions.has(ref)) issues.push(`${path}: decision_ids references unknown decision ${ref}`);
        }
      }
    }

    if (type === 'reflection') {
      const cycleId = nullable(d.cycle_id);
      if (cycleId && !delivery.some(candidate => dataOf(candidate).id === cycleId && dataOf(candidate).type === 'cycle')) issues.push(`${path}: cycle_id references unknown cycle ${cycleId}`);
      if (!meaningful(d.version)) issues.push(`${path}: reflection version is required`);
      for (const decisionId of list(d.decision_ids)) if (!decisions.has(decisionId)) issues.push(`${path}: decision_ids references unknown decision ${decisionId}`);
    }
  }
  return issues;
}
