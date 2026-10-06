import { Schema } from '@livestore/livestore';
import {
  taskDraftFieldSchema,
  taskDraftFieldValueSchema,
  type TaskDraftFieldValue,
  type TaskEditableField,
} from './task-drafts';

export const TASK_EDIT_HISTORY_ROW_ID = 'global';

export const taskEditCanonicalBaselineSchema = Schema.Struct({
  value: Schema.String,
  sourceCommit: Schema.String,
  contentRevision: Schema.String,
});

export const taskEditSessionPayloadSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  sessionId: Schema.String,
  itemId: Schema.String,
  field: taskDraftFieldSchema,
  ownerId: Schema.String,
  beforeValue: Schema.String,
  beforeFieldState: Schema.Union(taskDraftFieldValueSchema, Schema.Null),
  canonicalAtStart: taskEditCanonicalBaselineSchema,
  currentValue: Schema.String,
  currentFieldState: Schema.Union(taskDraftFieldValueSchema, Schema.Null),
  startedAt: Schema.String,
  updatedAt: Schema.String,
});

export const taskEditActionSchema = Schema.Struct({
  actionId: Schema.String,
  itemId: Schema.String,
  field: taskDraftFieldSchema,
  beforeValue: Schema.String,
  afterValue: Schema.String,
  beforeFieldState: Schema.Union(taskDraftFieldValueSchema, Schema.Null),
  afterFieldState: Schema.Union(taskDraftFieldValueSchema, Schema.Null),
  canonicalAtStart: taskEditCanonicalBaselineSchema,
  createdAt: Schema.String,
});

export const taskEditHistoryPayloadSchema = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  undo: Schema.Array(taskEditActionSchema),
  redo: Schema.Array(taskEditActionSchema),
  skipped: Schema.Array(Schema.Struct({
    direction: Schema.Union(Schema.Literal('undo'), Schema.Literal('redo')),
    action: taskEditActionSchema,
    skippedAt: Schema.String,
  })),
});

const legacyTaskEditHistoryPayloadSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  undo: Schema.Array(taskEditActionSchema),
  redo: Schema.Array(taskEditActionSchema),
});

export type TaskEditCanonicalBaseline = typeof taskEditCanonicalBaselineSchema.Type;
export type TaskEditSessionPayload = typeof taskEditSessionPayloadSchema.Type;
export type TaskEditAction = typeof taskEditActionSchema.Type;
export type TaskEditHistoryPayload = typeof taskEditHistoryPayloadSchema.Type;
export type TaskEditHistoryDirection = 'undo' | 'redo';

export interface TaskEditSessionRowLike {
  readonly id: string;
  readonly itemId: string;
  readonly ownerId: string;
  readonly payloadJson: string;
}

export interface TaskEditHistoryRowLike {
  readonly id: string;
  readonly payloadJson: string;
}

export function createTaskEditSessionPayload({
  sessionId,
  itemId,
  field,
  ownerId,
  beforeValue,
  beforeFieldState,
  canonicalAtStart,
  startedAt,
}: {
  readonly sessionId: string;
  readonly itemId: string;
  readonly field: TaskEditableField;
  readonly ownerId: string;
  readonly beforeValue: string;
  readonly beforeFieldState: TaskDraftFieldValue | null;
  readonly canonicalAtStart: TaskEditCanonicalBaseline;
  readonly startedAt: string;
}): TaskEditSessionPayload {
  return {
    schemaVersion: 1,
    sessionId,
    itemId,
    field,
    ownerId,
    beforeValue,
    beforeFieldState,
    canonicalAtStart,
    currentValue: beforeValue,
    currentFieldState: beforeFieldState,
    startedAt,
    updatedAt: startedAt,
  };
}

export function updateTaskEditSessionPayload({
  session,
  value,
  fieldState,
  updatedAt,
}: {
  readonly session: TaskEditSessionPayload;
  readonly value: string;
  readonly fieldState: TaskDraftFieldValue | null;
  readonly updatedAt: string;
}): TaskEditSessionPayload {
  return { ...session, currentValue: value, currentFieldState: fieldState, updatedAt };
}

export function taskEditSessionIsMeaningful(session: TaskEditSessionPayload): boolean {
  return session.currentValue !== session.beforeValue;
}

const canonicalItemsSchema = Schema.Struct({
  items: Schema.Array(Schema.Struct({
    id: Schema.String,
    title: Schema.String,
    sections: Schema.optional(Schema.Struct({
      outcome: Schema.optional(Schema.String),
      completionCondition: Schema.optional(Schema.String),
      nextStep: Schema.optional(Schema.String),
      evidence: Schema.optional(Schema.String),
    })),
  })),
});

function decodeJson<TSchema extends Schema.Schema.AnyNoContext>(schema: TSchema, json: string, label: string): TSchema['Type'] {
  let decoded: unknown;
  try {
    decoded = JSON.parse(json);
  } catch (cause) {
    throw new Error(`${label} is not valid JSON.`, { cause });
  }
  return Schema.decodeUnknownSync(schema, { onExcessProperty: 'error' })(decoded);
}

export function parseTaskEditSessionPayload(payloadJson: string): TaskEditSessionPayload {
  return decodeJson(taskEditSessionPayloadSchema, payloadJson, 'Saved task edit session');
}

