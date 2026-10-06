/**
 * @typedef {import('./work-manager-types').BuildManagerProjectionInput} BuildManagerProjectionInput
 * @typedef {import('./work-manager-types').ManagerProjection} ManagerProjection
 * @typedef {import('./work-manager-types').SelectManagerMatchesInput} SelectManagerMatchesInput
 * @typedef {import('./work-activity-types').NormalizedWorkEvidence} NormalizedWorkEvidence
 */

const UNASSIGNED_PERSON_ID = '__unassigned__';
const COMPLETED_STATUSES = new Set(['done', 'completed', 'archived']);
const EXECUTOR_KINDS = new Set(['human', 'agent', 'codex-handoff']);
const PLACEHOLDERS = new Set(['', '-', 'tbd', 'unknown', 'unset', 'placeholder', 'n/a']);
const ROLE_ORDER = new Map([['dri', 0], ['executor', 1], ['observed', 2]]);

function text(value) {
  const result = String(value ?? '').trim();
  return result && result !== '-' ? result : null;
}

function key(value) {
  return text(value)?.toLocaleLowerCase() ?? null;
}

function statusOf(item) {
  return key(item?.status ?? item?.data?.status) ?? 'unknown';
}

function commitmentOf(item) {
  return key(item?.commitment ?? item?.data?.commitment);
}

function isCompleted(item) {
  return item?.completed === true || item?.archived === true || COMPLETED_STATUSES.has(statusOf(item));
}

function isTask(item) {
  return key(item?.type ?? item?.data?.type) === 'task';
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === '') return [];
  return [value];
}

function normalizePeople(people) {
  const list = Array.isArray(people) ? people : Array.isArray(people?.people) ? people.people : [];
  const profiles = list.filter(person => person && text(person.id)).map(person => ({
    ...person,
    id: text(person.id),
    active: key(person.status) === 'active',
    identityNames: [text(person.name), text(person.fullName)].filter(Boolean),
    name: text(person.fullName) ?? text(person.name) ?? text(person.id),
  }));
  const byIdentity = new Map();
  const byCanonicalId = new Map();
  for (const person of profiles) {
    const canonicalMatches = byCanonicalId.get(person.id) ?? [];
    canonicalMatches.push(person);
    byCanonicalId.set(person.id, canonicalMatches);

    const identities = new Set([
      person.id,
      person.githubHandle,
      person.handle,
      ...person.identityNames,
      ...(Array.isArray(person.aliases) ? person.aliases : []),
    ].map(key).filter(Boolean));
    for (const normalized of identities) {
      const matches = byIdentity.get(normalized) ?? [];
      matches.push(person);
      byIdentity.set(normalized, matches);
    }
  }
  return {
    profiles,
    activeProfiles: profiles.filter(person => person.active),
    resolve(value) {
      const exactId = text(value);
      if (!exactId) return null;
      const canonicalMatches = byCanonicalId.get(exactId);
      if (canonicalMatches) return canonicalMatches.length === 1 ? canonicalMatches[0] : null;

      const matches = byIdentity.get(key(exactId)) ?? [];
      return matches.length === 1 ? matches[0] : null;
    },
  };
}

function latestRecord(records) {
  return [...records].sort((left, right) => {
    const leftTime = Date.parse(left?.updatedAt ?? '') || 0;
    const rightTime = Date.parse(right?.updatedAt ?? '') || 0;
    return rightTime - leftTime || String(left?.id ?? '').localeCompare(String(right?.id ?? ''));
  })[0] ?? null;
}

function sectionValue(sections, name) {
  const normalized = Object.fromEntries(Object.entries(sections ?? {}).map(([section, value]) => [
    String(section).trim().toLocaleLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' '),
    value,
  ]));
  const result = text(normalized[name]);
  return result && !PLACEHOLDERS.has(result.toLocaleLowerCase()) ? result : null;
}

function actionableBrief(brief) {
  return Boolean(brief) && [
    'outcome', 'context', 'completion evidence', 'dependencies', 'next action', 'handoff',
  ].every(section => sectionValue(brief.sections, section) !== null);
}

