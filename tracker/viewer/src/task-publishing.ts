import { Schema } from '@livestore/livestore';
import {
  TASK_EDITABLE_FIELDS,
  type ParsedTaskContentDraft,
  type TaskDraftFieldValue,
  type TaskEditableField,
} from './task-drafts';
import type { TrackerSnapshot } from './snapshot';
import type { TaskEditAction, TaskEditHistoryPayload, TaskEditSessionPayload } from './task-edit-history';
import { normalizeNarrativeValue, normalizeTaskTitle } from '../../../tooling/tracker/markdown.mjs';

const publishFieldValueSchema = Schema.Struct({
  value: Schema.String,
  baseValue: Schema.String,
  baseSourceCommit: Schema.String,
  baseContentRevision: Schema.String,
});

const publishFieldsSchema = Schema.Struct({
  title: Schema.optional(publishFieldValueSchema),
  'sections.outcome': Schema.optional(publishFieldValueSchema),
  'sections.completionCondition': Schema.optional(publishFieldValueSchema),
  'sections.nextStep': Schema.optional(publishFieldValueSchema),
  'sections.evidence': Schema.optional(publishFieldValueSchema),
});

const publishTaskSchema = Schema.Struct({ id: Schema.String, fields: publishFieldsSchema });

export const frozenTaskPublishRequestSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  requestId: Schema.String,
  tasks: Schema.Array(publishTaskSchema),
});

const taskPublishReviewSchema = Schema.Struct({
  taskId: Schema.String,
  requiresApproval: Schema.Boolean,
  reviewDigest: Schema.String,
  title: Schema.String,
  approvedParts: Schema.Array(Schema.String),
  changes: Schema.Array(Schema.Struct({
    field: Schema.String,
    label: Schema.String,
    before: Schema.String,
    after: Schema.String,
  })),
  retained: Schema.Array(Schema.Struct({ label: Schema.String, value: Schema.String })),
});

export const taskPublishPrepareResponseSchema = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  status: Schema.Literal('ready-for-review'),
  published: Schema.Literal(false),
  requestId: Schema.String,
  currentSourceCommit: Schema.String,
  reviews: Schema.Array(taskPublishReviewSchema),
});

const taskPublishConflictSchema = Schema.Struct({
  taskId: Schema.String,
  field: Schema.String,
  baseValue: Schema.String,
  currentValue: Schema.String,
  proposedValue: Schema.String,
  message: Schema.String,
});

export const taskPublishConflictResponseSchema = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  status: Schema.Literal('conflict'),
  published: Schema.Literal(false),
  requestId: Schema.String,
  error: Schema.String,
  code: Schema.String,
  currentSourceCommit: Schema.String,
  conflicts: Schema.Array(taskPublishConflictSchema),
});

const taskPublishFinalRequestSchema = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  requestId: Schema.String,
  tasks: Schema.Array(publishTaskSchema),
  approvals: Schema.Array(Schema.Struct({ taskId: Schema.String, reviewDigest: Schema.String })),
});

const taskPublishReceiptFieldSchema = Schema.Struct({
  taskId: Schema.String,
  field: Schema.String,
  publishedValue: Schema.String,
});

const taskPublishReceiptSchema = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  status: Schema.Literal('committed'),
  published: Schema.Literal(true),
  requestId: Schema.String,
  payloadHash: Schema.String,
  originalSourceCommit: Schema.String,
  commit: Schema.String,
  fields: Schema.Array(taskPublishReceiptFieldSchema),
  source: Schema.optional(Schema.Struct({
    commit: Schema.String,
    includesPublishedCommit: Schema.Boolean,
  })),
});

const taskPublishTransactionPhaseSchema = Schema.Union(
  Schema.Literal('prepare-pending'),
  Schema.Literal('review-ready'),
  Schema.Literal('final-pending'),
  Schema.Literal('receipt-recorded'),
  Schema.Literal('receipt-superseded'),
  Schema.Literal('conflict'),
  Schema.Literal('canceled'),
  Schema.Literal('complete'),
);

const taskPublishConfirmedSourceSchema = Schema.Struct({
  sourceCommit: Schema.String,
  contentRevision: Schema.String,
  includesPublishedCommit: Schema.Literal(true),
});

export const taskPublishTransactionPayloadSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  request: frozenTaskPublishRequestSchema,
  phase: taskPublishTransactionPhaseSchema,
  prepared: Schema.optional(taskPublishPrepareResponseSchema),
  finalRequest: Schema.optional(taskPublishFinalRequestSchema),
  receipt: Schema.optional(taskPublishReceiptSchema),
  conflict: Schema.optional(taskPublishConflictResponseSchema),
  confirmedSource: Schema.optional(taskPublishConfirmedSourceSchema),
  updatedAt: Schema.String,
});

