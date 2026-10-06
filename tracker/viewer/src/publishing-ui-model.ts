import { diffWordsWithSpace } from 'diff';
import type { TaskDraftSaveState, TaskDraftPublishState } from './router-context';
import { TASK_EDITABLE_FIELDS, type ParsedTaskContentDraft } from './task-drafts';
import { taskPublishFieldValuesMatch } from './task-publishing';
import type {
  TaskPublishPrepareResponse,
  TaskPublishTransactionPayload,
} from './task-publishing';

export type PublishingSnapshotSyncStatus =
  | { readonly kind: 'checking' }
  | { readonly kind: 'saving' }
  | { readonly kind: 'save-failed'; readonly message: string }
  | { readonly kind: 'current'; readonly checkedAt: string }
  | { readonly kind: 'stale'; readonly message: string; readonly checkedAt: string | null }
  | { readonly kind: 'unavailable'; readonly message: string };

export interface PublishingSnapshotStatus {
  readonly savedAt: string;
  readonly sync: PublishingSnapshotSyncStatus;
}

export interface PublishingPresentationInput {
  readonly taskDrafts: readonly ParsedTaskContentDraft[];
  readonly transaction: TaskPublishTransactionPayload | null;
  readonly saveState: TaskDraftSaveState;
  readonly publishState: TaskDraftPublishState;
  readonly storageMode: 'persisted' | 'in-memory';
  readonly snapshot: PublishingSnapshotStatus;
}

export type PublishingBannerTone = 'neutral' | 'info' | 'success' | 'warning' | 'error';
export type PublishingActionId =
  | 'open-review'
  | 'cancel-review'
  | 'retry-prepare'
  | 'retry-publication'
  | 'open-details'
  | 'check-update'
  | 'resolve-conflicts'
  | 'review-latest';

export interface PublishingPresentationAction {
  readonly id: PublishingActionId;
  readonly label: string;
}

export interface PublishingPresentation {
  readonly phase: PublishingPresentationPhase;
  readonly tone: PublishingBannerTone;
  readonly message: string;
  readonly supportingMessage: string | null;
  readonly actions: readonly PublishingPresentationAction[];
  readonly busy: boolean;
  readonly distinctDraftTaskCount: number;
  readonly warnings: readonly string[];
  readonly snapshotDetails: string;
  readonly savedAt: string;
}

export type PublishingPresentationPhase =
  | 'idle'
  | 'drafts'
  | 'saving'
  | 'save-failed'
  | 'preparing'
  | 'review-ready'
  | 'publishing'
  | 'receipt-recorded'
  | 'complete'
  | 'conflict'
  | 'receipt-superseded';

export interface ReviewSelectionState {
  readonly identity: string;
  readonly taskIds: readonly string[];
  readonly checkedTaskIds: readonly string[];
  readonly openedTaskId: string | null;
}

export type ReviewSelectionAction =
  | { readonly type: 'sync-review'; readonly prepared: TaskPublishPrepareResponse }
  | { readonly type: 'toggle-task'; readonly taskId: string; readonly checked: boolean }
  | { readonly type: 'toggle-all' }
  | { readonly type: 'open-task'; readonly taskId: string }
  | { readonly type: 'back-to-list' };

export interface FieldDiffPart {
  readonly value: string;
  readonly kind: 'unchanged' | 'removed' | 'added';
}

export interface FieldComparison {
  readonly before: string;
  readonly after: string;
  /** Null means the bounded diff declined; render both original strings without highlights. */
  readonly parts: readonly FieldDiffPart[] | null;
}

export interface PublicationNotificationSnapshot {
  readonly transaction: TaskPublishTransactionPayload | null;
  readonly publishState: TaskDraftPublishState;
}

export type PublicationNotificationTone = 'loading' | 'success' | 'error';

export type PublicationNotificationCommand =
  | { readonly kind: 'show'; readonly id: string; readonly tone: PublicationNotificationTone; readonly message: string; readonly durationMs: number | null }
  | { readonly kind: 'dismiss'; readonly id: string };

export function reviewIdentity(prepared: TaskPublishPrepareResponse): string {
  return JSON.stringify([
    prepared.requestId,
    prepared.reviews.map(review => [review.taskId, review.reviewDigest]),
  ]);
}

