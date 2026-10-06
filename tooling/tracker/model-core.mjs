import {
  APPROVAL_SOURCES,
  APPROVED_PARTS,
  COMMITMENTS,
  approvalData,
  acceptedTaskDigest,
  approvedParts,
  commitmentValue,
  confirmationData,
  deriveProgress,
  hasDonApproval,
  isDonIdentity,
  isUtcTimestamp,
  milestonePlanApprovalDigest,
  numberValue,
  scalarValue,
  taskApprovalDigest
} from './planning.mjs';
import { extractMarkdownSections, scanMarkdownHeadings } from './markdown.mjs';
import { validateActivityEvidence } from './activity-evidence.mjs';
import { validateDeliveryRecords } from './delivery-records.mjs';

export const ITEM_STATUSES = new Set(['queued', 'active', 'blocked', 'done']);
export const PHASES = new Set(['discovery', 'build', 'verify']);
export const ITEM_TYPES = new Set(['project', 'workstream', 'task']);
export { COMMITMENTS };
export const DECISION_STATES = new Set(['proposed', 'approved', 'superseded']);
export const PLAN_STATES = new Set(['draft', 'proposed', 'approved', 'superseded', 'deferred']);
export const APPROVAL_STATES = new Set(['proposed', 'approved', 'rejected', 'deferred']);
export const MILESTONE_STATES = new Set(['proposed', 'approved', 'complete', 'needs-reverification', 'deferred']);
export const CONFIRMATION_STATES = new Set(['pending', 'confirmed', 'not-done', 'later', 'needs-reverification']);
export const HEALTH_STATES = new Set(['on-track', 'at-risk', 'blocked', 'unknown']);
export const CONFIRMATION_SOURCES = new Set(['grok-ui', 'authenticated-edit']);
export const idPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

const unknownValues = new Set(['', '-', 'unknown', 'tbd', 'unset']);
const planDirs = ['tracker/plans'];
const milestoneDirs = ['tracker/milestones'];
const capacityDirs = ['tracker/capacities', 'tracker/capacity'];
const legacyItemDirs = ['tracker/active', 'tracker/intake', 'tracker/archive'];

export function isUnknown(value) {
  return value === undefined || value === null || unknownValues.has(String(value).trim().toLowerCase());
}

export function isDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '')) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

export function isUtcSecond(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value ?? '')) return false;
  const date = new Date(value);
  return !Number.isNaN(date.valueOf()) && date.toISOString().replace('.000Z', 'Z') === value;
}

// Kept at this module boundary because callers historically imported it from
// model.mjs while approval validation now lives in planning.mjs.
export { APPROVAL_SOURCES, isUtcTimestamp };