export type FrozenTaskPublishRequest = typeof frozenTaskPublishRequestSchema.Type;
export type TaskPublishPrepareResponse = typeof taskPublishPrepareResponseSchema.Type;
export type TaskPublishConflictResponse = typeof taskPublishConflictResponseSchema.Type;
export type TaskPublishFinalRequest = typeof taskPublishFinalRequestSchema.Type;
export type TaskPublishReceipt = typeof taskPublishReceiptSchema.Type;
export type TaskPublishTransactionPayload = typeof taskPublishTransactionPayloadSchema.Type;
export type TaskPublishTransactionPhase = typeof taskPublishTransactionPhaseSchema.Type;
export type TaskPublishConfirmedSource = typeof taskPublishConfirmedSourceSchema.Type;

export interface TaskPublishTransactionRowLike {
  readonly id: string;
  readonly payloadJson: string;
}

export const TASK_PUBLISH_TRANSACTION_ROW_ID = 'active';

function decodeJson<TSchema extends Schema.Schema.AnyNoContext>(schema: TSchema, json: string, label: string): TSchema['Type'] {
  let decoded: unknown;
  try {
    decoded = JSON.parse(json);
  } catch (cause) {
    throw new Error(`${label} is not valid JSON.`, { cause });
  }
  return Schema.decodeUnknownSync(schema, { onExcessProperty: 'error' })(decoded);
}

export function parseTaskPublishTransaction(payloadJson: string): TaskPublishTransactionPayload {
  const transaction = decodeJson(taskPublishTransactionPayloadSchema, payloadJson, 'Saved task publish transaction');
  if (transaction.request.requestId.length === 0) throw new Error('Saved task publish transaction has an empty request ID.');
  if (transaction.phase === 'review-ready' && transaction.prepared === undefined) throw new Error('Saved publish review is missing its prepared response.');
  if (transaction.phase === 'final-pending' && (transaction.prepared === undefined || transaction.finalRequest === undefined)) {
    throw new Error('Saved final publish request is missing its frozen review or body.');
  }
  if ((transaction.phase === 'receipt-recorded' || transaction.phase === 'receipt-superseded' || transaction.phase === 'complete') && transaction.receipt === undefined) {
    throw new Error('Saved publish receipt is missing its committed response.');
  }
  if (transaction.phase === 'receipt-superseded'
    && (transaction.receipt?.source?.includesPublishedCommit !== true
      || transaction.receipt.source.commit.length === 0)) {
    throw new Error('Superseded publish receipt is missing its deployed source proof.');
  }
  if (transaction.phase === 'complete' && transaction.confirmedSource === undefined) {
    throw new Error('Saved publish confirmation is missing its deployed source proof.');
  }
  if (transaction.phase === 'conflict' && transaction.conflict === undefined) throw new Error('Saved publish conflict is missing its response.');
  return transaction;
}

export function parseTaskPublishTransactionRows(rows: readonly TaskPublishTransactionRowLike[]): TaskPublishTransactionPayload | null {
  if (rows.length === 0) return null;
  if (rows.length !== 1 || rows[0]?.id !== TASK_PUBLISH_TRANSACTION_ROW_ID) {
    throw new Error('Saved task publish transaction has an invalid singleton identity.');
  }
  return parseTaskPublishTransaction(rows[0].payloadJson);
}

function publishReceiptCoreJson(receipt: TaskPublishTransactionPayload['receipt']): string | null {
  if (receipt === undefined) return null;
  return JSON.stringify({
    schemaVersion: receipt.schemaVersion,
    status: receipt.status,
    published: receipt.published,
    requestId: receipt.requestId,
    payloadHash: receipt.payloadHash,
    originalSourceCommit: receipt.originalSourceCommit,
    commit: receipt.commit,
    fields: receipt.fields,
  });
}

