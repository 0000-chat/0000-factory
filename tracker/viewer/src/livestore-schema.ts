import { Events, makeSchema, Schema, State, type MaterializerContextQuery, type MaterializerResult } from '@livestore/livestore';
import {
  parseTaskDraftPayload,
  restoreTaskDraftPayloadField,
  taskDraftFieldSchema,
  taskDraftFieldValueSchema,
  TASK_CONTENT_DRAFT_COLLECTION,
  taskContentDraftId,
  updateTaskDraftPayload,
  TASK_EDITABLE_FIELDS,
  type TaskDraftFieldValue,
  type TaskEditableField,
} from './task-drafts';
import {
  appendTaskEditAction,
  emptyTaskEditHistory,
  fieldStateForHistoryTarget,
  moveTaskEditHistory,
  parseCanonicalTaskFieldValue,
  parseTaskEditHistoryPayload,
  parseTaskEditSessionPayload,
  parseTaskEditSessionRows,
  skipUnavailableTaskEdit,
  TASK_EDIT_HISTORY_ROW_ID,
  updateTaskEditSessionPayload,
  type TaskEditAction,
} from './task-edit-history';
import {
  canAdvanceTaskPublishTransaction,
  parseTaskPublishTransaction,
  parseTaskPublishTransactionRows,
  rebaseTaskDraftFieldForPublishedField,
  rebaseTaskEditHistoryForPublishedField,
  rebaseTaskEditSessionForPublishedField,
  taskDraftFieldStateMatches,
  taskPublishFieldValuesMatch,
  taskPublishReceiptMatchesRequest,
  TASK_PUBLISH_TRANSACTION_ROW_ID,
  type TaskPublishTransactionPayload,
} from './task-publishing';
import { trackerInstanceConfig } from './instance-config';

export const TRACKER_STORE_SCHEMA_VERSION = 3;
export const TRACKER_STORE_ID = trackerInstanceConfig.browser.storeId;

export const canonicalSnapshotTable = State.SQLite.table({
  name: 'tracker_canonical_snapshot',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    payloadJson: State.SQLite.text(),
    sourceCommit: State.SQLite.text(),
    contentRevision: State.SQLite.text(),
    snapshotSchemaVersion: State.SQLite.integer(),
    storeSchemaVersion: State.SQLite.integer(),
    savedAt: State.SQLite.text(),
  },
});

export const draftOverlayTable = State.SQLite.table({
  name: 'tracker_draft_overlay',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    collection: State.SQLite.text(),
    recordId: State.SQLite.text(),
    payloadJson: State.SQLite.text(),
    updatedAt: State.SQLite.text(),
  },
});

export const taskEditSessionTable = State.SQLite.table({
  name: 'tracker_task_edit_session',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    itemId: State.SQLite.text(),
    ownerId: State.SQLite.text(),
    payloadJson: State.SQLite.text(),
    updatedAt: State.SQLite.text(),
  },
});

export const taskEditHistoryTable = State.SQLite.table({
  name: 'tracker_task_edit_history',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    payloadJson: State.SQLite.text(),
    updatedAt: State.SQLite.text(),
  },
});

export const taskPublishTransactionTable = State.SQLite.table({
  name: 'tracker_task_publish_transaction',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    payloadJson: State.SQLite.text(),
    updatedAt: State.SQLite.text(),
  },
});

export type TrackerDraftOverlay = typeof draftOverlayTable.rowSchema.Type;
export type TrackerTaskEditSession = typeof taskEditSessionTable.rowSchema.Type;
export type TrackerTaskEditHistory = typeof taskEditHistoryTable.rowSchema.Type;
export type TrackerTaskPublishTransaction = typeof taskPublishTransactionTable.rowSchema.Type;

export const trackerTables = {
  canonicalSnapshot: canonicalSnapshotTable,
  draftOverlay: draftOverlayTable,
  taskEditSession: taskEditSessionTable,
  taskEditHistory: taskEditHistoryTable,
  taskPublishTransaction: taskPublishTransactionTable,
};

