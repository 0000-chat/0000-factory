import { ArrowLeft, ChevronRight, ShieldCheck } from 'lucide-react';
import { useLayoutEffect, useMemo, useRef } from 'react';
import { Button } from './components/ui/button.tsx';
import { Checkbox } from './components/ui/checkbox.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './components/ui/dialog.tsx';
import {
  buildFieldComparison,
  canConfirmPreparedReview,
  preparedReviewsMatchFrozenTasks,
  reviewIdentity,
  type ReviewSelectionAction,
  type ReviewSelectionState,
} from './publishing-ui-model.ts';
import type { TaskDraftPublishState } from './router-context.ts';
import type { TaskPublishPrepareResponse, TaskPublishTransactionPayload } from './task-publishing.ts';
import './publishing-review.css';

export interface PublishingReviewDialogProps {
  readonly open: boolean;
  readonly transaction: TaskPublishTransactionPayload | null;
  readonly selection: ReviewSelectionState;
  readonly publishState: TaskDraftPublishState;
  readonly hasNewerEdits: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSelectionAction: (action: ReviewSelectionAction) => void;
  readonly onConfirm: (allCheckedTaskIds: readonly string[]) => void;
}

type PreparedReview = TaskPublishPrepareResponse['reviews'][number];

function changedFieldSummary(review: PreparedReview): string {
  const labels = review.changes.map(change => change.label);
  return labels.length === 0 ? 'No changed fields' : labels.join(' · ');
}

function renderExactValue(value: string) {
  return value === '' ? <span className="publishing-review-empty">Empty</span> : value;
}

function renderComparedValue(comparison: ReturnType<typeof buildFieldComparison>, side: 'before' | 'after') {
  if (comparison.parts === null) {
    return renderExactValue(comparison[side]);
  }

  const visibleParts = comparison.parts.filter(part => side === 'before'
    ? part.kind !== 'added'
    : part.kind !== 'removed');
  const reconstructed = visibleParts.map(part => part.value).join('');
  if (reconstructed !== comparison[side]) return renderExactValue(comparison[side]);
  if (comparison[side] === '') return renderExactValue('');

  return visibleParts.map((part, index) => {
    if (side === 'before' && part.kind === 'removed') {
      return <del className="publishing-review-diff-removed" key={`${index}:${part.value}`}>{part.value}</del>;
    }
    if (side === 'after' && part.kind === 'added') {
      return <ins className="publishing-review-diff-added" key={`${index}:${part.value}`}>{part.value}</ins>;
    }
    return <span key={`${index}:${part.value}`}>{part.value}</span>;
  });
}

function ScopeBadge() {
  return <span className="publishing-review-scope-badge"><ShieldCheck size={14} aria-hidden="true" />Scope approval</span>;
}

function TaskConfirmation({
  review,
  checked,
  onCheckedChange,
}: {
  readonly review: PreparedReview;
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
}) {
  return <div className="publishing-review-confirmation">
    <Checkbox
      checked={checked}
      aria-label={`Review ${review.title}`}
      onCheckedChange={value => onCheckedChange(value === true)}
    />
    <span>{review.requiresApproval ? 'Reviewed scope and existing approvals' : 'Reviewed'}</span>
  </div>;
}

