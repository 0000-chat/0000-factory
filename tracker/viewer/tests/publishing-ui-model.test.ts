import assert from 'node:assert/strict';
import { test } from 'bun:test';
import type { TaskDraftPublishState } from '../src/router-context';
import type { ParsedTaskContentDraft, TaskDraftFieldValue, TaskEditableField } from '../src/task-drafts';
import {
  createFrozenTaskPublishRequest,
  createPendingTaskPublishTransaction,
  parseTaskPublishReceipt,
  type TaskPublishPrepareResponse,
  type TaskPublishTransactionPayload,
} from '../src/task-publishing';
import {
  buildFieldComparison,
  canConfirmPreparedReview,
  createReviewSelectionState,
  derivePublicationNotifications,
  derivePublishingPresentation,
  hasNewerDraftEdits,
  preparedReviewsMatchFrozenTasks,
  reduceReviewSelection,
  reviewIdentity,
  type PublicationNotificationSnapshot,
  type PublishingPresentationInput,
} from '../src/publishing-ui-model';

const baseField: TaskDraftFieldValue = {
  value: 'New value',
  baseValue: 'Old value',
  baseSourceCommit: 'source-1',
  baseContentRevision: 'content-1',
};

function draft(recordId: string, fields: Partial<Record<TaskEditableField, TaskDraftFieldValue>> = { title: baseField }): ParsedTaskContentDraft {
  return {
    id: `task-content:${recordId}`,
    recordId,
    updatedAt: '2026-10-04T00:00:00.000Z',
    payload: { schemaVersion: 1, fields },
  };
}

function prepared(
  taskIds: readonly string[] = ['task-1', 'task-2'],
  requestId = 'request-1',
  digests: readonly string[] = taskIds.map(id => `digest-${id}`),
): TaskPublishPrepareResponse {
  return {
    schemaVersion: 2,
    status: 'ready-for-review',
    published: false,
    requestId,
    currentSourceCommit: 'source-2',
    reviews: taskIds.map((taskId, index) => ({
      taskId,
      requiresApproval: taskId === 'task-1',
      reviewDigest: digests[index] ?? `digest-${taskId}`,
      title: `Title ${taskId}`,
      approvedParts: [],
      changes: [{ field: 'title', label: 'Title', before: 'Before', after: 'After' }],
      retained: [],
    })),
  };
}

function request(taskIds: readonly string[] = ['task-1', 'task-2'], requestId = 'request-1') {
  return createFrozenTaskPublishRequest(taskIds.map(taskId => ({
    id: `task-content:${taskId}`,
    recordId: taskId,
    updatedAt: '2026-10-04T00:00:00.000Z',
    payload: { schemaVersion: 1 as const, fields: { title: { ...baseField, value: `Proposed ${taskId}` } } },
  })), requestId);
}

function reviewTransaction(
  taskIds: readonly string[] = ['task-1', 'task-2'],
  preparedResponse = prepared(taskIds),
): TaskPublishTransactionPayload {
  return {
    ...createPendingTaskPublishTransaction(request(taskIds, preparedResponse.requestId), '2026-10-04T00:00:00.000Z'),
    phase: 'review-ready',
    prepared: preparedResponse,
  };
}

function basePresentation(overrides: Partial<PublishingPresentationInput> = {}): PublishingPresentationInput {
  return {
    taskDrafts: [],
    transaction: null,
    saveState: { kind: 'saved' },
    publishState: { kind: 'idle' },
    storageMode: 'persisted',
    snapshot: { savedAt: '2026-10-04T01:00:00.000Z', sync: { kind: 'current', checkedAt: '2026-10-04T01:05:00.000Z' } },
    ...overrides,
  };
}

function actionIds(input: PublishingPresentationInput): readonly string[] {
  return derivePublishingPresentation(input).actions.map(entry => entry.id);
}

function notificationSnapshot(
  transaction: TaskPublishTransactionPayload | null,
  publishState: TaskDraftPublishState = { kind: 'idle' },
): PublicationNotificationSnapshot {
  return { transaction, publishState };
}

