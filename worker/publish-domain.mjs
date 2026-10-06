import { createHash } from 'node:crypto';
import {
  acceptedTaskDigest,
  approvedParts,
  bodySection,
} from '../tooling/tracker/planning.mjs';
import { extractMarkdownTitle, normalizeNarrativeValue, normalizeTaskTitle } from '../tooling/tracker/markdown.mjs';

export const EDITABLE_FIELDS = Object.freeze([
  'title',
  'sections.outcome',
  'sections.completionCondition',
  'sections.nextStep',
  'sections.evidence',
]);

export const SCOPE_FIELDS = new Set(['title', 'sections.outcome', 'sections.completionCondition']);

const FIELD_LABELS = Object.freeze({
  title: 'Title',
  'sections.outcome': 'Outcome',
  'sections.completionCondition': 'Completion condition',
  'sections.nextStep': 'Next step',
  'sections.evidence': 'Evidence',
});

const RETAINED_FIELDS = Object.freeze([
  ['Type', 'type'],
  ['Project', 'project'],
  ['Plan', 'plan'],
  ['Commitment', 'commitment'],
  ['Accepted from', 'accepted_from'],
  ['Parent', 'parent'],
  ['Dependencies', 'depends_on'],
  ['Status', 'status'],
  ['Phase', 'phase'],
  ['Owner', 'owner'],
  ['Proposed owner', 'owner_proposed'],
  ['Owner proposal rationale', 'owner_proposal_rationale'],
  ['Planned start', 'planned_start'],
  ['Planned end', 'planned_end'],
  ['Provisional schedule', 'schedule_provisional'],
  ['Effort min', 'effort_min'],
  ['Effort max', 'effort_max'],
  ['Priority', 'priority'],
  ['Priority rationale', 'priority_rationale'],
  ['Target', 'target'],
  ['Revision', 'revision'],
  ['Approval state', 'approval_state'],
  ['Approved by', 'approved_by'],
  ['Approved at', 'approved_at'],
  ['Approval reference', 'approval_ref'],
  ['Approved revision', 'approved_revision'],
  ['Approval detail', 'reviewed_detail'],
  ['Approval source', 'approval_source'],
  ['Approval digest', 'approval_digest'],
]);

export function normalizeFieldValue(field, value) {
  return field === 'title' ? normalizeTaskTitle(value) : normalizeNarrativeValue(value);
}

export function readTaskField(item, field) {
  if (!EDITABLE_FIELDS.includes(field)) throw new TypeError(`unsupported task field: ${field}`);
  if (field === 'title') return normalizeTaskTitle(extractMarkdownTitle(item.body) ?? item.data.id);
  const section = {
    'sections.outcome': 'outcome',
    'sections.completionCondition': 'completion condition',
    'sections.nextStep': 'next step',
    'sections.evidence': 'evidence',
  }[field];
  return normalizeNarrativeValue(bodySection(item.body, section));
}

function sortedCanonical(value) {
  if (Array.isArray(value)) return value.map(sortedCanonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortedCanonical(value[key])]));
}

export function sha256Json(value) {
  return createHash('sha256').update(JSON.stringify(sortedCanonical(value))).digest('hex');
}

function stringValue(value) {
  return value === undefined || value === null ? '-' : String(value);
}

export function legacyApprovedParts(item, records) {
  if (item.data.approval_state === 'approved' && item.data.approved_parts) return null;
  const manifest = records.legacyApprovals?.[item.data.id];
  if (!manifest || item.data.commitment !== 'accepted' || acceptedTaskDigest(item) !== manifest.digest) return null;
  const parts = ['task'];
  if (item.data.owner && item.data.owner !== 'unassigned' && item.data.owner !== '-') parts.push('assignment');
  if ((item.data.planned_start && !['-', 'unknown', 'tbd', 'unset'].includes(item.data.planned_start.toLowerCase()))
    || (item.data.planned_end && !['-', 'unknown', 'tbd', 'unset'].includes(item.data.planned_end.toLowerCase()))) parts.push('schedule');
  return parts;
}

export function currentApprovalParts(item, records) {
  const legacyParts = legacyApprovedParts(item, records);
  if (legacyParts) return legacyParts;
  if (item.data.approval_state !== 'approved') return [];
  return approvedParts(item.data);
}