export function parseTaskEditSessionRows(rows: readonly TaskEditSessionRowLike[]): TaskEditSessionPayload[] {
  return rows.map(row => {
    const session = parseTaskEditSessionPayload(row.payloadJson);
    if (row.id !== session.sessionId || row.itemId !== session.itemId || row.ownerId !== session.ownerId) {
      throw new Error(`Saved task edit session ${row.id} has mismatched identity metadata.`);
    }
    return session;
  });
}

export function emptyTaskEditHistory(): TaskEditHistoryPayload {
  return { schemaVersion: 2, undo: [], redo: [], skipped: [] };
}

export function parseTaskEditHistoryPayload(payloadJson: string): TaskEditHistoryPayload {
  let decoded: unknown;
  try {
    decoded = JSON.parse(payloadJson);
  } catch (cause) {
    throw new Error('Saved task edit history is not valid JSON.', { cause });
  }
  if (typeof decoded === 'object' && decoded !== null && 'schemaVersion' in decoded && decoded.schemaVersion === 1) {
    const legacy = Schema.decodeUnknownSync(legacyTaskEditHistoryPayloadSchema, { onExcessProperty: 'error' })(decoded);
    return { schemaVersion: 2, undo: legacy.undo, redo: legacy.redo, skipped: [] };
  }
  return Schema.decodeUnknownSync(taskEditHistoryPayloadSchema, { onExcessProperty: 'error' })(decoded);
}

export function parseTaskEditHistoryRows(rows: readonly TaskEditHistoryRowLike[]): TaskEditHistoryPayload {
  if (rows.length === 0) return emptyTaskEditHistory();
  if (rows.length !== 1 || rows[0]?.id !== TASK_EDIT_HISTORY_ROW_ID) {
    throw new Error('Saved task edit history has an invalid global identity.');
  }
  return parseTaskEditHistoryPayload(rows[0].payloadJson);
}

export function appendTaskEditAction(
  history: TaskEditHistoryPayload,
  session: TaskEditSessionPayload,
  createdAt: string,
): TaskEditHistoryPayload {
  const action: TaskEditAction = {
    actionId: session.sessionId,
    itemId: session.itemId,
    field: session.field,
    beforeValue: session.beforeValue,
    afterValue: session.currentValue,
    beforeFieldState: session.beforeFieldState,
    afterFieldState: session.currentFieldState,
    canonicalAtStart: session.canonicalAtStart,
    createdAt,
  };
  return { ...history, undo: [...history.undo, action], redo: [] };
}

export function moveTaskEditHistory(
  history: TaskEditHistoryPayload,
  direction: 'undo' | 'redo',
): { readonly history: TaskEditHistoryPayload; readonly action: TaskEditAction } | null {
  const source = direction === 'undo' ? history.undo : history.redo;
  const action = source.at(-1);
  if (action === undefined) return null;

  return direction === 'undo'
    ? {
        history: {
          ...history,
          undo: history.undo.slice(0, -1),
          redo: [...history.redo, action],
        },
        action,
      }
    : {
        history: {
          ...history,
          undo: [...history.undo, action],
          redo: history.redo.slice(0, -1),
        },
        action,
      };
}

export function parseCanonicalTaskFieldValue(
  payloadJson: string,
  itemId: string,
  field: TaskEditableField,
): string | null {
  let decodedJson: unknown;
  try {
    decodedJson = JSON.parse(payloadJson);
  } catch (cause) {
    throw new Error('Saved canonical snapshot is not valid JSON.', { cause });
  }
  const canonical = Schema.decodeUnknownSync(canonicalItemsSchema, { onExcessProperty: 'ignore' })(decodedJson);
  const item = canonical.items.find(candidate => candidate.id === itemId);
  if (item === undefined) return null;

  switch (field) {
    case 'title': return item.title;
    case 'sections.outcome': return item.sections?.outcome ?? '';
    case 'sections.completionCondition': return item.sections?.completionCondition ?? '';
    case 'sections.nextStep': return item.sections?.nextStep ?? '';
    case 'sections.evidence': return item.sections?.evidence ?? '';
    default: {
      const exhaustive: never = field;
      return exhaustive;
    }
  }
}

export function fieldStateForHistoryTarget({
  targetValue,
  targetFieldState,
  canonicalValueNow,
  canonicalAtStart,
}: {
  readonly targetValue: string;
  readonly targetFieldState: TaskDraftFieldValue | null;
  readonly canonicalValueNow: string | null;
  readonly canonicalAtStart: TaskEditCanonicalBaseline;
}): TaskDraftFieldValue | null {
  if (targetFieldState !== null) return targetFieldState;
  if (targetValue === canonicalValueNow) return null;
  return {
    value: targetValue,
    baseValue: canonicalAtStart.value,
    baseSourceCommit: canonicalAtStart.sourceCommit,
    baseContentRevision: canonicalAtStart.contentRevision,
  };
}

export function skipUnavailableTaskEdit(
  history: TaskEditHistoryPayload,
  direction: TaskEditHistoryDirection,
  expectedActionId: string,
  skippedAt: string,
): TaskEditHistoryPayload | null {
  const source = direction === 'undo' ? history.undo : history.redo;
  const action = source.at(-1);
  if (action === undefined || action.actionId !== expectedActionId) return null;
  return {
    ...history,
    undo: direction === 'undo' ? source.slice(0, -1) : history.undo,
    redo: direction === 'redo' ? source.slice(0, -1) : history.redo,
    skipped: [...history.skipped, { direction, action, skippedAt }],
  };
}