function approvedParts(item) {
  const value = item?.acceptance?.approvedParts;
  return new Set(asArray(value).flatMap(part => String(part).split(',')).map(key).filter(Boolean));
}

function acceptedScope(item) {
  return commitmentOf(item) === 'accepted'
    && item?.acceptance?.accepted === true
    && item?.acceptance?.approved === true;
}

function ownerValue(item) {
  return key(item?.owner ?? item?.data?.owner);
}

function hasApprovedDri(item) {
  return acceptedScope(item) && approvedParts(item).has('assignment')
    && Boolean(ownerValue(item)) && ownerValue(item) !== 'unassigned';
}

function sourceBackedDiscovery(discovery) {
  return discovery?.attribution === 'clear' && Boolean(text(discovery?.observedExecutor))
    && (asArray(discovery?.sourceRefs).some(text) || asArray(discovery?.evidenceIds).some(text));
}

function ownMovement(activityProjection, itemId) {
  const own = activityProjection?.get?.(itemId)?.own;
  return {
    state: own?.state === 'recent' || own?.state === 'quiet' ? own.state : 'unknown',
    summary: text(own?.summary),
    date: text(own?.lastDate),
  };
}

function decisionReferences(deliveryRecords, decisions, item) {
  const ids = new Set();
  for (const decision of Array.isArray(decisions) ? decisions : []) {
    if (asArray(decision?.affects).map(String).includes(item.id)) ids.add(decision.id);
  }
  for (const value of asArray(item?.linked?.decisions)) {
    const id = typeof value === 'object' ? value?.id : value;
    if (text(id)) ids.add(String(id));
  }
  for (const record of Array.isArray(deliveryRecords) ? deliveryRecords : []) {
    if (record?.itemId !== item.id) continue;
    for (const id of [record.priorityDecision, record.assignmentDecision, record.nextDecision, record.approvalDecision]) {
      if (text(id)) ids.add(String(id));
    }
  }
  const byId = new Map((Array.isArray(decisions) ? decisions : []).map(decision => [decision.id, decision]));
  return [...ids].map(id => byId.get(id)).filter(Boolean);
}

function decisionView(decision, peopleIndex) {
  const owner = peopleIndex.resolve(decision?.owner);
  const ownerId = owner?.id ?? (['don', 'owner'].includes(key(decision?.owner)) ? 'don' : null);
  return {
    id: String(decision.id),
    title: text(decision.title) ?? String(decision.id),
    state: key(decision.state) ?? 'unknown',
    question: sectionValue(decision.sections, 'question') ?? text(decision.title) ?? String(decision.id),
    recommendation: sectionValue(decision.sections, 'recommendation')
      ?? sectionValue(decision.sections, 'decision and rationale')
      ?? sectionValue(decision.sections, 'current state'),
    source: text(decision.sourcePath ?? decision.path ?? decision.approvalRef),
    owner: ownerId,
  };
}

function executorDisplay(brief, peopleIndex) {
  if (!brief) return null;
  const kind = key(brief.executorKind);
  if (kind === 'human') return peopleIndex.resolve(brief.executorRef)?.name ?? text(brief.executorRef);
  if (kind === 'agent') return 'Agent';
  if (kind === 'codex-handoff') return 'Codex handoff';
  return null;
}

function approvedExecutorAssignment(brief) {
  return Boolean(brief && brief.approved === true
    && EXECUTOR_KINDS.has(key(brief.executorKind)) && text(brief.executorRef));
}

function dependencyState(item, byItemId) {
  const dependencies = asArray(item?.dependsOn ?? item?.depends_on ?? item?.data?.depends_on)
    .flatMap(value => String(value).split(',')).map(text).filter(Boolean);
  const missing = [];
  const incomplete = [];
  for (const dependencyId of new Set(dependencies)) {
    const dependency = byItemId.get(dependencyId);
    if (!dependency) missing.push(dependencyId);
    else if (!isCompleted(dependency)) incomplete.push(dependencyId);
  }
  return { missing, incomplete };
}

