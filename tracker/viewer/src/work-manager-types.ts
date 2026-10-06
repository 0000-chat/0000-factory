import type { NormalizedWorkEvidence } from './work-activity-types';

export type ManagerReadiness = 'ready' | 'waiting' | 'not-assessed';
export type ManagerMovementState = 'recent' | 'quiet' | 'unknown';
export type ManagerPersonRoleName = 'dri' | 'executor' | 'observed';
export type ManagerPreset = 'none' | 'team' | 'moving' | 'delivery' | 'needs-me';

export interface ManagerPersonRole {
  personId: string;
  role: ManagerPersonRoleName;
}

export interface ManagerDecision {
  id: string;
  title: string;
  state: string;
  question: string;
  recommendation: string | null;
  source: string | null;
  owner: string | null;
}

export interface ManagerMovement {
  state: ManagerMovementState;
  summary: string | null;
  /** Last source-backed Manila day from the work activity projection. */
  date: string | null;
}

export interface ManagerProjectionEntry {
  id: string;
  parentId: string | null;
  type: string | null;
  accepted: boolean;
  unfinished: boolean;
  personRoles: ManagerPersonRole[];
  current: boolean;
  upcoming: boolean;
  readiness: ManagerReadiness;
  reasons: string[];
  unreviewed: boolean;
  briefId: string | null;
  executor: string | null;
  executorApproved: boolean;
  nextApproved: boolean;
  gaps: string[];
  decisions: ManagerDecision[];
  movement: ManagerMovement;
  /** True when no accepted, named DRI assignment is present. */
  driUnassigned: boolean;
}

export interface ManagerCoverageCounts {
  tasks: number;
  moving: number;
  quiet: number;
  unknownCurrent: number;
  ready: number;
  waiting: number;
  notAssessed: number;
  unreviewed: number;
}

export interface ManagerCoverageRow {
  personId: string;
  personName: string;
  /** Context containers never contribute to this task-only count map. */
  taskTypeCounts: { task: number };
  /** Recent own activity on unfinished current tasks. */
  movingIds: string[];
  /** Quiet own activity on unfinished current tasks. */
  quietIds: string[];
  unknownCurrentIds: string[];
  /** Ready tasks that are queued upcoming work. */
  readyIds: string[];
  waitingIds: string[];
  notAssessedIds: string[];
  unreviewedIds: string[];
  counts: ManagerCoverageCounts;
}

export interface ManagerProjection {
  byId: Map<string, ManagerProjectionEntry>;
  coverage: ManagerCoverageRow[];
}

export interface BuildManagerProjectionInput {
  /** Full item hierarchy for dependency and decision facts, including retained context. */
  items?: Array<Record<string, unknown> & { id: string }>;
  activityProjection?: Map<string, {
    own?: Partial<ManagerMovement> & { lastDate?: string | null; evidenceIds?: string[] };
  }>;
  /** Normalized included source evidence used to assess reported results. */
  activityEvidence?: NormalizedWorkEvidence[];
  deliveryRecords?: Array<Record<string, unknown> & {
    id: string;
    type: string;
    itemId: string | null;
    updatedAt?: string | null;
    sections?: Record<string, unknown>;
  }>;
  decisions?: Array<Record<string, unknown> & { id: string; state: string }>;
  people?: Array<Record<string, unknown> & { id: string; status?: string }> | { people: Array<Record<string, unknown> & { id: string; status?: string }> };
  /** IDs in the canonical pre-filter project scope; restricts coverage only. */
  scopeIds?: Iterable<string>;
  now?: Date | number | string;
}

export interface SelectManagerMatchesInput {
  managerProjection?: Pick<ManagerProjection, 'byId'> | null;
  preset?: ManagerPreset | string;
  /** Canonical roster IDs; values are ORed with each other and ANDed with preset. */
  people?: string[];
}