export function createReviewSelectionState(prepared: TaskPublishPrepareResponse): ReviewSelectionState {
  return {
    identity: reviewIdentity(prepared),
    taskIds: prepared.reviews.map(review => review.taskId),
    checkedTaskIds: [],
    openedTaskId: null,
  };
}

export function reduceReviewSelection(
  state: ReviewSelectionState,
  action: ReviewSelectionAction,
): ReviewSelectionState {
  switch (action.type) {
    case 'sync-review': {
      const next = createReviewSelectionState(action.prepared);
      if (next.identity !== state.identity) return next;
      const taskIds = new Set(next.taskIds);
      return {
        ...state,
        taskIds: next.taskIds,
        checkedTaskIds: state.checkedTaskIds.filter(id => taskIds.has(id)),
        openedTaskId: state.openedTaskId !== null && taskIds.has(state.openedTaskId) ? state.openedTaskId : null,
      };
    }
    case 'toggle-task': {
      if (!state.taskIds.includes(action.taskId)) return state;
      const checked = new Set(state.checkedTaskIds);
      if (action.checked) checked.add(action.taskId);
      else checked.delete(action.taskId);
      return { ...state, checkedTaskIds: state.taskIds.filter(id => checked.has(id)) };
    }
    case 'toggle-all':
      return {
        ...state,
        checkedTaskIds: state.checkedTaskIds.length === state.taskIds.length
          ? []
          : [...state.taskIds],
      };
    case 'open-task':
      return state.taskIds.includes(action.taskId) ? { ...state, openedTaskId: action.taskId } : state;
    case 'back-to-list':
      return state.openedTaskId === null ? state : { ...state, openedTaskId: null };
  }
}

export function preparedReviewsMatchFrozenTasks(transaction: TaskPublishTransactionPayload | null): boolean {
  if (transaction?.phase !== 'review-ready' || transaction.prepared === undefined) return false;
  if (transaction.request.requestId !== transaction.prepared.requestId) return false;
  const frozenIds = transaction.request.tasks.map(task => task.id);
  const reviewIds = transaction.prepared.reviews.map(review => review.taskId);
  if (frozenIds.length === 0 || frozenIds.length !== reviewIds.length) return false;
  if (new Set(frozenIds).size !== frozenIds.length || new Set(reviewIds).size !== reviewIds.length) return false;
  const frozenSet = new Set(frozenIds);
  return reviewIds.every(id => frozenSet.has(id));
}

export function hasNewerDraftEdits(
  transaction: TaskPublishTransactionPayload | null,
  drafts: readonly ParsedTaskContentDraft[],
): boolean {
  if (transaction === null) return drafts.length > 0;
  const frozenTasks = new Map(transaction.request.tasks.map(task => [task.id, task]));
  const currentDrafts = new Map(drafts.map(draft => [draft.recordId, draft]));
  if (currentDrafts.size !== drafts.length || currentDrafts.size !== frozenTasks.size) return true;
  for (const [taskId, frozenTask] of frozenTasks) {
    const draft = currentDrafts.get(taskId);
    if (draft === undefined) return true;
    for (const field of TASK_EDITABLE_FIELDS) {
      const frozen = frozenTask.fields[field];
      const current = draft.payload.fields[field];
      if (frozen === undefined || current === undefined) {
        if (frozen !== current) return true;
        continue;
      }
      if (!taskPublishFieldValuesMatch(field, current.value, frozen.value)
        || current.baseValue !== frozen.baseValue
        || current.baseSourceCommit !== frozen.baseSourceCommit
        || current.baseContentRevision !== frozen.baseContentRevision) return true;
    }
  }
  return false;
}

export function canConfirmPreparedReview(
  transaction: TaskPublishTransactionPayload | null,
  selection: ReviewSelectionState,
  publishState: TaskDraftPublishState,
): boolean {
  if (!preparedReviewsMatchFrozenTasks(transaction) || transaction?.prepared === undefined) return false;
  if (isPublishingOperationBusy(publishState)) return false;
  const prepared = transaction.prepared;
  if (selection.identity !== reviewIdentity(prepared)) return false;
  const requiredIds = transaction.request.tasks.map(task => task.id);
  if (selection.taskIds.length !== requiredIds.length
    || selection.taskIds.some((id, index) => id !== prepared.reviews[index]?.taskId)) return false;
  return requiredIds.length > 0
    && selection.checkedTaskIds.length === requiredIds.length
    && new Set(selection.checkedTaskIds).size === requiredIds.length
    && requiredIds.every(id => selection.checkedTaskIds.includes(id));
}