function transactionWithPhase(
  phase: TaskPublishTransactionPayload['phase'],
  taskIds: readonly string[] = ['task-1', 'task-2'],
): TaskPublishTransactionPayload {
  const initial = createPendingTaskPublishTransaction(request(taskIds), '2026-10-04T00:00:00.000Z');
  const ready = { ...initial, phase: 'review-ready' as const, prepared: prepared(taskIds) };
  if (phase === 'prepare-pending') return initial;
  if (phase === 'review-ready') return ready;
  if (phase === 'final-pending') return { ...ready, phase, finalRequest: { schemaVersion: 2, requestId: 'request-1', tasks: initial.request.tasks, approvals: [] } };
  if (phase === 'receipt-recorded' || phase === 'complete') {
    const receipt = parseTaskPublishReceipt({
      schemaVersion: 2,
      status: 'committed',
      published: true,
      requestId: 'request-1',
      payloadHash: 'hash-1',
      originalSourceCommit: 'source-2',
      commit: 'commit-1',
      fields: [{ taskId: 'task-1', field: 'title', publishedValue: 'Proposed task-1' }],
    }, 'request-1');
    const recorded = { ...ready, phase: 'final-pending' as const, finalRequest: { schemaVersion: 2 as const, requestId: 'request-1', tasks: initial.request.tasks, approvals: [] }, receipt };
    if (phase === 'receipt-recorded') return { ...recorded, phase };
    return { ...recorded, phase, confirmedSource: { sourceCommit: 'source-3', contentRevision: 'content-3', includesPublishedCommit: true } };
  }
  return { ...initial, phase };
}

test('review identity includes the request ID and ordered task digest pairs', () => {
  const original = prepared();
  assert.notEqual(reviewIdentity(original), reviewIdentity(prepared(['task-2', 'task-1'])));
  assert.notEqual(reviewIdentity(original), reviewIdentity(prepared(['task-1', 'task-2'], 'request-2')));
  assert.notEqual(reviewIdentity(original), reviewIdentity(prepared(['task-1', 'task-2'], 'request-1', ['changed', 'digest-task-2'])));
});

test('selection is task-wide, immutable, keeps checks through details, and resets for a changed identity', () => {
  const firstReview = prepared();
  const initial = createReviewSelectionState(firstReview);
  const firstChecked = reduceReviewSelection(initial, { type: 'toggle-task', taskId: 'task-1', checked: true });
  assert.deepEqual(initial.checkedTaskIds, []);
  assert.deepEqual(firstChecked.checkedTaskIds, ['task-1']);
  assert.equal(reduceReviewSelection(firstChecked, { type: 'open-task', taskId: 'task-1' }).openedTaskId, 'task-1');
  const detail = reduceReviewSelection(firstChecked, { type: 'open-task', taskId: 'task-1' });
  assert.deepEqual(reduceReviewSelection(detail, { type: 'back-to-list' }).checkedTaskIds, ['task-1']);
  const allChecked = reduceReviewSelection(firstChecked, { type: 'toggle-all' });
  assert.deepEqual(allChecked.checkedTaskIds, ['task-1', 'task-2']);
  assert.deepEqual(reduceReviewSelection(allChecked, { type: 'toggle-all' }).checkedTaskIds, []);
  assert.equal(reduceReviewSelection(firstChecked, { type: 'toggle-task', taskId: 'unrelated', checked: true }), firstChecked);
  assert.deepEqual(reduceReviewSelection(firstChecked, { type: 'sync-review', prepared: firstReview }).checkedTaskIds, ['task-1']);
  const changed = reduceReviewSelection(firstChecked, {
    type: 'sync-review',
    prepared: prepared(['task-1', 'task-2'], 'request-1', ['new-digest', 'digest-task-2']),
  });
  assert.deepEqual(changed.checkedTaskIds, []);
  assert.equal(changed.openedTaskId, null);
});

