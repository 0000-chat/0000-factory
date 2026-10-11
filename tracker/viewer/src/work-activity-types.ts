/** Normalized evidence produced by the source-evidence validator. */
export interface NormalizedWorkEvidence {
  /** Original item or update record ID; retained as the evidence row ID. */
  id: string;
  originalItemId: string | null;
  originalUpdateId: string | null;
  /** Effective canonical task attribution after approved corrections. */
  itemId: string | null;
  /** Stable identity of the original source event, before correction. */
  sourceEventId: string | null;
  occurredAt: string | null;
  discoveredAt: string | null;
  kind: 'work' | 'result' | 'decision' | 'discussion' | 'unknown';
  summary: string | null;
  attributionBasis: string | null;
  evidenceRef: string | null;
  included: boolean;
  amendmentIds: string[];
  approvalDecisionIds: string[];
}

/** Minimal normalized task shape consumed by the view-independent projection. */
export interface WorkProjectionItem {
  id: string;
  title?: string | null;
  status?: string | null;
  completed?: boolean;
  /** Canonical roster GitHub handle (when set), roster ID, or `unassigned`. */
  owner?: string | null;
  ownerName?: string | null;
  /** Canonical parent item ID. */
  parent?: string | null;
  /** Canonical direct children used to order children whose parent link matches. */
  childIds?: string[];
  commitment?: string | null;
  schedule?: {
    approved?: boolean;
    proposed?: boolean;
    plannedStart?: string | null;
    plannedEnd?: string | null;
    forecastStart?: string | null;
    forecastEndMin?: string | null;
    forecastEndMax?: string | null;
    [key: string]: unknown;
  } | null;
  [key: string]: unknown;
}

export type WorkActivityState = 'recent' | 'quiet' | 'unknown';
export type ManilaDay = string;
export type WorkAttentionReason = 'blocked' | 'quiet' | 'overdue' | 'missing-evidence';

export interface WorkActivityStreak {
  /** Trailing consecutive Monday–Friday dates with qualifying evidence. */
  days: number;
  /** Latest weekday in the streak; null when no qualifying weekday exists. */
  endDate: ManilaDay | null;
}

export interface WorkProjectionOwnActivity {
  state: WorkActivityState;
  firstDate: ManilaDay | null;
  lastDate: ManilaDay | null;
  firstOccurredAt: string | null;
  lastOccurredAt: string | null;
  ageBusinessDays: number | null;
  summary: string | null;
  evidenceRef: string | null;
  evidenceIds: string[];
  streak: WorkActivityStreak;
}

export interface WorkProjectionDescendants {
  /** Unfinished descendant IDs, each counted once by its own direct evidence. */
  recentIds: string[];
  quietIds: string[];
  unknownIds: string[];
  /** Distinct canonical owners of unfinished descendants, excluding this row's owner. */
  ownerIds: string[];
  /** Per-task streaks for descendants with dated qualifying evidence. */
  streaks: Array<WorkActivityStreak & { id: string; title: string }>;
}

export interface WorkProjectionTimeline {
  ownPlannedStart: ManilaDay | null;
  ownPlannedDue: ManilaDay | null;
  ownProposedStart?: ManilaDay | null;
  ownProposedDue?: ManilaDay | null;
  ownProposedScheduleKind?: 'span' | 'checkpoint' | null;
  ownProposedExplicit?: boolean;
  ownForecastStart?: ManilaDay | null;
  ownForecastDue?: ManilaDay | null;
  plannedStart: ManilaDay | null;
  plannedDue: ManilaDay | null;
  observedStart: ManilaDay | null;
  observedEnd: ManilaDay | null;
  inferredStart: ManilaDay | null;
  forecastStart: ManilaDay | null;
  forecastEnd: ManilaDay | null;
  proposedStart: ManilaDay | null;
  proposedEnd: ManilaDay | null;
  /** True when a projected range has incomplete schedule coverage or endpoints. */
  partial: boolean;
  /** Calendar days past the effective approved due date; zero when not overdue. */
  overdueCalendarDays: number;
}

export interface WorkProjectionEntry {
  id: string;
  parentId: string | null;
  childIds: string[];
  title: string;
  status: string;
  completed: boolean;
  /** Canonical roster identity, lowercased for comparison; not the display name. */
  owner: string | null;
  ownerName: string | null;
  own: WorkProjectionOwnActivity;
  descendants: WorkProjectionDescendants;
  timeline: WorkProjectionTimeline;
  attentionReasons: WorkAttentionReason[];
}

export interface BuildWorkProjectionInput {
  items?: WorkProjectionItem[];
  evidence?: NormalizedWorkEvidence[];
  /** Injected clock value; date-only values are Manila calendar days. */
  now?: Date | number | string;
}

export type WorkActivityFilter = 'all' | 'recent' | 'quiet' | 'attention';

export interface SelectWorkRowsInput {
  projection: Map<string, WorkProjectionEntry>;
  /** Item IDs after the caller's existing visibility and completion controls. */
  eligibleIds: Iterable<string>;
  activityFilter?: WorkActivityFilter | string;
  /** Reveal selected-row ancestor paths when a non-activity filter is active. */
  revealAncestors?: boolean;
  /** Optional selected subtree root. Null selects the full projection. */
  scopeRootId?: string | null;
}

export interface SelectWorkRowsResult {
  /** Rows that directly satisfy the current eligibility and activity predicate. */
  matchIds: Set<string>;
  /** Matches plus ancestor rows needed to render their hierarchy paths. */
  visibleIds: Set<string>;
  /** Visible ancestors that are context only, not direct matches. */
  contextIds: Set<string>;
  /** Ancestors to reveal while an activity or caller-selected row filter is active. */
  revealAncestorIds: Set<string>;
}
