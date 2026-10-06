import { normalizeData } from './snapshot-normalizer.js';
import type { NormalizedWorkEvidence } from './work-activity-types';
import {
  TRACKER_STORE_SCHEMA_VERSION,
  canonicalSnapshotTable,
} from './livestore-schema';

export type SnapshotRecord = Record<string, unknown>;

export interface TrackerSections {
  outcome: string;
  completionCondition: string;
  nextStep: string;
  evidence: string;
  blocker: string | null;
}

export interface TrackerProgress extends SnapshotRecord {
  scoped: boolean;
  percent: number | null;
  milestones: SnapshotRecord[];
  approvedAt: string | null;
  evidenceReviewedAt: string | null;
}

export interface TrackerHealth extends SnapshotRecord {
  state: string;
  reason: string;
  missingInformation: string;
  suggestedAction: string;
  actor: string;
  reviewedAt: string | null;
}

export interface TrackerSchedule extends SnapshotRecord {
  plannedStart: string | null;
  plannedEnd: string | null;
  forecastStart: string | null;
  forecastEndMin: string | null;
  forecastEndMax: string | null;
  provisional: boolean;
  approved: boolean;
}

export interface TrackerDecisionSummary extends SnapshotRecord {
  id: string;
  title: string;
  state: string;
  owner: string | null;
  ownerName: string | null;
  updatedAt: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  approvalTimeUtc: string | null;
  approvalRef: string | null;
  approvalSource: string | null;
  coordinationDigest: string | null;
  executorItem: string | null;
  executorKind: string | null;
  executorRef: string | null;
  nextItem: string | null;
  nextActor: string | null;
  supersededBy: string | null;
  affects: string[];
  sourcePath: string | null;
  path?: string;
}

export interface TrackerRelease extends SnapshotRecord {
  id: string;
  title: string;
  project: string | null;
  owner: string | null;
  ownerName: string | null;
  status: string | null;
  target: string | null;
  sourcePath: string | null;
  path?: string;
}

export interface TrackerItem extends SnapshotRecord {
  id: string;
  title: string;
  type?: string;
  status: string;
  parent?: string | null;
  childIds: string[];
  dependsOn: string[];
  completed: boolean;
  commitment: string | null;
  plan: string | null;
  sections: TrackerSections;
  progress: TrackerProgress;
  health: TrackerHealth;
  schedule: TrackerSchedule;
  effort: unknown;
  priority: unknown;
  linked: {
    decisions: TrackerDecisionSummary[];
    releases: TrackerRelease[];
    updates: SnapshotRecord[];
  };
  childSummary: { done: number; total: number };
  approval: SnapshotRecord;
  acceptance: SnapshotRecord;
  blockers: SnapshotRecord[];
  owner?: string | null;
  ownerName?: string | null;
  phase?: string | null;
  target?: string | null;
}

export interface TrackerPlan extends SnapshotRecord {
  id: string;
  title: string;
  project: string | null;
  status: string;
  approval: SnapshotRecord;
  sections: Record<string, unknown>;
  taskIds: string[];
}

export interface TrackerDecision extends TrackerDecisionSummary {
  body: string;
  sections: Record<string, unknown>;
}

export interface TrackerHistoryRecord extends SnapshotRecord {
  id: string;
  title: string;
  supersededBy?: string | null;
}

export interface TrackerDeliveryRecord extends SnapshotRecord {
  id: string;
  type: 'discovery' | 'brief' | 'coordination' | 'cycle' | 'reflection';
  itemId: string | null;
  updatedAt: string | null;
  sourcePath: string | null;
  sections: Record<string, string>;
  origin?: string | null;
  observedExecutor?: string | null;
  requestedBy?: string | null;
  sourceRefs?: string[];
  evidenceIds?: string[];
  suggestedParent?: string | null;
  candidateParents?: string[];
  attribution?: string | null;
  priorityDecision?: string | null;
  executorKind?: string | null;
  executorRef?: string | null;
  assignmentDecision?: string | null;
  nextDecision?: string | null;
  recipient?: string | null;
  channel?: string | null;
  approvalDecision?: string | null;
  requestDigest?: string | null;
  deliveryReceipt?: string | null;
  deliveryRef?: string | null;
  dispatchRequest?: string | null;
  dispatchState?: string | null;
  scope?: string | null;
  invocationKey?: string | null;
  taskIds?: string[];
  briefIds?: string[];
  decisionIds?: string[];
  cycleId?: string | null;
  version?: string | null;
  approved?: boolean;
  messageApproved?: boolean;
  nextApproved?: boolean;
}

