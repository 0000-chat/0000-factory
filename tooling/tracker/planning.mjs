import { createHash } from 'node:crypto';
import { extractMarkdownSections, extractMarkdownTitle } from './markdown.mjs';

/*
 * Planning and progress calculations shared by the tracker validator and the
 * read-only snapshot builder. Records are flat scalar values parsed from
 * Markdown. Approval is always derived from explicit frontmatter and an exact
 * digest; prose that merely mentions approval is never authoritative.
 */

// The generic engine accepts the historical fixture aliases by default. Sites
// may provide an instance-scoped alias list when their approval records use a
// different stable actor ID; callers must pass that list explicitly.
export const DEFAULT_DON_APPROVER_IDS = Object.freeze(['don', 'owner']);
export const DON_APPROVER_IDS = DEFAULT_DON_APPROVER_IDS;
export const APPROVAL_SOURCES = new Set(['codex-chat', 'chatgpt-chat', 'grok-ui', 'authenticated-edit']);
export const CONFIRMATION_SOURCES = new Set(['grok-ui', 'authenticated-edit']);
export const APPROVED_PARTS = new Set(['task', 'assignment', 'schedule']);
export const COMMITMENTS = new Set(['draft', 'planned', 'accepted']);

const unknownValues = new Set(['', '-', 'unknown', 'tbd', 'unset']);
const approvalPartOrder = ['task', 'assignment', 'schedule'];

function firstValue(data, ...keys) {
  for (const key of keys) {
    if (data && data[key] !== undefined && data[key] !== null) return data[key];
  }
  return null;
}

export function scalarValue(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return unknownValues.has(text.toLowerCase()) ? null : text;
}

export function commitmentValue(value) {
  const data = value?.data ?? value;
  const commitment = scalarValue(data?.commitment ?? value)?.toLowerCase();
  return COMMITMENTS.has(commitment) ? commitment : null;
}

export function isDraft(value) {
  return commitmentValue(value) === 'draft';
}

export function isPlanned(value) {
  return commitmentValue(value) === 'planned';
}

export function isAccepted(value) {
  return commitmentValue(value) === 'accepted';
}

export function canTransitionCommitment(from, to) {
  const current = commitmentValue(from);
  const next = commitmentValue(to);
  if (!current || !next || current === next) return Boolean(current && next);
  return (current === 'draft' && next === 'planned') || (current === 'planned' && next === 'accepted');
}

export function numberValue(value) {
  const text = scalarValue(value);
  if (text === null) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

export function boolValue(value) {
  if (value === true || value === false) return value;
  const text = scalarValue(value);
  if (text === 'true') return true;
  if (text === 'false') return false;
  return null;
}

export function refValue(data, ...keys) {
  return scalarValue(firstValue(data, ...keys));
}

export function approvedParts(data = {}) {
  const raw = scalarValue(data.approved_parts) ?? 'task';
  return [...new Set(raw.split(',').map(part => part.trim()).filter(Boolean))]
    .sort((a, b) => approvalPartOrder.indexOf(a) - approvalPartOrder.indexOf(b));
}

export function approvalData(data = {}, prefix = '') {
  const approvedBy = scalarValue(firstValue(data, `${prefix}approved_by`));
  const approvedAt = scalarValue(firstValue(data, `${prefix}approved_at`));
  const reference = scalarValue(firstValue(data, `${prefix}approval_ref`));
  const revision = scalarValue(firstValue(data, `${prefix}approved_revision`));
  const detail = scalarValue(firstValue(data, `${prefix}reviewed_detail`));
  const digest = scalarValue(firstValue(data, `${prefix}approval_digest`));
  const source = scalarValue(firstValue(data, `${prefix}approval_source`));
  return { approvedBy, approvedAt, reference, revision, detail, digest, source };
}

export function confirmationData(data = {}) {
  const confirmedBy = scalarValue(firstValue(data, 'confirmed_by'));
  const confirmedAt = scalarValue(firstValue(data, 'confirmed_at'));
  const reference = scalarValue(firstValue(data, 'confirmation_ref'));
  const evidence = scalarValue(firstValue(data, 'evidence_ref'));
  const revision = scalarValue(firstValue(data, 'confirmed_revision'));
  const source = scalarValue(firstValue(data, 'confirmation_source'));
  const state = scalarValue(firstValue(data, 'confirmation_state'));
  return { state, confirmedBy, confirmedAt, reference, evidence, revision, source };
}

export function isDonIdentity(value, approverIds = DEFAULT_DON_APPROVER_IDS) {
  const identity = String(value ?? '').trim().toLowerCase();
  const ids = approverIds instanceof Set ? approverIds : new Set(approverIds ?? DEFAULT_DON_APPROVER_IDS);
  return ids.has(identity);
}

export function isUtcTimestamp(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value ?? '')) return false;
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return false;
  const match = /^(.*?)(?:\.(\d{1,3}))?Z$/.exec(value);
  return date.toISOString() === `${match[1]}.${(match[2] ?? '').padEnd(3, '0')}Z`;
}