function makeReadiness(item, brief, byItemId) {
  if (!isTask(item)) return { readiness: 'not-assessed', reasons: ['This hierarchy row is context, not a task.'] };
  if (isCompleted(item)) return { readiness: 'not-assessed', reasons: ['Completed work is outside readiness assessment.'] };
  const commitment = commitmentOf(item);
  if (commitment !== 'accepted') {
    if (!brief || !commitment) {
      return {
        readiness: 'not-assessed',
        reasons: [
          commitment ? 'Task scope is not accepted.' : 'Task commitment is not recorded.',
          ...(!brief ? ['No delivery brief is recorded.'] : []),
        ],
      };
    }
    return {
      readiness: 'waiting',
      reasons: [
        'Task scope is not accepted.',
        ...(!actionableBrief(brief) ? ['The delivery brief needs required content.'] : []),
      ],
    };
  }

  const reasons = [];
  const missing = [];
  const acceptance = item?.acceptance;
  if (acceptance?.accepted !== true || acceptance?.approved !== true) {
    if (acceptance?.accepted === false || acceptance?.approved === false) reasons.push('Accepted scope is held or lacks approval in the tracker.');
    else missing.push('Acceptance evidence is missing.');
  }

  const driApproved = hasApprovedDri(item);
  const executorApproved = approvedExecutorAssignment(brief);
  if (!driApproved && !executorApproved) {
    if (acceptance && (approvedParts(item).has('assignment') || ownerValue(item) === 'unassigned')) {
      reasons.push('No approved task assignment is recorded.');
    } else {
      missing.push('Task assignment approval metadata is missing.');
    }
  }

  if (!brief) {
    missing.push('No delivery brief is recorded.');
  } else {
    if (!actionableBrief(brief)) reasons.push('The delivery brief needs required content.');
    if (!EXECUTOR_KINDS.has(key(brief.executorKind)) || !text(brief.executorRef)) {
      missing.push('The delivery brief does not identify a supported executor.');
    }
  }

  const dependencies = dependencyState(item, byItemId);
  if (dependencies.missing.length) missing.push(`Dependency records are missing: ${dependencies.missing.join(', ')}.`);
  if (dependencies.incomplete.length) reasons.push(`Dependencies are incomplete: ${dependencies.incomplete.join(', ')}.`);

  if (missing.length) return { readiness: 'not-assessed', reasons: [...reasons, ...missing] };
  if (reasons.length) return { readiness: 'waiting', reasons };
  return { readiness: 'ready', reasons: [] };
}

function coordinationGaps(coordinations) {
  const gaps = [];
  for (const coordination of coordinations) {
    const id = text(coordination.id) ?? 'coordination record';
    const state = key(coordination.dispatchState);
    const reasons = [];
    if (coordination.messageApproved !== true) reasons.push('Don approval is outstanding.');
    if (state === 'draft') reasons.push('The message remains a draft.');
    else if (state === 'uncertain') reasons.push('Delivery is uncertain; check the receipt before retrying.');
    else if (state === 'failed') reasons.push('Delivery failed and needs resolution.');
    else if (state === 'sent' && !text(coordination.deliveryRef)) {
      reasons.push('The sent message lacks delivery proof.');
    } else if (!['draft', 'uncertain', 'failed', 'sent'].includes(state)) {
      reasons.push('Delivery state is unknown.');
    }
    if (reasons.length) gaps.push(`Coordination ${id}: ${reasons.join(' ')}`);
  }
  return gaps;
}

function sourceBackedResults(item, activityEvidence, activityProjection) {
  const projectedEvidenceIds = activityProjection?.get?.(item.id)?.own?.evidenceIds;
  const projectedIds = Array.isArray(projectedEvidenceIds) ? new Set(projectedEvidenceIds.map(String)) : null;
  return (Array.isArray(activityEvidence) ? activityEvidence : []).filter(evidence => {
    const occurredAt = text(evidence?.occurredAt);
    const dated = occurredAt !== null && Number.isFinite(Date.parse(occurredAt));
    return evidence?.included === true
      && key(evidence?.kind) === 'result'
      && text(evidence?.itemId) === item.id
      && dated
      && (!projectedIds || projectedIds.has(String(evidence.id)));
  });
}