export function buildFieldComparison(before: string, after: string): FieldComparison {
  if (before === after) {
    return { before, after, parts: [{ value: before, kind: 'unchanged' }] };
  }
  const parts = diffWordsWithSpace(before, after, { maxEditLength: 2000 });
  if (parts === undefined) return { before, after, parts: null };
  return {
    before,
    after,
    parts: parts.map(part => ({
      value: part.value,
      kind: part.added ? 'added' : part.removed ? 'removed' : 'unchanged',
    })),
  };
}

function unresolvedConflictCount(transaction: TaskPublishTransactionPayload, drafts: readonly ParsedTaskContentDraft[]): number {
  if (transaction.conflict === undefined || (transaction.phase !== 'conflict' && transaction.phase !== 'canceled')) return 0;
  return transaction.conflict.conflicts.filter(conflict => {
    if (!TASK_EDITABLE_FIELDS.some(field => field === conflict.field)) return false;
    const field = TASK_EDITABLE_FIELDS.find(candidate => candidate === conflict.field);
    if (field === undefined) return false;
    const draft = drafts.find(candidate => candidate.recordId === conflict.taskId);
    return draft?.payload.fields[field] !== undefined;
  }).length;
}

function isPublishingOperationBusy(state: TaskDraftPublishState): boolean {
  return state.kind === 'waiting'
    || state.kind === 'preparing'
    || state.kind === 'submitting'
    || state.kind === 'checking-source';
}

function snapshotDetails(snapshot: PublishingSnapshotStatus): string {
  const imported = `Last imported ${new Date(snapshot.savedAt).toLocaleString()}.`;
  switch (snapshot.sync.kind) {
    case 'checking': return `Checking for tracker updates. ${imported}`;
    case 'saving': return `Saving the latest tracker snapshot on this device. ${imported}`;
    case 'save-failed': return `${snapshot.sync.message} ${imported}`;
    case 'current': return `Checked ${new Date(snapshot.sync.checkedAt).toLocaleString()}. ${imported}`;
    case 'stale': return `${snapshot.sync.message} ${imported}`;
    case 'unavailable': return `${snapshot.sync.message} ${imported}`;
  }
}

function snapshotStateSentence(status: PublishingSnapshotSyncStatus): string | null {
  switch (status.kind) {
    case 'checking': return 'Checking tracker updates.';
    case 'saving': return 'Saving tracker data on this device.';
    case 'save-failed': return 'The latest tracker snapshot may not survive a reload.';
    case 'current': return 'Tracker data is current.';
    case 'stale': return 'Showing saved tracker data until a current source can be checked.';
    case 'unavailable': return 'Could not check the current tracker data.';
  }
}

function action(id: PublishingActionId, label: string): PublishingPresentationAction {
  return { id, label };
}