export function hasDonApproval(data = {}, prefix = '', approverIds = DEFAULT_DON_APPROVER_IDS) {
  const approval = approvalData(data, prefix);
  return Boolean(
    isDonIdentity(approval.approvedBy, approverIds)
      && isUtcTimestamp(approval.approvedAt)
      && approval.reference
      && approval.revision
      && approval.detail
      && /^[a-f0-9]{64}$/.test(approval.digest ?? '')
      && APPROVAL_SOURCES.has(approval.source)
  );
}

export function hasDonConfirmation(data = {}, expectedRevision = null, approverIds = DEFAULT_DON_APPROVER_IDS) {
  const confirmation = confirmationData(data);
  return confirmation.state === 'confirmed'
    && isDonIdentity(confirmation.confirmedBy, approverIds)
    && isUtcTimestamp(confirmation.confirmedAt)
    && Boolean(confirmation.revision)
    && (!expectedRevision || confirmation.revision === expectedRevision)
    && CONFIRMATION_SOURCES.has(confirmation.source)
    && Boolean(confirmation.reference && confirmation.evidence);
}

export function bodySection(body, heading) {
  return extractMarkdownSections(body)[heading.toLowerCase()] ?? '';
}

export function recordTitle(record) {
  const body = record?.body ?? '';
  return extractMarkdownTitle(body) ?? record?.data?.id ?? record?.id ?? null;
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function canonical(value) {
  if (value === undefined || value === null) return null;
  return String(value).trim();
}

function taskRecord(task) {
  return task?.data ? task : { data: task ?? {}, body: task?.body ?? '' };
}

/*
 * Digest for a future acceptance approval. Assignment and schedule fields
 * participate only after their corresponding approval part is included. A
 * task-only approval therefore remains valid while an unapproved owner/date
 * proposal is edited. The reviewed revision is always bound.
 */
export function taskApprovalDigest(task) {
  const record = taskRecord(task);
  const data = record.data ?? {};
  const parts = approvedParts(data);
  const assignmentApproved = parts.includes('assignment');
  const scheduleApproved = parts.includes('schedule');
  return digest({
    id: canonical(data.id),
    plan: canonical(data.plan),
    project: canonical(data.project),
    title: recordTitle(record),
    reviewedRevision: canonical(data.revision) ?? canonical(data.approved_revision),
    parent: canonical(data.parent),
    dependsOn: canonical(data.depends_on),
    approvedParts: parts,
    approvedOwner: assignmentApproved ? canonical(data.owner) : null,
    proposedOwner: assignmentApproved ? canonical(data.owner_proposed ?? data.owner) : null,
    proposedOwnerRationale: assignmentApproved ? canonical(data.owner_proposal_rationale) : null,
    plannedStart: scheduleApproved ? canonical(data.planned_start) : null,
    plannedEnd: scheduleApproved ? canonical(data.planned_end) : null,
    scheduleProvisional: scheduleApproved ? canonical(data.schedule_provisional) : null,
    effortMin: canonical(data.effort_min),
    effortMax: canonical(data.effort_max),
    priority: canonical(data.priority),
    priorityRationale: canonical(data.priority_rationale),
    target: canonical(data.target),
    outcome: bodySection(record.body, 'outcome'),
    completionCondition: bodySection(record.body, 'completion condition')
  });
}

/*
 * Digest for a currently accepted item. It is intentionally narrower than a
 * whole record: operational status, health, forecast, remaining effort,
 * next-step, and evidence edits do not require Don to reapprove scope. The
 * accepted baseline includes the durable title, scope, owner, dates, effort,
 * priority, target deadline, revision, and relationship fields.
 */
export function acceptedTaskDigest(task) {
  const record = taskRecord(task);
  const data = record.data ?? {};
  return digest({
    id: canonical(data.id),
    type: canonical(data.type),
    project: canonical(data.project),
    plan: canonical(data.plan),
    title: recordTitle(record),
    outcome: bodySection(record.body, 'outcome'),
    completionCondition: bodySection(record.body, 'completion condition'),
    owner: canonical(data.owner),
    plannedStart: canonical(data.planned_start),
    plannedEnd: canonical(data.planned_end),
    scheduleProvisional: canonical(data.schedule_provisional),
    effortMin: canonical(data.effort_min),
    effortMax: canonical(data.effort_max),
    priority: canonical(data.priority),
    priorityRationale: canonical(data.priority_rationale),
    target: canonical(data.target),
    revision: canonical(data.revision) ?? canonical(data.approved_revision),
    parent: canonical(data.parent),
    dependsOn: canonical(data.depends_on)
  });
}

export function taskApprovalState(task) {
  const data = task?.data ?? task ?? {};
  return scalarValue(firstValue(data, 'approval_state')) ?? 'proposed';
}

function planIdForMilestone(milestone) {
  const data = milestone?.data ?? milestone ?? {};
  return refValue(data, 'plan_id');
}

function milestoneWeight(milestone) {
  return numberValue((milestone?.data ?? milestone ?? {}).weight);
}

function planIsApproved(plan, { approverIds } = {}) {
  if (!plan) return false;
  const data = plan.data ?? plan;
  return scalarValue(data.status) === 'approved' && hasDonApproval(data, '', approverIds);
}

export function milestonePlanApprovalDigest(plan, milestones = []) {
  const planData = plan?.data ?? plan ?? {};
  const entries = milestones
    .map(milestone => {
      const data = milestone.data ?? milestone;
      return {
        id: data.id,
        item: data.item,
        planId: data.plan_id ?? data.plan,
        weight: Number(data.weight),
        completionCondition: bodySection(milestone.body, 'completion condition')
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  return digest({
    planId: planData.id,
    project: planData.project,
    reviewedRevision: scalarValue(planData.revision) ?? scalarValue(planData.approved_revision),
    objective: bodySection(plan?.body, 'objective'),
    scope: scalarValue(planData.scope) ?? planData.project,
    milestones: entries
  });
}

function milestoneView(milestone, approvedPlan, { approverIds } = {}) {
  const data = milestone.data ?? milestone;
  const confirmation = confirmationData(data);
  const approval = approvalData(data);
  const weight = milestoneWeight(milestone);
  const approvedPlanId = approvedPlan?.id ?? null;
  const planRevision = approvalData(approvedPlan?.plan?.data ?? approvedPlan?.plan ?? {}).revision;
  return {
    id: data.id,
    title: data.title ?? data.name ?? data.id,
    item: data.item,
    planId: planIdForMilestone(milestone),
    weight,
    included: Boolean(approvedPlanId && planIdForMilestone(milestone) === approvedPlanId),
    status: scalarValue(data.status) ?? 'proposed',
    approval: {
      state: scalarValue(data.approval_state) ?? null,
      reviewedDetail: approval.detail,
      revision: approval.revision,
      approvedBy: approval.approvedBy,
      approvedAt: approval.approvedAt,
      reference: approval.reference,
      digest: approval.digest
    },
    confirmation: {
      state: confirmation.state ?? 'pending',
      confirmedBy: confirmation.confirmedBy,
      confirmedAt: confirmation.confirmedAt,
      reference: confirmation.reference,
      evidence: confirmation.evidence,
      revision: confirmation.revision,
      source: confirmation.source
    },
    confirmed: Boolean(
      approvedPlanId
        && planIdForMilestone(milestone) === approvedPlanId
        && scalarValue(data.status) === 'complete'
        && hasDonConfirmation(data, planRevision, approverIds)
    ),
    sourcePath: milestone.path ?? null
  };
}

export function approvedMilestonePlan(itemId, milestones = [], plans = [], options = {}) {
  const itemMilestones = milestones.filter(milestone => (milestone.data ?? milestone).item === itemId);
  const plansById = new Map(plans.map(plan => [plan.data?.id ?? plan.id, plan]));
  const groups = new Map();
  for (const milestone of itemMilestones) {
    const planId = planIdForMilestone(milestone);
    if (!planId) continue;
    const list = groups.get(planId) ?? [];
    list.push(milestone);
    groups.set(planId, list);
  }
  for (const [planId, group] of groups) {
    const plan = plansById.get(planId);
    const planRevision = approvalData(plan?.data ?? plan ?? {}).revision;
    const planDigest = approvalData(plan?.data ?? plan ?? {}).digest;
    const includedStatuses = new Set(['approved', 'complete', 'needs-reverification']);
    const included = group.filter(milestone => includedStatuses.has(scalarValue((milestone.data ?? milestone).status)));
    if (planIsApproved(plan, options) && planRevision && planDigest && group.length > 0
      && included.length === group.length
      && milestonePlanApprovalDigest(plan, group) === planDigest
      && group.every(milestone => (
        milestoneWeight(milestone) !== null
        && scalarValue((milestone.data ?? milestone).approval_state) === 'approved'
        && hasDonApproval(milestone.data ?? milestone, '', options.approverIds)
        && approvalData(milestone.data ?? milestone).revision === planRevision
        && approvalData(milestone.data ?? milestone).digest === planDigest
      ))) {
      return { id: planId, plan, milestones: group };
    }
  }
  return null;
}

export function deriveProgress(itemId, milestones = [], plans = [], options = {}) {
  const itemMilestones = milestones.filter(milestone => (milestone.data ?? milestone).item === itemId);
  const approved = approvedMilestonePlan(itemId, milestones, plans, options);
  const views = itemMilestones.map(milestone => milestoneView(milestone, approved, options));
  if (!approved || approved.milestones.length === 0) {
    return { scoped: false, percent: null, milestones: views, approvedPlanId: null };
  }
  const totalWeight = approved.milestones.reduce((sum, milestone) => sum + milestoneWeight(milestone), 0);
  if (!Number.isFinite(totalWeight) || totalWeight <= 0) {
    return { scoped: false, percent: null, milestones: views, approvedPlanId: null };
  }
  const planRevision = approvalData(approved.plan?.data ?? approved.plan ?? {}).revision;
  const allVerified = approved.milestones.every(milestone => {
    const data = milestone.data ?? milestone;
    return scalarValue(data.status) === 'complete' && hasDonConfirmation(data, planRevision, options.approverIds);
  });
  const completedWeight = approved.milestones.reduce((sum, milestone) => {
    const data = milestone.data ?? milestone;
    return scalarValue(data.status) === 'complete' && hasDonConfirmation(data, planRevision, options.approverIds)
      ? sum + milestoneWeight(milestone) : sum;
  }, 0);
  const percent = allVerified ? 100 : Math.min(99, Math.floor((completedWeight / totalWeight) * 100));
  return {
    scoped: true,
    percent,
    milestones: views,
    approvedPlanId: approved.id,
    approvedPlanRevision: planRevision,
    allVerified,
    completedWeight,
    totalWeight
  };
}

export function buildProposal(data = {}) {
  const approval = approvalData(data);
  const owner = scalarValue(firstValue(data, 'owner_proposed'));
  const ownerRationale = scalarValue(firstValue(data, 'owner_proposal_rationale'));
  return {
    state: scalarValue(firstValue(data, 'approval_state', 'proposal_state')),
    owner,
    ownerRationale,
    approvedParts: approvedParts(data),
    rationale: scalarValue(firstValue(data, 'proposal_rationale')),
    revision: approval.revision,
    reviewedDetail: approval.detail,
    approval: {
      state: scalarValue(data.approval_state) ?? null,
      approvedBy: approval.approvedBy,
      approvedAt: approval.approvedAt,
      reference: approval.reference,
      revision: approval.revision,
      reviewedDetail: approval.detail,
      digest: approval.digest,
      source: approval.source
    }
  };
}