function hasValue(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function meaningful(value) {
  return hasValue(value) && !unknownValues.has(value.trim().toLowerCase());
}

function required(data, key, path, issues) {
  if (!hasValue(data[key])) issues.push(`${path}: ${key} is required`);
  return hasValue(data[key]);
}

function optionalScalar(data, key, path, issues) {
  if (data[key] !== undefined && typeof data[key] !== 'string') issues.push(`${path}: ${key} must be a scalar string`);
}

function parseDateField(data, key, path, issues) {
  if (data[key] !== undefined && !isUnknown(data[key]) && !isDate(data[key])) {
    issues.push(`${path}: ${key} must be unknown or a valid YYYY-MM-DD date`);
  }
}

function parseTimestampField(data, key, path, issues) {
  if (data[key] !== undefined && !isUnknown(data[key]) && !isUtcTimestamp(data[key])) {
    issues.push(`${path}: ${key} must be unknown or a valid UTC timestamp`);
  }
}

function parseNumberField(data, key, path, issues, { min = 0 } = {}) {
  if (data[key] === undefined || isUnknown(data[key])) return null;
  const value = Number(data[key]);
  if (!Number.isFinite(value) || value < min) issues.push(`${path}: ${key} must be a number >= ${min}`);
  return Number.isFinite(value) ? value : null;
}

function parseBooleanField(data, key, path, issues, { required: requiredBoolean = false } = {}) {
  if (data[key] === undefined || isUnknown(data[key])) {
    if (requiredBoolean) issues.push(`${path}: ${key} must be true or false`);
    return null;
  }
  if (!['true', 'false'].includes(String(data[key]).toLowerCase())) {
    issues.push(`${path}: ${key} must be true or false`);
    return null;
  }
  return String(data[key]).toLowerCase() === 'true';
}

function parseCommitmentField(data, path, issues) {
  const raw = scalarValue(data.commitment);
  if (raw === null) {
    issues.push(`${path}: commitment must be draft, planned, or accepted`);
    return null;
  }
  const commitment = raw.toLowerCase();
  if (!COMMITMENTS.has(commitment) || raw !== commitment) {
    issues.push(`${path}: commitment must be draft, planned, or accepted`);
    return null;
  }
  return commitment;
}

function approvalIssues(data, path, issues, { required: requiredApproval = false, strict = false, requireCurrentRevision = false } = {}) {
  const approval = approvalData(data);
  const anyApproval = [
    approval.approvedBy,
    approval.approvedAt,
    approval.reference,
    approval.revision,
    approval.detail,
    approval.digest,
    approval.source
  ].some(Boolean);
  if (approval.approvedBy && !isDonIdentity(approval.approvedBy)) issues.push(`${path}: approved_by must identify Don (owner or don)`);
  if (approval.source && !APPROVAL_SOURCES.has(approval.source)) issues.push(`${path}: invalid approval_source`);
  if (approval.approvedAt && !isUtcTimestamp(approval.approvedAt)) issues.push(`${path}: approved_at must be a valid UTC timestamp`);
  if (strict && (requiredApproval || anyApproval)) {
    if (!isDonIdentity(approval.approvedBy)) issues.push(`${path}: approved records need Don as approved_by`);
    if (!approval.approvedAt || !isUtcTimestamp(approval.approvedAt)) issues.push(`${path}: approved records need approved_at`);
    if (!approval.reference) issues.push(`${path}: approved records need approval_ref`);
    if (!approval.revision) issues.push(`${path}: approved records need approved_revision`);
    if (requireCurrentRevision && !meaningful(data.revision)) issues.push(`${path}: approved records need current revision`);
    if (requireCurrentRevision && meaningful(data.revision) && approval.revision !== data.revision) issues.push(`${path}: approved_revision must match current revision`);
    if (!approval.detail) issues.push(`${path}: approved records need reviewed_detail`);
    if (!approval.digest || !/^[a-f0-9]{64}$/.test(approval.digest)) issues.push(`${path}: approved records need a 64-character approval_digest`);
    if (!approval.source || !APPROVAL_SOURCES.has(approval.source)) issues.push(`${path}: approved records need approval_source`);
  }
  return { ...approval, anyApproval };
}

function confirmationIssues(data, path, issues) {
  const confirmation = confirmationData(data);
  const state = confirmation.state ?? 'pending';
  if (!CONFIRMATION_STATES.has(state)) issues.push(`${path}: invalid confirmation_state`);
  const anyConfirmation = [confirmation.confirmedBy, confirmation.confirmedAt, confirmation.reference, confirmation.evidence].some(Boolean);
  if (confirmation.confirmedBy && !isDonIdentity(confirmation.confirmedBy)) issues.push(`${path}: confirmed_by must identify Don (owner or don)`);
  if (confirmation.confirmedAt && !isUtcTimestamp(confirmation.confirmedAt)) issues.push(`${path}: confirmed_at must be a valid UTC timestamp`);
  if (confirmation.source && !CONFIRMATION_SOURCES.has(confirmation.source)) issues.push(`${path}: confirmation_source must be grok-ui or authenticated-edit`);
  if (state === 'confirmed' || anyConfirmation) {
    if (!isDonIdentity(confirmation.confirmedBy)) issues.push(`${path}: confirmed milestones need Don as confirmed_by`);
    if (!confirmation.confirmedAt || !isUtcTimestamp(confirmation.confirmedAt)) issues.push(`${path}: confirmed milestones need confirmed_at`);
    if (!confirmation.reference) issues.push(`${path}: confirmed milestones need confirmation_ref`);
    if (!confirmation.evidence) issues.push(`${path}: confirmed milestones need evidence_ref`);
    if (!CONFIRMATION_SOURCES.has(confirmation.source)) issues.push(`${path}: confirmed milestones need confirmation_source`);
    if (!confirmation.revision) issues.push(`${path}: confirmed milestones need confirmed_revision`);
  }
  return confirmation;
}

export function parseRecord(text) {
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  if (lines[0] !== '---') return { error: 'missing opening frontmatter fence' };
  const end = lines.indexOf('---', 1);
  if (end < 0) return { error: 'missing closing frontmatter fence' };
  const data = {};
  for (const line of lines.slice(1, end)) {
    const match = /^([a-z][a-z0-9_]*):\s*(.*?)\s*$/.exec(line);
    if (!match) return { error: `invalid frontmatter line: ${line}` };
    if (Object.hasOwn(data, match[1])) return { error: `duplicate key: ${match[1]}` };
    data[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return { data, body: lines.slice(end + 1).join('\n').trim() };
}

export function refs(value) {
  return !value || value === '-' ? [] : String(value).split(',').map(x => x.trim()).filter(Boolean);
}

function fileEntries(files) {
  if (files instanceof Map) return [...files.entries()].sort(([left], [right]) => left.localeCompare(right));
  if (typeof files !== 'object' || files === null || Array.isArray(files)) throw new TypeError('tracker files must be a Map or object');
  return Object.entries(files).sort(([left], [right]) => left.localeCompare(right));
}

function pathsUnder(paths, directory, extension = '.md') {
  const prefix = `${directory}/`;
  return paths.filter(path => path.startsWith(prefix) && path.endsWith(extension));
}

function parseFileRecord(files, path, extension = '.md') {
  const name = path.split('/').at(-1).slice(0, -extension.length);
  const text = files.get(path);
  if (typeof text !== 'string') return { path, name, error: 'file content is missing' };
  if (extension === '.json') {
    try {
      return { path, name, data: JSON.parse(text) };
    } catch (error) {
      return { path, name, error: `invalid JSON: ${error.message}` };
    }
  }
  const parsed = parseRecord(text);
  return parsed.error ? { path, name, error: parsed.error } : { ...parsed, path, name };
}

/** Parse a trusted tracker file map without filesystem access. */
export function loadTrackerFromFiles(fileInput) {
  const entries = fileEntries(fileInput);
  const files = new Map(entries);
  const paths = entries.map(([path]) => path);
  const records = {
    items: [],
    decisions: [],
    updates: [],
    releases: [],
    plans: [],
    history: [],
    migrations: [],
    milestones: [],
    capacities: [],
    delivery: [],
    people: [],
    botMessages: [],
    botReceipts: [],
    errors: []
  };

  for (const dir of legacyItemDirs) {
    const legacyRecords = pathsUnder(paths, dir).filter(path => !['README.md', '.gitkeep'].includes(path.split('/').at(-1)));
    if (legacyRecords.length) records.errors.push(`${dir}: legacy item folder is not supported; move live records to tracker/items and replaced records to tracker/history`);
  }
  const legacyProposals = pathsUnder(paths, 'tracker/proposals').filter(path => !['README.md', '.gitkeep'].includes(path.split('/').at(-1)));
  if (legacyProposals.length) records.errors.push('tracker/proposals: legacy planning folder is not supported; use tracker/plans and tracker/items');

  for (const path of pathsUnder(paths, 'tracker/items')) {
    const record = parseFileRecord(files, path);
    if (record.error) records.errors.push(`${path}: ${record.error}`);
    else records.items.push(record);
  }
  for (const path of pathsUnder(paths, 'tracker/history')) {
    const record = parseFileRecord(files, path);
    if (record.error) records.errors.push(`${path}: ${record.error}`);
    else records.history.push(record);
  }
  for (const [kind, dirs] of Object.entries({
    decisions: ['tracker/decisions'],
    updates: ['tracker/updates'],
    releases: ['tracker/releases']
  })) {
    for (const dir of dirs) for (const path of pathsUnder(paths, dir)) {
      const record = parseFileRecord(files, path);
      if (record.error) records.errors.push(`${path}: ${record.error}`);
      else records[kind].push(record);
    }
  }
  for (const dir of planDirs) for (const path of pathsUnder(paths, dir)) {
    const record = parseFileRecord(files, path);
    if (record.error) records.errors.push(`${path}: ${record.error}`);
    else if (path.split('/').length === 3) records.plans.push(record);
    else records.errors.push(`${path}: nested plan task files are not supported; add one tracker/items record instead`);
  }
  for (const dir of milestoneDirs) for (const path of pathsUnder(paths, dir)) {
    const record = parseFileRecord(files, path);
    if (record.error) records.errors.push(`${path}: ${record.error}`);
    else records.milestones.push(record);
  }
  for (const dir of capacityDirs) for (const path of pathsUnder(paths, dir)) {
    const record = parseFileRecord(files, path);
    if (record.error) records.errors.push(`${path}: ${record.error}`);
    else records.capacities.push(record);
  }
  const peopleText = files.get('tracker/people.json');
  if (typeof peopleText === 'string') {
    try {
      const registry = JSON.parse(peopleText);
      if (Array.isArray(registry?.people)) records.people = registry.people;
      else records.errors.push('tracker/people.json: people must be an array');
    } catch (error) {
      records.errors.push(`tracker/people.json: invalid JSON: ${error.message}`);
    }
  }
  for (const path of pathsUnder(paths, 'tracker/delivery').filter(path => !['README.md', '.gitkeep'].includes(path.split('/').at(-1)))) {
    const record = parseFileRecord(files, path);
    if (record.error) records.errors.push(`${path}: ${record.error}`);
    else records.delivery.push(record);
  }
  for (const [directory, collection] of [['grok-bot/inbox', 'botMessages'], ['grok-bot/receipts', 'botReceipts']]) {
    for (const path of pathsUnder(paths, directory).filter(path => /^grok-bot\/(?:inbox|receipts)\/[^/]+\/[^/]+\.md$/.test(path))) {
      const record = parseFileRecord(files, path);
      if (record.error) records.errors.push(`${path}: ${record.error}`);
      else records[collection].push(record);
    }
  }
  for (const path of paths.filter(candidate => /^tracker\/migrations\/[^/]+\.json$/.test(candidate))) {
    const record = parseFileRecord(files, path, '.json');
    if (record.error) records.errors.push(`${path}: ${record.error}`);
    else records.migrations.push(record);
  }
  records.legacyApprovals = Object.fromEntries(records.migrations.flatMap(record => Object.entries(record.data?.legacyApprovals ?? {})));
  return records;
}

function cycleErrors(nodes, field, refsFor) {
  const byId = new Map(nodes.map(node => [node.data.id, node]));
  const state = new Map();
  const issues = [];
  function visit(id, chain) {
    const mark = state.get(id);
    if (mark === 'done') return;
    if (mark === 'visiting') {
      issues.push(`${byId.get(chain.at(-1))?.path ?? id}: ${field} cycle: ${[...chain, id].join(' -> ')}`);
      return;
    }
    state.set(id, 'visiting');
    const node = byId.get(id);
    if (node) for (const ref of refsFor(node)) if (byId.has(ref)) visit(ref, [...chain, id]);
    state.set(id, 'done');
  }
  for (const id of byId.keys()) visit(id, []);
  return issues;
}

function sectionsFromBody(body) {
  return extractMarkdownSections(body);
}

function validateRecordBody(record, path, issues, headings) {
  for (const heading of headings) if (!record.body.includes(heading)) issues.push(`${path}: missing ${heading}`);
}

function validateItemSections(record, path, issues) {
  const expected = new Set(['outcome', 'completion condition', 'next step', 'evidence']);
  const counts = new Map();
  for (const heading of scanMarkdownHeadings(record.body).headings) {
    if (heading.level !== 2) continue;
    const name = heading.text.toLowerCase();
    if (!expected.has(name)) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  for (const [heading, count] of counts) if (count > 1) issues.push(`${path}: duplicate ## ${heading} section`);
}

function validateItemPlanningFields(item, issues, { requireHealth = false } = {}) {
  const { data: d, path } = item;
  optionalScalar(d, 'health_state', path, issues);
  const healthState = d.health_state ?? (requireHealth ? 'unknown' : null);
  if (healthState && !HEALTH_STATES.has(healthState)) issues.push(`${path}: invalid health_state`);
  for (const key of ['health_reason', 'missing_information', 'suggested_action', 'suggested_actor']) optionalScalar(d, key, path, issues);
  if (healthState && ['unknown', 'blocked', 'at-risk'].includes(healthState)) {
    for (const key of ['health_reason', 'missing_information', 'suggested_action', 'suggested_actor']) {
      if (!meaningful(d[key])) issues.push(`${path}: ${healthState} health needs ${key}`);
    }
  }
  parseTimestampField(d, 'health_reviewed_at', path, issues);
  for (const key of ['planned_start', 'planned_end', 'forecast_start', 'forecast_end_min', 'forecast_end_max']) parseDateField(d, key, path, issues);
  parseBooleanField(d, 'schedule_provisional', path, issues);
  for (const key of ['effort_min', 'effort_max', 'remaining_effort_min', 'remaining_effort_max']) parseNumberField(d, key, path, issues);
  if (!isUnknown(d.effort_min) && !isUnknown(d.effort_max) && Number(d.effort_max) < Number(d.effort_min)) issues.push(`${path}: effort_max must be >= effort_min`);
  if (!isUnknown(d.remaining_effort_min) && !isUnknown(d.remaining_effort_max) && Number(d.remaining_effort_max) < Number(d.remaining_effort_min)) issues.push(`${path}: remaining_effort_max must be >= remaining_effort_min`);
  if (!isUnknown(d.planned_start) && !isUnknown(d.planned_end) && d.planned_end < d.planned_start) issues.push(`${path}: planned_end must be >= planned_start`);
  if (!isUnknown(d.forecast_start) && !isUnknown(d.forecast_end_min) && d.forecast_end_min < d.forecast_start) issues.push(`${path}: forecast_end_min must be >= forecast_start`);
  if (!isUnknown(d.forecast_start) && !isUnknown(d.forecast_end_max) && d.forecast_end_max < d.forecast_start) issues.push(`${path}: forecast_end_max must be >= forecast_start`);
  if (!isUnknown(d.forecast_end_min) && !isUnknown(d.forecast_end_max) && d.forecast_end_max < d.forecast_end_min) issues.push(`${path}: forecast_end_max must be >= forecast_end_min`);
  if (meaningful(d.priority) && !meaningful(d.priority_rationale)) issues.push(`${path}: priority_rationale is required when priority is set`);
  if (meaningful(d.owner_proposed) && !meaningful(d.owner_proposal_rationale)) issues.push(`${path}: owner_proposal_rationale is required when owner_proposed is set`);
}

function exactAssignmentApproval(item) {
  const data = item.data;
  const approval = approvalData(data);
  const parts = approvedParts(data);
  return data.approval_state === 'approved'
    && parts.includes('assignment')
    && parts.every(part => APPROVED_PARTS.has(part))
    && meaningful(data.owner)
    && data.owner !== 'unassigned'
    && meaningful(data.owner_proposed)
    && data.owner === data.owner_proposed
    && meaningful(data.revision)
    && hasDonApproval(data)
    && approval.revision === data.revision
    && approval.digest === taskApprovalDigest(item);
}

function scopeFreeAssignmentApproval(item) {
  const parts = approvedParts(item.data);
  return !parts.includes('task')
    && parts.includes('assignment')
    && parts.every(part => part === 'assignment' || part === 'schedule')
    && exactAssignmentApproval(item);
}

function validateItems(records, issues) {
  const byId = new Map();
  for (const item of records.items) {
    const d = item.data;
    for (const key of ['id', 'type', 'status', 'phase', 'owner', 'parent', 'depends_on', 'updated_at', 'commitment']) required(d, key, item.path, issues);
    if (!idPattern.test(d.id ?? '') || item.name !== d.id) issues.push(`${item.path}: id must be a unique kebab-case filename`);
    if (byId.has(d.id)) issues.push(`${item.path}: duplicate item id ${d.id}`);
    byId.set(d.id, item);
    if (hasValue(d.type) && !ITEM_TYPES.has(d.type)) issues.push(`${item.path}: invalid item type`);
    if (hasValue(d.status) && !ITEM_STATUSES.has(d.status)) issues.push(`${item.path}: invalid status`);
    if (hasValue(d.phase) && !PHASES.has(d.phase)) issues.push(`${item.path}: invalid phase`);
    if (hasValue(d.updated_at) && !isDate(d.updated_at)) issues.push(`${item.path}: updated_at must be a valid YYYY-MM-DD date`);
    const commitment = parseCommitmentField(d, item.path, issues);
    if (d.planned !== undefined) issues.push(`${item.path}: planned boolean is obsolete; use commitment`);
    optionalScalar(d, 'accepted_from', item.path, issues);
    if (commitment !== 'accepted' && meaningful(d.accepted_from)) issues.push(`${item.path}: accepted_from is only valid for accepted items`);
    if (['draft', 'planned'].includes(commitment) && d.status !== 'queued') issues.push(`${item.path}: ${commitment} items must remain queued`);
    if (['draft', 'planned'].includes(commitment) && d.owner !== 'unassigned' && !exactAssignmentApproval(item)) {
      issues.push(`${item.path}: ${commitment} items must keep owner unassigned unless an exact assignment approval is valid`);
    }
    parseDateField(d, 'target', item.path, issues);
    if (d.status === 'done' && !isDate(d.completed_at)) issues.push(`${item.path}: done items need completed_at`);
    if (d.status !== 'done' && d.completed_at && d.completed_at !== '-') issues.push(`${item.path}: only done items may have completed_at`);
    const parts = item.path.split('/');
    const archived = parts[1] === 'items' && parts[2] === 'archive';
    if (archived) {
      if (parts.length !== 5 || !/^\d{4}$/.test(parts[3] ?? '')) issues.push(`${item.path}: archived item path must be tracker/items/archive/<year>/<id>.md`);
      if (d.status !== 'done') issues.push(`${item.path}: archived items must be done`);
      if (d.commitment !== 'accepted') issues.push(`${item.path}: archived items must be accepted with commitment: accepted`);
      if (parts[3] && d.completed_at && parts[3] !== d.completed_at.slice(0, 4)) issues.push(`${item.path}: archive year must match completed_at`);
    } else if (parts[1] !== 'items' || parts.length < 4 || parts.slice(2, -1).some(segment => !idPattern.test(segment))) {
      issues.push(`${item.path}: item path must be tracker/items/<kebab-case bucket>/<id>.md`);
    }
    validateItemSections(item, item.path, issues);
    validateItemPlanningFields(item, issues, { requireHealth: true });
    const approval = approvalIssues(d, item.path, issues);
    if (d.approval_state !== undefined && !APPROVAL_STATES.has(d.approval_state)) issues.push(`${item.path}: invalid approval_state`);
    const approvalParts = approvedParts(d);
    const hasDeclaredParts = d.approved_parts !== undefined && !isUnknown(d.approved_parts);
    if (approvalParts.some(part => !APPROVED_PARTS.has(part))
      || (!approvalParts.includes('task') && !scopeFreeAssignmentApproval(item) && (approval.anyApproval || hasDeclaredParts))) {
      issues.push(`${item.path}: approved_parts must contain task and may include assignment or schedule, unless an exact assignment approval records owner attribution`);
    }
  }
  return byId;
}

function validateHistory(records, itemIds, issues) {
  const byId = new Map();
  for (const record of records.history) {
    const d = record.data;
    required(d, 'id', record.path, issues);
    required(d, 'superseded_by', record.path, issues);
    if (!idPattern.test(d.id ?? '') || record.name !== d.id) issues.push(`${record.path}: history id must match kebab-case filename`);
    if (byId.has(d.id)) issues.push(`${record.path}: duplicate history id ${d.id}`);
    if (itemIds.has(d.id)) issues.push(`${record.path}: history id must not duplicate a live item id`);
    byId.set(d.id, record);
    if (d.superseded_by && !itemIds.has(d.superseded_by)) issues.push(`${record.path}: unknown superseded_by live item ${d.superseded_by}`);
    const parts = record.path.split('/');
    if (parts[1] !== 'history' || parts.length < 3 || parts.slice(2, -1).some(segment => !idPattern.test(segment))) {
      issues.push(`${record.path}: history path must be tracker/history/<id>.md or a kebab-case subfolder`);
    }
    validateItemSections(record, record.path, issues);
  }
  return byId;
}

function validatePlans(records, itemIds, issues) {
  const byId = new Map();
  for (const plan of records.plans) {
    const d = plan.data;
    for (const key of ['id', 'project', 'status', 'owner', 'updated_at']) required(d, key, plan.path, issues);
    if (plan.name !== d.id || !idPattern.test(d.id ?? '')) issues.push(`${plan.path}: id must match kebab-case filename`);
    if (byId.has(d.id)) issues.push(`${plan.path}: duplicate plan id ${d.id}`);
    byId.set(d.id, plan);
    optionalScalar(d, 'scope', plan.path, issues);
    if (d.status && !PLAN_STATES.has(d.status)) issues.push(`${plan.path}: invalid plan status`);
    if (d.updated_at && !isDate(d.updated_at)) issues.push(`${plan.path}: updated_at must be a valid YYYY-MM-DD date`);
    if (d.project && !itemIds.has(d.project)) issues.push(`${plan.path}: unknown project ${d.project}`);
    approvalIssues(d, plan.path, issues, { required: d.status === 'approved', strict: d.status === 'approved', requireCurrentRevision: d.status === 'approved' });
    validateRecordBody(plan, plan.path, issues, ['## Objective', '## Evidence']);
  }
  return byId;
}

function validateMilestones(records, itemIds, planIds, issues) {
  const byId = new Map();
  for (const milestone of records.milestones) {
    const d = milestone.data;
    for (const key of ['id', 'item', 'plan_id', 'weight', 'status', 'updated_at']) required(d, key, milestone.path, issues);
    if (!idPattern.test(d.id ?? '') || milestone.name !== d.id) issues.push(`${milestone.path}: id must match kebab-case filename`);
    if (byId.has(d.id)) issues.push(`${milestone.path}: duplicate milestone id ${d.id}`);
    byId.set(d.id, milestone);
    if (!itemIds.has(d.item)) issues.push(`${milestone.path}: unknown milestone item ${d.item}`);
    if (!planIds.has(d.plan_id)) issues.push(`${milestone.path}: unknown milestone plan ${d.plan_id}`);
    if (!MILESTONE_STATES.has(d.status)) issues.push(`${milestone.path}: invalid milestone status`);
    const weight = parseNumberField(d, 'weight', milestone.path, issues, { min: Number.MIN_VALUE });
    if (weight === null) issues.push(`${milestone.path}: weight must be a positive number`);
    if (d.updated_at && !isDate(d.updated_at)) issues.push(`${milestone.path}: updated_at must be a valid YYYY-MM-DD date`);
    if (d.approval_state && !APPROVAL_STATES.has(d.approval_state)) issues.push(`${milestone.path}: invalid approval_state`);
    if (['approved', 'complete', 'needs-reverification'].includes(d.status)) {
      if (d.approval_state !== 'approved') issues.push(`${milestone.path}: active milestones need approval_state approved`);
      approvalIssues(d, milestone.path, issues, { required: true, strict: true });
    } else approvalIssues(d, milestone.path, issues);
    confirmationIssues(d, milestone.path, issues);
    if (d.status === 'complete' && !confirmationData(d).confirmedBy) issues.push(`${milestone.path}: complete milestones need a Don confirmation record`);
    if (d.status === 'complete' && confirmationData(d).state !== 'confirmed') issues.push(`${milestone.path}: complete milestones need confirmation_state confirmed`);
    validateRecordBody(milestone, milestone.path, issues, ['## Outcome', '## Completion condition', '## Evidence']);
  }
  return byId;
}

function validateCapacities(records, issues) {
  const byId = new Map();
  for (const capacity of records.capacities) {
    const d = capacity.data;
    for (const key of ['id', 'person', 'updated_at']) required(d, key, capacity.path, issues);
    if (!idPattern.test(d.id ?? '') || capacity.name !== d.id) issues.push(`${capacity.path}: id must be kebab-case filename`);
    if (byId.has(d.id)) issues.push(`${capacity.path}: duplicate capacity id ${d.id}`);
    byId.set(d.id, capacity);
    if (d.updated_at && !isDate(d.updated_at)) issues.push(`${capacity.path}: updated_at must be a valid YYYY-MM-DD date`);
    parseDateField(d, 'as_of', capacity.path, issues);
    parseBooleanField(d, 'provisional', capacity.path, issues);
    for (const key of ['weekly_days', 'scheduled_days', 'free_days']) parseNumberField(d, key, capacity.path, issues);
    if (!isUnknown(d.weekly_days) && !isUnknown(d.scheduled_days) && !isUnknown(d.free_days)) {
      const derived = Math.max(0, Number(d.weekly_days) - Number(d.scheduled_days));
      if (Number(d.free_days) !== derived) issues.push(`${capacity.path}: free_days must equal weekly_days minus scheduled_days, floored at zero`);
    } else if (!isUnknown(d.free_days)) issues.push(`${capacity.path}: free_days must be unknown when weekly_days or scheduled_days is unknown`);
    validateRecordBody(capacity, capacity.path, issues, ['## Context', '## Evidence']);
  }
  return byId;
}

function validateDecisions(records, itemIds, historyIds, issues) {
  const resolvable = new Set([...itemIds.keys(), ...historyIds.keys()]);
  for (const decision of records.decisions ?? []) {
    const d = decision.data;
    for (const key of ['id', 'state', 'owner', 'affects', 'updated_at']) required(d, key, decision.path, issues);
    if (decision.name !== d.id || !idPattern.test(d.id ?? '')) issues.push(`${decision.path}: id must be kebab-case filename`);
    if (hasValue(d.state) && !DECISION_STATES.has(d.state)) issues.push(`${decision.path}: invalid decision state`);
    if (hasValue(d.updated_at) && !isDate(d.updated_at)) issues.push(`${decision.path}: updated_at must be a valid YYYY-MM-DD date`);
    if (d.state === 'approved' && (!isDonIdentity(d.approved_by) || !isDate(d.approved_at))) issues.push(`${decision.path}: approved decisions need approver and date`);
    for (const ref of refs(d.affects)) if (!resolvable.has(ref)) issues.push(`${decision.path}: unknown affected item ${ref}`);
  }
}

function validateUpdates(records, itemIds, historyIds, issues) {
  const resolvable = new Set([...itemIds.keys(), ...historyIds.keys()]);
  const sources = new Set();
  for (const update of records.updates ?? []) {
    const d = update.data;
    const parts = update.path.split('/');
    for (const key of ['id', 'item', 'source', 'observed_at']) required(d, key, update.path, issues);
    if (parts.at(-2) !== d.item || update.name !== d.id) issues.push(`${update.path}: path must match item and update id`);
    if (!resolvable.has(d.item)) issues.push(`${update.path}: unknown item ${d.item}`);
    if (hasValue(d.observed_at) && !isUtcSecond(d.observed_at)) issues.push(`${update.path}: observed_at must be a valid UTC second`);
    const key = `${d.item}/${d.source}`;
    if (sources.has(key)) issues.push(`${update.path}: duplicate source for item`);
    sources.add(key);
  }
}

function validateReleases(records, itemIds, issues) {
  for (const release of records.releases ?? []) {
    const d = release.data;
    for (const key of ['id', 'project', 'status', 'owner', 'target', 'updated_at']) required(d, key, release.path, issues);
    if (release.name !== d.id || !idPattern.test(d.id ?? '')) issues.push(`${release.path}: id must be kebab-case filename`);
    if (!itemIds.has(d.project)) issues.push(`${release.path}: unknown project ${d.project}`);
    if (hasValue(d.updated_at) && !isDate(d.updated_at)) issues.push(`${release.path}: updated_at must be a valid YYYY-MM-DD date`);
    if (hasValue(d.target) && d.target !== 'unknown' && !isDate(d.target)) issues.push(`${release.path}: target must be unknown or a valid YYYY-MM-DD date`);
    validateRecordBody(release, release.path, issues, ['## Gates']);
  }
}

function legacyApprovalMap(records) {
  return Object.fromEntries((records.migrations ?? []).flatMap(record => Object.entries(record.data?.legacyApprovals ?? {})));
}

function safeManifestPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\')) return false;
  if (value.startsWith('/') || value.endsWith('/')) return false;
  const segments = value.split('/');
  return segments[0] === 'tracker'
    && segments.every(segment => segment.length > 0 && segment !== '.' && segment !== '..');
}

function manifestBasename(value) {
  if (typeof value !== 'string') return null;
  const basename = value.split('/').at(-1);
  return basename?.endsWith('.md') ? basename.slice(0, -3) : basename ?? null;
}

function validateMigrationManifest(records, itemIds, decisions, issues) {
  if (!(records.migrations ?? []).length) {
    return;
  }
  if (records.migrations.length !== 1) issues.push('tracker/migrations: exactly one unified-work.json manifest is required');
  const migration = records.migrations[0];
  const data = migration.data;
  if (migration.name !== 'unified-work') issues.push(`${migration.path}: migration manifest must be tracker/migrations/unified-work.json`);
  if (data?.schemaVersion !== 1) issues.push(`${migration.path}: schemaVersion must be 1`);
  if (!/^[a-f0-9]{40}$/.test(data?.sourceCommit ?? '')) issues.push(`${migration.path}: sourceCommit must be a 40-character hexadecimal commit`);
  if (!Array.isArray(data?.mappings)) issues.push(`${migration.path}: mappings must be an array`);
  if (!data || typeof data.legacyApprovals !== 'object' || Array.isArray(data.legacyApprovals)) issues.push(`${migration.path}: legacyApprovals must be an object`);
  const mappings = Array.isArray(data?.mappings) ? data.mappings : [];
  if (mappings.length !== 98) issues.push(`${migration.path}: mappings must contain 98 source records`);
  const sourceIds = new Set();
  const sourcePaths = new Set();
  const targetIds = new Set();
  const identityTargetIds = new Set();
  const historyPaths = new Set();
  for (const mapping of mappings) {
    if (!mapping || typeof mapping !== 'object') {
      issues.push(`${migration.path}: each mapping must be an object`);
      continue;
    }
    for (const key of ['sourceId', 'sourcePath', 'targetId', 'targetPath']) if (!hasValue(mapping[key])) issues.push(`${migration.path}: mapping ${key} is required`);
    if (mapping.historyPath !== null && typeof mapping.historyPath !== 'string') issues.push(`${migration.path}: mapping historyPath must be null or a string`);
    if (sourceIds.has(mapping.sourceId)) issues.push(`${migration.path}: duplicate sourceId ${mapping.sourceId}`);
    if (sourcePaths.has(mapping.sourcePath)) issues.push(`${migration.path}: duplicate sourcePath ${mapping.sourcePath}`);
    sourceIds.add(mapping.sourceId);
    sourcePaths.add(mapping.sourcePath);
    targetIds.add(mapping.targetId);
    if (mapping.historyPath) historyPaths.add(mapping.historyPath);
    if (mapping.targetId && !itemIds.has(mapping.targetId)) issues.push(`${migration.path}: mapping targetId ${mapping.targetId} is not resolvable as a current live item`);
    if (mapping.historyPath === null) {
      if (hasValue(mapping.sourceId) && hasValue(mapping.targetId) && mapping.sourceId !== mapping.targetId) {
        issues.push(`${migration.path}: nonhistorical mapping ${mapping.sourceId} must preserve targetId ${mapping.sourceId}`);
      } else if (hasValue(mapping.sourceId) && mapping.sourceId === mapping.targetId) {
        identityTargetIds.add(mapping.targetId);
      }
    }
    if (!safeManifestPath(mapping.sourcePath)) {
      issues.push(`${migration.path}: mapping sourcePath must be a safe tracker-relative path`);
    } else if (manifestBasename(mapping.sourcePath) !== mapping.sourceId) {
      issues.push(`${migration.path}: mapping sourcePath basename must match sourceId ${mapping.sourceId}`);
    }
    if (!safeManifestPath(mapping.targetPath)) {
      issues.push(`${migration.path}: mapping targetPath must be a safe tracker-relative path`);
    } else {
      if (!mapping.targetPath.startsWith('tracker/items/')) issues.push(`${migration.path}: mapping targetPath must use the canonical tracker/items prefix`);
      if (manifestBasename(mapping.targetPath) !== mapping.targetId) issues.push(`${migration.path}: mapping targetPath basename must match targetId ${mapping.targetId}`);
    }
    if (mapping.historyPath !== null) {
      if (!safeManifestPath(mapping.historyPath)) {
        issues.push(`${migration.path}: mapping historyPath must be a safe tracker-relative path`);
      } else {
        if (!mapping.historyPath.startsWith('tracker/history/')) issues.push(`${migration.path}: mapping historyPath must use the tracker/history prefix`);
        if (manifestBasename(mapping.historyPath) !== mapping.sourceId) issues.push(`${migration.path}: mapping historyPath basename must match sourceId ${mapping.sourceId}`);
        const history = records.history.find(candidate => candidate.path === mapping.historyPath);
        if (!history) {
          issues.push(`${migration.path}: mapping historyPath ${mapping.historyPath} must resolve to a loaded history record`);
        } else {
          if (history.data.id !== mapping.sourceId) issues.push(`${migration.path}: historyPath ${mapping.historyPath} must load sourceId ${mapping.sourceId}`);
          if (history.data.superseded_by !== mapping.targetId) issues.push(`${migration.path}: historyPath ${mapping.historyPath} must supersede targetId ${mapping.targetId}`);
        }
      }
    }
  }
  const historicalMappings = mappings.filter(mapping => mapping && mapping.historyPath !== null);
  const identityMappings = mappings.filter(mapping => mapping?.historyPath === null && hasValue(mapping?.sourceId) && mapping.sourceId === mapping.targetId);
  if (historyPaths.size !== historicalMappings.length) issues.push(`${migration.path}: historical mappings must use unique history paths`);
  if (identityTargetIds.size !== identityMappings.length) issues.push(`${migration.path}: live identity mappings must preserve unique source identities`);
  if (targetIds.size !== identityTargetIds.size) issues.push(`${migration.path}: mappings must target every original live identity and no other target`);
  for (const mapping of mappings) {
    if (mapping?.historyPath !== null && hasValue(mapping?.targetId) && !identityTargetIds.has(mapping.targetId)) {
      issues.push(`${migration.path}: historical replacement targetId ${mapping.targetId} must be one of the live original identity targets`);
    }
  }
  const legacy = data?.legacyApprovals ?? {};
  const legacyIds = Object.keys(legacy);
  if (legacyIds.length !== 4) issues.push(`${migration.path}: legacyApprovals must cover four retained accepted records`);
  const retainedIds = new Set(mappings
    .filter(mapping => mapping?.historyPath === null
      && typeof mapping?.sourcePath === 'string'
      && mapping.sourcePath.startsWith('tracker/active/')
      && mapping.sourceId === mapping.targetId)
    .map(mapping => mapping.targetId));
  if (retainedIds.size !== 4) issues.push(`${migration.path}: mappings must identify four retained accepted records`);
  if (legacyIds.length !== retainedIds.size || legacyIds.some(id => !retainedIds.has(id)) || [...retainedIds].some(id => !Object.hasOwn(legacy, id))) {
    issues.push(`${migration.path}: legacyApprovals keys must exactly match the retained accepted IDs`);
  }
  for (const id of legacyIds) {
    const entry = legacy[id];
    const item = records.items.find(candidate => candidate.data.id === id);
    if (!itemIds.has(id)) issues.push(`${migration.path}: legacy approval ${id} must identify a live item`);
    if (!retainedIds.has(id)) issues.push(`${migration.path}: legacy approval ${id} is not a retained accepted item from the migration mappings`);
    if (item && item.data.commitment !== 'accepted') issues.push(`${migration.path}: legacy approval ${id} must identify an accepted item`);
    if (!entry || !/^[a-f0-9]{64}$/.test(entry.digest ?? '')) issues.push(`${migration.path}: legacy approval ${id} needs a 64-character digest`);
    if (entry?.decision !== 'project-alpha-delivery-schedule-2026-09-30') issues.push(`${migration.path}: legacy approval ${id} must cite project-alpha-delivery-schedule-2026-09-30`);
    if (entry?.decision && !decisions.some(decision => (decision.data ?? decision).id === entry.decision)) issues.push(`${migration.path}: legacy approval ${id} cites unknown decision ${entry.decision}`);
  }
}

export function acceptanceState(item, allItems = [], legacyApprovals = {}, decisions = []) {
  const record = item?.data ? item : { data: item ?? {} };
  const data = record.data ?? {};
  const byId = new Map(allItems.map(candidate => [candidate.data?.id ?? candidate.id, candidate]));
  const commitment = commitmentValue(data);
  const accepted = commitment === 'accepted';
  const blockers = [];
  for (const dependency of refs(data.depends_on)) {
    const candidate = byId.get(dependency);
    if (!candidate) blockers.push({ id: dependency, reason: 'unknown-prerequisite' });
    else {
      const dependencyCommitment = commitmentValue(candidate.data ?? candidate);
      if (dependencyCommitment !== 'accepted') blockers.push({ id: dependency, reason: `prerequisite-${dependencyCommitment ?? 'uncommitted'}` });
    }
  }
  const approval = approvalData(data);
  const parts = approvedParts(data);
  const currentRevision = scalarValue(data.revision);
  const legacyEntry = legacyApprovals?.[data.id];
  const decisionId = legacyEntry?.decision;
  const decisionRecord = decisions.find(candidate => (candidate.data ?? candidate).id === decisionId);
  const decisionData = decisionRecord?.data ?? decisionRecord ?? {};
  const legacyApproved = Boolean(
    legacyEntry
      && accepted
      && acceptedTaskDigest(record) === legacyEntry.digest
      && decisionData.state === 'approved'
      && isDonIdentity(decisionData.approved_by)
      && refs(decisionData.affects).includes(data.id)
  );
  const validParts = parts.length > 0 && parts.every(part => APPROVED_PARTS.has(part));
  const scopeApproved = Boolean(
    data.approval_state === 'approved'
      && hasDonApproval(data)
      && parts.includes('task')
      && validParts
      && approval.digest === taskApprovalDigest(record)
      && currentRevision
      && approval.revision === currentRevision
  );
  const hasActualOwner = meaningful(data.owner) && data.owner !== 'unassigned';
  const assignmentReady = !hasActualOwner || exactAssignmentApproval(record);
  const scheduleReady = isUnknown(data.planned_start) && isUnknown(data.planned_end) || parts.includes('schedule');
  const perTaskApproved = scopeApproved && accepted && assignmentReady && scheduleReady;
  const legacyParts = legacyApproved
    ? [...new Set([
      ...parts,
      'task',
      meaningful(data.owner) && data.owner !== 'unassigned' ? 'assignment' : null,
      !isUnknown(data.planned_start) && !isUnknown(data.planned_end) ? 'schedule' : null
    ].filter(Boolean))]
    : parts;
  const planned = commitment === 'planned';
  const approved = legacyApproved || (accepted ? perTaskApproved : scopeApproved && assignmentReady);
  if ((accepted || planned) && !approved) blockers.unshift({ id: data.id, reason: 'approval-required' });
  const readinessStage = (planned || accepted) && approved;
  return {
    commitment,
    accepted,
    legacyApproved,
    approved,
    eligible: readinessStage && blockers.filter(blocker => blocker.reason !== 'approval-required').length === 0,
    held: approved && blockers.some(blocker => blocker.reason !== 'approval-required'),
    blockers,
    approvedParts: approved ? legacyParts : [],
    scheduleApproved: accepted && approved && (legacyApproved
      ? !isUnknown(data.planned_start) && !isUnknown(data.planned_end)
      : parts.includes('schedule'))
  };
}

function validateRelationships(records, itemIds, historyIds, issues) {
  const allNodes = records.items;
  for (const item of records.items) {
    const d = item.data;
    const parents = refs(d.parent);
    if (parents.length > 1) issues.push(`${item.path}: an item may have only one parent`);
    for (const ref of parents) {
      if (!itemIds.has(ref)) issues.push(`${item.path}: unknown parent ${ref}`);
      if (historyIds.has(ref)) issues.push(`${item.path}: live item parent must be a live item, not history ${ref}`);
    }
    for (const ref of refs(d.depends_on)) {
      if (!itemIds.has(ref)) issues.push(`${item.path}: unknown dependency ${ref}; dependencies must reference live items`);
      if (historyIds.has(ref)) issues.push(`${item.path}: live dependency must be a live item, not history ${ref}`);
    }
    if (d.commitment === 'accepted') {
      for (const ref of refs(d.depends_on)) {
        const dependency = records.items.find(candidate => candidate.data.id === ref);
        if (dependency && dependency.data.commitment !== 'accepted') issues.push(`${item.path}: accepted item depends on unaccepted prerequisite ${ref}`);
      }
    }
  }
  issues.push(...cycleErrors(allNodes, 'parent', node => refs(node.data.parent)));
  issues.push(...cycleErrors(allNodes, 'depends_on', node => refs(node.data.depends_on)));
}

function freshAcceptedApprovalIssues(item) {
  const d = item.data;
  const approval = approvalData(d);
  const parts = approvedParts(d);
  const issues = [];
  if (d.approval_state !== 'approved') issues.push(`${item.path}: accepted item needs approval_state approved or a matching legacy approval`);
  approvalIssues(d, item.path, issues, { required: true, strict: true, requireCurrentRevision: true });
  if (!hasDonApproval(d)) return issues;
  if (!parts.includes('task') || parts.some(part => !APPROVED_PARTS.has(part))) issues.push(`${item.path}: accepted item approval must include task scope`);
  if (meaningful(d.owner) && d.owner !== 'unassigned' && !parts.includes('assignment')) issues.push(`${item.path}: accepted owner needs approved assignment`);
  if (parts.includes('assignment') && meaningful(d.owner_proposed) && meaningful(d.owner) && d.owner !== 'unassigned' && d.owner !== d.owner_proposed) {
    issues.push(`${item.path}: approved assignment owner must match owner_proposed`);
  }
  if ((!isUnknown(d.planned_start) || !isUnknown(d.planned_end)) && !parts.includes('schedule')) issues.push(`${item.path}: accepted dates need approved schedule`);
  if (approval.digest !== taskApprovalDigest(item)) issues.push(`${item.path}: approval_digest does not match the exact approved task scope`);
  return issues;
}

function validateApprovalRules(records, itemIds, issues) {
  const legacy = legacyApprovalMap(records);
  const decisions = new Map((records.decisions ?? []).map(decision => {
    const data = decision.data ?? decision;
    return [data.id, data];
  }));
  for (const item of records.items) {
    const d = item.data;
    const accepted = d.commitment === 'accepted';
    const approval = approvalData(d);
    if (!accepted) {
      if (d.approval_state === 'approved') {
        approvalIssues(d, item.path, issues, { required: true, strict: true, requireCurrentRevision: true });
        if (approval.digest !== taskApprovalDigest(item)) issues.push(`${item.path}: approval_digest does not match the exact approved task scope`);
      }
      continue;
    }
    const legacyEntry = legacy[d.id];
    if (legacyEntry) {
      const decision = decisions.get(legacyEntry.decision);
      if (!decision || decision.state !== 'approved' || !isDonIdentity(decision.approved_by) || !refs(decision.affects).includes(d.id)) {
        issues.push(`${item.path}: legacy accepted item needs its approved Don decision to authorize this item`);
      }
      if (acceptedTaskDigest(item) !== legacyEntry.digest) {
        const freshIssues = freshAcceptedApprovalIssues(item);
        if (freshIssues.length) {
          issues.push(`${item.path}: accepted scope changed since its frozen legacy approval digest`);
          issues.push(...freshIssues);
        }
      } else if (d.approval_state && d.approval_state !== 'approved') {
        issues.push(`${item.path}: legacy accepted item must have approval_state approved when present`);
      }
      continue;
    }
    if (d.accepted_from !== 'planned') issues.push(`${item.path}: accepted item needs accepted_from: planned after a planned-stage transition`);
    issues.push(...freshAcceptedApprovalIssues(item));
  }
  for (const id of Object.keys(legacy)) if (!itemIds.has(id)) issues.push(`tracker/migrations/unified-work.json: legacy approval ${id} does not identify a live item`);
}

function validateApprovedPlans(records, issues) {
  for (const plan of records.plans) {
    if (plan.data.status !== 'approved') continue;
    const planMilestones = records.milestones.filter(milestone => milestone.data.plan_id === plan.data.id);
    if (!planMilestones.length) continue;
    const weights = planMilestones.map(milestone => numberValue(milestone.data.weight));
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    if (weights.some(weight => weight === null || weight <= 0) || !Number.isFinite(totalWeight) || totalWeight <= 0) issues.push(`${plan.path}: approved milestone plan needs finite positive weights`);
    const revision = approvalData(plan.data).revision;
    const approvalDigest = approvalData(plan.data).digest;
    if (approvalDigest && milestonePlanApprovalDigest(plan, planMilestones) !== approvalDigest) issues.push(`${plan.path}: approval_digest does not match the exact approved milestone scope`);
    for (const milestone of planMilestones) {
      if (!revision || approvalData(milestone.data).revision !== revision) issues.push(`${milestone.path}: milestone weight needs the approved plan revision ${revision ?? 'reference'}`);
      if (!approvalDigest || approvalData(milestone.data).digest !== approvalDigest) issues.push(`${milestone.path}: milestone needs the approved plan approval_digest`);
      if (!['approved', 'complete', 'needs-reverification'].includes(milestone.data.status)) issues.push(`${milestone.path}: proposed or deferred milestones cannot be included in an approved plan`);
      if (milestone.data.approval_state !== 'approved') issues.push(`${milestone.path}: included milestones need approval_state approved`);
      if (!hasDonApproval(milestone.data)) issues.push(`${milestone.path}: included milestones need their exact Don approval record`);
      const confirmation = confirmationData(milestone.data);
      if (milestone.data.status === 'complete' && (confirmation.state !== 'confirmed' || confirmation.revision !== revision || !confirmation.confirmedBy || !confirmation.confirmedAt || !confirmation.reference || !confirmation.evidence || !CONFIRMATION_SOURCES.has(confirmation.source))) {
        issues.push(`${milestone.path}: complete milestones need a specific Don confirmation for the approved revision`);
      }
    }
  }
}

export function validateTracker(input) {
  const records = {
    items: [],
    history: [],
    decisions: [],
    updates: [],
    releases: [],
    plans: [],
    migrations: [],
    milestones: [],
    capacities: [],
    delivery: [],
    people: [],
    botMessages: [],
    botReceipts: [],
    errors: [],
    ...input
  };
  const issues = [...(records.errors ?? [])];
  const itemIds = validateItems(records, issues);
  const historyIds = validateHistory(records, itemIds, issues);
  validateDecisions(records, itemIds, historyIds, issues);
  validateUpdates(records, itemIds, historyIds, issues);
  validateActivityEvidence(records, issues);
  validateDeliveryRecords(records, issues);
  validateReleases(records, itemIds, issues);
  const planIds = validatePlans(records, itemIds, issues);
  validateMilestones(records, itemIds, planIds, issues);
  validateCapacities(records, issues);
  validateRelationships(records, itemIds, historyIds, issues);
  validateMigrationManifest(records, itemIds, records.decisions, issues);
  validateApprovalRules(records, itemIds, issues);
  validateApprovedPlans(records, issues);

  const approvedMilestonePlansByItem = new Map();
  for (const milestone of records.milestones) {
    const progressPlan = records.plans.find(plan => plan.data.id === milestone.data.plan_id && plan.data.status === 'approved');
    if (!progressPlan) continue;
    const list = approvedMilestonePlansByItem.get(milestone.data.item) ?? [];
    if (!list.includes(progressPlan.data.id)) list.push(progressPlan.data.id);
    approvedMilestonePlansByItem.set(milestone.data.item, list);
  }
  for (const [itemId, planIds] of approvedMilestonePlansByItem) if (planIds.length > 1) issues.push(`item ${itemId}: multiple active approved milestone plans: ${planIds.join(', ')}`);
  for (const item of records.items) {
    const progress = deriveProgress(item.data.id, records.milestones, records.plans);
    if (item.data.status === 'done' && progress.scoped) {
      if (progress.percent !== 100 || !progress.allVerified) issues.push(`${item.path}: scoped done items need all approved milestones confirmed`);
      if (!meaningful(sectionsFromBody(item.body).evidence)) issues.push(`${item.path}: scoped done items need completion evidence`);
    }
  }
  return [...new Set(issues)].sort();
}

export function archiveCandidates(records, today = new Date()) {
  const cutoff = today.valueOf() - 14 * 24 * 60 * 60 * 1000;
  return records.items.filter(x => !String(x.path ?? '').startsWith('tracker/items/archive/')
    && x.data.type === 'task'
    && x.data.status === 'done'
    && x.data.commitment === 'accepted'
    && Date.parse(`${x.data.completed_at}T00:00:00Z`) <= cutoff);
}
