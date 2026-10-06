import { acceptanceState as sharedAcceptanceState } from '../../../tooling/tracker/model.mjs';
import { normalizeActivityEvidence } from '../../../tooling/tracker/activity-evidence.mjs';
import { extractMarkdownSections, extractMarkdownTitle, scanMarkdownHeadings } from '../../../tooling/tracker/markdown.mjs';
import { normalizeDeliveryRecords } from '../../../tooling/tracker/delivery-records.mjs';
import { approvalData, approvedParts, buildProposal, commitmentValue, deriveProgress, isAccepted, numberValue } from './planning.mjs';

function refs(value) {
  if (Array.isArray(value)) return value.flatMap(refs);
  return !value || value === '-' ? [] : String(value).split(',').map(value => value.trim()).filter(Boolean);
}

export function parseOwnerNames(markdown) {
  const owners = new Map();
  const headingPattern = /^##\s+(.+?)\s+·\s+\[@([^\]]+)\]\([^)]*\)\s*$/gm;
  for (const match of String(markdown ?? '').matchAll(headingPattern)) owners.set(match[2], match[1].trim());
  return owners;
}

function firstHeading(body, fallback) {
  return extractMarkdownTitle(body) || fallback;
}

export function extractSections(body) {
  return extractMarkdownSections(body);
}

function extractUpdateSections(body) {
  const sections = extractSections(body);
  if (sections.observation) return sections;
  const { lines, headings } = scanMarkdownHeadings(body);
  const observationHeading = headings.find(heading => heading.level === 1 && heading.text.toLowerCase() === 'observation');
  if (observationHeading === undefined) return sections;
  const nextHeading = headings.find(heading => heading.level === 1 && heading.index > observationHeading.index);
  const observation = lines.slice(observationHeading.index + 1, nextHeading?.index ?? lines.length).join('\n').trim();
  if (observation) sections.observation = observation;
  return sections;
}

function titleAndSections(record) {
  return { title: firstHeading(record?.body, record?.data?.id ?? 'untitled'), sections: extractSections(record?.body) };
}

function humanBucket(path) {
  const parts = String(path ?? '').split('/');
  if (parts[1] === 'items' && ['product', 'platform', 'operations', 'gtm'].includes(parts[2])) return parts[2];
  return 'other';
}

function isArchivedPath(path) {
  return String(path ?? '').startsWith('tracker/items/archive/');
}

function dateOrNull(value) {
  return value && !['-', 'unknown', 'tbd', 'unset', 'null'].includes(String(value).trim().toLowerCase()) ? value : null;
}

function textOrNull(value) {
  const valueText = String(value ?? '').trim();
  return valueText && !['-', 'unknown', 'tbd', 'unset', 'null'].includes(valueText.toLowerCase()) ? valueText : null;
}

function numberOrNull(value) {
  const number = numberValue(value);
  return number === null ? null : number;
}

function booleanOrNull(value) {
  if (value === true || value === false) return value;
  if (String(value).trim().toLowerCase() === 'true') return true;
  if (String(value).trim().toLowerCase() === 'false') return false;
  return null;
}

function healthFor(data = {}) {
  return {
    state: data.health_state ?? 'unknown',
    reason: textOrNull(data.health_reason) ?? 'Health has not been reviewed with sufficient evidence.',
    missingInformation: textOrNull(data.missing_information) ?? 'A current evidence review is missing.',
    suggestedAction: textOrNull(data.suggested_action) ?? 'Review the item and record the missing delivery evidence.',
    actor: textOrNull(data.suggested_actor) ?? 'agent',
    reviewedAt: dateOrNull(data.health_reviewed_at)
  };
}

function scheduleFields(data = {}) {
  return {
    plannedStart: dateOrNull(data.planned_start),
    plannedEnd: dateOrNull(data.planned_end),
    forecastStart: dateOrNull(data.forecast_start),
    forecastEndMin: dateOrNull(data.forecast_end_min),
    forecastEndMax: dateOrNull(data.forecast_end_max),
    provisional: booleanOrNull(data.schedule_provisional)
  };
}

function scheduleFor(data, { approved = false, preserveProposed = false } = {}) {
  const fields = scheduleFields(data);
  return {
    ...fields,
    plannedStart: approved || preserveProposed ? fields.plannedStart : null,
    plannedEnd: approved || preserveProposed ? fields.plannedEnd : null,
    approved: Boolean(approved)
  };
}