export function derivePublishingPresentation(input: PublishingPresentationInput): PublishingPresentation {
  const { transaction, publishState } = input;
  const distinctDraftTaskCount = new Set(input.taskDrafts.map(draft => draft.recordId)).size;
  const unresolvedConflicts = transaction === null ? 0 : unresolvedConflictCount(transaction, input.taskDrafts);
  const busy = isPublishingOperationBusy(publishState);
  const warnings: string[] = [];
  if (input.storageMode === 'in-memory') warnings.push('Changes are kept only while this tab stays open.');
  let tone: PublishingBannerTone = 'neutral';
  let message = 'Tracker is up to date';
  let supportingMessage: string | null = snapshotStateSentence(input.snapshot.sync);
  let actions: PublishingPresentationAction[] = [];
  let phase: PublishingPresentationPhase = 'idle';

  if (transaction?.phase === 'receipt-superseded') {
    phase = 'receipt-superseded';
    tone = 'warning';
    message = input.storageMode === 'in-memory'
      ? 'Published changes were updated again. Your local edits remain in this tab.'
      : 'Published changes were updated again. Your local edits are saved.';
    supportingMessage = distinctDraftTaskCount > 0
      ? `${distinctDraftTaskCount} ${distinctDraftTaskCount === 1 ? 'task has' : 'tasks have'} newer local edits.`
      : 'Review the latest changes before publishing again.';
    actions = [action('review-latest', 'Review latest changes'), action('open-details', 'Details')];
  } else if (transaction?.phase === 'conflict' || unresolvedConflicts > 0) {
    phase = 'conflict';
    tone = 'error';
    message = 'Some changes need your attention';
    supportingMessage = `${unresolvedConflicts || transaction?.conflict?.conflicts.length || 0} conflicting ${unresolvedConflicts === 1 ? 'field needs' : 'fields need'} review.`;
    actions = [action('resolve-conflicts', 'Resolve changes'), action('open-details', 'Details')];
  } else if (transaction?.phase === 'final-pending') {
    phase = 'publishing';
    tone = publishState.kind === 'failed' ? 'error' : 'info';
    message = publishState.kind === 'failed' ? 'Publishing needs your attention' : 'Publishing your changes…';
    supportingMessage = publishState.kind === 'failed'
      ? 'Your changes are still here. You can check and retry.'
      : 'Your changes are being checked.';
    actions = [
      ...(publishState.kind === 'failed' ? [action('retry-publication', 'Check and retry publication')] : []),
      action('open-details', 'Details'),
    ];
  } else if (transaction?.phase === 'receipt-recorded') {
    phase = 'receipt-recorded';
    tone = 'success';
    message = 'Changes published. Updating the app…';
    supportingMessage = publishState.kind === 'failed'
      ? 'Check for an update or try again shortly.'
      : snapshotStateSentence(input.snapshot.sync);
    actions = [action('check-update', 'Check for update'), action('open-details', 'Details')];
  } else if (transaction?.phase === 'complete') {
    phase = 'complete';
    message = distinctDraftTaskCount > 0
      ? draftCountMessage(distinctDraftTaskCount, input.storageMode)
      : snapshotBannerTitle(input.snapshot.sync);
    actions = [
      ...(distinctDraftTaskCount > 0 ? [action('open-review', 'Review changes')] : []),
      action('open-details', 'Sync details'),
    ];
  } else if (transaction?.phase === 'review-ready') {
    phase = 'review-ready';
    tone = 'info';
    const reviewCount = transaction.prepared?.reviews.length ?? 0;
    message = `${reviewCount} ${reviewCount === 1 ? 'task' : 'tasks'} ready to review`;
    supportingMessage = 'Check every task before publishing.';
    actions = [action('open-review', 'Review changes'), action('cancel-review', 'Cancel review')];
  } else if (publishState.kind === 'failed') {
    phase = transaction?.phase === 'prepare-pending' ? 'preparing' : 'save-failed';
    tone = 'error';
    message = input.storageMode === 'in-memory'
      ? 'Couldn’t prepare your review. Your changes remain in this tab.'
      : 'Couldn’t prepare your review. Your changes are saved.';
    supportingMessage = 'Retry to prepare the saved request again.';
    actions = [action('retry-prepare', 'Retry review'), action('open-details', 'Details')];
  } else if (transaction?.phase === 'prepare-pending' || publishState.kind === 'preparing' || publishState.kind === 'waiting') {
    phase = 'preparing';
    tone = 'info';
    message = 'Preparing your review…';
    supportingMessage = input.storageMode === 'in-memory'
      ? 'Your changes remain in this tab while preparation runs.'
      : 'Your saved changes are being checked against the tracker.';
    actions = [action('open-details', 'Details')];
  } else if (distinctDraftTaskCount > 0) {
    phase = input.saveState.kind === 'saving' ? 'saving' : input.saveState.kind === 'failed' ? 'save-failed' : 'drafts';
    tone = input.saveState.kind === 'failed' ? 'error' : 'neutral';
    message = input.saveState.kind === 'saving'
      ? 'Saving your changes…'
      : input.saveState.kind === 'failed'
        ? 'Some changes could not be saved'
        : draftCountMessage(distinctDraftTaskCount, input.storageMode);
    supportingMessage = input.saveState.kind === 'failed'
      ? 'See details for the save error.'
      : snapshotStateSentence(input.snapshot.sync);
    actions = [
      ...(input.saveState.kind !== 'failed' ? [action('open-review', 'Review changes')] : []),
      action('open-details', 'Details'),
    ];
  } else if (input.saveState.kind === 'failed') {
    phase = 'save-failed';
    tone = 'error';
    message = 'Some changes could not be saved';
    supportingMessage = 'See details for the save error.';
    actions = [action('open-details', 'Details')];
  } else if (input.saveState.kind === 'saving') {
    phase = 'saving';
    message = 'Saving your changes…';
    supportingMessage = 'Tracker changes are being saved.';
    actions = [action('open-details', 'Details')];
  } else {
    message = snapshotBannerTitle(input.snapshot.sync);
    supportingMessage = snapshotStateSentence(input.snapshot.sync);
    actions = [action('open-details', 'Sync details')];
  }

  if (input.saveState.kind === 'failed' && phase !== 'save-failed') {
    warnings.push('Some changes could not be saved.');
  }
  if (input.snapshot.sync.kind === 'save-failed' && phase !== 'idle') {
    warnings.push('The latest tracker snapshot may not survive a reload.');
  }
  return {
    phase,
    tone,
    message,
    supportingMessage,
    actions,
    busy,
    distinctDraftTaskCount,
    warnings,
    snapshotDetails: snapshotDetails(input.snapshot),
    savedAt: input.snapshot.savedAt,
  };
}

