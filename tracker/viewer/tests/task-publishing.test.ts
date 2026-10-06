import assert from 'node:assert/strict';
import { test } from 'bun:test';
import type { TaskEditHistoryPayload } from '../src/task-edit-history';
import type { TaskDraftFieldValue } from '../src/task-drafts';
import {
  canAdvanceTaskPublishTransaction,
  createFinalTaskPublishRequest,
  createFrozenTaskPublishRequest,
  createPendingTaskPublishTransaction,
  parseTaskPublishConflictResponse,
  parseTaskPublishReceipt,
  parseTaskPublishTransaction,
  rebaseTaskDraftFieldForPublishedField,
  rebaseTaskEditHistoryForPublishedField,
  taskPublishFieldValuesMatch,
  taskPublishReceiptMatchesRequest,
} from '../src/task-publishing';

const submittedTitle: TaskDraftFieldValue = {
  value: 'New title',
  baseValue: 'Old title',
  baseSourceCommit: 'source-1',
  baseContentRevision: 'content-1',
};

const request = createFrozenTaskPublishRequest([{
  id: 'task-content:task-1',
  recordId: 'task-1',
  updatedAt: '2026-10-03T00:00:00.000Z',
  payload: {
    schemaVersion: 1,
    fields: {
      title: submittedTitle,
      'sections.outcome': {
        value: '  First line\nSecond line  \n',
        baseValue: 'Old outcome',
        baseSourceCommit: 'source-1',
        baseContentRevision: 'content-1',
      },
    },
  },
}], 'request-1');

test('publish conflict decoding requires the frozen request ID and complete server envelope', () => {
  const conflict = {
    schemaVersion: 2,
    status: 'conflict',
    published: false,
    requestId: 'request-1',
    error: 'The repository field changed.',
    code: 'field-conflict',
    currentSourceCommit: 'source-2',
    conflicts: [{
      taskId: 'task-1',
      field: 'title',
      baseValue: 'Old title',
      currentValue: 'Repository title',
      proposedValue: 'New title',
      message: 'Refresh before preparing another request.',
    }],
  };
  assert.equal(parseTaskPublishConflictResponse(conflict, 'request-1').requestId, 'request-1');
  assert.throws(() => parseTaskPublishConflictResponse(conflict, 'request-2'), /different frozen request/);
  assert.throws(() => parseTaskPublishConflictResponse({ ...conflict, code: undefined }, 'request-1'));
});

test('publish reviews require explicit approval confirmation only for reviewed approved scope', () => {
  const prepared = {
    schemaVersion: 2 as const,
    status: 'ready-for-review' as const,
    published: false as const,
    requestId: 'request-1',
    currentSourceCommit: 'source-2',
    reviews: [{
      taskId: 'task-1',
      requiresApproval: true,
      reviewDigest: 'review-digest',
      title: 'Task title',
      approvedParts: ['outcome'],
      changes: [{ field: 'title', label: 'Title', before: 'Old title', after: 'New title' }],
      retained: [{ label: 'Owner', value: 'don' }],
    }],
  };
  const transaction = {
    ...createPendingTaskPublishTransaction(request, '2026-10-03T00:00:00.000Z'),
    phase: 'review-ready' as const,
    prepared,
  };
  assert.throws(() => createFinalTaskPublishRequest(transaction, new Set()), /Review every approved task scope/);
  assert.deepEqual(createFinalTaskPublishRequest(transaction, new Set(['task-1'])).approvals, [
    { taskId: 'task-1', reviewDigest: 'review-digest' },
  ]);

  const noRenewal = {
    ...transaction,
    prepared: { ...prepared, reviews: prepared.reviews.map(review => ({ ...review, requiresApproval: false })) },
  };
  assert.deepEqual(createFinalTaskPublishRequest(noRenewal, new Set()).approvals, []);

  const pending = createPendingTaskPublishTransaction(request, '2026-10-03T00:00:00.000Z');
  assert.equal(canAdvanceTaskPublishTransaction(pending, transaction, 'request-1', 'prepare-pending'), true);
  const changedRequest = {
    ...request,
    tasks: request.tasks.map(task => task.id === 'task-1'
      ? { ...task, fields: { ...task.fields, title: { ...submittedTitle, value: 'Changed after freeze' } } }
      : task),
  };
  assert.equal(canAdvanceTaskPublishTransaction(pending, { ...transaction, request: changedRequest }, 'request-1', 'prepare-pending'), false);

  const finalRequest = createFinalTaskPublishRequest(transaction, new Set(['task-1']));
  const finalPending = { ...transaction, phase: 'final-pending' as const, finalRequest };
  const committedReceipt = parseTaskPublishReceipt({
    schemaVersion: 2,
    status: 'committed',
    published: true,
    requestId: 'request-1',
    payloadHash: 'payload-hash',
    originalSourceCommit: 'source-2',
    commit: 'publish-commit',
    fields: [{ taskId: 'task-1', field: 'title', publishedValue: 'New title' }],
  }, 'request-1');
  const receiptRecorded = { ...finalPending, phase: 'receipt-recorded' as const, receipt: committedReceipt };
  const alteredFinalRequest = {
    ...finalRequest,
    approvals: [{ taskId: 'task-1', reviewDigest: 'changed-digest' }],
  };
  assert.equal(canAdvanceTaskPublishTransaction(
    finalPending,
    { ...receiptRecorded, finalRequest: alteredFinalRequest },
    'request-1',
    'final-pending',
  ), false);
  const ancestryProof = {
    ...receiptRecorded,
    receipt: { ...committedReceipt, source: { commit: 'source-3', includesPublishedCommit: true } },
  };
  assert.equal(canAdvanceTaskPublishTransaction(receiptRecorded, ancestryProof, 'request-1', 'receipt-recorded'), true);
  assert.equal(canAdvanceTaskPublishTransaction(receiptRecorded, {
    ...ancestryProof,
    receipt: { ...committedReceipt, source: { commit: 'source-3', includesPublishedCommit: true }, commit: 'other-commit' },
  }, 'request-1', 'receipt-recorded'), false);
});