function effortFor(data = {}) {
  return {
    min: numberOrNull(data.effort_min),
    max: numberOrNull(data.effort_max),
    remainingMin: numberOrNull(data.remaining_effort_min),
    remainingMax: numberOrNull(data.remaining_effort_max)
  };
}

function compactRecord(record, extra = {}, parsed = null) {
  const { title, sections } = parsed ?? titleAndSections(record);
  return { id: record?.data?.id, title, path: record?.path, ...extra, sections };
}

function decisionRecord(record, ownerNames) {
  const data = rawData(record);
  const { title, sections } = titleAndSections(record);
  return {
    id: data.id,
    title,
    path: record.path,
    state: data.state,
    owner: data.owner,
    ownerName: ownerNames.get(data.owner) ?? data.owner,
    updatedAt: dateOrNull(data.updated_at),
    approvedBy: textOrNull(data.approved_by),
    approvedAt: dateOrNull(data.approved_at),
    approvalTimeUtc: dateOrNull(data.approval_time_utc),
    approvalRef: textOrNull(data.approval_ref),
    approvalSource: textOrNull(data.approval_source),
    coordinationDigest: textOrNull(data.coordination_digest),
    executorItem: textOrNull(data.executor_item),
    executorKind: textOrNull(data.executor_kind),
    executorRef: textOrNull(data.executor_ref),
    nextItem: textOrNull(data.next_item),
    nextActor: textOrNull(data.next_actor),
    supersededBy: textOrNull(data.superseded_by),
    affects: refs(data.affects),
    sourcePath: record.path,
    body: record.body ?? '',
    sections
  };
}

function approvalView(data = {}, fallback = null, decision = null) {
  const approval = approvalData(data) ?? {};
  const source = fallback && typeof fallback === 'object' ? fallback : {};
  const decisionData = decision && typeof decision === 'object' ? decision : {};
  const approvedBy = textOrNull(approval.approvedBy ?? source.approved_by ?? decisionData.approved_by);
  const approvedAt = dateOrNull(approval.approvedAt ?? source.approved_at ?? decisionData.approved_at);
  const reference = textOrNull(approval.reference ?? source.approval_ref ?? decisionData.approval_ref);
  const revision = textOrNull(approval.revision ?? source.approved_revision);
  const detail = textOrNull(approval.detail ?? source.reviewed_detail);
  const digest = textOrNull(approval.digest ?? source.approval_digest ?? source.digest);
  const approvalSource = textOrNull(approval.source ?? source.approval_source ?? decisionData.approval_source);
  const parts = approvedParts(data);
  return {
    state: textOrNull(data.approval_state),
    approvedBy,
    approvedAt,
    reference,
    revision,
    reviewedDetail: detail,
    digest,
    source: approvalSource,
    parts
  };
}

function rawData(value) {
  return value?.data && typeof value.data === 'object' ? value.data : value ?? {};
}

function approvalManifestEntry(legacyApprovals, id) {
  return legacyApprovals && id ? legacyApprovals[id] ?? null : null;
}

function acceptanceState(record, allRecords, legacyApprovals, decisions) {
  return sharedAcceptanceState(record, allRecords, legacyApprovals, decisions);
}

function approvalPartsOf(value) {
  const parts = value?.approvedParts ?? value?.approved_parts;
  return refs(parts).map(part => part.toLowerCase());
}

function blockersOf(value) {
  return Array.isArray(value?.blockers) ? value.blockers.map(blocker => ({ id: blocker.id ?? null, reason: blocker.reason ?? 'Acceptance prerequisite is unresolved.' })) : [];
}

function scheduleApproved(acceptance) {
  return acceptance.scheduleApproved === true;
}

function normalizeAcceptance(record, allRecords, legacyApprovals, decisions, commitment) {
  const data = rawData(record);
  const legacyApproval = approvalManifestEntry(legacyApprovals, data.id);
  const resolved = acceptanceState(record, allRecords, legacyApprovals, decisions);
  const legacyApproved = resolved.legacyApproved === true;
  const legacyDecision = legacyApproved && legacyApproval?.decision
    ? decisions.find(candidate => rawData(candidate).id === legacyApproval.decision)
    : null;
  const approval = approvalView(data, legacyApproved ? legacyApproval : null, rawData(legacyDecision));
  const blockers = blockersOf(resolved);
  const state = commitment !== 'accepted' ? commitment : resolved.accepted && resolved.eligible ? 'accepted' : resolved.held ? 'held' : 'blocked';
  const approvedParts = [...new Set([...approval.parts, ...approvalPartsOf(resolved)])];
  approval.parts = approvedParts;
  if (!approval.state && resolved.approved === true) approval.state = 'approved';
  return {
    ...resolved,
    state,
    accepted: resolved.accepted === true,
    approved: resolved.approved === true,
    eligible: resolved.eligible === true,
    held: resolved.held === true,
    blockers,
    approvedParts,
    legacy: legacyApproved,
    legacyDecision: legacyApproved ? legacyApproval?.decision ?? null : null,
    approval,
    scheduleApproved: scheduleApproved(resolved)
  };
}