function pendingVerificationMilestones(item) {
  const milestones = asArray(item?.progress?.milestones);
  return milestones.filter(milestone => {
    if (key(milestone?.status) === 'needs-reverification') return true;
    if (key(milestone?.status) !== 'complete') return false;
    return ['pending', 'not-done', 'later', 'needs-reverification'].includes(key(milestone?.confirmation?.state))
      || milestone?.confirmed === false;
  });
}

function verificationGaps(item, activityEvidence, activityProjection) {
  const reported = pendingVerificationMilestones(item);
  if (reported.length) {
    const ids = reported.map(milestone => text(milestone?.id)).filter(Boolean);
    const suffix = ids.length ? ` (${ids.join(', ')})` : '';
    return [`Reported completion is awaiting verification${suffix}.`];
  }

  if (!sourceBackedResults(item, activityEvidence, activityProjection).length) return [];
  const progress = item?.progress;
  const milestones = asArray(progress?.milestones);
  const includedMilestones = milestones.filter(milestone => milestone?.included === true);
  const verified = progress?.allVerified === true
    || (progress?.scoped === true && includedMilestones.length > 0
      && includedMilestones.every(milestone => milestone?.confirmed === true));
  if (verified || (progress?.scoped === true && includedMilestones.length > 0)) return [];
  return ['A source-backed result needs a verification assessment.'];
}

function taskGaps(item, brief, discoveries, coordinations, byItemId, activityEvidence, activityProjection) {
  if (!isTask(item) || isCompleted(item) || commitmentOf(item) !== 'accepted') return [];
  const gaps = [];
  if (!acceptedScope(item)) gaps.push('Acceptance evidence is missing, unapproved, or held.');
  if (!hasApprovedDri(item)) {
    gaps.push(approvedExecutorAssignment(brief)
      ? 'No approved human DRI is recorded; accountability remains unassigned.'
      : 'No approved task assignment is recorded.');
  }
  if (!brief) gaps.push('No delivery brief is recorded.');
  else if (!actionableBrief(brief)) gaps.push('The delivery brief has missing or placeholder content.');
  if (!hasApprovedDri(item) && !approvedExecutorAssignment(brief)) gaps.push('No executor assignment is approved.');
  if (brief?.nextApproved !== true) gaps.push('Queue is not explicitly sequenced.');
  const dependencies = dependencyState(item, byItemId);
  if (dependencies.missing.length) gaps.push(`Dependency records are missing: ${dependencies.missing.join(', ')}.`);
  if (dependencies.incomplete.length) gaps.push(`Dependencies are incomplete: ${dependencies.incomplete.join(', ')}.`);
  if (discoveries.some(discovery => discovery?.approved !== true)) gaps.push('A discovery is awaiting priority review.');
  gaps.push(...coordinationGaps(coordinations));
  gaps.push(...verificationGaps(item, activityEvidence, activityProjection));
  return [...new Set(gaps)];
}

function addRole(roles, personId, role) {
  if (!personId || roles.some(entry => entry.personId === personId && entry.role === role)) return;
  roles.push({ personId, role });
}