export const trackerEvents = {
  canonicalSnapshotReceived: Events.clientOnly({
    name: 'tracker.canonical-snapshot-received.v1',
    schema: Schema.Struct({
      payloadJson: Schema.String,
      sourceCommit: Schema.String,
      contentRevision: Schema.String,
      snapshotSchemaVersion: Schema.Number,
      savedAt: Schema.String,
    }),
  }),
  draftOverlaySaved: Events.clientOnly({
    name: 'tracker.draft-overlay-saved.v1',
    schema: Schema.Struct({
      id: Schema.String,
      collection: Schema.String,
      recordId: Schema.String,
      payloadJson: Schema.String,
      updatedAt: Schema.String,
    }),
  }),
  draftOverlayDiscarded: Events.clientOnly({
    name: 'tracker.draft-overlay-discarded.v1',
    schema: Schema.Struct({ id: Schema.String }),
  }),
  taskDraftFieldSet: Events.clientOnly({
    name: 'tracker.task-content-field-set.v1',
    schema: Schema.Struct({
      id: Schema.String,
      recordId: Schema.String,
      field: taskDraftFieldSchema,
      value: Schema.String,
      canonicalValue: Schema.String,
      sourceCommit: Schema.String,
      contentRevision: Schema.String,
      updatedAt: Schema.String,
    }),
  }),
  taskDraftFieldRestored: Events.clientOnly({
    name: 'tracker.task-content-field-restored.v1',
    schema: Schema.Struct({
      id: Schema.String,
      recordId: Schema.String,
      field: taskDraftFieldSchema,
      fieldState: Schema.Union(taskDraftFieldValueSchema, Schema.Null),
      updatedAt: Schema.String,
    }),
  }),
  taskEditSessionBegan: Events.clientOnly({
    name: 'tracker.task-edit-session-began.v1',
    schema: Schema.Struct({ payloadJson: Schema.String }),
  }),
  taskEditSessionValueChanged: Events.clientOnly({
    name: 'tracker.task-edit-session-value-changed.v1',
    schema: Schema.Struct({
      sessionId: Schema.String,
      ownerId: Schema.String,
      value: Schema.String,
      updatedAt: Schema.String,
    }),
  }),
  taskEditSessionFinished: Events.clientOnly({
    name: 'tracker.task-edit-session-finished.v1',
    schema: Schema.Struct({
      sessionId: Schema.String,
      ownerId: Schema.String,
      updatedAt: Schema.String,
    }),
  }),
  taskEditSessionCanceled: Events.clientOnly({
    name: 'tracker.task-edit-session-canceled.v1',
    schema: Schema.Struct({
      sessionId: Schema.String,
      ownerId: Schema.String,
      updatedAt: Schema.String,
    }),
  }),
  taskEditSessionRecovered: Events.clientOnly({
    name: 'tracker.task-edit-session-recovered.v1',
    schema: Schema.Struct({
      sessionId: Schema.String,
      ownerId: Schema.String,
      recoveredByOwnerId: Schema.String,
      updatedAt: Schema.String,
    }),
  }),
  taskEditHistoryUndoRequested: Events.clientOnly({
    name: 'tracker.task-edit-history-undo-requested.v1',
    schema: Schema.Struct({ requesterOwnerId: Schema.String, expectedActionId: Schema.String, updatedAt: Schema.String }),
  }),
  taskEditHistoryRedoRequested: Events.clientOnly({
    name: 'tracker.task-edit-history-redo-requested.v1',
    schema: Schema.Struct({ requesterOwnerId: Schema.String, expectedActionId: Schema.String, updatedAt: Schema.String }),
  }),
  taskEditHistoryUnavailableSkipped: Events.clientOnly({
    name: 'tracker.task-edit-history-unavailable-skipped.v1',
    schema: Schema.Struct({
      direction: Schema.Union(Schema.Literal('undo'), Schema.Literal('redo')),
      expectedActionId: Schema.String,
      requesterOwnerId: Schema.String,
      updatedAt: Schema.String,
    }),
  }),
  taskPublishTransactionSaved: Events.clientOnly({
    name: 'tracker.task-publish-transaction-saved.v1',
    schema: Schema.Struct({
      expectedRequestId: Schema.Union(Schema.String, Schema.Null),
      expectedPhase: Schema.Union(
        Schema.Literal('prepare-pending'),
        Schema.Literal('review-ready'),
        Schema.Literal('final-pending'),
        Schema.Literal('receipt-recorded'),
        Schema.Literal('receipt-superseded'),
        Schema.Literal('conflict'),
        Schema.Literal('canceled'),
        Schema.Literal('complete'),
        Schema.Null,
      ),
      payloadJson: Schema.String,
      updatedAt: Schema.String,
    }),
  }),
  taskPublishSourceConfirmed: Events.clientOnly({
    name: 'tracker.task-publish-source-confirmed.v1',
    schema: Schema.Struct({
      requestId: Schema.String,
      sourceCommit: Schema.String,
      contentRevision: Schema.String,
      updatedAt: Schema.String,
    }),
  }),
  taskPublishReceiptSuperseded: Events.clientOnly({
    name: 'tracker.task-publish-receipt-superseded.v1',
    schema: Schema.Struct({
      requestId: Schema.String,
      sourceCommit: Schema.String,
      contentRevision: Schema.String,
      updatedAt: Schema.String,
    }),
  }),
  taskDraftConflictDiscarded: Events.clientOnly({
    name: 'tracker.task-draft-conflict-discarded.v1',
    schema: Schema.Struct({
      requestId: Schema.String,
      actionId: Schema.String,
      itemId: Schema.String,
      field: taskDraftFieldSchema,
      repositoryCurrentValue: Schema.String,
      expectedFieldState: Schema.Union(taskDraftFieldValueSchema, Schema.Null),
      sourceCommit: Schema.String,
      contentRevision: Schema.String,
      updatedAt: Schema.String,
    }),
  }),
};

function taskDraftRow(query: MaterializerContextQuery, itemId: string): TrackerDraftOverlay | undefined {
  const row = query(draftOverlayTable.select().where({ id: taskContentDraftId(itemId) }).first());
  if (row !== undefined && (
    row.collection !== TASK_CONTENT_DRAFT_COLLECTION
    || row.recordId !== itemId
  )) {
    throw new Error(`Saved task draft ${row.id} belongs to a different record.`);
  }
  return row;
}