function itemRecord(record, relationships, progressByItem, allRecords, legacyApprovals, decisions) {
  const data = rawData(record);
  const { title, sections } = titleAndSections(record);
  const commitment = commitmentValue(data);
  const parent = refs(data.parent)[0] ?? null;
  const dependsOn = refs(data.depends_on);
  const completed = data.status === 'done' || data.status === 'completed' || data.status === 'archived' || isArchivedPath(record.path);
  const childIds = relationships.children.get(data.id) ?? [];
  const progress = isAccepted(data) ? (progressByItem.get(data.id) ?? { scoped: false, percent: null, milestones: [] }) : { scoped: false, percent: null, milestones: [] };
  const acceptance = normalizeAcceptance(record, allRecords, legacyApprovals, decisions, commitment);
  const approval = acceptance.approval ?? approvalView(data);
  const plan = textOrNull(data.plan);
  const schedule = scheduleFor(data, { approved: isAccepted(data) && acceptance.scheduleApproved, preserveProposed: !isAccepted(data) });
  return {
    id: data.id,
    title,
    type: data.type,
    status: data.status,
    phase: data.phase,
    owner: data.owner,
    ownerName: relationships.ownerNames.get(data.owner) ?? data.owner,
    parent,
    dependsOn,
    updatedAt: data.updated_at,
    completedAt: dateOrNull(data.completed_at),
    target: dateOrNull(data.target),
    bucket: humanBucket(record.path),
    archived: isArchivedPath(record.path),
    completed,
    commitment,
    plan,
    sourcePath: record.path,
    sections: {
      outcome: sections.outcome ?? '',
      completionCondition: sections['completion condition'] ?? '',
      nextStep: sections['next step'] ?? '',
      evidence: sections.evidence ?? '',
      blocker: textOrNull(data.blocker) ?? textOrNull(sections.blocker)
    },
    childIds,
    childSummary: {
      done: childIds.filter(childId => {
        const child = relationships.byId.get(childId);
        return child && isAccepted(child.data) && (child.data.status === 'done' || child.data.status === 'completed' || child.data.status === 'archived' || isArchivedPath(child.path));
      }).length,
      archived: childIds.filter(childId => {
        const child = relationships.byId.get(childId);
        return child && isAccepted(child.data) && isArchivedPath(child.path);
      }).length,
      total: childIds.filter(childId => {
        const child = relationships.byId.get(childId);
        return child && isAccepted(child.data);
      }).length
    },
    linked: {
      decisions: relationships.decisionsByItem.get(data.id) ?? [],
      releases: relationships.releasesByItem.get(data.id) ?? [],
      updates: relationships.updatesByItem.get(data.id) ?? []
    },
    progress: {
      scoped: Boolean(progress.scoped),
      percent: progress.scoped ? progress.percent : null,
      milestones: progress.milestones ?? []
    },
    health: healthFor(data),
    schedule,
    effort: effortFor(data),
    priority: {
      value: textOrNull(data.priority),
      rationale: textOrNull(data.priority_rationale)
    },
    proposal: buildProposal(data),
    approval,
    acceptance,
    blockers: acceptance.blockers
  };
}

function planRecord(record, relationships, itemsByPlan) {
  const { title, sections } = titleAndSections(record);
  const data = rawData(record);
  const taskIds = [...new Set(itemsByPlan.get(data.id) ?? [])]
    .filter(id => relationships.byId.has(id))
    .sort((a, b) => a.localeCompare(b));
  return {
    id: data.id,
    title,
    project: textOrNull(data.project),
    scope: textOrNull(data.scope) ?? textOrNull(data.project),
    status: data.status,
    owner: data.owner,
    ownerName: relationships.ownerNames.get(data.owner) ?? data.owner,
    revision: textOrNull(data.revision),
    approval: approvalView(data),
    sections,
    taskIds,
    sourcePath: record.path
  };
}

