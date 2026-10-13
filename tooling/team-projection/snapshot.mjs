/**
 * Adapt the validated public team projection to the existing viewer snapshot
 * shape. The adapter deliberately leaves canonical-only collections empty and
 * does not synthesize approval, decision, history, or publication records.
 */
import { taskCodeForId, taskCodeIndex } from '../tracker/task-codes.mjs';

const EMPTY_SOURCE_DIGEST = `sha256:${'0'.repeat(64)}`;

function safeActivityEvidence(companion) {
  if (companion?.staleActivity === true || !Array.isArray(companion?.activitySummaries)) return [];
  return companion.activitySummaries
    .filter(summary => Number.isInteger(summary?.eventCount) && summary.eventCount > 0 && typeof summary.latestOccurredAt === 'string')
    .map(summary => ({
      id: `team-activity-summary-${summary.taskId}`,
      originalItemId: summary.taskId,
      originalUpdateId: null,
      itemId: summary.taskId,
      sourceEventId: null,
      occurredAt: summary.latestOccurredAt,
      discoveredAt: summary.latestOccurredAt,
      kind: 'work',
      summary: `${summary.eventCount} team activity event${summary.eventCount === 1 ? '' : 's'} recorded`,
      attributionBasis: 'team-safe-activity-summary',
      evidenceRef: null,
      included: true,
      amendmentIds: [],
      approvalDecisionIds: [],
    }));
}