function taskDraftPayload(row: TrackerDraftOverlay | undefined) {
  return row === undefined ? null : parseTaskDraftPayload(row.payloadJson);
}

function taskEditSessionRow(query: MaterializerContextQuery, sessionId: string): TrackerTaskEditSession | undefined {
  const row = query(taskEditSessionTable.select().where({ id: sessionId }).first());
  if (row === undefined) return undefined;
  const session = parseTaskEditSessionPayload(row.payloadJson);
  if (row.id !== session.sessionId || row.itemId !== session.itemId || row.ownerId !== session.ownerId) {
    throw new Error(`Saved task edit session ${row.id} has mismatched identity metadata.`);
  }
  return row;
}

function taskDraftFieldMutations({
  existingRow,
  itemId,
  field,
  fieldState,
  updatedAt,
}: {
  readonly existingRow: TrackerDraftOverlay | undefined;
  readonly itemId: string;
  readonly field: TaskEditableField;
  readonly fieldState: TaskDraftFieldValue | null;
  readonly updatedAt: string;
}) {
  const id = taskContentDraftId(itemId);
  const payload = restoreTaskDraftPayloadField({
    existing: taskDraftPayload(existingRow),
    field,
    fieldState,
  });
  if (payload === null) {
    return existingRow === undefined ? [] : [draftOverlayTable.delete().where({ id })];
  }

  const row = {
    id,
    collection: TASK_CONTENT_DRAFT_COLLECTION,
    recordId: itemId,
    payloadJson: JSON.stringify(payload),
    updatedAt,
  };
  return existingRow === undefined
    ? [draftOverlayTable.insert(row)]
    : [draftOverlayTable.update({
        collection: row.collection,
        recordId: row.recordId,
        payloadJson: row.payloadJson,
        updatedAt: row.updatedAt,
      }).where({ id })];
}

function taskEditHistoryRow(query: MaterializerContextQuery): TrackerTaskEditHistory | undefined {
  return query(taskEditHistoryTable.select().where({ id: TASK_EDIT_HISTORY_ROW_ID }).first());
}

function taskEditHistoryMutation(
  existingRow: TrackerTaskEditHistory | undefined,
  history: ReturnType<typeof emptyTaskEditHistory>,
  updatedAt: string,
) {
  const row = { id: TASK_EDIT_HISTORY_ROW_ID, payloadJson: JSON.stringify(history), updatedAt };
  return existingRow === undefined
    ? taskEditHistoryTable.insert(row)
    : taskEditHistoryTable.update({ payloadJson: row.payloadJson, updatedAt }).where({ id: TASK_EDIT_HISTORY_ROW_ID });
}

function taskPublishTransactionRow(query: MaterializerContextQuery): TrackerTaskPublishTransaction | undefined {
  return query(taskPublishTransactionTable.select().where({ id: TASK_PUBLISH_TRANSACTION_ROW_ID }).first());
}

function isTaskEditableField(field: string): field is TaskEditableField {
  return TASK_EDITABLE_FIELDS.some(candidate => candidate === field);
}

function taskPublishReceiptMatchesCanonicalPayload(
  receipt: NonNullable<TaskPublishTransactionPayload['receipt']>,
  payloadJson: string,
): boolean {
  try {
    return receipt.fields.every(entry => {
      if (!isTaskEditableField(entry.field)) return false;
      const canonicalValue = parseCanonicalTaskFieldValue(payloadJson, entry.taskId, entry.field);
      return canonicalValue !== null && taskPublishFieldValuesMatch(entry.field, canonicalValue, entry.publishedValue);
    });
  } catch {
    return false;
  }
}

function publishSubmittedField(
  transaction: TaskPublishTransactionPayload,
  itemId: string,
  field: TaskEditableField,
): TaskDraftFieldValue | undefined {
  return transaction.request.tasks.find(task => task.id === itemId)?.fields[field];
}