test('frozen review guard requires every frozen task including tasks without renewed approval', () => {
  const transaction = reviewTransaction();
  assert.equal(preparedReviewsMatchFrozenTasks(transaction), true);
  const initial = createReviewSelectionState(transaction.prepared!);
  const oneChecked = reduceReviewSelection(initial, { type: 'toggle-task', taskId: 'task-1', checked: true });
  assert.equal(canConfirmPreparedReview(transaction, oneChecked, { kind: 'idle' }), false);
  const allChecked = reduceReviewSelection(oneChecked, { type: 'toggle-task', taskId: 'task-2', checked: true });
  assert.equal(canConfirmPreparedReview(transaction, allChecked, { kind: 'idle' }), true);
  assert.equal(canConfirmPreparedReview(transaction, allChecked, { kind: 'submitting' }), false);
  assert.equal(canConfirmPreparedReview(transaction, allChecked, { kind: 'failed', message: 'A prior retry failed.' }), true);

  const serverOrderReview = reviewTransaction(['task-1', 'task-2'], prepared(['task-2', 'task-1']));
  const serverOrderSelection = reduceReviewSelection(
    createReviewSelectionState(serverOrderReview.prepared!),
    { type: 'toggle-all' },
  );
  assert.equal(preparedReviewsMatchFrozenTasks(serverOrderReview), true);
  assert.equal(canConfirmPreparedReview(serverOrderReview, serverOrderSelection, { kind: 'idle' }), true);

  const missing = reviewTransaction(['task-1'], prepared(['task-1', 'task-2']));
  assert.equal(preparedReviewsMatchFrozenTasks(missing), false);
  assert.equal(canConfirmPreparedReview(missing, createReviewSelectionState(prepared(['task-1', 'task-2'])), { kind: 'idle' }), false);
  const duplicatePrepared = { ...prepared(['task-1']), reviews: [prepared(['task-1']).reviews[0]!, prepared(['task-1']).reviews[0]!] };
  assert.equal(preparedReviewsMatchFrozenTasks(reviewTransaction(['task-1'], duplicatePrepared)), false);
});

test('frozen review detects changed, added, and removed local task field state', () => {
  const transaction = reviewTransaction(['task-1']);
  const same = draft('task-1', { title: { ...baseField, value: 'Proposed task-1' } });
  assert.equal(hasNewerDraftEdits(transaction, [same]), false);
  assert.equal(hasNewerDraftEdits(transaction, [draft('task-1', { title: { ...baseField, value: 'A newer title' } })]), true);
  assert.equal(hasNewerDraftEdits(transaction, [draft('task-1', {
    title: { ...baseField, value: 'Proposed task-1' },
    'sections.outcome': baseField,
  })]), true);
  assert.equal(hasNewerDraftEdits(transaction, [draft('task-1', {})]), true);
  assert.equal(hasNewerDraftEdits(transaction, [same, draft('task-2')]), true);
  assert.equal(hasNewerDraftEdits(transaction, []), true);
  assert.equal(hasNewerDraftEdits(transaction, [same, same]), true);
});

test('field comparison reconstructs exact whitespace, Unicode, punctuation, markup, and URLs', () => {
  const examples = [
    ['  alpha\n\tbeta  ', ' alpha\n gamma\t'],
    ['日本語 — 🙂 word', '日本語— 😀 phrase'],
    ['**before** <b>html</b>', '**after** <b>HTML</b>'],
    ['https://example.com/a/very-long/path?query=one&x=two', 'https://example.com/a/very-long/path?query=two&x=two'],
  ] as const;
  for (const [before, after] of examples) {
    const comparison = buildFieldComparison(before, after);
    assert.equal(comparison.before, before);
    assert.equal(comparison.after, after);
    assert.notEqual(comparison.parts, null);
    assert.equal(comparison.parts?.filter(part => part.kind !== 'added').map(part => part.value).join(''), before);
    assert.equal(comparison.parts?.filter(part => part.kind !== 'removed').map(part => part.value).join(''), after);
  }
  const same = buildFieldComparison('same  \n', 'same  \n');
  assert.deepEqual(same.parts, [{ value: 'same  \n', kind: 'unchanged' }]);
});

test('bounded field diff falls back to exact plain strings for oversized edits', () => {
  const before = 'old '.repeat(2500);
  const after = 'new '.repeat(2500);
  const comparison = buildFieldComparison(before, after);
  assert.equal(comparison.parts, null);
  assert.equal(comparison.before, before);
  assert.equal(comparison.after, after);
});