export function canAdvanceTaskPublishTransaction(
  current: TaskPublishTransactionPayload | null,
  next: TaskPublishTransactionPayload,
  expectedRequestId: string | null,
  expectedPhase: TaskPublishTransactionPhase | null,
): boolean {
  if (current === null) {
    return expectedRequestId === null && expectedPhase === null && next.phase === 'prepare-pending';
  }
  if (current.request.requestId !== expectedRequestId || current.phase !== expectedPhase) return false;
  if (current.phase === 'complete' || current.phase === 'canceled' || current.phase === 'receipt-superseded') {
    return next.phase === 'prepare-pending';
  }
  if (current.request.requestId !== next.request.requestId) return false;
  if (JSON.stringify(current.request) !== JSON.stringify(next.request)) return false;
  if (current.prepared !== undefined && JSON.stringify(current.prepared) !== JSON.stringify(next.prepared)) return false;
  if (current.finalRequest !== undefined && JSON.stringify(current.finalRequest) !== JSON.stringify(next.finalRequest)) return false;
  if (current.receipt !== undefined && publishReceiptCoreJson(current.receipt) !== publishReceiptCoreJson(next.receipt)) return false;
  switch (current.phase) {
    case 'prepare-pending': return next.phase === 'review-ready' || next.phase === 'conflict' || next.phase === 'canceled';
    case 'review-ready': return next.phase === 'final-pending' || next.phase === 'canceled';
    case 'final-pending': return next.phase === 'receipt-recorded' || next.phase === 'conflict';
    case 'receipt-recorded': return next.phase === 'receipt-recorded' || next.phase === 'receipt-superseded' || next.phase === 'complete';
    case 'conflict': return next.phase === 'canceled';
  }
}

export function createFrozenTaskPublishRequest(
  drafts: readonly ParsedTaskContentDraft[],
  requestId: string,
): FrozenTaskPublishRequest {
  const tasks = [...drafts]
    .sort((left, right) => left.recordId.localeCompare(right.recordId))
    .map(draft => {
      const fields: Partial<Record<TaskEditableField, TaskDraftFieldValue>> = {};
      for (const field of TASK_EDITABLE_FIELDS) {
        const value = draft.payload.fields[field];
        if (value !== undefined) fields[field] = value;
      }
      return { id: draft.recordId, fields };
    });
  return Schema.decodeUnknownSync(frozenTaskPublishRequestSchema, { onExcessProperty: 'error' })({
    schemaVersion: 1,
    requestId,
    tasks,
  });
}

export function createPendingTaskPublishTransaction(
  request: FrozenTaskPublishRequest,
  updatedAt: string,
): TaskPublishTransactionPayload {
  return { schemaVersion: 1, request, phase: 'prepare-pending', updatedAt };
}

export function parseTaskPublishPrepareResponse(value: unknown, requestId: string): TaskPublishPrepareResponse {
  const response = Schema.decodeUnknownSync(taskPublishPrepareResponseSchema, { onExcessProperty: 'error' })(value);
  if (response.requestId !== requestId) throw new Error('Publish preparation returned a different request ID.');
  const taskIds = new Set<string>();
  for (const review of response.reviews) {
    if (review.taskId.length === 0 || taskIds.has(review.taskId)) throw new Error('Publish preparation returned invalid task reviews.');
    taskIds.add(review.taskId);
  }
  return response;
}

export function parseTaskPublishConflictResponse(value: unknown, requestId: string): TaskPublishConflictResponse {
  const response = Schema.decodeUnknownSync(taskPublishConflictResponseSchema, { onExcessProperty: 'error' })(value);
  if (response.requestId !== requestId) throw new Error('Publish conflict belongs to a different frozen request.');
  return response;
}

export function createFinalTaskPublishRequest(
  transaction: TaskPublishTransactionPayload,
  explicitlyReviewedTaskIds: ReadonlySet<string>,
): TaskPublishFinalRequest {
  if (transaction.phase !== 'review-ready' || transaction.prepared === undefined) {
    throw new Error('This publish request is not ready for review.');
  }
  const requiredReviews = transaction.prepared.reviews.filter(review => review.requiresApproval);
  const requiredIds = new Set(requiredReviews.map(review => review.taskId));
  for (const taskId of requiredIds) {
    if (!explicitlyReviewedTaskIds.has(taskId)) throw new Error('Review every approved task scope before publishing.');
  }
  const approvals = requiredReviews.map(review => ({ taskId: review.taskId, reviewDigest: review.reviewDigest }));
  return Schema.decodeUnknownSync(taskPublishFinalRequestSchema, { onExcessProperty: 'error' })({
    schemaVersion: 2,
    requestId: transaction.request.requestId,
    tasks: transaction.request.tasks,
    approvals,
  });
}

export function parseTaskPublishReceipt(value: unknown, requestId: string): TaskPublishReceipt {
  const receipt = Schema.decodeUnknownSync(taskPublishReceiptSchema, { onExcessProperty: 'error' })(value);
  if (receipt.requestId !== requestId) throw new Error('Publish receipt belongs to a different request.');
  if (receipt.fields.length === 0) throw new Error('Publish receipt contains no published fields.');
  return receipt;
}