function taskPublishSourceConfirmed({
  requestId,
  sourceCommit,
  contentRevision,
  updatedAt,
  query,
}: {
  readonly requestId: string;
  readonly sourceCommit: string;
  readonly contentRevision: string;
  readonly updatedAt: string;
  readonly query: MaterializerContextQuery;
}) {
  const transactionRow = taskPublishTransactionRow(query);
  if (transactionRow === undefined) return [];
  const transaction = parseTaskPublishTransaction(transactionRow.payloadJson);
  if (transaction.request.requestId !== requestId || transaction.phase !== 'receipt-recorded' || transaction.receipt === undefined) return [];
  if (!taskPublishReceiptMatchesRequest(transaction.receipt, transaction.request)) return [];
  const sourceProof = transaction.receipt.source;
  if (sourceProof === undefined || sourceProof.commit !== sourceCommit || sourceProof.includesPublishedCommit !== true) return [];

  const canonical = query(canonicalSnapshotTable.select().where({ id: 'canonical' }).first());
  if (canonical === undefined || canonical.sourceCommit !== sourceCommit || canonical.contentRevision !== contentRevision) return [];
  if (!taskPublishReceiptMatchesCanonicalPayload(transaction.receipt, canonical.payloadJson)) return [];

  const existingDraftRows = new Map<string, TrackerDraftOverlay>();
  const overlays = query(draftOverlayTable.select());
  for (const itemId of transaction.request.tasks.map(task => task.id)) {
    const row = overlays.find(candidate => candidate.id === taskContentDraftId(itemId));
    if (row !== undefined) existingDraftRows.set(itemId, row);
  }

  const nextDraftFields = new Map<string, ReturnType<typeof taskDraftPayload>>();
  for (const [itemId, row] of existingDraftRows) nextDraftFields.set(itemId, taskDraftPayload(row));
  const changedDraftItems = new Set<string>();
  let nextHistory = emptyTaskEditHistory();
  const historyRow = taskEditHistoryRow(query);
  if (historyRow !== undefined) nextHistory = parseTaskEditHistoryPayload(historyRow.payloadJson);
  let historyChanged = false;

  const changedSessions = new Map<string, { readonly row: TrackerTaskEditSession; readonly payloadJson: string }>();
  const sessionRows = query(taskEditSessionTable.select());
  const sessions = parseTaskEditSessionRows(sessionRows);

  for (const receiptField of transaction.receipt.fields) {
    if (!isTaskEditableField(receiptField.field)) return [];
    const field = receiptField.field;
    const submitted = publishSubmittedField(transaction, receiptField.taskId, field);
    if (submitted === undefined) return [];

    const existingPayload = nextDraftFields.get(receiptField.taskId) ?? null;
    const currentFieldState = existingPayload?.fields[field] ?? null;
    const nextFieldState = rebaseTaskDraftFieldForPublishedField({
      field,
      current: currentFieldState,
      submitted,
      publishedValue: receiptField.publishedValue,
      sourceCommit,
      contentRevision,
    });
    if (!taskDraftFieldStateMatches(currentFieldState, nextFieldState)) {
      nextDraftFields.set(receiptField.taskId, restoreTaskDraftPayloadField({
        existing: existingPayload,
        field,
        fieldState: nextFieldState,
      }));
      changedDraftItems.add(receiptField.taskId);
    }

    const rebasedHistory = rebaseTaskEditHistoryForPublishedField({
      history: nextHistory,
      itemId: receiptField.taskId,
      field,
      submitted,
      publishedValue: receiptField.publishedValue,
      sourceCommit,
      contentRevision,
    });
    if (JSON.stringify(rebasedHistory) !== JSON.stringify(nextHistory)) {
      nextHistory = rebasedHistory;
      historyChanged = true;
    }

    for (const session of sessions) {
      const rebased = rebaseTaskEditSessionForPublishedField({
        session,
        itemId: receiptField.taskId,
        field,
        submitted,
        publishedValue: receiptField.publishedValue,
        sourceCommit,
        contentRevision,
      });
      if (rebased !== session) {
        const row = sessionRows.find(candidate => candidate.id === session.sessionId);
        if (row !== undefined) changedSessions.set(session.sessionId, { row, payloadJson: JSON.stringify(rebased) });
      }
    }
  }

  const draftMutations: MaterializerResult[] = [];
  for (const [itemId, payload] of nextDraftFields) {
    if (!changedDraftItems.has(itemId)) continue;
    const existingRow = existingDraftRows.get(itemId);
    if (payload === null) {
      if (existingRow !== undefined) draftMutations.push(draftOverlayTable.delete().where({ id: existingRow.id }));
      continue;
    }
    const row = {
      id: taskContentDraftId(itemId),
      collection: TASK_CONTENT_DRAFT_COLLECTION,
      recordId: itemId,
      payloadJson: JSON.stringify(payload),
      updatedAt,
    };
    if (existingRow === undefined) draftMutations.push(draftOverlayTable.insert(row));
    else draftMutations.push(draftOverlayTable.update({ payloadJson: row.payloadJson, updatedAt }).where({ id: row.id }));
  }
  const nextTransaction: TaskPublishTransactionPayload = {
    ...transaction,
    phase: 'complete',
    confirmedSource: { sourceCommit, contentRevision, includesPublishedCommit: true },
    updatedAt,
  };
  return [
    ...draftMutations,
    ...(historyChanged ? [taskEditHistoryMutation(historyRow, nextHistory, updatedAt)] : []),
    ...[...changedSessions.values()].map(({ row, payloadJson }) => taskEditSessionTable.update({ payloadJson, updatedAt }).where({ id: row.id })),
    taskPublishTransactionTable.update({ payloadJson: JSON.stringify(nextTransaction), updatedAt }).where({ id: TASK_PUBLISH_TRANSACTION_ROW_ID }),
  ];
}

function taskPublishReceiptSuperseded({
  requestId,
  sourceCommit,
  contentRevision,
  updatedAt,
  query,
}: {
  readonly requestId: string;
  readonly sourceCommit: string;
  readonly contentRevision: string;
  readonly updatedAt: string;
  readonly query: MaterializerContextQuery;
}) {
  const transactionRow = taskPublishTransactionRow(query);
  if (transactionRow === undefined) return [];
  const transaction = parseTaskPublishTransaction(transactionRow.payloadJson);
  if (transaction.request.requestId !== requestId || transaction.phase !== 'receipt-recorded' || transaction.receipt === undefined) return [];
  if (!taskPublishReceiptMatchesRequest(transaction.receipt, transaction.request)) return [];
  const sourceProof = transaction.receipt.source;
  if (sourceProof === undefined || sourceProof.commit !== sourceCommit || sourceProof.includesPublishedCommit !== true) return [];

  const canonical = query(canonicalSnapshotTable.select().where({ id: 'canonical' }).first());
  if (canonical === undefined || canonical.sourceCommit !== sourceCommit || canonical.contentRevision !== contentRevision) return [];
  if (taskPublishReceiptMatchesCanonicalPayload(transaction.receipt, canonical.payloadJson)) return [];

  const nextTransaction: TaskPublishTransactionPayload = {
    ...transaction,
    phase: 'receipt-superseded',
    updatedAt,
  };
  return taskPublishTransactionTable.update({ payloadJson: JSON.stringify(nextTransaction), updatedAt })
    .where({ id: TASK_PUBLISH_TRANSACTION_ROW_ID });
}