export function PublishingReviewDialog({
  open,
  transaction,
  selection,
  publishState,
  hasNewerEdits,
  onOpenChange,
  onSelectionAction,
  onConfirm,
}: PublishingReviewDialogProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const listTitleButtons = useRef(new Map<string, HTMLButtonElement>());
  const backButtonRef = useRef<HTMLButtonElement>(null);
  const selectAllRef = useRef<HTMLButtonElement>(null);
  const previousOpenedTaskId = useRef(selection.openedTaskId);
  const openerTaskId = useRef<string | null>(null);
  const savedListScrollTop = useRef(0);
  const prepared = transaction?.phase === 'review-ready' ? transaction.prepared : undefined;
  const reviewIsValid = preparedReviewsMatchFrozenTasks(transaction);
  const selectionMatchesPrepared = prepared !== undefined
    && selection.identity === reviewIdentity(prepared);
  const visibleSelection = selectionMatchesPrepared ? selection : null;
  const openedReview = !reviewIsValid || visibleSelection?.openedTaskId === null || visibleSelection?.openedTaskId === undefined
    ? null
    : prepared?.reviews.find(review => review.taskId === visibleSelection.openedTaskId) ?? null;
  const reviews = reviewIsValid && prepared !== undefined ? prepared.reviews : [];
  const checkedIds = useMemo(() => new Set(selection.checkedTaskIds), [selection.checkedTaskIds]);
  const checkedCount = reviews.reduce((count, review) => count + Number(checkedIds.has(review.taskId)), 0);
  const allSelected = reviews.length > 0 && checkedCount === reviews.length;
  const canConfirm = canConfirmPreparedReview(transaction, selection, publishState);

  useLayoutEffect(() => {
    const previousTaskId = previousOpenedTaskId.current;
    const currentTaskId = selection.openedTaskId;
    if (previousTaskId === currentTaskId) return;
    previousOpenedTaskId.current = currentTaskId;

    if (currentTaskId !== null) {
      requestAnimationFrame(() => backButtonRef.current?.focus());
      return;
    }

    if (previousTaskId !== null) {
      requestAnimationFrame(() => {
        if (listRef.current) listRef.current.scrollTop = savedListScrollTop.current;
        const focusId = openerTaskId.current ?? previousTaskId;
        const opener = listTitleButtons.current.get(focusId);
        if (opener) opener.focus({ preventScroll: true });
        else selectAllRef.current?.focus({ preventScroll: true });
      });
    }
  }, [selection.openedTaskId]);

  const setTaskChecked = (taskId: string, checked: boolean) => {
    onSelectionAction({ type: 'toggle-task', taskId, checked });
  };

  const openTaskDetails = (taskId: string) => {
    savedListScrollTop.current = listRef.current?.scrollTop ?? 0;
    openerTaskId.current = taskId;
    onSelectionAction({ type: 'open-task', taskId });
  };

  const confirmPublish = () => {
    if (!canConfirm || prepared === undefined) return;
    const allTaskIds = prepared.reviews.map(review => review.taskId);
    onConfirm(allTaskIds);
    onOpenChange(false);
  };

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent
      className="publishing-review-dialog"
      data-review-view={openedReview ? 'details' : reviewIsValid ? 'list' : 'invalid'}
      aria-describedby="publishing-review-description"
      onOpenAutoFocus={event => {
        if (openedReview) {
          event.preventDefault();
          backButtonRef.current?.focus();
        }
      }}
    >
      <DialogHeader className="publishing-review-header">
        <div className="publishing-review-heading-row">
          {openedReview ? <Button
            ref={backButtonRef}
            className="publishing-review-back"
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => onSelectionAction({ type: 'back-to-list' })}
          ><ArrowLeft size={16} aria-hidden="true" />Back to tasks</Button> : null}
          <div className="publishing-review-heading-copy">
            <DialogTitle className="publishing-review-title">{openedReview?.title ?? 'Review changes'}</DialogTitle>
            <DialogDescription id="publishing-review-description" className="publishing-review-description">
              {openedReview
                ? `${openedReview.changes.length} ${openedReview.changes.length === 1 ? 'field' : 'fields'} changed`
                : 'Check each task when you’re ready to publish.'}
            </DialogDescription>
          </div>
        </div>
        {!openedReview && reviews.some(review => review.requiresApproval) ? <p className="publishing-review-approval-note">
          For marked tasks, checking the box confirms the new scope and the existing approvals shown in its details.
        </p> : null}
        {hasNewerEdits ? <p className="publishing-review-newer-edits">Newer edits will stay saved for your next publish.</p> : null}
        {openedReview ? <div className="publishing-review-header-confirmation">
          <TaskConfirmation
            review={openedReview}
            checked={checkedIds.has(openedReview.taskId)}
            onCheckedChange={checked => setTaskChecked(openedReview.taskId, checked)}
          />
          {openedReview.requiresApproval ? <ScopeBadge /> : null}
        </div> : null}
      </DialogHeader>

      {openedReview ? <div className="publishing-review-body" key={`detail:${openedReview.taskId}`}>
        <TaskReviewDetailsContent review={openedReview} />
      </div> : <div className="publishing-review-body" ref={listRef} key="list">
        {reviewIsValid ? <>
          <div className="publishing-review-list-controls">
            <Button
              ref={selectAllRef}
              type="button"
              variant="outline"
              size="sm"
              disabled={reviews.length === 0}
              onClick={() => onSelectionAction({ type: 'toggle-all' })}
            >{allSelected ? 'Clear all' : 'Select all'}</Button>
            <p className="publishing-review-count" aria-live="polite">
              {checkedCount} of {reviews.length} {reviews.length === 1 ? 'task' : 'tasks'} checked
            </p>
          </div>
          <ul className="publishing-review-list">
            {reviews.map(review => <li className="publishing-review-list-item" key={review.taskId}>
              <Checkbox
                checked={checkedIds.has(review.taskId)}
                aria-label={`Review ${review.title}`}
                onCheckedChange={value => setTaskChecked(review.taskId, value === true)}
              />
              <Button
                ref={node => {
                  if (node) listTitleButtons.current.set(review.taskId, node);
                  else listTitleButtons.current.delete(review.taskId);
                }}
                className="publishing-review-open-task"
                type="button"
                variant="ghost"
                onClick={() => openTaskDetails(review.taskId)}
                aria-label={`View changes for ${review.title}`}
              >
                <span className="publishing-review-list-title">{review.title}</span>
                <span className="publishing-review-field-summary">{changedFieldSummary(review)}</span>
                {review.requiresApproval ? <ScopeBadge /> : null}
                <ChevronRight className="publishing-review-open-icon" size={16} aria-hidden="true" />
              </Button>
            </li>)}
          </ul>
        </> : <div className="publishing-review-invalid" role="alert">
          <h3>This review could not be verified</h3>
          <p>The prepared task list does not match the frozen request, so publishing is blocked. Close this dialog and review the request again.</p>
        </div>}
      </div>}

      <DialogFooter className="publishing-review-footer">
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Review later</Button>
        <Button type="button" disabled={!canConfirm} onClick={confirmPublish}>
          Publish {reviews.length} {reviews.length === 1 ? 'task' : 'tasks'}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