export function taskPublishReceiptMatchesCanonical(
  receipt: TaskPublishReceipt,
  snapshot: TrackerSnapshot,
): boolean {
  return receipt.fields.every(field => {
    const item = snapshot.itemById.get(field.taskId);
    if (item === undefined) return false;
    switch (field.field) {
      case 'title': return normalizeTaskTitle(item.title) === normalizeTaskTitle(field.publishedValue);
      case 'sections.outcome': return normalizeNarrativeValue(item.sections.outcome) === normalizeNarrativeValue(field.publishedValue);
      case 'sections.completionCondition': return normalizeNarrativeValue(item.sections.completionCondition) === normalizeNarrativeValue(field.publishedValue);
      case 'sections.nextStep': return normalizeNarrativeValue(item.sections.nextStep) === normalizeNarrativeValue(field.publishedValue);
      case 'sections.evidence': return normalizeNarrativeValue(item.sections.evidence) === normalizeNarrativeValue(field.publishedValue);
      default: return false;
    }
  });
}

export function taskPublishFieldValuesMatch(field: TaskEditableField, left: string, right: string): boolean {
  return field === 'title'
    ? normalizeTaskTitle(left) === normalizeTaskTitle(right)
    : normalizeNarrativeValue(left) === normalizeNarrativeValue(right);
}

export function taskPublishReceiptMatchesRequest(
  receipt: TaskPublishReceipt,
  request: FrozenTaskPublishRequest,
): boolean {
  const requestedFields = request.tasks.flatMap(task => TASK_EDITABLE_FIELDS.flatMap(field => {
    const value = task.fields[field];
    return value === undefined ? [] : [{ taskId: task.id, field, value: value.value }];
  }));
  if (requestedFields.length !== receipt.fields.length) return false;
  const remaining = new Map(requestedFields.map(field => [`${field.taskId}\u0000${field.field}`, field]));
  for (const field of receipt.fields) {
    const key = `${field.taskId}\u0000${field.field}`;
    const requested = remaining.get(key);
    if (requested === undefined || !taskPublishFieldValuesMatch(requested.field, requested.value, field.publishedValue)) return false;
    remaining.delete(key);
  }
  return remaining.size === 0;
}

function sameSubmittedBaseline(state: TaskDraftFieldValue | null, submitted: TaskDraftFieldValue): boolean {
  return state !== null
    && state.baseValue === submitted.baseValue
    && state.baseSourceCommit === submitted.baseSourceCommit
    && state.baseContentRevision === submitted.baseContentRevision;
}

export function taskDraftFieldStateMatches(left: TaskDraftFieldValue | null, right: TaskDraftFieldValue | null): boolean {
  return left === right || left !== null && right !== null
    && left.value === right.value
    && left.baseValue === right.baseValue
    && left.baseSourceCommit === right.baseSourceCommit
    && left.baseContentRevision === right.baseContentRevision;
}

export function taskDraftFieldStateSharesBaseline(state: TaskDraftFieldValue | null, submitted: TaskDraftFieldValue): boolean {
  return sameSubmittedBaseline(state, submitted);
}

export function rebaseTaskDraftFieldForPublishedField({
  field,
  current,
  submitted,
  publishedValue,
  sourceCommit,
  contentRevision,
}: {
  readonly field: TaskEditableField;
  readonly current: TaskDraftFieldValue | null;
  readonly submitted: TaskDraftFieldValue;
  readonly publishedValue: string;
  readonly sourceCommit: string;
  readonly contentRevision: string;
}): TaskDraftFieldValue | null {
  if (taskDraftFieldStateMatches(current, submitted)) {
    return current !== null && taskPublishFieldValuesMatch(field, current.value, publishedValue) ? null : current;
  }
  if (!taskDraftFieldStateSharesBaseline(current, submitted) || current === null) return current;
  if (taskPublishFieldValuesMatch(field, current.value, publishedValue)) return null;
  return {
    ...current,
    baseValue: publishedValue,
    baseSourceCommit: sourceCommit,
    baseContentRevision: contentRevision,
  };
}

function rebasedTargetFieldState({
  field,
  value,
  state,
  submitted,
  publishedValue,
  baseline,
}: {
  readonly field: TaskEditableField;
  readonly value: string;
  readonly state: TaskDraftFieldValue | null;
  readonly submitted: TaskDraftFieldValue;
  readonly publishedValue: string;
  readonly baseline: { readonly sourceCommit: string; readonly contentRevision: string };
}): TaskDraftFieldValue | null {
  if (taskPublishFieldValuesMatch(field, value, publishedValue)) return null;
  if (state === null) {
    return {
      value,
      baseValue: publishedValue,
      baseSourceCommit: baseline.sourceCommit,
      baseContentRevision: baseline.contentRevision,
    };
  }
  if (!sameSubmittedBaseline(state, submitted)) return state;
  return {
    value: state.value,
    baseValue: publishedValue,
    baseSourceCommit: baseline.sourceCommit,
    baseContentRevision: baseline.contentRevision,
  };
}

