import { useEffect, useMemo, useRef, useState, type SyntheticEvent } from 'react';
import { toast } from 'sonner';
import { Button } from './components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './components/ui/dialog';
import { PublishingReviewDialog } from './publishing-review-dialog';
import {
  canConfirmPreparedReview,
  derivePublicationNotifications,
  derivePublishingPresentation,
  hasNewerDraftEdits,
  preparedReviewsMatchFrozenTasks,
  reduceReviewSelection,
  reviewIdentity,
  type PublicationNotificationCommand,
  type PublicationNotificationSnapshot,
  type PublishingActionId,
  type PublishingPresentationInput,
  type ReviewSelectionAction,
  type ReviewSelectionState,
} from './publishing-ui-model';
import {
  TASK_EDITABLE_FIELDS,
  taskDraftFieldValue,
  type ParsedTaskContentDraft,
  type TaskEditableField,
} from './task-drafts';
import { taskPublishFieldValuesMatch, type TaskPublishConflictResponse, type TaskPublishTransactionPayload } from './task-publishing';
import type { TaskEditController } from './router-context';
import type { PersistedCanonicalSnapshot, TrackerSnapshot } from './snapshot';
import type { PublishingSnapshotSyncStatus } from './publishing-ui-model';
import './publishing-status.css';

export interface PublishingStatusHostProps {
  readonly taskEdit: TaskEditController;
  readonly taskDrafts: readonly ParsedTaskContentDraft[];
  readonly canonicalData: TrackerSnapshot;
  readonly saved: Pick<PersistedCanonicalSnapshot, 'savedAt'>;
  readonly snapshotSync: PublishingSnapshotSyncStatus;
  readonly storageMode: 'persisted' | 'in-memory';
}

const EMPTY_SELECTION: ReviewSelectionState = {
  identity: '',
  taskIds: [],
  checkedTaskIds: [],
  openedTaskId: null,
};

const ACTIVE_PUBLISH_STATES = new Set(['waiting', 'preparing', 'submitting', 'checking-source']);

const FIELD_LABELS: Record<TaskEditableField, string> = {
  title: 'Title',
  'sections.outcome': 'Outcome',
  'sections.completionCondition': 'Completion condition',
  'sections.nextStep': 'Next step',
  'sections.evidence': 'Evidence',
};

function hasActivePublishOperation(taskEdit: TaskEditController): boolean {
  return ACTIVE_PUBLISH_STATES.has(taskEdit.publishState.kind);
}

function isEditableField(value: string): value is TaskEditableField {
  return (TASK_EDITABLE_FIELDS as readonly string[]).includes(value);
}

function makePresentationInput(props: PublishingStatusHostProps): PublishingPresentationInput {
  return {
    taskDrafts: props.taskDrafts,
    transaction: props.taskEdit.publishTransaction,
    saveState: props.taskEdit.saveState,
    publishState: props.taskEdit.publishState,
    storageMode: props.storageMode,
    snapshot: { savedAt: props.saved.savedAt, sync: props.snapshotSync },
  };
}

function notify(
  command: PublicationNotificationCommand,
  dismissedIds: Set<string>,
  programmaticDismissals: Set<string>,
  generations: Map<string, number>,
  latestRef: { current: PublicationNotificationSnapshot },
): void {
  if (command.kind === 'dismiss') {
    if (toast.getToasts().some(current => current.id === command.id)) {
      programmaticDismissals.add(command.id);
      toast.dismiss(command.id);
    }
    return;
  }
  if (command.tone === 'error' && dismissedIds.has(command.id)) return;

  const generation = generations.get(command.id) ?? 0;
  const options = {
    id: command.id,
    duration: command.durationMs ?? Number.POSITIVE_INFINITY,
    closeButton: true,
    onDismiss: () => {
      if (programmaticDismissals.has(command.id)) {
        programmaticDismissals.delete(command.id);
        return;
      }
      if (command.tone === 'error'
        && (generations.get(command.id) ?? 0) === generation
        && notificationErrorIsCurrent(command.id, latestRef.current)) {
        dismissedIds.add(command.id);
      }
    },
  };
  switch (command.tone) {
    case 'loading': toast.loading(command.message, options); break;
    case 'success': toast.success(command.message, options); break;
    case 'error': toast.error(command.message, options); break;
  }
}