export function buildTeamProjectionSnapshot(projection, source = {}, companion = null) {
  const initialized = projection.sourcePlanDigest !== EMPTY_SOURCE_DIGEST || projection.tasks.length > 0;
  const directory = Array.isArray(companion?.directory) ? companion.directory : [];
  const directoryById = new Map(directory.map(entry => [entry.id, entry]));
  const metadataByTaskId = new Map((Array.isArray(companion?.taskMetadata) ? companion.taskMetadata : []).map(entry => [entry.taskId, entry]));
  const activityByTaskId = new Map((Array.isArray(companion?.activitySummaries) ? companion.activitySummaries : []).map(entry => [entry.taskId, entry]));
  const companionSchedulesAreAuthoritative = companion?.kind === 'team-safe-companion'
    && companion.directoryOnly !== true
    && companion.staleSchedule === false
    && Array.isArray(companion.schedules);
  const schedulesByTaskId = new Map((companionSchedulesAreAuthoritative ? companion.schedules : []).map(entry => [entry.taskId, entry]));
  const teamProfiles = directory.map(entry => ({
    id: entry.id,
    slug: entry.id,
    handle: entry.id,
    name: entry.displayName,
    fullName: entry.displayName,
    aliases: [],
    githubHandle: null,
    avatar: entry.avatar,
    avatarUrl: entry.avatar ? `/avatars/${entry.avatar}` : null,
    status: 'projected',
    organizationIds: [],
    organizations: [],
    verifiedLabel: true,
  }));
  const contextNodes = new Map();
  for (const node of projection.contextNodes ?? []) {
    const existing = contextNodes.get(node.id);
    if (existing) throw new Error(`duplicate context node ID ${node.id}`);
    contextNodes.set(node.id, node);
  }
  const referenceCodes = new Map([...taskCodeIndex([
    ...projection.tasks.map(task => task.taskId),
    ...contextNodes.keys(),
  ])].map(([code, id]) => [id, code]));

  const sharedItem = ({ id, title, type, status, owner = null, ownerName = null, parent = null, contextOnly = false, metadata = null, activitySummary = null }) => ({
    id,
    referenceCode: referenceCodes.get(id) ?? taskCodeForId(id),
    title: title ?? id,
    type,
    status,
    phase: metadata?.phase ?? null,
    owner,
    ownerName: ownerName ?? owner,
    parent,
    dependsOn: [],
    updatedAt: null,
    completedAt: null,
    target: null,
    bucket: 'other',
    archived: false,
    completed: !contextOnly && status === 'done',
    commitment: metadata?.commitment ?? null,
    activitySummary,
    plan: null,
    sourcePath: null,
    sections: {
      outcome: '',
      completionCondition: '',
      nextStep: '',
      evidence: '',
      reviewer: '',
      checkpoint: '',
      dependencies: '',
      blocker: null,
    },
    teamProjection: contextOnly ? { contextOnly: true } : null,
    childIds: [],
    childSummary: { done: 0, archived: 0, total: 0 },
    linked: { decisions: [], releases: [], updates: [] },
    progress: { scoped: false, percent: null, milestones: [] },
    health: {
      state: metadata?.healthState ?? 'unknown',
      reason: contextOnly ? 'Structural context only.' : 'Team projection has no health assessment.',
      missingInformation: contextOnly ? 'Only structural context is shared.' : 'Health evidence is outside this projection.',
      suggestedAction: contextOnly ? 'Select a shared task to view actionable work.' : 'Coordinate the next step with the assigned owner.',
      actor: 'team',
      reviewedAt: null,
    },
    schedule: {
      plannedStart: null,
      plannedEnd: null,
      forecastStart: null,
      forecastEndMin: null,
      forecastEndMax: null,
      provisional: true,
      approved: false,
    },
    effort: { min: null, max: null, remainingMin: null, remainingMax: null },
    priority: { value: null, rationale: null },
    proposal: null,
    approval: {},
    acceptance: { state: contextOnly ? 'team-projection-context' : 'team-projection', accepted: false, approved: false, eligible: false, held: false, blockers: [] },
    blockers: [],
    ...(contextOnly ? { contextOnly: true } : {}),
  });

  const items = projection.tasks.map(task => {
    const evidence = task.evidenceLinks.join('\n');
    const metadata = metadataByTaskId.get(task.taskId) ?? null;
    const schedule = schedulesByTaskId.get(task.taskId) ?? null;
    const plannedStart = schedule?.approvedStart ?? null;
    // A validated companion is an allowlist: omitted tasks have no current
    // approved endpoint. Keep the anchored projection deadline only for the
    // legacy path where no companion supplied an authoritative schedule set.
    const plannedEnd = schedule?.approvedEnd ?? (companionSchedulesAreAuthoritative ? null : task.approvedDate ?? null);
    const approvedDate = companionSchedulesAreAuthoritative ? plannedEnd : task.approvedDate ?? null;
    const forecastEnd = task.forecastDate ?? null;
    const ownerProfile = directoryById.get(task.assignee);
    return {
      ...sharedItem({
        id: task.taskId,
        title: task.title,
        type: 'task',
        status: task.status,
        owner: task.assignee ?? null,
        ownerName: ownerProfile?.displayName ?? task.assignee ?? null,
        parent: task.parentId ?? null,
        metadata,
        activitySummary: activityByTaskId.get(task.taskId) ?? null,
      }),
      target: plannedEnd,
      sections: {
        outcome: task.scope ?? '',
        completionCondition: task.completionCondition ?? '',
        nextStep: task.nextStep ?? '',
        evidence,
        reviewer: task.reviewer ?? '',
        checkpoint: task.checkpoint ?? '',
        dependencies: task.dependencies.map(({ summary }) => summary).join('\n'),
        blocker: task.status === 'blocked' ? (task.nextStep ?? 'Blocked') : null,
      },
      teamProjection: {
        taskId: task.taskId,
        assignee: task.assignee ?? null,
        reviewer: task.reviewer ?? null,
        approvedDate,
        approvedStart: plannedStart,
        approvedEnd: plannedEnd,
        commitment: metadata?.commitment ?? null,
        phase: metadata?.phase ?? null,
        healthState: metadata?.healthState ?? null,
        forecastDate: task.forecastDate ?? null,
        checkpoint: task.checkpoint ?? null,
        dependencies: task.dependencies.map(({ summary }) => summary),
        evidenceLinks: [...task.evidenceLinks],
        parentId: task.parentId ?? null,
      },
      schedule: {
        plannedStart,
        plannedEnd,
        forecastStart: null,
        forecastEndMin: forecastEnd,
        forecastEndMax: forecastEnd,
        provisional: plannedEnd === null,
        approved: plannedEnd !== null,
      },
      blockers: task.status === 'blocked' ? [{ id: task.taskId, reason: task.nextStep ?? 'Blocked' }] : [],
    };
  });

  const taskIds = new Set(items.map(item => item.id));
  for (const node of contextNodes.values()) {
    if (taskIds.has(node.id)) throw new Error(`context node ID ${node.id} collides with a task ID`);
    items.push(sharedItem({
      id: node.id,
      title: node.title,
      type: node.kind,
      status: '',
      parent: node.parentId,
      contextOnly: true,
    }));
  }

  const itemsById = new Map(items.map(item => [item.id, item]));
  for (const item of items) {
    const parent = item.parent ? itemsById.get(item.parent) : null;
    if (parent) parent.childIds.push(item.id);
  }
  for (const item of items) item.childIds.sort((a, b) => a.localeCompare(b));
  const rootIds = items.filter(item => !item.parent || !itemsById.has(item.parent)).map(item => item.id);
  const expandedIds = items.filter(item => item.childIds.length > 0).map(item => item.id);

  return {
    schemaVersion: 4,
    source: {
      commit: source.commit ?? 'unknown',
      shortCommit: source.commit && source.commit !== 'unknown' ? source.commit.slice(0, 10) : 'unknown',
      committedAt: source.committedAt ?? null,
      dirty: Boolean(source.dirty),
      builtAt: initialized ? (source.builtAt ?? null) : null,
      layout: 'team-projection-v1',
      projectionId: projection.projectionId,
      week: projection.week,
      revision: projection.revision,
      policyRevision: projection.policyRevision,
      projectionState: initialized ? 'exported' : 'uninitialized',
      exportedAt: initialized ? projection.generatedAt : null,
      projectionGeneratedAt: initialized ? projection.generatedAt : null,
      projectionDigest: source.projectionDigest ?? null,
    },
    defaultExpanded: expandedIds,
    bucketOrder: ['other'],
    rootsByBucket: { other: rootIds },
    items,
    plans: [],
    deliveryRecords: [],
    people: teamProfiles,
    history: [],
    migrations: [],
    capacities: [],
    decisions: [],
    releases: [],
    updates: [],
    activityEvidence: safeActivityEvidence(companion),
    team: teamProfiles,
  };
}