function actionBelongsToSubmittedBaseline(action: TaskEditAction, submitted: TaskDraftFieldValue): boolean {
  return action.canonicalAtStart.value === submitted.baseValue
    && action.canonicalAtStart.sourceCommit === submitted.baseSourceCommit
    && action.canonicalAtStart.contentRevision === submitted.baseContentRevision
    || sameSubmittedBaseline(action.beforeFieldState, submitted)
    || sameSubmittedBaseline(action.afterFieldState, submitted);
}

function rebasePublishedAction(
  action: TaskEditAction,
  {
    itemId,
    field,
    submitted,
    publishedValue,
    baseline,
  }: {
    readonly itemId: string;
    readonly field: TaskEditableField;
    readonly submitted: TaskDraftFieldValue;
    readonly publishedValue: string;
    readonly baseline: { readonly sourceCommit: string; readonly contentRevision: string };
  },
): TaskEditAction {
  if (action.itemId !== itemId || action.field !== field || !actionBelongsToSubmittedBaseline(action, submitted)) return action;
  return {
    ...action,
    canonicalAtStart: { value: publishedValue, ...baseline },
    beforeFieldState: rebasedTargetFieldState({
      field: action.field,
      value: action.beforeValue,
      state: action.beforeFieldState,
      submitted,
      publishedValue,
      baseline,
    }),
    afterFieldState: rebasedTargetFieldState({
      field: action.field,
      value: action.afterValue,
      state: action.afterFieldState,
      submitted,
      publishedValue,
      baseline,
    }),
  };
}

export function rebaseTaskEditHistoryForPublishedField({
  history,
  itemId,
  field,
  submitted,
  publishedValue,
  sourceCommit,
  contentRevision,
}: {
  readonly history: TaskEditHistoryPayload;
  readonly itemId: string;
  readonly field: TaskEditableField;
  readonly submitted: TaskDraftFieldValue;
  readonly publishedValue: string;
  readonly sourceCommit: string;
  readonly contentRevision: string;
}): TaskEditHistoryPayload {
  const rebase = (action: TaskEditAction) => rebasePublishedAction(action, {
    itemId,
    field,
    submitted,
    publishedValue,
    baseline: { sourceCommit, contentRevision },
  });
  return {
    ...history,
    undo: history.undo.map(rebase),
    redo: history.redo.map(rebase),
    skipped: history.skipped.map(entry => ({ ...entry, action: rebase(entry.action) })),
  };
}

export function rebaseTaskEditSessionForPublishedField({
  session,
  itemId,
  field,
  submitted,
  publishedValue,
  sourceCommit,
  contentRevision,
}: {
  readonly session: TaskEditSessionPayload;
  readonly itemId: string;
  readonly field: TaskEditableField;
  readonly submitted: TaskDraftFieldValue;
  readonly publishedValue: string;
  readonly sourceCommit: string;
  readonly contentRevision: string;
}): TaskEditSessionPayload {
  const sessionMatches = session.itemId === itemId && session.field === field;
  const baselineMatches = session.canonicalAtStart.value === submitted.baseValue
    && session.canonicalAtStart.sourceCommit === submitted.baseSourceCommit
    && session.canonicalAtStart.contentRevision === submitted.baseContentRevision;
  const stateMatches = sameSubmittedBaseline(session.beforeFieldState, submitted)
    || sameSubmittedBaseline(session.currentFieldState, submitted);
  if (!sessionMatches || (!baselineMatches && !stateMatches)) return session;
  const baseline = { sourceCommit, contentRevision };
  return {
    ...session,
    canonicalAtStart: { value: publishedValue, ...baseline },
    beforeFieldState: rebasedTargetFieldState({
      field,
      value: session.beforeValue,
      state: session.beforeFieldState,
      submitted,
      publishedValue,
      baseline,
    }),
    currentFieldState: rebasedTargetFieldState({
      field,
      value: session.currentValue,
      state: session.currentFieldState,
      submitted,
      publishedValue,
      baseline,
    }),
  };
}

export function isTaskPublishTransactionRetryable(transaction: TaskPublishTransactionPayload): boolean {
  return transaction.phase === 'prepare-pending' || transaction.phase === 'final-pending' || transaction.phase === 'receipt-recorded';
}