function capacityRecord(record, ownerNames) {
  const data = rawData(record);
  const weeklyDays = numberOrNull(data.weekly_days);
  const scheduledDays = numberOrNull(data.scheduled_days);
  const freeDays = weeklyDays !== null && scheduledDays !== null ? Math.max(0, weeklyDays - scheduledDays) : null;
  return {
    id: data.id,
    person: data.person,
    personName: ownerNames.get(data.person) ?? data.person,
    weeklyDays,
    scheduledDays,
    freeDays,
    overallocatedDays: weeklyDays !== null && scheduledDays !== null ? Math.max(0, scheduledDays - weeklyDays) : null,
    asOf: dateOrNull(data.as_of),
    provisional: booleanOrNull(data.provisional),
    source: textOrNull(data.source_ref),
    sourcePath: record.path,
    sections: extractSections(record.body)
  };
}

function mapByItem(records, predicate) {
  const output = new Map();
  for (const record of records) for (const itemId of predicate(record)) {
    if (!itemId) continue;
    const list = output.get(itemId) ?? [];
    list.push(record);
    output.set(itemId, list);
  }
  return output;
}

function historyRecord(record, relationships) {
  const data = rawData(record);
  const { title, sections } = titleAndSections(record);
  const supersededBy = textOrNull(data.superseded_by);
  const evidence = textOrNull(data.evidence_ref) ?? sections.evidence ?? '';
  return {
    id: data.id,
    title,
    type: data.type,
    status: data.status,
    owner: data.owner,
    ownerName: relationships.ownerNames.get(data.owner) ?? data.owner,
    parent: refs(data.parent)[0] ?? null,
    dependsOn: refs(data.depends_on),
    supersededBy,
    replacementId: supersededBy,
    updatedAt: data.updated_at,
    completedAt: dateOrNull(data.completed_at),
    sourcePath: record.path,
    sections: {
      outcome: sections.outcome ?? '',
      completionCondition: sections['completion condition'] ?? '',
      nextStep: sections['next step'] ?? '',
      evidence
    },
    evidence,
    approval: approvalView(data),
    schedule: scheduleFields(data)
  };
}

function migrationRecord(record) {
  if (!record || typeof record !== 'object') return record;
  if (!record.data) return record;
  const { title, sections } = titleAndSections(record);
  return { id: record.data.id, title, path: record.path, ...record.data, sections };
}

function mergeItemRecords(records) {
  return records.items ?? [];
}