function snapshotBannerTitle(status: PublishingSnapshotSyncStatus): string {
  switch (status.kind) {
    case 'checking': return 'Checking tracker updates';
    case 'saving': return 'Saving tracker data';
    case 'current': return 'Tracker is up to date';
    case 'stale': return 'Showing saved tracker data';
    case 'save-failed': return 'Tracker data is not saved';
    case 'unavailable': return 'Tracker data is unavailable';
  }
}

function draftCountMessage(count: number, storageMode: PublishingPresentationInput['storageMode']): string {
  const tasks = `${count} ${count === 1 ? 'task' : 'tasks'}`;
  return storageMode === 'in-memory'
    ? `Changes to ${tasks} remain in this tab`
    : `Changes to ${tasks} saved on this device`;
}

function notificationId(requestId: string, stage: string): string {
  return `task-publish:${requestId}:${stage}`;
}

function sameSnapshot(left: PublicationNotificationSnapshot, right: PublicationNotificationSnapshot): boolean {
  return left.transaction?.request.requestId === right.transaction?.request.requestId
    && left.transaction?.phase === right.transaction?.phase
    && left.publishState.kind === right.publishState.kind
    && (left.publishState.kind !== 'failed' || right.publishState.kind !== 'failed' || left.publishState.message === right.publishState.message);
}