function discardConflictedTaskDraftField({
  requestId,
  actionId,
  itemId,
  field,
  repositoryCurrentValue,
  expectedFieldState,
  sourceCommit,
  contentRevision,
  updatedAt,
  query,
}: {
  readonly requestId: string;
  readonly actionId: string;
  readonly itemId: string;
  readonly field: TaskEditableField;
  readonly repositoryCurrentValue: string;
  readonly expectedFieldState: TaskDraftFieldValue | null;
  readonly sourceCommit: string;
  readonly contentRevision: string;
  readonly updatedAt: string;
  readonly query: MaterializerContextQuery;
}) {
  const transactionRow = taskPublishTransactionRow(query);
  if (transactionRow === undefined) return [];
  const transaction = parseTaskPublishTransaction(transactionRow.payloadJson);
  if (transaction.phase !== 'canceled' || transaction.request.requestId !== requestId || transaction.conflict === undefined) return [];
  const conflict = transaction.conflict.conflicts.find(entry => entry.taskId === itemId && entry.field === field);
  if (conflict === undefined || !taskPublishFieldValuesMatch(field, conflict.currentValue, repositoryCurrentValue)) return [];
  const canonical = query(canonicalSnapshotTable.select().where({ id: 'canonical' }).first());
  if (canonical === undefined || canonical.sourceCommit !== sourceCommit || canonical.contentRevision !== contentRevision) return [];
  const canonicalValue = currentCanonicalFieldValue(query, itemId, field);
  if (canonicalValue === null) return [];
  const activeSessions = parseTaskEditSessionRows(query(taskEditSessionTable.select().where({ itemId })));
  if (activeSessions.some(session => session.field === field)) return [];

  const existingDraft = taskDraftRow(query, itemId);
  const payload = taskDraftPayload(existingDraft);
  const currentFieldState = payload?.fields[field] ?? null;
  if (!taskDraftFieldStateMatches(currentFieldState, expectedFieldState)) return [];
  const historyRow = taskEditHistoryRow(query);
  let history = historyRow === undefined ? emptyTaskEditHistory() : parseTaskEditHistoryPayload(historyRow.payloadJson);
  if (currentFieldState !== null && currentFieldState.value !== canonicalValue) {
    const action: TaskEditAction = {
      actionId,
      itemId,
      field,
      beforeValue: currentFieldState.value,
      afterValue: canonicalValue,
      beforeFieldState: currentFieldState,
      afterFieldState: null,
      canonicalAtStart: { value: canonicalValue, sourceCommit, contentRevision },
      createdAt: updatedAt,
    };
    history = { ...history, undo: [...history.undo, action], redo: [] };
  }
  return [
    ...taskDraftFieldMutations({ existingRow: existingDraft, itemId, field, fieldState: null, updatedAt }),
    ...(currentFieldState !== null && currentFieldState.value !== canonicalValue
      ? [taskEditHistoryMutation(historyRow, history, updatedAt)]
      : []),
  ];
}

function currentCanonicalFieldValue(
  query: MaterializerContextQuery,
  itemId: string,
  field: TaskEditableField,
): string | null {
  const canonical = query(canonicalSnapshotTable.select().where({ id: 'canonical' }).first());
  return canonical === undefined
    ? null
    : parseCanonicalTaskFieldValue(canonical.payloadJson, itemId, field);
}

function fieldStateForLiveEdit({
  value,
  currentCanonicalValue,
  existingFieldState,
  beforeFieldState,
  canonicalAtStart,
}: {
  readonly value: string;
  readonly currentCanonicalValue: string | null;
  readonly existingFieldState: TaskDraftFieldValue | undefined;
  readonly beforeFieldState: TaskDraftFieldValue | null;
  readonly canonicalAtStart: { readonly value: string; readonly sourceCommit: string; readonly contentRevision: string };
}): TaskDraftFieldValue | null {
  if (value === currentCanonicalValue) return null;
  const baseline = existingFieldState ?? beforeFieldState;
  return {
    value,
    baseValue: baseline?.baseValue ?? canonicalAtStart.value,
    baseSourceCommit: baseline?.baseSourceCommit ?? canonicalAtStart.sourceCommit,
    baseContentRevision: baseline?.baseContentRevision ?? canonicalAtStart.contentRevision,
  };
}