export function buildTrackerData(records, source = {}) {
  const itemsRecords = mergeItemRecords(records);
  const byId = new Map(itemsRecords.map(record => [rawData(record).id, record]));
  const children = new Map();
  for (const record of itemsRecords) {
    const data = rawData(record);
    const parent = refs(data.parent)[0];
    if (!parent) continue;
    const list = children.get(parent) ?? [];
    list.push(data.id);
    children.set(parent, list);
  }
  for (const list of children.values()) list.sort((a, b) => a.localeCompare(b));

  const ownerNames = source.ownerNames ?? new Map();
  const rawDecisions = records.decisions ?? [];
  const decisions = rawDecisions.map(record => decisionRecord(record, ownerNames)).sort((a, b) => a.id.localeCompare(b.id));
  const releases = (records.releases ?? []).map(record => {
    const data = rawData(record);
    return compactRecord(record, {
      project: data.project,
      owner: data.owner,
      ownerName: ownerNames.get(data.owner) ?? data.owner,
      status: data.status ?? null,
      target: dateOrNull(data.target),
      sourcePath: record.path
    });
  }).sort((a, b) => a.id.localeCompare(b.id));
  const updates = (records.updates ?? []).map(record => {
    const data = rawData(record);
    return compactRecord(record, {
      item: data.item,
      source: data.source,
      observedAt: data.observed_at,
      occurredAt: data.occurred_at ?? null,
      activityKind: data.activity_kind ?? null,
      activitySummary: data.activity_summary ?? null,
      attributionBasis: data.attribution_basis ?? null,
      evidenceRef: data.evidence_ref ?? null,
      targetUpdate: data.target_update ?? null,
      activityAction: data.activity_action ?? null,
      supersedesUpdate: data.supersedes_update ?? null,
      approvalDecision: data.approval_decision ?? null,
      activityItem: data.activity_item ?? null,
      sourcePath: record.path
    }, { title: firstHeading(record?.body, record?.data?.id ?? 'untitled'), sections: extractUpdateSections(record?.body) });
  }).sort((a, b) => `${a.item}/${a.id}`.localeCompare(`${b.item}/${b.id}`));
  const activityEvidence = normalizeActivityEvidence(records);

  const decisionLinks = decisions.map(({ body, sections, ...summary }) => summary);
  const decisionsByItem = mapByItem(decisionLinks, record => record.affects);
  const releasesByItem = mapByItem(releases, record => [record.project]);
  const updatesByItem = mapByItem(updates, record => [record.item]);
  const relationships = { byId, children, decisionsByItem, releasesByItem, updatesByItem, ownerNames };
  const plansRecords = records.plans ?? [];
  const milestones = records.milestones ?? [];
  const progressByItem = new Map(itemsRecords.map(record => {
    const data = rawData(record);
    return [data.id, deriveProgress(data.id, milestones, plansRecords)];
  }));
  const legacyApprovals = records.legacyApprovals ?? {};
  const plansByTask = new Map();
  for (const record of itemsRecords) {
    const data = rawData(record);
    const plan = textOrNull(data.plan);
    if (plan) {
      const list = plansByTask.get(data.id) ?? [];
      if (!list.includes(plan)) list.push(plan);
      plansByTask.set(data.id, list);
    }
  }
  const itemsByPlan = new Map();
  for (const [taskId, planIds] of plansByTask) for (const planId of planIds) {
    const list = itemsByPlan.get(planId) ?? [];
    list.push(taskId);
    itemsByPlan.set(planId, list);
  }
  const items = itemsRecords.map(record => itemRecord(record, relationships, progressByItem, itemsRecords, legacyApprovals, rawDecisions)).sort((a, b) => a.id.localeCompare(b.id));
  const rootIds = items.filter(item => !item.parent).map(item => item.id);
  const rootsByBucket = new Map();
  for (const rootId of rootIds) {
    const item = byId.get(rootId);
    const bucket = humanBucket(item.path);
    const list = rootsByBucket.get(bucket) ?? [];
    list.push(rootId);
    rootsByBucket.set(bucket, list);
  }
  for (const list of rootsByBucket.values()) list.sort((a, b) => a.localeCompare(b));

  const plans = plansRecords.map(record => planRecord(record, relationships, itemsByPlan)).sort((a, b) => a.id.localeCompare(b.id));
  const deliveryRecords = normalizeDeliveryRecords(records);
  const people = (records.people ?? []).map(person => {
    const aliases = [...new Set((Array.isArray(person.aliases) ? person.aliases : [])
      .map(textOrNull)
      .filter(alias => alias && !alias.includes('@') && !/^https?:\/\//i.test(alias)))];
    return {
      id: String(person.id),
      name: String(person.name ?? person.id),
      fullName: textOrNull(person.fullName),
      status: String(person.status ?? 'inactive'),
      githubHandle: textOrNull(person.githubHandle),
      avatar: textOrNull(person.avatar),
      ...(aliases.length ? { aliases } : {}),
    };
  }).sort((left, right) => left.id.localeCompare(right.id));
  const capacities = (records.capacities ?? []).map(record => capacityRecord(record, ownerNames)).sort((a, b) => a.id.localeCompare(b.id));
  const history = (records.history ?? []).map(record => historyRecord(record, relationships)).sort((a, b) => a.id.localeCompare(b.id));
  const migrations = (records.migrations ?? []).map(migrationRecord);
  return {
    schemaVersion: 4,
    source: {
      commit: source.commit ?? 'unknown',
      shortCommit: source.commit && source.commit !== 'unknown' ? source.commit.slice(0, 10) : 'unknown',
      committedAt: source.committedAt ?? null,
      dirty: Boolean(source.dirty),
      builtAt: source.builtAt ?? new Date().toISOString()
    },
    defaultExpanded: byId.has('project-alpha') ? ['project-alpha'] : [],
    bucketOrder: ['product', 'platform', 'operations', 'gtm', 'other'],
    rootsByBucket: Object.fromEntries([...rootsByBucket.entries()]),
    items,
    plans,
    deliveryRecords,
    people,
    history,
    migrations,
    capacities,
    decisions,
    releases,
    updates,
    activityEvidence
  };
}