function projectionEntry({ item, activityProjection, activityEvidence, deliveryRecords, decisions, peopleIndex, byItemId }) {
  const itemRecords = (Array.isArray(deliveryRecords) ? deliveryRecords : []).filter(record => record?.itemId === item.id);
  const brief = latestRecord(itemRecords.filter(record => record.type === 'brief'));
  const discoveries = itemRecords.filter(record => record.type === 'discovery');
  const coordinations = itemRecords.filter(record => record.type === 'coordination');
  const decisionViews = decisionReferences(itemRecords, decisions, item)
    .map(decision => decisionView(decision, peopleIndex))
    .sort((left, right) => left.id.localeCompare(right.id));
  const movement = ownMovement(activityProjection, item.id);
  const completed = isCompleted(item);
  const status = statusOf(item);
  const current = !completed && (movement.state === 'recent' || status === 'active' || status === 'blocked');
  const upcoming = !completed && !current && status === 'queued';
  const readiness = makeReadiness(item, brief, byItemId);
  const roles = [];

  if (hasApprovedDri(item)) {
    const person = peopleIndex.resolve(item.owner);
    if (person?.active) addRole(roles, person.id, 'dri');
  }
  if (brief?.approved === true && key(brief.executorKind) === 'human') {
    const person = peopleIndex.resolve(brief.executorRef);
    if (person?.active) addRole(roles, person.id, 'executor');
  }
  for (const discovery of discoveries) {
    if (!sourceBackedDiscovery(discovery)) continue;
    const person = peopleIndex.resolve(discovery.observedExecutor);
    if (person?.active) addRole(roles, person.id, 'observed');
  }
  roles.sort((left, right) => left.personId.localeCompare(right.personId)
    || (ROLE_ORDER.get(left.role) ?? 99) - (ROLE_ORDER.get(right.role) ?? 99));

  return {
    id: item.id,
    parentId: text(item.parent ?? item.parentId ?? item.parent_id),
    type: key(item.type ?? item.data?.type),
    accepted: acceptedScope(item),
    unfinished: !completed,
    personRoles: roles,
    current,
    upcoming,
    readiness: readiness.readiness,
    reasons: readiness.reasons,
    unreviewed: discoveries.some(discovery => discovery?.approved !== true),
    briefId: text(brief?.id),
    executor: executorDisplay(brief, peopleIndex),
    executorApproved: approvedExecutorAssignment(brief),
    nextApproved: brief?.nextApproved === true,
    gaps: taskGaps(item, brief, discoveries, coordinations, byItemId, activityEvidence, activityProjection),
    decisions: decisionViews,
    movement,
    driUnassigned: isTask(item) && !hasApprovedDri(item),
  };
}

function emptyCoverageRow(personId, personName) {
  return {
    personId,
    personName,
    taskTypeCounts: { task: 0 },
    movingIds: [],
    quietIds: [],
    unknownCurrentIds: [],
    readyIds: [],
    waitingIds: [],
    notAssessedIds: [],
    unreviewedIds: [],
    counts: {
      tasks: 0,
      moving: 0,
      quiet: 0,
      unknownCurrent: 0,
      ready: 0,
      waiting: 0,
      notAssessed: 0,
      unreviewed: 0,
    },
  };
}

function isOpenTaskEntry(entry) {
  return entry?.type === 'task' && entry.unfinished === true;
}

function addCoverage(row, entry) {
  if (!row || !isOpenTaskEntry(entry)) return;
  row.taskIds ??= [];
  if (!row.taskIds.includes(entry.id)) row.taskIds.push(entry.id);
  row.taskTypeCounts.task += 1;
  if (entry.current && entry.movement.state === 'recent') row.movingIds.push(entry.id);
  if (entry.current && entry.movement.state === 'quiet') row.quietIds.push(entry.id);
  if (entry.current && entry.movement.state === 'unknown') row.unknownCurrentIds.push(entry.id);
  if (entry.upcoming && entry.readiness === 'ready') row.readyIds.push(entry.id);
  if (entry.readiness === 'waiting') row.waitingIds.push(entry.id);
  if (entry.readiness === 'not-assessed') row.notAssessedIds.push(entry.id);
  if (entry.unreviewed) row.unreviewedIds.push(entry.id);
}

function finalizeCoverage(row) {
  const fields = ['taskIds', 'movingIds', 'quietIds', 'unknownCurrentIds', 'readyIds', 'waitingIds', 'notAssessedIds', 'unreviewedIds'];
  for (const field of fields) row[field] = [...new Set(row[field] ?? [])].sort((left, right) => left.localeCompare(right));
  row.counts = {
    tasks: row.taskIds.length,
    moving: row.movingIds.length,
    quiet: row.quietIds.length,
    unknownCurrent: row.unknownCurrentIds.length,
    ready: row.readyIds.length,
    waiting: row.waitingIds.length,
    notAssessed: row.notAssessedIds.length,
    unreviewed: row.unreviewedIds.length,
  };
  delete row.taskIds;
  return row;
}

