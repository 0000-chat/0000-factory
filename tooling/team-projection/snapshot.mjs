/**
 * Adapt the validated public team projection to the existing viewer snapshot
 * shape. The adapter deliberately leaves canonical-only collections empty and
 * does not synthesize approval, decision, history, or publication records.
 */
const EMPTY_SOURCE_DIGEST = `sha256:${'0'.repeat(64)}`;

export function buildTeamProjectionSnapshot(projection, source = {}) {
  const initialized = projection.sourcePlanDigest !== EMPTY_SOURCE_DIGEST || projection.tasks.length > 0;
  const contextNodes = new Map();
  for (const node of projection.contextNodes ?? []) {
    const existing = contextNodes.get(node.id);
    if (existing) throw new Error(`duplicate context node ID ${node.id}`);
    contextNodes.set(node.id, node);
  }

  const sharedItem = ({ id, title, type, status, owner = null, parent = null, contextOnly = false }) => ({
    id,
    title: title ?? id,
    type,
    status,
    phase: null,
    owner,
    ownerName: owner,
    parent,
    dependsOn: [],
    updatedAt: null,
    completedAt: null,
    target: null,
    bucket: 'other',
    archived: false,
    completed: !contextOnly && status === 'done',
    commitment: null,
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
      state: 'unknown',
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
    const plannedEnd = task.approvedDate ?? null;
    const forecastEnd = task.forecastDate ?? null;
    return {
      ...sharedItem({
        id: task.taskId,
        title: task.title,
        type: 'task',
        status: task.status,
        owner: task.assignee ?? null,
        parent: task.parentId ?? null,
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
        approvedDate: task.approvedDate ?? null,
        forecastDate: task.forecastDate ?? null,
        checkpoint: task.checkpoint ?? null,
        dependencies: task.dependencies.map(({ summary }) => summary),
        evidenceLinks: [...task.evidenceLinks],
        parentId: task.parentId ?? null,
      },
      schedule: {
        plannedStart: null,
        plannedEnd,
        forecastStart: null,
        forecastEndMin: forecastEnd,
        forecastEndMax: forecastEnd,
        provisional: true,
        approved: false,
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
    people: [],
    history: [],
    migrations: [],
    capacities: [],
    decisions: [],
    releases: [],
    updates: [],
    activityEvidence: [],
    team: [],
  };
}