function TaskReviewDetailsContent({ review }: {
  readonly review: PreparedReview;
}) {
  return <div className="publishing-review-detail-content">
    <div className="publishing-review-detail-meta">
      <p>{changedFieldSummary(review)}</p>
    </div>
    <div className="publishing-review-fields">
      {review.changes.map(change => {
        const comparison = buildFieldComparison(change.before, change.after);
        return <section className="publishing-review-field" key={`${change.field}:${change.label}`}>
          <h3>{change.label}</h3>
          <div className="publishing-review-comparison">
            <div className="publishing-review-value-panel is-before">
              <h4><span aria-hidden="true" className="publishing-review-state-mark">−</span>Before</h4>
              <p>{renderComparedValue(comparison, 'before')}</p>
            </div>
            <div className="publishing-review-value-panel is-after">
              <h4><span aria-hidden="true" className="publishing-review-state-mark">+</span>After</h4>
              <p>{renderComparedValue(comparison, 'after')}</p>
            </div>
          </div>
        </section>;
      })}
    </div>
    {review.requiresApproval ? <p className="publishing-review-scope-explanation">
      Checking this task confirms its new scope and the existing approvals listed below.
    </p> : null}
    <details className="publishing-review-retained">
      <summary>Details kept unchanged</summary>
      {review.approvedParts.length > 0 ? <div className="publishing-review-approved-parts">
        <h3>Approved parts</h3>
        <ul>{review.approvedParts.map(part => <li key={part}>{part}</li>)}</ul>
      </div> : null}
      {review.retained.length > 0 ? <dl>
        {review.retained.map((entry, index) => <div key={`${entry.label}:${index}`}>
          <dt>{entry.label}</dt>
          <dd>{entry.value === '' ? 'Not set' : entry.value}</dd>
        </div>)}
      </dl> : null}
      {review.approvedParts.length === 0 && review.retained.length === 0
        ? <p className="publishing-review-no-retained">No retained details or existing approvals.</p>
        : null}
    </details>
  </div>;
}