function finalizeTaskEditSession({
  sessionId,
  ownerId,
  updatedAt,
  query,
}: {
  readonly sessionId: string;
  readonly ownerId: string;
  readonly updatedAt: string;
  readonly query: MaterializerContextQuery;
}) {
  const sessionRow = taskEditSessionRow(query, sessionId);
  if (sessionRow === undefined || sessionRow.ownerId !== ownerId) return [];

  const session = parseTaskEditSessionPayload(sessionRow.payloadJson);
  if (session.sessionId !== sessionId || session.ownerId !== ownerId) return [];
  const existingDraft = taskDraftRow(query, session.itemId);
  const canonicalValueNow = currentCanonicalFieldValue(query, session.itemId, session.field);
  const historyRow = taskEditHistoryRow(query);
  const history = historyRow === undefined ? emptyTaskEditHistory() : parseTaskEditHistoryPayload(historyRow.payloadJson);
  const removeSession = taskEditSessionTable.delete().where({ id: sessionId });

  if (session.currentValue === session.beforeValue) {
    const restoredState = fieldStateForHistoryTarget({
      targetValue: session.beforeValue,
      targetFieldState: session.beforeFieldState,
      canonicalValueNow,
      canonicalAtStart: session.canonicalAtStart,
    });
    return [
      ...taskDraftFieldMutations({
        existingRow: existingDraft,
        itemId: session.itemId,
        field: session.field,
        fieldState: restoredState,
        updatedAt,
      }),
      removeSession,
    ];
  }

  const afterFieldState = fieldStateForHistoryTarget({
    targetValue: session.currentValue,
    targetFieldState: session.currentFieldState,
    canonicalValueNow,
    canonicalAtStart: session.canonicalAtStart,
  });
  const finalized = updateTaskEditSessionPayload({
    session,
    value: session.currentValue,
    fieldState: afterFieldState,
    updatedAt,
  });
  const nextHistory = appendTaskEditAction(history, finalized, updatedAt);
  return [
    ...taskDraftFieldMutations({
      existingRow: existingDraft,
      itemId: session.itemId,
      field: session.field,
      fieldState: afterFieldState,
      updatedAt,
    }),
    taskEditHistoryMutation(historyRow, nextHistory, updatedAt),
    removeSession,
  ];
}

function cancelTaskEditSession({
  sessionId,
  ownerId,
  updatedAt,
  query,
}: {
  readonly sessionId: string;
  readonly ownerId: string;
  readonly updatedAt: string;
  readonly query: MaterializerContextQuery;
}) {
  const sessionRow = taskEditSessionRow(query, sessionId);
  if (sessionRow === undefined || sessionRow.ownerId !== ownerId) return [];
  const session = parseTaskEditSessionPayload(sessionRow.payloadJson);
  if (session.sessionId !== sessionId || session.ownerId !== ownerId) return [];

  const existingDraft = taskDraftRow(query, session.itemId);
  const canonicalValueNow = currentCanonicalFieldValue(query, session.itemId, session.field);
  const restoredState = fieldStateForHistoryTarget({
    targetValue: session.beforeValue,
    targetFieldState: session.beforeFieldState,
    canonicalValueNow,
    canonicalAtStart: session.canonicalAtStart,
  });
  return [
    ...taskDraftFieldMutations({
      existingRow: existingDraft,
      itemId: session.itemId,
      field: session.field,
      fieldState: restoredState,
      updatedAt,
    }),
    taskEditSessionTable.delete().where({ id: sessionId }),
  ];
}

function moveGlobalTaskEditHistory({
  direction,
  expectedActionId,
  updatedAt,
  query,
}: {
  readonly direction: 'undo' | 'redo';
  readonly expectedActionId: string;
  readonly updatedAt: string;
  readonly query: MaterializerContextQuery;
}) {
  const historyRow = taskEditHistoryRow(query);
  if (historyRow === undefined) return [];
  const history = parseTaskEditHistoryPayload(historyRow.payloadJson);
  const source = direction === 'undo' ? history.undo : history.redo;
  if (source.at(-1)?.actionId !== expectedActionId) return [];
  const moved = moveTaskEditHistory(history, direction);
  if (moved === null) return [];

  const activeItemSessions = query(taskEditSessionTable.select().where({ itemId: moved.action.itemId }));
  if (parseTaskEditSessionRows(activeItemSessions).some(session => session.field === moved.action.field)) return [];

  const existingDraft = taskDraftRow(query, moved.action.itemId);
  const canonicalValueNow = currentCanonicalFieldValue(query, moved.action.itemId, moved.action.field);
  if (canonicalValueNow === null) return [];
  const targetValue = direction === 'undo' ? moved.action.beforeValue : moved.action.afterValue;
  const targetFieldState = direction === 'undo' ? moved.action.beforeFieldState : moved.action.afterFieldState;
  const fieldState = fieldStateForHistoryTarget({
    targetValue,
    targetFieldState,
    canonicalValueNow,
    canonicalAtStart: moved.action.canonicalAtStart,
  });
  return [
    ...taskDraftFieldMutations({
      existingRow: existingDraft,
      itemId: moved.action.itemId,
      field: moved.action.field,
      fieldState,
      updatedAt,
    }),
    taskEditHistoryMutation(historyRow, moved.history, updatedAt),
  ];
}