export function derivePublicationNotifications(
  previous: PublicationNotificationSnapshot | null,
  current: PublicationNotificationSnapshot,
): readonly PublicationNotificationCommand[] {
  if (previous === null || sameSnapshot(previous, current)) return [];
  const before = previous.transaction;
  const after = current.transaction;
  const requestId = after?.request.requestId ?? before?.request.requestId;
  if (requestId === undefined) return [];
  const commands: PublicationNotificationCommand[] = [];
  const dismiss = (forRequestId: string, ...stages: readonly string[]) => {
    for (const stage of stages) commands.push({ kind: 'dismiss', id: notificationId(forRequestId, stage) });
  };
  const show = (forRequestId: string, stage: string, tone: PublicationNotificationTone, message: string, durationMs: number | null) => {
    commands.push({ kind: 'show', id: notificationId(forRequestId, stage), tone, message, durationMs });
  };
  const previousRequestId = before?.request.requestId;
  const requestChanged = previousRequestId !== after?.request.requestId;
  if (requestChanged && previousRequestId !== undefined) {
    dismiss(previousRequestId, 'preparation', 'preparation-failure', 'review-ready', 'publication', 'publication-failure', 'publication-success', 'deployment', 'conflict');
  }

  if (current.publishState.kind === 'failed') {
    const stage = after?.phase === 'final-pending'
      ? 'publication-failure'
      : after?.phase === 'receipt-recorded'
        ? 'deployment-failure'
        : 'preparation-failure';
    const previousFailureStage = previous.publishState.kind === 'failed'
      ? before?.phase === 'final-pending'
        ? 'publication-failure'
        : before?.phase === 'receipt-recorded'
          ? 'deployment-failure'
          : 'preparation-failure'
      : null;
    if (previousFailureStage !== null && previousFailureStage !== stage && previousRequestId !== undefined) {
      dismiss(previousRequestId, previousFailureStage);
    }
    if (!previousFailureStage || previousFailureStage !== stage
      || previousRequestId !== after?.request.requestId
      || previous.publishState.kind !== 'failed'
      || previous.publishState.message !== current.publishState.message) {
      if (after !== null) {
        const message = stage === 'publication-failure'
          ? 'Could not confirm publication. Open details for the error.'
          : stage === 'deployment-failure'
            ? 'Could not confirm the tracker update. Open details for the error.'
            : 'Could not prepare your review. Open details for the error.';
        show(after.request.requestId, stage, 'error', message, null);
      }
    }
    if (after !== null) dismiss(after.request.requestId,
      stage === 'publication-failure' ? 'publication' : stage === 'deployment-failure' ? 'deployment' : 'preparation');
    return commands;
  }
  if (previous.publishState.kind === 'failed' && previousRequestId !== undefined) {
    dismiss(previousRequestId, before?.phase === 'final-pending'
      ? 'publication-failure'
      : before?.phase === 'receipt-recorded'
        ? 'deployment-failure'
        : 'preparation-failure');
  }
  if (after === null) {
    if (previousRequestId !== undefined) {
      dismiss(previousRequestId, 'preparation', 'preparation-failure', 'review-ready', 'publication', 'publication-failure', 'publication-success', 'deployment', 'conflict');
    }
    return commands;
  }

  if (after?.phase === 'conflict' || after?.phase === 'receipt-superseded') {
    if (before?.phase !== after.phase || requestChanged) {
      show(after.request.requestId, 'conflict', 'error', after.phase === 'conflict' ? 'Some changes need your attention.' : 'Published changes were updated again.', null);
    }
    dismiss(after.request.requestId, 'preparation', 'preparation-failure', 'publication', 'publication-failure', 'deployment');
    return commands;
  }
  const enteredPreparation = before?.phase !== 'prepare-pending' || requestChanged;
  const retriedPreparation = before?.phase === 'prepare-pending' && previous.publishState.kind === 'failed';
  if (after?.phase === 'prepare-pending'
    && (current.publishState.kind === 'preparing' || current.publishState.kind === 'waiting')
    && (enteredPreparation || retriedPreparation)) {
    show(after.request.requestId, 'preparation', 'loading', 'Preparing your review…', null);
    return commands;
  }
  if (after?.phase === 'review-ready' && before?.phase !== 'review-ready') {
    dismiss(after.request.requestId, 'preparation', 'preparation-failure');
    show(after.request.requestId, 'review-ready', 'success', 'Your review is ready.', 5000);
    return commands;
  }
  if (after?.phase === 'final-pending'
    && (before?.phase !== 'final-pending' || previous.publishState.kind === 'failed')) {
    dismiss(after.request.requestId, 'publication-failure');
    show(after.request.requestId, 'publication', 'loading', 'Publishing your changes…', null);
    return commands;
  }
  if (after?.phase === 'receipt-recorded' && before?.phase !== 'receipt-recorded') {
    dismiss(after.request.requestId, 'publication', 'publication-failure');
    show(after.request.requestId, 'publication-success', 'success', 'Changes published.', 5000);
    show(after.request.requestId, 'deployment', 'loading', 'Updating the tracker…', null);
    return commands;
  }
  if (after?.phase === 'receipt-recorded' && before?.phase === 'receipt-recorded'
    && previous.publishState.kind === 'failed' && current.publishState.kind === 'checking-source') {
    dismiss(after.request.requestId, 'deployment-failure');
    show(after.request.requestId, 'deployment', 'loading', 'Updating the tracker…', null);
    return commands;
  }
  if (after?.phase === 'complete' && before?.phase !== 'complete') {
    show(after.request.requestId, 'deployment', 'success', 'Tracker update is available.', 5000);
    dismiss(after.request.requestId, 'conflict');
  }
  if (after?.phase === 'canceled') {
    dismiss(after.request.requestId, 'preparation', 'preparation-failure', 'review-ready', 'conflict');
  }
  return commands;
}