test('receipt matching uses title and narrative normalization without weakening baseline matching', () => {
  const receipt = parseTaskPublishReceipt({
    schemaVersion: 2,
    status: 'committed',
    published: true,
    requestId: 'request-1',
    payloadHash: 'payload-hash',
    originalSourceCommit: 'source-1',
    commit: 'publish-commit',
    fields: [
      { taskId: 'task-1', field: 'title', publishedValue: 'New title' },
      { taskId: 'task-1', field: 'sections.outcome', publishedValue: '  First line\nSecond line' },
    ],
  }, 'request-1');
  assert.equal(taskPublishReceiptMatchesRequest(receipt, request), true);
  assert.equal(taskPublishFieldValuesMatch('title', ' New title\n', 'New title'), true);
  assert.equal(taskPublishFieldValuesMatch('sections.outcome', '\n  First line\nSecond line  \n\n', '  First line\nSecond line'), true);
  assert.equal(taskPublishFieldValuesMatch('sections.outcome', ' First line\nSecond line', 'First line\nSecond line'), false);
});

test('own publication rebases only matching field baselines and preserves visible undo values', () => {
  const action: TaskEditHistoryPayload['undo'][number] = {
    actionId: 'action-1',
    itemId: 'task-1',
    field: 'title',
    beforeValue: 'Old title',
    afterValue: 'New title',
    beforeFieldState: null,
    afterFieldState: submittedTitle,
    canonicalAtStart: { value: 'Old title', sourceCommit: 'source-1', contentRevision: 'content-1' },
    createdAt: '2026-10-03T00:00:01.000Z',
  };
  const history: TaskEditHistoryPayload = { schemaVersion: 2, undo: [action], redo: [], skipped: [] };
  const rebased = rebaseTaskEditHistoryForPublishedField({
    history,
    itemId: 'task-1',
    field: 'title',
    submitted: submittedTitle,
    publishedValue: 'New title',
    sourceCommit: 'publish-source',
    contentRevision: 'publish-content',
  });
  assert.equal(rebased.undo[0]?.beforeValue, 'Old title');
  assert.equal(rebased.undo[0]?.afterValue, 'New title');
  assert.deepEqual(rebased.undo[0]?.beforeFieldState, {
    value: 'Old title',
    baseValue: 'New title',
    baseSourceCommit: 'publish-source',
    baseContentRevision: 'publish-content',
  });
  assert.equal(rebased.undo[0]?.afterFieldState, null);
  assert.deepEqual(rebased.undo[0]?.canonicalAtStart, {
    value: 'New title',
    sourceCommit: 'publish-source',
    contentRevision: 'publish-content',
  });

  const newerDraft: TaskDraftFieldValue = {
    value: 'A newer edit',
    baseValue: 'Old title',
    baseSourceCommit: 'source-1',
    baseContentRevision: 'content-1',
  };
  assert.deepEqual(rebaseTaskDraftFieldForPublishedField({
    field: 'title',
    current: newerDraft,
    submitted: submittedTitle,
    publishedValue: 'New title',
    sourceCommit: 'publish-source',
    contentRevision: 'publish-content',
  }), {
    value: 'A newer edit',
    baseValue: 'New title',
    baseSourceCommit: 'publish-source',
    baseContentRevision: 'publish-content',
  });

  const unrelatedDraft: TaskDraftFieldValue = {
    value: 'External-baseline edit',
    baseValue: 'Outside the submitted family',
    baseSourceCommit: 'source-x',
    baseContentRevision: 'content-x',
  };
  assert.equal(rebaseTaskDraftFieldForPublishedField({
    field: 'title',
    current: unrelatedDraft,
    submitted: submittedTitle,
    publishedValue: 'New title',
    sourceCommit: 'publish-source',
    contentRevision: 'publish-content',
  }), unrelatedDraft);
});

test('a superseded receipt must retain persisted positive ancestry proof', () => {
  const receipt = {
    schemaVersion: 2 as const,
    status: 'committed' as const,
    published: true as const,
    requestId: 'request-1',
    payloadHash: 'payload-hash',
    originalSourceCommit: 'source-1',
    commit: 'publish-commit',
    fields: [{ taskId: 'task-1', field: 'title', publishedValue: 'New title' }],
    source: { commit: 'source-3', includesPublishedCommit: false },
  };
  const transaction = {
    schemaVersion: 1 as const,
    request,
    phase: 'receipt-superseded' as const,
    receipt,
    updatedAt: '2026-10-03T00:00:02.000Z',
  };
  assert.throws(() => parseTaskPublishTransaction(JSON.stringify(transaction)), /source proof/);
  const proved = { ...transaction, receipt: { ...receipt, source: { ...receipt.source, includesPublishedCommit: true } } };
  assert.equal(parseTaskPublishTransaction(JSON.stringify(proved)).phase, 'receipt-superseded');
});