function skipUnavailableGlobalTaskEdit({
  direction,
  expectedActionId,
  updatedAt,
  query,
}: {
  readonly direction: 'undo' | 'redo';
  readonly expectedActionId: string;
  readonly updatedAt: string;
  readonly query: MaterializerContextQuery;
}) {
  const historyRow = taskEditHistoryRow(query);
  const canonicalRow = query(canonicalSnapshotTable.select().where({ id: 'canonical' }).first());
  if (historyRow === undefined || canonicalRow === undefined) return [];
  const history = parseTaskEditHistoryPayload(historyRow.payloadJson);
  const source = direction === 'undo' ? history.undo : history.redo;
  const action = source.at(-1);
  if (action === undefined || action.actionId !== expectedActionId) return [];
  if (currentCanonicalFieldValue(query, action.itemId, action.field) !== null) return [];
  const activeItemSessions = query(taskEditSessionTable.select().where({ itemId: action.itemId }));
  if (parseTaskEditSessionRows(activeItemSessions).some(session => session.field === action.field)) return [];
  const skipped = skipUnavailableTaskEdit(history, direction, expectedActionId, updatedAt);
  if (skipped === null) return [];
  return taskEditHistoryMutation(historyRow, skipped, updatedAt);
}

const materializers = State.SQLite.materializers(trackerEvents, {
  'tracker.canonical-snapshot-received.v1': (event, { query }) => {
    const row = {
      payloadJson: event.payloadJson,
      sourceCommit: event.sourceCommit,
      contentRevision: event.contentRevision,
      snapshotSchemaVersion: event.snapshotSchemaVersion,
      storeSchemaVersion: TRACKER_STORE_SCHEMA_VERSION,
      savedAt: event.savedAt,
    };
    return query(canonicalSnapshotTable.select().where({ id: 'canonical' }).first()) === undefined
      ? canonicalSnapshotTable.insert({ id: 'canonical', ...row })
      : canonicalSnapshotTable.update(row).where({ id: 'canonical' });
  },
  'tracker.draft-overlay-saved.v1': (event, { query }) => {
    const existing = query(draftOverlayTable.select().where({ id: event.id }).first());
    return existing === undefined
      ? draftOverlayTable.insert(event)
      : draftOverlayTable.update({
          collection: event.collection,
          recordId: event.recordId,
          payloadJson: event.payloadJson,
          updatedAt: event.updatedAt,
        }).where({ id: event.id });
  },
  'tracker.draft-overlay-discarded.v1': ({ id }) => draftOverlayTable.delete().where({ id }),
  'tracker.task-content-field-set.v1': (event, { query }) => {
    if (event.id !== taskContentDraftId(event.recordId)) {
      throw new Error(`Task draft field event ${event.id} has an invalid item identity.`);
    }
    const existingRow = query(draftOverlayTable.select().where({ id: event.id }).first());
    if (existingRow !== undefined && (
      existingRow.collection !== TASK_CONTENT_DRAFT_COLLECTION
      || existingRow.recordId !== event.recordId
    )) {
      throw new Error(`Saved task draft ${event.id} belongs to a different record.`);
    }
    const existing = existingRow === undefined ? null : parseTaskDraftPayload(existingRow.payloadJson);
    const payload = updateTaskDraftPayload({
      existing,
      field: event.field,
      value: event.value,
      canonicalValue: event.canonicalValue,
      sourceCommit: event.sourceCommit,
      contentRevision: event.contentRevision,
    });
    if (payload === null) return draftOverlayTable.delete().where({ id: event.id });
    const row = {
      id: event.id,
      collection: TASK_CONTENT_DRAFT_COLLECTION,
      recordId: event.recordId,
      payloadJson: JSON.stringify(payload),
      updatedAt: event.updatedAt,
    };
    return existingRow === undefined
      ? draftOverlayTable.insert(row)
      : draftOverlayTable.update({
          collection: row.collection,
          recordId: row.recordId,
          payloadJson: row.payloadJson,
          updatedAt: row.updatedAt,
        }).where({ id: event.id });
  },
  'tracker.task-content-field-restored.v1': (event, { query }) => {
    if (event.id !== taskContentDraftId(event.recordId)) {
      throw new Error(`Task draft restore event ${event.id} has an invalid item identity.`);
    }
    const existingRow = query(draftOverlayTable.select().where({ id: event.id }).first());
    if (existingRow !== undefined && (
      existingRow.collection !== TASK_CONTENT_DRAFT_COLLECTION
      || existingRow.recordId !== event.recordId
    )) {
      throw new Error(`Saved task draft ${event.id} belongs to a different record.`);
    }
    const existing = existingRow === undefined ? null : parseTaskDraftPayload(existingRow.payloadJson);
    const payload = restoreTaskDraftPayloadField({
      existing,
      field: event.field,
      fieldState: event.fieldState,
    });
    if (payload === null) return draftOverlayTable.delete().where({ id: event.id });
    const row = {
      id: event.id,
      collection: TASK_CONTENT_DRAFT_COLLECTION,
      recordId: event.recordId,
      payloadJson: JSON.stringify(payload),
      updatedAt: event.updatedAt,
    };
    return existingRow === undefined
      ? draftOverlayTable.insert(row)
      : draftOverlayTable.update({
          collection: row.collection,
          recordId: row.recordId,
          payloadJson: row.payloadJson,
          updatedAt: row.updatedAt,
      }).where({ id: event.id });
  },
  'tracker.task-edit-session-began.v1': ({ payloadJson }, { query }) => {
    const session = parseTaskEditSessionPayload(payloadJson);
    if (session.sessionId.length === 0 || session.ownerId.length === 0 || session.itemId.length === 0) {
      throw new Error('Task edit session identity cannot be empty.');
    }
    if (
      session.currentValue !== session.beforeValue
      || JSON.stringify(session.currentFieldState) !== JSON.stringify(session.beforeFieldState)
    ) {
      throw new Error(`Task edit session ${session.sessionId} does not start from its before state.`);
    }

    const existing = taskEditSessionRow(query, session.sessionId);
    if (existing !== undefined) return [];
    const openSessions = query(taskEditSessionTable.select().where({ itemId: session.itemId }));
    if (parseTaskEditSessionRows(openSessions).some(candidate => candidate.field === session.field)) return [];

    return taskEditSessionTable.insert({
      id: session.sessionId,
      itemId: session.itemId,
      ownerId: session.ownerId,
      payloadJson: JSON.stringify(session),
      updatedAt: session.updatedAt,
    });
  },
  'tracker.task-edit-session-value-changed.v1': (event, { query }) => {
    const sessionRow = taskEditSessionRow(query, event.sessionId);
    if (sessionRow === undefined || sessionRow.ownerId !== event.ownerId) return [];
    const session = parseTaskEditSessionPayload(sessionRow.payloadJson);
    const existingDraft = taskDraftRow(query, session.itemId);
    const existingPayload = taskDraftPayload(existingDraft);
    const canonicalValueNow = currentCanonicalFieldValue(query, session.itemId, session.field);
    const fieldState = fieldStateForLiveEdit({
      value: event.value,
      currentCanonicalValue: canonicalValueNow,
      existingFieldState: existingPayload?.fields[session.field],
      beforeFieldState: session.beforeFieldState,
      canonicalAtStart: session.canonicalAtStart,
    });
    const updatedSession = updateTaskEditSessionPayload({ session, value: event.value, fieldState, updatedAt: event.updatedAt });
    return [
      ...taskDraftFieldMutations({
        existingRow: existingDraft,
        itemId: session.itemId,
        field: session.field,
        fieldState,
        updatedAt: event.updatedAt,
      }),
      taskEditSessionTable.update({ payloadJson: JSON.stringify(updatedSession), updatedAt: event.updatedAt }).where({ id: session.sessionId }),
    ];
  },
  'tracker.task-edit-session-finished.v1': (event, context) => finalizeTaskEditSession({ ...event, query: context.query }),
  'tracker.task-edit-session-canceled.v1': (event, context) => cancelTaskEditSession({ ...event, query: context.query }),
  'tracker.task-edit-session-recovered.v1': ({ sessionId, ownerId, updatedAt }, context) =>
    finalizeTaskEditSession({ sessionId, ownerId, updatedAt, query: context.query }),
  'tracker.task-edit-history-undo-requested.v1': ({ expectedActionId, updatedAt }, context) =>
    moveGlobalTaskEditHistory({ direction: 'undo', expectedActionId, updatedAt, query: context.query }),
  'tracker.task-edit-history-redo-requested.v1': ({ expectedActionId, updatedAt }, context) =>
    moveGlobalTaskEditHistory({ direction: 'redo', expectedActionId, updatedAt, query: context.query }),
  'tracker.task-edit-history-unavailable-skipped.v1': ({ direction, expectedActionId, updatedAt }, context) =>
    skipUnavailableGlobalTaskEdit({ direction, expectedActionId, updatedAt, query: context.query }),
  'tracker.task-publish-transaction-saved.v1': ({ expectedRequestId, expectedPhase, payloadJson, updatedAt }, { query }) => {
    const next = parseTaskPublishTransaction(payloadJson);
    if (next.updatedAt !== updatedAt) throw new Error('Task publish transaction event has mismatched update metadata.');
    const existing = taskPublishTransactionRow(query);
    const current = existing === undefined
      ? null
      : parseTaskPublishTransactionRows([{ id: existing.id, payloadJson: existing.payloadJson }]);
    if (!canAdvanceTaskPublishTransaction(current, next, expectedRequestId, expectedPhase)) return [];
    if (existing === undefined) {
      return taskPublishTransactionTable.insert({
        id: TASK_PUBLISH_TRANSACTION_ROW_ID,
        payloadJson,
        updatedAt,
      });
    }
    return taskPublishTransactionTable.update({ payloadJson, updatedAt }).where({ id: TASK_PUBLISH_TRANSACTION_ROW_ID });
  },
  'tracker.task-publish-source-confirmed.v1': (event, context) => taskPublishSourceConfirmed({ ...event, query: context.query }),
  'tracker.task-publish-receipt-superseded.v1': (event, context) => taskPublishReceiptSuperseded({ ...event, query: context.query }),
  'tracker.task-draft-conflict-discarded.v1': (event, context) => discardConflictedTaskDraftField({ ...event, query: context.query }),
});

const state = State.SQLite.makeState({ tables: trackerTables, materializers });

export const trackerSchema = makeSchema({ state, events: trackerEvents });