function notificationErrorIsCurrent(id: string, latest: PublicationNotificationSnapshot): boolean {
  const separator = id.lastIndexOf(':');
  if (separator < 0) return false;
  const transaction = latest.transaction;
  if (transaction?.request.requestId !== id.slice('task-publish:'.length, separator)) return false;
  switch (id.slice(separator + 1)) {
    case 'preparation-failure':
      return transaction.phase === 'prepare-pending';
    case 'publication-failure':
      return transaction.phase === 'final-pending';
    case 'deployment-failure':
      return transaction.phase === 'receipt-recorded';
    case 'conflict':
      return transaction.phase === 'conflict' || transaction.phase === 'receipt-superseded';
    default:
      return false;
  }
}

function NotificationBridge({
  snapshot,
  snapshotRef,
  dismissedIds,
  programmaticDismissals,
  generations,
}: {
  readonly snapshot: PublicationNotificationSnapshot;
  readonly snapshotRef: { current: PublicationNotificationSnapshot };
  readonly dismissedIds: Set<string>;
  readonly programmaticDismissals: Set<string>;
  readonly generations: Map<string, number>;
}) {
  const current = useMemo(() => snapshot, [snapshot]);
  const previous = useRef<PublicationNotificationSnapshot | null>(null);

  useEffect(() => {
    const commands = derivePublicationNotifications(previous.current, current);
    previous.current = current;
    for (const command of commands) notify(command, dismissedIds, programmaticDismissals, generations, snapshotRef);
  }, [current, dismissedIds, programmaticDismissals, generations, snapshotRef]);

  return null;
}

function ConflictValue({ label, value }: { readonly label: string; readonly value: string | null }) {
  return (
    <div className="publishing-conflict-value">
      <dt>{label}</dt>
      <dd><pre>{value === null ? 'Not available in the deployed snapshot.' : value.length === 0 ? 'Empty' : value}</pre></dd>
    </div>
  );
}

function conflictCanBeDiscarded(
  transaction: TaskPublishTransactionPayload,
  conflict: TaskPublishConflictResponse['conflicts'][number],
  taskDrafts: readonly ParsedTaskContentDraft[],
  canonicalData: TrackerSnapshot,
): conflict is TaskPublishConflictResponse['conflicts'][number] & { field: TaskEditableField } {
  if (transaction.phase !== 'canceled' || !isEditableField(conflict.field)) return false;
  const item = canonicalData.itemById.get(conflict.taskId);
  const draft = taskDrafts.find(candidate => candidate.recordId === conflict.taskId);
  if (item === undefined || draft?.payload.fields[conflict.field] === undefined) return false;
  return taskPublishFieldValuesMatch(conflict.field, taskDraftFieldValue(item, conflict.field), conflict.currentValue);
}