export interface TrackerPerson extends SnapshotRecord {
  id: string;
  name: string;
  fullName: string | null;
  status: string;
  githubHandle: string | null;
  avatar: string | null;
  aliases?: string[];
}

export interface TrackerSource extends SnapshotRecord {
  commit?: string;
  shortCommit?: string;
  contentRevision?: string;
  builtAt?: string;
  committedAt?: string | null;
  dirty?: boolean;
}

export interface TrackerSnapshot extends SnapshotRecord {
  schemaVersion: number;
  items: TrackerItem[];
  itemById: Map<string, TrackerItem>;
  rootsByBucket: Record<string, string[]>;
  bucketOrder: string[];
  defaultExpanded: string[];
  activityEvidence: NormalizedWorkEvidence[];
  deliveryRecords: TrackerDeliveryRecord[];
  people: TrackerPerson[];
  plans: TrackerPlan[];
  decisions: TrackerDecision[];
  team: SnapshotRecord[];
  history: TrackerHistoryRecord[];
  migrations: SnapshotRecord[];
  capacities: SnapshotRecord[];
  releases: TrackerRelease[];
  source: TrackerSource;
}

export interface CanonicalSnapshotPayload {
  readonly payloadJson: string;
  readonly snapshot: TrackerSnapshot;
  readonly fetchedAt: string;
}

export type PersistedCanonicalSnapshot = typeof canonicalSnapshotTable.rowSchema.Type;

export const TRACKER_SNAPSHOT_SCHEMA_VERSION = 4;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Array.isArray(value) === false;
}

export function parseTrackerSnapshot(payload: unknown): TrackerSnapshot {
  if (isRecord(payload) === false) throw new Error('tracker snapshot must be an object');
  if (payload.schemaVersion !== TRACKER_SNAPSHOT_SCHEMA_VERSION) {
    throw new Error(`unsupported tracker snapshot schema version (${String(payload.schemaVersion)})`);
  }

  const collectionNames = ['items', 'plans', 'decisions', 'team', 'history', 'migrations', 'capacities', 'releases'];
  for (const collectionName of collectionNames) {
    if (Array.isArray(payload[collectionName]) === false) {
      throw new Error(`tracker snapshot ${collectionName} collection is missing or invalid`);
    }
  }
  if (payload.deliveryRecords !== undefined && Array.isArray(payload.deliveryRecords) === false) {
    throw new Error('tracker snapshot deliveryRecords collection is invalid');
  }
  if (payload.people !== undefined && Array.isArray(payload.people) === false) {
    throw new Error('tracker snapshot people collection is invalid');
  }

  if (isRecord(payload.source) === false || typeof payload.source.commit !== 'string') {
    throw new Error('tracker snapshot source commit is missing or invalid');
  }

  return normalizeData(payload);
}

export function normalizeTrackerSnapshot(payload: unknown): TrackerSnapshot {
  return normalizeData(payload);
}

export async function fetchCanonicalTrackerSnapshot(signal?: AbortSignal): Promise<CanonicalSnapshotPayload> {
  const response = await fetch('/data.json', { cache: 'no-store', signal });
  if (!response.ok) throw new Error(`snapshot request failed (${response.status})`);
  const payload: unknown = await response.json();
  const snapshot = parseTrackerSnapshot(payload);
  return {
    payloadJson: JSON.stringify(payload),
    snapshot,
    fetchedAt: new Date().toISOString(),
  };
}

export function canonicalSnapshotMatches(
  saved: PersistedCanonicalSnapshot | undefined,
  incoming: TrackerSnapshot,
): boolean {
  if (saved === undefined) return false;
  return saved.storeSchemaVersion === TRACKER_STORE_SCHEMA_VERSION
    && saved.snapshotSchemaVersion === incoming.schemaVersion
    && saved.sourceCommit === (incoming.source.commit ?? 'unknown')
    && saved.contentRevision === (incoming.source.contentRevision ?? incoming.source.commit ?? 'unknown');
}