/**
 * Build a pure, view-independent manager projection over the supplied scope.
 * @param {BuildManagerProjectionInput} [input]
 * @returns {ManagerProjection}
 */
export function buildManagerProjection({
  items = [],
  activityProjection = new Map(),
  activityEvidence = [],
  deliveryRecords = [],
  decisions = [],
  people = [],
  scopeIds,
} = {}) {
  const inputItems = Array.isArray(items) ? items.filter(item => text(item?.id)) : [];
  const byItemId = new Map(inputItems.map(item => [String(item.id), item]));
  const peopleIndex = normalizePeople(people);
  const byId = new Map(inputItems.map(item => [String(item.id), projectionEntry({
    item,
    activityProjection,
    activityEvidence,
    deliveryRecords,
    decisions,
    peopleIndex,
    byItemId,
  })]));

  const coverageByPerson = new Map(peopleIndex.activeProfiles.map(person => [
    person.id,
    emptyCoverageRow(person.id, person.name),
  ]));
  coverageByPerson.set(UNASSIGNED_PERSON_ID, emptyCoverageRow(UNASSIGNED_PERSON_ID, 'Unassigned'));

  const inScopeIds = scopeIds === undefined ? null : new Set([...scopeIds].map(String));
  for (const entry of byId.values()) {
    if (inScopeIds && !inScopeIds.has(entry.id)) continue;
    if (!isOpenTaskEntry(entry)) continue;
    const rowIds = new Set(entry.personRoles.map(role => role.personId));
    if (entry.driUnassigned) rowIds.add(UNASSIGNED_PERSON_ID);
    for (const personId of rowIds) addCoverage(coverageByPerson.get(personId), entry);
  }

  return { byId, coverage: [...coverageByPerson.values()].map(finalizeCoverage) };
}

function isNeedsMeEntry(entry) {
  return entry.decisions.some(decision => decision.state === 'proposed' && decision.owner === 'don');
}

function matchesPreset(entry, preset) {
  if (preset === 'team') return entry.type === 'task' && entry.unfinished && (entry.current || entry.upcoming);
  if (preset === 'moving') return ['task', 'project', 'workstream'].includes(entry.type)
    && entry.unfinished && entry.movement.state === 'recent';
  if (preset === 'delivery') return entry.type === 'task' && ((entry.accepted && entry.unfinished) || entry.unreviewed);
  if (preset === 'needs-me') return isNeedsMeEntry(entry);
  return entry.type === 'task';
}

function selectedPeople(values) {
  return new Set(asArray(values)
    .flatMap(value => String(value ?? '').split(','))
    .map(value => key(value) === 'unassigned' ? UNASSIGNED_PERSON_ID : key(value))
    .filter(Boolean));
}

function matchesPeople(entry, selected) {
  if (selected.size === 0) return true;
  return entry.personRoles.some(role => selected.has(key(role.personId)))
    || (entry.driUnassigned && selected.has(UNASSIGNED_PERSON_ID));
}

/**
 * Return only directly matching task IDs; the caller restores ancestor context.
 * @param {SelectManagerMatchesInput} [input]
 * @returns {Set<string>}
 */
export function selectManagerMatches({ managerProjection, preset = 'none', people = [] } = {}) {
  const byId = managerProjection?.byId instanceof Map ? managerProjection.byId : new Map();
  const selected = selectedPeople(people);
  const normalizedPreset = ['none', 'team', 'moving', 'delivery', 'needs-me'].includes(key(preset))
    ? key(preset)
    : 'none';
  const matches = new Set();
  for (const [id, entry] of byId) {
    if (matchesPreset(entry, normalizedPreset) && matchesPeople(entry, selected)) matches.add(id);
  }
  return matches;
}