function RecoveryDialog({
  open,
  transaction,
  taskDrafts,
  canonicalData,
  operationBusy,
  requestId,
  onOpenChange,
  onCancelRequest,
  onDiscardField,
  onRefresh,
}: {
  readonly open: boolean;
  readonly transaction: TaskPublishTransactionPayload | null;
  readonly taskDrafts: readonly ParsedTaskContentDraft[];
  readonly canonicalData: TrackerSnapshot;
  readonly operationBusy: boolean;
  readonly requestId: string | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onCancelRequest: (requestId: string) => void;
  readonly onDiscardField: (requestId: string, itemId: string, field: TaskEditableField) => void;
  readonly onRefresh: (requestId: string) => void;
}) {
  const conflict = transaction?.conflict;
  const valid = transaction !== null
    && transaction.conflict !== undefined
    && transaction.request.requestId === requestId
    && (transaction.phase === 'conflict' || transaction.phase === 'canceled');
  const canCancel = transaction !== null && valid && transaction.phase === 'conflict' && !operationBusy;
  const canRefresh = valid && !operationBusy;

  return (
    <Dialog open={open && valid} onOpenChange={onOpenChange}>
      <DialogContent className="publishing-conflict-dialog" aria-describedby="publishing-conflict-description">
        <DialogHeader className="publishing-conflict-header">
          <DialogTitle>Resolve tracker changes</DialogTitle>
          <DialogDescription id="publishing-conflict-description">
            Compare repository values with the deployed tracker and your local drafts. A field can be discarded only after the deployed value matches the repository value.
          </DialogDescription>
          {transaction?.phase === 'conflict' ? (
            <p className="publishing-conflict-request-state">Cancel the unsubmitted request before resolving its local fields. Your drafts and Undo history stay available.</p>
          ) : null}
        </DialogHeader>
        <div className="publishing-conflict-list">
          {valid && conflict?.conflicts.map((entry, index) => {
            const field = isEditableField(entry.field) ? entry.field : null;
            const item = canonicalData.itemById.get(entry.taskId);
            const deployedValue = field !== null && item !== undefined ? taskDraftFieldValue(item, field) : null;
            const canDiscard = field !== null && conflictCanBeDiscarded(transaction, entry, taskDrafts, canonicalData);
            const hasLocalDraft = field !== null
              && taskDrafts.some(draft => draft.recordId === entry.taskId && draft.payload.fields[field] !== undefined);

            return (
              <article className="publishing-conflict-card" key={`${entry.taskId}:${entry.field}:${index}`}>
                <h3>{entry.taskId} · {field === null ? entry.field : FIELD_LABELS[field]}</h3>
                <dl>
                  <ConflictValue label="Repository current value" value={entry.currentValue} />
                  <ConflictValue label="Deployed tracker value" value={deployedValue} />
                  <ConflictValue label="Local proposed value" value={entry.proposedValue} />
                </dl>
                {entry.message ? (
                  <details className="publishing-conflict-explanation">
                    <summary>Conflict details</summary>
                    <p>{entry.message}</p>
                  </details>
                ) : null}
                {canDiscard && field !== null ? (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={operationBusy}
                    onClick={() => requestId !== null && onDiscardField(requestId, entry.taskId, field)}
                  >Discard this field’s local draft</Button>
                ) : hasLocalDraft ? (
                  <p className="publishing-conflict-refresh">Refresh or wait until the deployed tracker value matches the repository value before discarding this local draft.</p>
                ) : (
                  <p className="publishing-conflict-resolved">This local field draft has already been resolved.</p>
                )}
              </article>
            );
          })}
        </div>
        <DialogFooter className="publishing-conflict-footer">
          <Button type="button" variant="outline" disabled={!canRefresh} onClick={() => requestId !== null && onRefresh(requestId)}>
            Refresh tracker source
          </Button>
          {canCancel ? (
            <Button type="button" variant="outline" onClick={() => requestId !== null && onCancelRequest(requestId)}>
              Cancel conflicted request
            </Button>
          ) : null}
          <Button type="button" onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function PublishingStatusHost(props: PublishingStatusHostProps) {
  const propsRef = useRef(props);
  propsRef.current = props;

  const [reviewOpen, setReviewOpen] = useState(false);
  const reviewRequestIdRef = useRef<string | null>(null);
  const [reviewSelection, setReviewSelection] = useState<ReviewSelectionState>(EMPTY_SELECTION);
  const reviewSelectionRef = useRef(reviewSelection);
  reviewSelectionRef.current = reviewSelection;
  const reviewIntent = useRef<{ requestId: string | null; originRequestId: string | null } | null>(null);

  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [recoveryRequestId, setRecoveryRequestId] = useState<string | null>(null);
  const recoveryRequestIdRef = useRef<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);

  const presentationInput = useMemo(() => makePresentationInput(props), [
    props.taskDrafts,
    props.taskEdit.publishTransaction,
    props.taskEdit.saveState,
    props.taskEdit.publishState,
    props.storageMode,
    props.saved.savedAt,
    props.snapshotSync,
  ]);
  const presentation = useMemo(() => derivePublishingPresentation(presentationInput), [presentationInput]);
  const notificationSnapshot = useMemo<PublicationNotificationSnapshot>(() => ({
    transaction: props.taskEdit.publishTransaction,
    publishState: props.taskEdit.publishState,
  }), [props.taskEdit.publishTransaction, props.taskEdit.publishState]);
  const notificationSnapshotRef = useRef(notificationSnapshot);
  notificationSnapshotRef.current = notificationSnapshot;
  const dismissedNotificationIds = useRef(new Set<string>());
  const programmaticDismissals = useRef(new Set<string>());
  const notificationGenerations = useRef(new Map<string, number>());

  useEffect(() => {
    if (props.taskEdit.publishTransaction?.phase !== 'review-ready'
      || props.taskEdit.publishTransaction.prepared === undefined) return;
    const prepared = props.taskEdit.publishTransaction.prepared;
    setReviewSelection(previous => reduceReviewSelection(previous, { type: 'sync-review', prepared }));
  }, [
    props.taskEdit.publishTransaction?.phase,
    props.taskEdit.publishTransaction?.prepared?.requestId,
    props.taskEdit.publishTransaction?.prepared?.reviews,
  ]);

  useEffect(() => {
    const transaction = props.taskEdit.publishTransaction;
    const intent = reviewIntent.current;
    if (intent === null) return;
    if (props.taskEdit.publishState.kind === 'failed') {
      reviewIntent.current = null;
      return;
    }

    if (intent.requestId === null) {
      if ((transaction?.phase === 'prepare-pending' || transaction?.phase === 'review-ready')
        && transaction.request.requestId !== intent.originRequestId) {
        intent.requestId = transaction.request.requestId;
      } else if (transaction?.phase === 'prepare-pending'
        && transaction.request.requestId === intent.originRequestId) {
        intent.requestId = transaction.request.requestId;
      }
      if (intent.requestId === null) return;
    }

    if (transaction?.request.requestId !== intent.requestId) {
      reviewIntent.current = null;
      return;
    }
    if (transaction.phase === 'review-ready' && transaction.prepared !== undefined
      && props.taskEdit.publishState.kind === 'idle') {
      reviewIntent.current = null;
      const prepared = transaction.prepared;
      setReviewSelection(previous => reduceReviewSelection(previous, { type: 'sync-review', prepared }));
      reviewRequestIdRef.current = transaction.request.requestId;
      setReviewOpen(true);
      return;
    }
    if (transaction.phase !== 'prepare-pending' && transaction.phase !== 'review-ready') {
      reviewIntent.current = null;
    }
  }, [
    props.taskEdit.publishTransaction?.phase,
    props.taskEdit.publishTransaction?.request.requestId,
    props.taskEdit.publishTransaction?.prepared,
    props.taskEdit.publishState.kind,
  ]);

  useEffect(() => {
    if (!reviewOpen) return;
    const transaction = props.taskEdit.publishTransaction;
    if (transaction?.phase !== 'review-ready'
      || transaction.request.requestId !== reviewRequestIdRef.current
      || transaction.prepared === undefined) {
      reviewRequestIdRef.current = null;
      setReviewOpen(false);
    }
  }, [reviewOpen, props.taskEdit.publishTransaction]);

  useEffect(() => {
    if (!recoveryOpen) return;
    const transaction = props.taskEdit.publishTransaction;
    if (transaction?.request.requestId !== recoveryRequestIdRef.current
      || transaction.conflict === undefined
      || (transaction.phase !== 'conflict' && transaction.phase !== 'canceled')) {
      recoveryRequestIdRef.current = null;
      setRecoveryRequestId(null);
      setRecoveryOpen(false);
    }
  }, [recoveryOpen, props.taskEdit.publishTransaction]);

  const handleReviewOpenChange = (open: boolean) => {
    const current = propsRef.current.taskEdit.publishTransaction;
    if (open) {
      if (current?.phase !== 'review-ready' || current.prepared === undefined) return;
      const prepared = current.prepared;
      setReviewSelection(previous => reduceReviewSelection(previous, { type: 'sync-review', prepared }));
      reviewRequestIdRef.current = current.request.requestId;
      setReviewOpen(true);
      return;
    }
    setReviewOpen(false);
  };

  const handleReviewSelectionAction = (action: ReviewSelectionAction) => {
    const latest = propsRef.current;
    const transaction = latest.taskEdit.publishTransaction;
    const requestId = reviewRequestIdRef.current;
    if (transaction?.phase !== 'review-ready' || transaction.prepared === undefined
      || requestId === null || transaction.request.requestId !== requestId
      || reviewIdentity(transaction.prepared) !== reviewSelectionRef.current.identity) return;
    setReviewSelection(previous => reduceReviewSelection(previous, action));
  };

  const handleConfirm = (checkedTaskIds: readonly string[]) => {
    const latest = propsRef.current;
    const transaction = latest.taskEdit.publishTransaction;
    const selection = reviewSelectionRef.current;
    const requestId = reviewRequestIdRef.current;
    if (transaction?.phase !== 'review-ready' || transaction.prepared === undefined
      || requestId === null || transaction.request.requestId !== requestId
      || !preparedReviewsMatchFrozenTasks(transaction)
      || !canConfirmPreparedReview(transaction, selection, latest.taskEdit.publishState)
      || hasActivePublishOperation(latest.taskEdit)) return;
    const frozenIds = transaction.request.tasks.map(task => task.id);
    const checkedSet = new Set(checkedTaskIds);
    if (checkedTaskIds.length !== frozenIds.length
      || checkedSet.size !== frozenIds.length
      || checkedTaskIds.some(id => !frozenIds.includes(id))) return;
    latest.taskEdit.confirmPublish(checkedTaskIds);
    setReviewOpen(false);
  };

  const openReview = (transaction: TaskPublishTransactionPayload | null) => {
    if (hasActivePublishOperation(propsRef.current.taskEdit)) return;
    if (transaction?.phase === 'review-ready' && transaction.prepared !== undefined) {
      const prepared = transaction.prepared;
      setReviewSelection(previous => reduceReviewSelection(previous, { type: 'sync-review', prepared }));
      reviewRequestIdRef.current = transaction.request.requestId;
      setReviewOpen(true);
      return;
    }
    reviewIntent.current = {
      requestId: transaction?.phase === 'prepare-pending' ? transaction.request.requestId : null,
      originRequestId: transaction?.request.requestId ?? null,
    };
    propsRef.current.taskEdit.startPublish();
  };

  const clearDismissedNotificationStages = (requestId: string | undefined, ...stages: readonly string[]) => {
    if (requestId === undefined) return;
    const prefix = `task-publish:${requestId}:`;
    for (const id of dismissedNotificationIds.current) {
      if (id.startsWith(prefix) && stages.includes(id.slice(prefix.length))) dismissedNotificationIds.current.delete(id);
    }
    for (const stage of stages) {
      const id = `${prefix}${stage}`;
      notificationGenerations.current.set(id, (notificationGenerations.current.get(id) ?? 0) + 1);
    }
  };

  const openRecovery = (transaction: TaskPublishTransactionPayload | null) => {
    if (transaction?.conflict === undefined
      || (transaction.phase !== 'conflict' && transaction.phase !== 'canceled')) return;
    recoveryRequestIdRef.current = transaction.request.requestId;
    setRecoveryRequestId(transaction.request.requestId);
    setRecoveryOpen(true);
  };

  const handleBannerAction = (id: PublishingActionId) => {
    const latest = propsRef.current;
    const transaction = latest.taskEdit.publishTransaction;
    const currentPresentation = derivePublishingPresentation(makePresentationInput(latest));
    if (!currentPresentation.actions.some(action => action.id === id)) return;
    if (id !== 'open-details' && hasActivePublishOperation(latest.taskEdit)) return;

    switch (id) {
      case 'open-review':
        openReview(transaction);
        break;
      case 'review-latest':
        reviewIntent.current = { requestId: null, originRequestId: transaction?.request.requestId ?? null };
        latest.taskEdit.startPublish();
        break;
      case 'cancel-review':
        if (transaction?.phase !== 'review-ready') return;
        latest.taskEdit.cancelPublishRequest();
        reviewRequestIdRef.current = null;
        setReviewOpen(false);
        break;
      case 'retry-prepare':
        if (transaction?.phase === 'final-pending' || transaction?.phase === 'review-ready') return;
        clearDismissedNotificationStages(transaction?.request.requestId, 'preparation', 'preparation-failure', 'review-ready');
        reviewIntent.current = {
          requestId: transaction?.phase === 'prepare-pending' ? transaction.request.requestId : null,
          originRequestId: transaction?.request.requestId ?? null,
        };
        if (transaction?.phase === 'prepare-pending') latest.taskEdit.retryPublish();
        else latest.taskEdit.startPublish();
        break;
      case 'retry-publication':
        if (transaction?.phase !== 'final-pending' || latest.taskEdit.publishState.kind !== 'failed') return;
        clearDismissedNotificationStages(transaction.request.requestId, 'publication', 'publication-failure', 'publication-success', 'deployment', 'deployment-failure', 'conflict');
        latest.taskEdit.retryPublish();
        break;
      case 'check-update':
        if (transaction?.phase !== 'receipt-recorded') return;
        clearDismissedNotificationStages(transaction.request.requestId, 'publication-success', 'deployment', 'deployment-failure', 'conflict');
        latest.taskEdit.retryPublish();
        break;
      case 'resolve-conflicts':
        openRecovery(transaction);
        break;
      case 'open-details':
        setDetailsOpen(true);
        break;
    }
  };

  const handleRecoveryCancel = (requestId: string) => {
    const latest = propsRef.current;
    const transaction = latest.taskEdit.publishTransaction;
    if (recoveryRequestIdRef.current !== requestId
      || transaction?.request.requestId !== requestId
      || transaction.phase !== 'conflict'
      || hasActivePublishOperation(latest.taskEdit)) return;
    latest.taskEdit.cancelPublishRequest();
  };

  const handleRecoveryDiscard = (requestId: string, taskId: string, field: TaskEditableField) => {
    const latest = propsRef.current;
    const transaction = latest.taskEdit.publishTransaction;
    if (recoveryRequestIdRef.current !== requestId
      || transaction?.request.requestId !== requestId
      || transaction.phase !== 'canceled'
      || transaction.conflict === undefined
      || hasActivePublishOperation(latest.taskEdit)) return;
    const conflict = transaction.conflict.conflicts.find(entry => entry.taskId === taskId && entry.field === field);
    if (conflict === undefined || !conflictCanBeDiscarded(transaction, conflict, latest.taskDrafts, latest.canonicalData)) return;
    latest.taskEdit.discardConflictedField(taskId, field);
  };

  const handleRecoveryRefresh = (requestId: string) => {
    const latest = propsRef.current;
    const transaction = latest.taskEdit.publishTransaction;
    if (recoveryRequestIdRef.current !== requestId
      || transaction?.request.requestId !== requestId
      || (transaction.phase !== 'conflict' && transaction.phase !== 'canceled')
      || hasActivePublishOperation(latest.taskEdit)) return;
    latest.taskEdit.refreshCanonical();
  };

  const handleDetailsToggle = (event: SyntheticEvent<HTMLDetailsElement>) => {
    setDetailsOpen(event.currentTarget.open);
  };

  const currentTransaction = props.taskEdit.publishTransaction;
  const hasNewerEdits = hasNewerDraftEdits(currentTransaction, props.taskDrafts);
  const activeOperation = hasActivePublishOperation(props.taskEdit);

  return (
    <>
      <NotificationBridge
        snapshot={notificationSnapshot}
        snapshotRef={notificationSnapshotRef}
        dismissedIds={dismissedNotificationIds.current}
        programmaticDismissals={programmaticDismissals.current}
        generations={notificationGenerations.current}
      />
      <aside
        className={`publishing-status-banner publishing-status-${presentation.tone}`}
        role="status"
        aria-live="polite"
        aria-label="Task draft publishing"
        data-state={presentation.phase}
        data-sync-state={props.snapshotSync.kind}
        data-snapshot-saved-at={presentation.savedAt}
      >
        <div className="publishing-status-copy">
          <strong>{presentation.message}</strong>
          {presentation.supportingMessage ? <p>{presentation.supportingMessage}</p> : null}
          {presentation.warnings.length > 0 ? (
            <ul className="publishing-status-warnings">
              {presentation.warnings.map(warning => <li key={warning}>{warning}</li>)}
            </ul>
          ) : null}
          <details className="publishing-status-details" open={detailsOpen} onToggle={handleDetailsToggle}>
            <summary>Sync details</summary>
            <p>{presentation.snapshotDetails}</p>
            <dl className="publishing-status-diagnostics">
              <div><dt>Publication phase</dt><dd>{currentTransaction?.phase ?? 'No saved publish request'}</dd></div>
              {currentTransaction ? <div><dt>Request ID</dt><dd><code>{currentTransaction.request.requestId}</code></dd></div> : null}
              {currentTransaction?.receipt ? <div><dt>Published commit</dt><dd><code>{currentTransaction.receipt.commit}</code></dd></div> : null}
              {currentTransaction?.receipt?.source ? <div><dt>Tracker source</dt><dd><code>{currentTransaction.receipt.source.commit}</code></dd></div> : null}
            </dl>
            {props.taskEdit.saveState.kind === 'failed' ? <p className="publishing-status-error-detail">Draft save: {props.taskEdit.saveState.message}</p> : null}
            {props.taskEdit.publishState.kind === 'failed' ? <p className="publishing-status-error-detail">Publish check: {props.taskEdit.publishState.message}</p> : null}
            {currentTransaction?.conflict?.error ? <p className="publishing-status-error-detail">Repository conflict: {currentTransaction.conflict.error}</p> : null}
          </details>
        </div>
        {presentation.actions.length > 0 ? (
          <div className="publishing-status-actions">
            {presentation.actions.map(action => (
              <Button
                key={action.id}
                type="button"
                variant={action.id === 'open-review' || action.id === 'retry-prepare' || action.id === 'retry-publication' || action.id === 'resolve-conflicts' ? 'default' : 'outline'}
                disabled={activeOperation && action.id !== 'open-details'}
                onClick={() => handleBannerAction(action.id)}
              >{action.label}</Button>
            ))}
          </div>
        ) : null}
      </aside>

      <PublishingReviewDialog
        open={reviewOpen}
        transaction={currentTransaction}
        selection={reviewSelection}
        publishState={props.taskEdit.publishState}
        hasNewerEdits={hasNewerEdits}
        onOpenChange={handleReviewOpenChange}
        onSelectionAction={handleReviewSelectionAction}
        onConfirm={handleConfirm}
      />

      <RecoveryDialog
        open={recoveryOpen}
        transaction={currentTransaction}
        taskDrafts={props.taskDrafts}
        canonicalData={props.canonicalData}
        operationBusy={activeOperation}
        requestId={recoveryRequestId}
        onOpenChange={open => {
          if (!open) setRecoveryOpen(false);
          else openRecovery(propsRef.current.taskEdit.publishTransaction);
        }}
        onCancelRequest={handleRecoveryCancel}
        onDiscardField={handleRecoveryDiscard}
        onRefresh={handleRecoveryRefresh}
      />
    </>
  );
}