test('banner gives saved review and preparation failure their safe actions', () => {
  const review = reviewTransaction();
  const savedReview = derivePublishingPresentation(basePresentation({
    transaction: review,
    publishState: { kind: 'waiting' },
  }));
  assert.equal(savedReview.phase, 'review-ready');
  assert.equal(savedReview.message, '2 tasks ready to review');
  assert.equal(savedReview.busy, true);
  assert.ok(savedReview.actions.some(entry => entry.id === 'open-review'));

  const singleTaskReview = derivePublishingPresentation(basePresentation({
    transaction: reviewTransaction(['task-1']),
  }));
  assert.equal(singleTaskReview.message, '1 task ready to review');

  const preparationFailed = derivePublishingPresentation(basePresentation({
    transaction: transactionWithPhase('prepare-pending'),
    publishState: { kind: 'failed', message: 'The local operation timed out.' },
  }));
  assert.equal(preparationFailed.busy, false);
  assert.ok(preparationFailed.actions.some(entry => entry.id === 'retry-prepare'));
  assert.equal(preparationFailed.supportingMessage?.includes('timed out'), false);

  const publishingFailed = derivePublishingPresentation(basePresentation({
    transaction: transactionWithPhase('final-pending'),
    publishState: { kind: 'failed', message: 'Could not confirm the final request.' },
  }));
  assert.ok(publishingFailed.actions.some(entry => entry.id === 'retry-publication'));
  assert.ok(publishingFailed.actions.find(entry => entry.id === 'retry-publication')?.label.includes('Check and retry'));
  assert.equal(publishingFailed.supportingMessage, 'Your changes are still here. You can check and retry.');
  assert.equal(publishingFailed.supportingMessage?.includes('confirm the final request'), false);

  const publishing = derivePublishingPresentation(basePresentation({
    transaction: transactionWithPhase('final-pending'),
    publishState: { kind: 'submitting' },
  }));
  assert.equal(publishing.supportingMessage, 'Your changes are being checked.');

  const deploymentFailed = derivePublishingPresentation(basePresentation({
    transaction: transactionWithPhase('receipt-recorded'),
    publishState: { kind: 'failed', message: 'Could not confirm the deployed source.' },
  }));
  assert.equal(deploymentFailed.supportingMessage, 'Check for an update or try again shortly.');

  const superseded = derivePublishingPresentation(basePresentation({
    transaction: transactionWithPhase('receipt-superseded'),
  }));
  assert.equal(superseded.supportingMessage, 'Review the latest changes before publishing again.');
});

test('banner offers review while saving, counts distinct tasks, and avoids false persisted copy', () => {
  const localDrafts = [draft('task-1'), draft('task-1'), draft('task-2')];
  const saving = derivePublishingPresentation(basePresentation({
    taskDrafts: localDrafts,
    saveState: { kind: 'saving' },
  }));
  assert.equal(saving.distinctDraftTaskCount, 2);
  assert.ok(saving.actions.some(entry => entry.id === 'open-review'));
  assert.equal(saving.message, 'Saving your changes…');

  for (const transaction of [null, transactionWithPhase('complete')]) {
    const inMemory = derivePublishingPresentation(basePresentation({
      taskDrafts: [draft('task-1')],
      transaction,
      storageMode: 'in-memory',
    }));
    assert.equal(inMemory.message.includes('saved on this device'), false);
    assert.ok(inMemory.warnings.some(warning => warning.includes('only while this tab stays open')));
  }
});

test('banner keeps stale source status truthful with no drafts and conflict resolution follows surviving fields', () => {
  const stale = derivePublishingPresentation(basePresentation({
    snapshot: { savedAt: '2026-10-04T01:00:00.000Z', sync: { kind: 'stale', message: 'This device is offline.', checkedAt: null } },
  }));
  assert.equal(stale.message, 'Showing saved tracker data');
  assert.equal(stale.message.includes('up to date'), false);
  assert.equal(stale.supportingMessage?.includes('offline'), false);
  const completedWithStaleSource = derivePublishingPresentation(basePresentation({
    transaction: transactionWithPhase('complete'),
    snapshot: { savedAt: '2026-10-04T01:00:00.000Z', sync: { kind: 'stale', message: 'This device is offline.', checkedAt: null } },
  }));
  assert.equal(completedWithStaleSource.message, 'Showing saved tracker data');
  assert.ok(completedWithStaleSource.actions.some(entry => entry.label === 'Sync details'));
  const savingSnapshot = derivePublishingPresentation(basePresentation({
    transaction: transactionWithPhase('prepare-pending'),
    snapshot: { savedAt: '2026-10-04T01:00:00.000Z', sync: { kind: 'save-failed', message: 'Snapshot acknowledgement timed out.' } },
  }));
  assert.ok(savingSnapshot.warnings.some(warning => warning.includes('snapshot may not survive')));

  const conflict: TaskPublishTransactionPayload = {
    ...transactionWithPhase('canceled', ['task-1']),
    conflict: {
      schemaVersion: 2,
      status: 'conflict',
      published: false,
      requestId: 'request-1',
      error: 'Conflict',
      code: 'field-conflict',
      currentSourceCommit: 'source-2',
      conflicts: [{ taskId: 'task-1', field: 'title', baseValue: 'Old', currentValue: 'Current', proposedValue: 'New', message: 'Resolve this field.' }],
    },
  };
  assert.ok(actionIds(basePresentation({ transaction: conflict, taskDrafts: [draft('task-1')] })).includes('resolve-conflicts'));
  assert.ok(actionIds(basePresentation({ transaction: conflict, taskDrafts: [draft('task-1', {})] })).includes('open-review'));
});