function scopeProjection(item, approvedPartList) {
  const data = item.data;
  return {
    id: data.id,
    type: data.type,
    project: data.project ?? null,
    plan: data.plan ?? null,
    parent: data.parent ?? null,
    depends_on: data.depends_on ?? null,
    commitment: data.commitment ?? null,
    accepted_from: data.accepted_from ?? null,
    revision: data.revision ?? null,
    approval_state: data.approval_state ?? null,
    approved_parts: approvedPartList,
    approved_by: data.approved_by ?? null,
    approved_at: data.approved_at ?? null,
    approval_ref: data.approval_ref ?? null,
    approved_revision: data.approved_revision ?? null,
    reviewed_detail: data.reviewed_detail ?? null,
    approval_source: data.approval_source ?? null,
    approval_digest: data.approval_digest ?? null,
    owner: data.owner ?? null,
    owner_proposed: data.owner_proposed ?? null,
    owner_proposal_rationale: data.owner_proposal_rationale ?? null,
    planned_start: data.planned_start ?? null,
    planned_end: data.planned_end ?? null,
    schedule_provisional: data.schedule_provisional ?? null,
    effort_min: data.effort_min ?? null,
    effort_max: data.effort_max ?? null,
    priority: data.priority ?? null,
    priority_rationale: data.priority_rationale ?? null,
    target: data.target ?? null,
    title: readTaskField(item, 'title'),
    outcome: readTaskField(item, 'sections.outcome'),
    completionCondition: readTaskField(item, 'sections.completionCondition'),
  };
}

export function requiresScopeApproval(item, taskRequest) {
  const data = item.data;
  const approved = data.commitment === 'accepted' || data.approval_state === 'approved';
  if (!approved) return false;
  return Object.entries(taskRequest.fields).some(([field, change]) =>
    SCOPE_FIELDS.has(field)
      && normalizeFieldValue(field, change.value) !== readTaskField(item, field));
}

export function buildTaskReview(item, taskRequest, records) {
  const beforeValues = {};
  const proposedValues = {};
  const changes = [];
  for (const field of EDITABLE_FIELDS) {
    const change = taskRequest.fields[field];
    if (change === undefined) continue;
    const before = readTaskField(item, field);
    const after = normalizeFieldValue(field, change.value);
    beforeValues[field] = before;
    proposedValues[field] = after;
    changes.push({ field, label: FIELD_LABELS[field], before, after });
  }
  const parts = currentApprovalParts(item, records);
  const approvedPartsValue = item.data.approved_parts === undefined
    ? parts.join(',')
    : String(item.data.approved_parts);
  const digestInput = {
    retainedScope: scopeProjection(item, parts),
    proposedScope: {
      title: proposedValues.title ?? readTaskField(item, 'title'),
      outcome: proposedValues['sections.outcome'] ?? readTaskField(item, 'sections.outcome'),
      completionCondition: proposedValues['sections.completionCondition'] ?? readTaskField(item, 'sections.completionCondition'),
    },
  };
  const retained = RETAINED_FIELDS.map(([label, key]) => ({ label, value: stringValue(item.data[key]) }));
  retained.splice(4, 0, { label: 'Approved parts', value: approvedPartsValue });
  return {
    taskId: item.data.id,
    requiresApproval: requiresScopeApproval(item, taskRequest),
    reviewDigest: sha256Json(digestInput),
    title: proposedValues.title ?? readTaskField(item, 'title'),
    approvedParts: parts,
    changes,
    retained,
  };
}

export function findFieldConflicts(taskRequest, item) {
  const conflicts = [];
  for (const [field, change] of Object.entries(taskRequest.fields)) {
    const baseValue = normalizeFieldValue(field, change.baseValue);
    const currentValue = readTaskField(item, field);
    const proposedValue = normalizeFieldValue(field, change.value);
    if (currentValue !== baseValue) {
      conflicts.push({
        taskId: taskRequest.id,
        field,
        baseValue,
        currentValue,
        proposedValue,
        message: 'The latest source value changed after this draft began. Review the current value before publishing.',
      });
    }
  }
  return conflicts;
}

export function freshApprovalParts(item, records) {
  const legacyParts = legacyApprovedParts(item, records);
  if (legacyParts) return legacyParts;
  return currentApprovalParts(item, records);
}

export function fieldLabels() {
  return FIELD_LABELS;
}

export function approvalRelevantValues(item, records) {
  return scopeProjection(item, currentApprovalParts(item, records));
}