test('notification transitions use stable IDs, clear resolved failures, and never replay an existing complete receipt', () => {
  const noRequest = notificationSnapshot(null);
  const initial = notificationSnapshot(transactionWithPhase('prepare-pending'), { kind: 'waiting' });
  const preparing = notificationSnapshot(transactionWithPhase('prepare-pending'), { kind: 'preparing' });
  const preparationCommands = derivePublicationNotifications(noRequest, initial);
  assert.deepEqual(preparationCommands, [{
    kind: 'show', id: 'task-publish:request-1:preparation', tone: 'loading', message: 'Preparing your review…', durationMs: null,
  }]);
  assert.deepEqual(derivePublicationNotifications(initial, preparing), []);
  assert.deepEqual(derivePublicationNotifications(preparing, preparing), []);

  const failed = notificationSnapshot(transactionWithPhase('prepare-pending'), { kind: 'failed', message: 'Preparation timed out.' });
  assert.ok(derivePublicationNotifications(preparing, failed).some(command => command.kind === 'show' && command.id.endsWith(':preparation-failure')));
  const retried = notificationSnapshot(transactionWithPhase('prepare-pending'), { kind: 'waiting' });
  const retryCommands = derivePublicationNotifications(failed, retried);
  assert.ok(retryCommands.some(command => command.kind === 'dismiss' && command.id.endsWith(':preparation-failure')));
  assert.ok(retryCommands.some(command => command.kind === 'show' && command.id.endsWith(':preparation')));

  const finalPending = notificationSnapshot(transactionWithPhase('final-pending'), { kind: 'submitting' });
  const receipt = notificationSnapshot(transactionWithPhase('receipt-recorded'));
  const receiptCommands = derivePublicationNotifications(finalPending, receipt);
  assert.ok(receiptCommands.some(command => command.kind === 'show' && command.id.endsWith(':publication-success') && command.durationMs === 5000));
  assert.ok(receiptCommands.some(command => command.kind === 'show' && command.id.endsWith(':deployment') && command.durationMs === null));
  const completeCommands = derivePublicationNotifications(receipt, notificationSnapshot(transactionWithPhase('complete')));
  assert.ok(completeCommands.some(command => command.kind === 'show' && command.id.endsWith(':deployment') && command.tone === 'success'));
  assert.deepEqual(derivePublicationNotifications(null, notificationSnapshot(transactionWithPhase('complete'))), []);

  const ready = notificationSnapshot(transactionWithPhase('review-ready'));
  const canceled = notificationSnapshot(transactionWithPhase('canceled'));
  assert.ok(derivePublicationNotifications(ready, canceled).some(command => command.kind === 'dismiss' && command.id.endsWith(':review-ready')));

  const deploymentFailed = notificationSnapshot(transactionWithPhase('receipt-recorded'), { kind: 'failed', message: 'Could not confirm the deployed source.' });
  const deploymentErrorCommands = derivePublicationNotifications(receipt, deploymentFailed);
  assert.ok(deploymentErrorCommands.some(command => command.kind === 'show' && command.id.endsWith(':deployment-failure')));
  assert.equal(deploymentErrorCommands.some(command => command.kind === 'show' && command.id.endsWith(':preparation-failure')), false);
});

test('notification replacement dismisses the previous request IDs', () => {
  const previous = notificationSnapshot(transactionWithPhase('prepare-pending'), { kind: 'preparing' });
  const nextPrepared = prepared(['task-1', 'task-2'], 'request-2');
  const next = notificationSnapshot({
    ...createPendingTaskPublishTransaction(request(['task-1', 'task-2'], 'request-2'), '2026-10-04T00:00:00.000Z'),
    phase: 'review-ready',
    prepared: nextPrepared,
  });
  const commands = derivePublicationNotifications(previous, next);
  assert.ok(commands.some(command => command.kind === 'dismiss' && command.id === 'task-publish:request-1:preparation'));
  assert.ok(commands.some(command => command.kind === 'show' && command.id === 'task-publish:request-2:review-ready'));
});
