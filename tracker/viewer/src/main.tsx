import { Component, StrictMode, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { unstable_batchedUpdates } from 'react-dom';
import { RouterProvider } from '@tanstack/react-router';
import { makePersistedAdapter } from '@livestore/adapter-web';
import { StoreRegistry, storeOptions } from '@livestore/livestore';
import { StoreRegistryProvider, useStore } from '@livestore/react';
import { ShieldAlert } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from './components/ui/alert.tsx';
import { Button } from './components/ui/button.tsx';
import { Toaster } from './components/ui/sonner';
import { PublishingStatusHost } from './publishing-host';
import { createTrackerRouter } from './router';
import {
  canonicalSnapshotTable,
  draftOverlayTable,
  taskEditHistoryTable,
  taskEditSessionTable,
  taskPublishTransactionTable,
  TRACKER_STORE_ID,
  trackerSchema,
  trackerEvents,
} from './livestore-schema';
import { parseTrackerSnapshot } from './snapshot';
import { refreshCanonicalSnapshot, SnapshotAcknowledgementTimeout, waitForStoreAcknowledgement, type TrackerStore } from './snapshot-sync';
import { trackerInstanceConfig } from './instance-config';
import { legacyLocationPath } from './navigation';
import {
  composeTaskContentDrafts,
  parseTaskContentDraftOverlays,
  taskDraftFieldValue,
  TASK_EDITABLE_FIELDS,
} from './task-drafts';
import {
  createTaskEditSessionPayload,
  parseTaskEditHistoryRows,
  parseTaskEditHistoryPayload,
  parseTaskEditSessionPayload,
  parseTaskEditSessionRows,
} from './task-edit-history';
import {
  acquireTaskFieldLock,
  createTaskEditDocumentOwner,
  withAbandonedTaskEditOwnerLock,
} from './task-edit-locks';
import {
  createFinalTaskPublishRequest,
  createFrozenTaskPublishRequest,
  createPendingTaskPublishTransaction,
  isTaskPublishTransactionRetryable,
  parseTaskPublishConflictResponse,
  parseTaskPublishPrepareResponse,
  parseTaskPublishReceipt,
  parseTaskPublishTransactionRows,
  taskPublishReceiptMatchesCanonical,
  taskPublishReceiptMatchesRequest,
  taskPublishFieldValuesMatch,
  TASK_PUBLISH_TRANSACTION_ROW_ID,
  type TaskPublishConflictResponse,
  type TaskPublishTransactionPayload,
  type TaskPublishTransactionPhase,
} from './task-publishing';
import type { TaskDraftPublishState, TaskDraftSaveState, TaskEditController } from './router-context';
import type { PublishingSnapshotSyncStatus } from './publishing-ui-model';
import './theme';

const adapter = makePersistedAdapter({
  storage: { type: 'opfs' },
  worker: options => new Worker(new URL('./livestore.worker.js', import.meta.url), { ...options, type: 'module' }),
  sharedWorker: options => new SharedWorker(new URL('./livestore.shared-worker.js', import.meta.url), { ...options, type: 'module' }),
});

const trackerStoreOptions = storeOptions({
  storeId: TRACKER_STORE_ID,
  schema: trackerSchema,
  adapter,
});

const storeRegistry = new StoreRegistry({ defaultOptions: { batchUpdates: unstable_batchedUpdates } });
const taskEditDocumentOwner = createTaskEditDocumentOwner();

function SnapshotLoading() {
  return <main className="loading-shell" role="status" aria-live="polite"><div className="loading-mark">{trackerInstanceConfig.branding.markText}</div><p>{trackerInstanceConfig.branding.loadingLabel}</p></main>;
}

function SnapshotError({ error }: { error: Error }) {
  return <main className="error-shell">
    <Alert>
      <ShieldAlert size={26} aria-hidden="true" />
      <AlertTitle role="heading" aria-level={1}>Snapshot unavailable</AlertTitle>
      <AlertDescription>
        <p>{error.message}</p>
        <Button type="button" onClick={() => window.location.reload()}>Reload snapshot</Button>
      </AlertDescription>
    </Alert>
  </main>;
}

function taskStoreSchemaTablesAreMissing(error: unknown): boolean {
  const messages: string[] = [];
  const visited = new Set<object>();
  let current: unknown = error;
  while (current !== null && typeof current === 'object' && !visited.has(current)) {
    visited.add(current);
    if (current instanceof Error) messages.push(current.message);
    const cause = 'cause' in current ? current.cause : undefined;
    if (cause === undefined) break;
    current = cause;
  }
  if (messages.length === 0) messages.push(String(error));
  const message = messages.join(' ');
  return /no such table\s*:\s*(?:main\.)?["`]?tracker_(?:task_edit_(?:session|history)|task_publish_transaction)\b/i.test(message)
    || /table\s+["`]?tracker_(?:task_edit_(?:session|history)|task_publish_transaction)["`]?\s+does not exist/i.test(message);
}

function TaskEditSchemaUpgradeRequired() {
  return <main className="error-shell" role="alert">
    <Alert>
      <ShieldAlert size={26} aria-hidden="true" />
      <AlertTitle role="heading" aria-level={1}>Close older tracker tabs</AlertTitle>
      <AlertDescription>
        <p>Another open tracker tab is using an older saved-store schema. Close older tracker tabs, then reload this page to upgrade the cached store. This page does not clear your saved tracker data or drafts.</p>
        <Button type="button" onClick={() => window.location.reload()}>Reload tracker</Button>
      </AlertDescription>
    </Alert>
  </main>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function waitForTaskEditHandoff(store: TrackerStore, pendingSessions: Set<string>, timeoutMs = 15_000): Promise<void> {
  return new Promise((resolve, reject) => {
    let lastReadyHead: string | null = null;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      if (pollTimer !== null) clearTimeout(pollTimer);
      reject(new Error('Task edits are still active or waiting for local acknowledgement. Finish or cancel open edits, then retry.'));
    }, timeoutMs);
    const check = () => {
      if (settled) return;
      try {
        const sessions = parseTaskEditSessionRows(store.query(taskEditSessionTable.select()));
        const sync = store.syncStatus();
        const ready = pendingSessions.size === 0
          && sessions.length === 0
          && sync.pendingCount === 0
          && sync.isSynced;
        if (ready && lastReadyHead === sync.localHead) {
          settled = true;
          clearTimeout(timeout);
          if (pollTimer !== null) clearTimeout(pollTimer);
          resolve();
          return;
        }
        lastReadyHead = ready ? sync.localHead : null;
      } catch (error) {
        settled = true;
        clearTimeout(timeout);
        if (pollTimer !== null) clearTimeout(pollTimer);
        reject(error);
        return;
      }
      pollTimer = setTimeout(check, 25);
    };
    check();
  });
}

function publishResponseError(body: unknown, status: number): string {
  if (isRecord(body) && typeof body.error === 'string') return body.error.slice(0, 400);
  if (typeof body === 'string' && body.trim() !== '') return body.trim().slice(0, 400);
  return `Worker returned HTTP ${status}.`;
}

function taskPublishLockManager(): LockManager | null {
  return typeof navigator === 'undefined' || navigator.locks === undefined ? null : navigator.locks;
}

async function withTaskPublishLock<T>(run: () => Promise<T>): Promise<T> {
  const locks = taskPublishLockManager();
  if (locks === null) throw new Error('This browser cannot serialize publish requests across tracker tabs.');
  return locks.request(trackerInstanceConfig.browser.publishLockName, { mode: 'exclusive' }, run);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function responseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.trim() === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function sameTaskPublishReceipt(
  left: NonNullable<TaskPublishTransactionPayload['receipt']>,
  right: NonNullable<TaskPublishTransactionPayload['receipt']>,
): boolean {
  return left.requestId === right.requestId
    && left.payloadHash === right.payloadHash
    && left.originalSourceCommit === right.originalSourceCommit
    && left.commit === right.commit
    && JSON.stringify(left.fields) === JSON.stringify(right.fields);
}

function transactionPayloadJson(transaction: TaskPublishTransactionPayload): string {
  return JSON.stringify(transaction);
}

const publishingDisabledMessage = 'Publishing is unavailable for this tracker. Local drafts remain saved on this device.';

function StoredSnapshot({ store }: { store: TrackerStore }) {
  const saved = store.useQuery(canonicalSnapshotTable.select().first());
  const draftOverlays = store.useQuery(draftOverlayTable.select());
  const taskEditSessionRows = store.useQuery(taskEditSessionTable.select());
  const taskEditHistoryRows = store.useQuery(taskEditHistoryTable.select());
  const taskPublishTransactionRows = store.useQuery(taskPublishTransactionTable.select());
  const [status, setStatus] = useState<PublishingSnapshotSyncStatus>(() => (
    typeof navigator !== 'undefined' && navigator.onLine
      ? { kind: 'checking' }
      : { kind: 'stale', message: 'This device is offline.', checkedAt: null }
  ));
  const [taskDraftSaveState, setTaskDraftSaveState] = useState<TaskDraftSaveState>({ kind: 'saved' });
  const [taskEditOwnerState, setTaskEditOwnerState] = useState<'checking' | 'ready' | 'unsupported'>('checking');
  const [taskDraftPublishState, setTaskDraftPublishState] = useState<TaskDraftPublishState>({ kind: 'idle' });
  const inFlight = useRef<Promise<void> | null>(null);
  const publishInFlight = useRef(false);
  const automaticPublishAttempts = useRef(new Set<string>());
  const refreshRef = useRef<(() => Promise<void>) | null>(null);
  const draftWriteSequence = useRef(0);
  const pendingEditSessionIds = useRef(new Set<string>());
  const fieldLockReleases = useRef(new Map<string, { readonly release: () => void; readonly released: Promise<void> }>());
  const closingFieldLockHandoffs = useRef(new Map<string, Promise<void>>());
  const recoveringOwners = useRef(new Set<string>());
  const parsed = useMemo(() => {
    if (saved === undefined) return { snapshot: null, error: null };
    try {
      const payload: unknown = JSON.parse(saved.payloadJson);
      return { snapshot: parseTrackerSnapshot(payload), error: null };
    } catch (error) {
      return { snapshot: null, error: error instanceof Error ? error : new Error(String(error)) };
    }
  }, [saved]);
  const routerRef = useRef<ReturnType<typeof createTrackerRouter> | null>(null);
  const snapshot = parsed.snapshot;
  const projection = useMemo(
    () => snapshot === null ? null : composeTaskContentDrafts(snapshot, draftOverlays),
    [snapshot, draftOverlays],
  );
  const effectiveSnapshot = projection?.snapshot ?? null;
  const parsedTaskEdits = useMemo(() => {
    try {
      return {
        sessions: parseTaskEditSessionRows(taskEditSessionRows),
        history: parseTaskEditHistoryRows(taskEditHistoryRows),
        error: null,
      };
    } catch (error) {
      return { sessions: [], history: null, error: error instanceof Error ? error : new Error(String(error)) };
    }
  }, [taskEditHistoryRows, taskEditSessionRows]);
  const parsedTaskPublish = useMemo(() => {
    try {
      return { transaction: parseTaskPublishTransactionRows(taskPublishTransactionRows), error: null };
    } catch (error) {
      return { transaction: null, error: error instanceof Error ? error : new Error(String(error)) };
    }
  }, [taskPublishTransactionRows]);
  const persistTaskEditEvent = useCallback((commit: () => void, operation: string): Promise<void> => {
    const sequence = ++draftWriteSequence.current;
    const previousStatus = store.syncStatus();
    setTaskDraftSaveState({ kind: 'saving' });
    try {
      commit();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (draftWriteSequence.current === sequence) {
        setTaskDraftSaveState({ kind: 'failed', message: `LiveStore could not accept the task edit: ${message}` });
      }
      return Promise.reject(error);
    }
    return waitForStoreAcknowledgement(store, previousStatus, 15_000, operation)
      .then(() => {
        if (draftWriteSequence.current === sequence) setTaskDraftSaveState({ kind: 'saved' });
      })
      .catch(error => {
        if (draftWriteSequence.current === sequence) {
          console.error('LiveStore task draft acknowledgement failed.', error);
          setTaskDraftSaveState({ kind: 'failed', message: 'LiveStore could not confirm that this task draft was saved.' });
        }
        throw error;
      });
  }, [store]);
  const registerPendingEditSession = useCallback((sessionId: string) => {
    pendingEditSessionIds.current.add(sessionId);
  }, []);
  const releasePendingEditSession = useCallback((sessionId: string) => {
    pendingEditSessionIds.current.delete(sessionId);
  }, []);
  const readTaskPublishTransaction = useCallback(() => (
    parseTaskPublishTransactionRows(store.query(taskPublishTransactionTable.select()))
  ), [store]);
  const persistTaskPublishTransaction = useCallback(async (
    current: TaskPublishTransactionPayload | null,
    next: TaskPublishTransactionPayload,
  ) => {
    const previousStatus = store.syncStatus();
    const payloadJson = transactionPayloadJson(next);
    store.commit(trackerEvents.taskPublishTransactionSaved({
      expectedRequestId: current?.request.requestId ?? null,
      expectedPhase: current?.phase ?? null,
      payloadJson,
      updatedAt: next.updatedAt,
    }));
    const saved = store.query(taskPublishTransactionTable.select().where({ id: TASK_PUBLISH_TRANSACTION_ROW_ID }).first());
    if (saved?.payloadJson !== payloadJson) throw new Error('Another tracker tab changed the publish request; reload its current state before retrying.');
    await waitForStoreAcknowledgement(store, previousStatus, 15_000, 'frozen task publish request');
    const acknowledged = store.query(taskPublishTransactionTable.select().where({ id: TASK_PUBLISH_TRANSACTION_ROW_ID }).first());
    if (acknowledged?.payloadJson !== payloadJson) {
      throw new Error('LiveStore acknowledged a different saved publish state. No follow-up publish request was sent; reload the saved transaction before retrying.');
    }
  }, [store]);
  const runPublishOperation = useCallback((operation: () => Promise<void>) => {
    if (publishInFlight.current) return null;
    publishInFlight.current = true;
    const pending = withTaskPublishLock(operation)
      .catch(error => {
        setTaskDraftPublishState({ kind: 'failed', message: errorMessage(error).replaceAll(/[\r\n]+/g, ' ').slice(0, 400) });
      })
      .finally(() => { publishInFlight.current = false; });
    return pending;
  }, []);
  const savePublishConflict = useCallback(async (
    transaction: TaskPublishTransactionPayload,
    response: Response,
  ) => {
    const body = await responseBody(response);
    const conflict = parseTaskPublishConflictResponse(body, transaction.request.requestId);
    if (conflict.currentSourceCommit.length === 0) throw new Error('Publish conflict did not identify its source commit.');
    const current = readTaskPublishTransaction();
    if (current?.request.requestId !== transaction.request.requestId || current.phase !== transaction.phase) {
      throw new Error('The saved publish request changed while the conflict was being checked.');
    }
    await persistTaskPublishTransaction(current, {
      ...current,
      phase: 'conflict',
      conflict,
      updatedAt: new Date().toISOString(),
    });
  }, [persistTaskPublishTransaction, readTaskPublishTransaction]);
  const prepareFrozenTaskPublish = useCallback(async (transaction: TaskPublishTransactionPayload) => {
    setTaskDraftPublishState({ kind: 'preparing' });
    const response = await fetch('/api/publish/prepare', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(transaction.request),
    });
    if (response.status === 409) {
      await savePublishConflict(transaction, response);
      setTaskDraftPublishState({ kind: 'idle' });
      return;
    }
    const body = await responseBody(response);
    if (!response.ok) throw new Error(publishResponseError(body, response.status));
    const prepared = parseTaskPublishPrepareResponse(body, transaction.request.requestId);
    const requestedIds = transaction.request.tasks.map(task => task.id).sort();
    const reviewedIds = prepared.reviews.map(review => review.taskId).sort();
    if (JSON.stringify(requestedIds) !== JSON.stringify(reviewedIds)) throw new Error('Publish preparation did not review every frozen task.');
    const current = readTaskPublishTransaction();
    if (current?.request.requestId !== transaction.request.requestId || current.phase !== 'prepare-pending') {
      throw new Error('The frozen publish request changed while its review was being prepared.');
    }
    await persistTaskPublishTransaction(current, {
      ...current,
      phase: 'review-ready',
      prepared,
      updatedAt: new Date().toISOString(),
    });
    setTaskDraftPublishState({ kind: 'idle' });
  }, [persistTaskPublishTransaction, readTaskPublishTransaction, savePublishConflict]);
  const confirmPublishReceipt = useCallback(async (transaction: TaskPublishTransactionPayload, statusFirst = false) => {
    if (transaction.phase !== 'final-pending' || transaction.finalRequest === undefined) {
      throw new Error('The frozen publish request is not ready to submit.');
    }
    const recordReceipt = async (receipt: ReturnType<typeof parseTaskPublishReceipt>) => {
      if (!taskPublishReceiptMatchesRequest(receipt, transaction.request)) {
        throw new Error('Publish receipt values do not match the submitted fields; local drafts and history were kept.');
      }
      const current = readTaskPublishTransaction();
      if (current?.request.requestId !== transaction.request.requestId || current.phase !== 'final-pending') {
        throw new Error('The frozen publish request changed before its receipt arrived.');
      }
      const receiptTransaction: TaskPublishTransactionPayload = {
        ...current,
        phase: 'receipt-recorded',
        receipt,
        updatedAt: new Date().toISOString(),
      };
      await persistTaskPublishTransaction(current, receiptTransaction);
      await refreshRef.current?.();
      await checkPublishedSource(receiptTransaction);
    };

    if (statusFirst) {
      setTaskDraftPublishState({ kind: 'checking-source' });
      const canonical = store.query(canonicalSnapshotTable.select().where({ id: 'canonical' }).first());
      if (canonical === undefined || canonical.sourceCommit === 'unknown') {
        throw new Error('A canonical tracker source commit is needed to check this saved publish request before retrying.');
      }
      const query = new URLSearchParams({ sourceCommit: canonical.sourceCommit });
      const statusResponse = await fetch(`/api/publish/${encodeURIComponent(transaction.request.requestId)}?${query.toString()}`, {
        method: 'GET',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      });
      if (statusResponse.status !== 404) {
        const statusBody = await responseBody(statusResponse);
        if (!statusResponse.ok) throw new Error(publishResponseError(statusBody, statusResponse.status));
        const receipt = parseTaskPublishReceipt(statusBody, transaction.request.requestId);
        if (receipt.source === undefined || receipt.source.commit !== canonical.sourceCommit) {
          throw new Error('Publish status did not prove which tracker source commit it checked. The frozen request is retained.');
        }
        await recordReceipt(receipt);
        return;
      }
    }

    setTaskDraftPublishState({ kind: 'submitting' });
    const response = await fetch('/api/publish', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(transaction.finalRequest),
    });
    if (response.status === 409) {
      await savePublishConflict(transaction, response);
      setTaskDraftPublishState({ kind: 'idle' });
      return;
    }
    const body = await responseBody(response);
    if (!response.ok) throw new Error(publishResponseError(body, response.status));
    await recordReceipt(parseTaskPublishReceipt(body, transaction.request.requestId));
  }, [persistTaskPublishTransaction, readTaskPublishTransaction, savePublishConflict, store]);
  const checkPublishedSource = useCallback(async (transaction: TaskPublishTransactionPayload) => {
    if (transaction.phase !== 'receipt-recorded' || transaction.receipt === undefined) return;
    const canonical = store.query(canonicalSnapshotTable.select().where({ id: 'canonical' }).first());
    if (canonical === undefined || canonical.sourceCommit === 'unknown') return;
    setTaskDraftPublishState({ kind: 'checking-source' });
    const query = new URLSearchParams({ sourceCommit: canonical.sourceCommit });
    const response = await fetch(`/api/publish/${encodeURIComponent(transaction.request.requestId)}?${query.toString()}`, {
      method: 'GET',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    if (response.status === 404) {
      setTaskDraftPublishState({ kind: 'idle' });
      return;
    }
    const body = await responseBody(response);
    if (!response.ok) throw new Error(publishResponseError(body, response.status));
    const receipt = parseTaskPublishReceipt(body, transaction.request.requestId);
    if (!sameTaskPublishReceipt(transaction.receipt, receipt)) throw new Error('Publish status returned a different receipt for the frozen request.');
    if (receipt.source === undefined || receipt.source.commit !== canonical.sourceCommit || !receipt.source.includesPublishedCommit) {
      setTaskDraftPublishState({ kind: 'idle' });
      return;
    }
    const latestCanonical = store.query(canonicalSnapshotTable.select().where({ id: 'canonical' }).first());
    if (latestCanonical?.sourceCommit !== canonical.sourceCommit || latestCanonical.contentRevision !== canonical.contentRevision) {
      setTaskDraftPublishState({ kind: 'idle' });
      return;
    }
    let currentTransaction = readTaskPublishTransaction();
    if (currentTransaction?.request.requestId !== transaction.request.requestId || currentTransaction.phase !== 'receipt-recorded') {
      throw new Error('The saved publish transaction changed before source proof could be stored. Drafts and history were kept.');
    }
    const hasPersistedProof = currentTransaction.receipt?.source?.commit === receipt.source.commit
      && currentTransaction.receipt.source.includesPublishedCommit === true;
    if (!hasPersistedProof) {
      const withProof: TaskPublishTransactionPayload = {
        ...currentTransaction,
        receipt,
        updatedAt: new Date().toISOString(),
      };
      await persistTaskPublishTransaction(currentTransaction, withProof);
      currentTransaction = readTaskPublishTransaction();
    }
    if (currentTransaction?.request.requestId !== transaction.request.requestId
      || currentTransaction.phase !== 'receipt-recorded'
      || currentTransaction.receipt?.source?.commit !== canonical.sourceCommit
      || currentTransaction.receipt.source.includesPublishedCommit !== true) {
      throw new Error('The published source proof was not saved; drafts and history remain unchanged.');
    }
    const snapshot = parseTrackerSnapshot(JSON.parse(canonical.payloadJson));
    if (!taskPublishReceiptMatchesCanonical(receipt, snapshot)) {
      const previousStatus = store.syncStatus();
      store.commit(trackerEvents.taskPublishReceiptSuperseded({
        requestId: transaction.request.requestId,
        sourceCommit: canonical.sourceCommit,
        contentRevision: canonical.contentRevision,
        updatedAt: new Date().toISOString(),
      }));
      const superseded = readTaskPublishTransaction();
      if (superseded?.request.requestId !== transaction.request.requestId || superseded.phase !== 'receipt-superseded') {
        throw new Error('The deployed task text changed while marking the receipt as superseded. Drafts and Undo history remain saved.');
      }
      await waitForStoreAcknowledgement(store, previousStatus, 15_000, 'superseded task publish receipt');
      setTaskDraftPublishState({ kind: 'idle' });
      return;
    }
    const previousStatus = store.syncStatus();
    store.commit(trackerEvents.taskPublishSourceConfirmed({
      requestId: transaction.request.requestId,
      sourceCommit: canonical.sourceCommit,
      contentRevision: canonical.contentRevision,
      updatedAt: new Date().toISOString(),
    }));
    const saved = readTaskPublishTransaction();
    if (saved?.request.requestId !== transaction.request.requestId || saved.phase !== 'complete') {
      throw new Error('The published source changed during confirmation. Drafts and history remain saved; check the source again.');
    }
    await waitForStoreAcknowledgement(store, previousStatus, 15_000, 'published task source confirmation');
    setTaskDraftPublishState({ kind: 'idle' });
  }, [persistTaskPublishTransaction, readTaskPublishTransaction, store]);
  const startPublish = useCallback(() => {
    if (trackerInstanceConfig.publishing.kind === 'disabled') {
      setTaskDraftPublishState({ kind: 'failed', message: publishingDisabledMessage });
      return;
    }
    void runPublishOperation(async () => {
      setTaskDraftPublishState({ kind: 'waiting' });
      let current = readTaskPublishTransaction();
      if (current?.phase === 'prepare-pending') return prepareFrozenTaskPublish(current);
      if (current?.phase === 'final-pending') return confirmPublishReceipt(current, true);
      if (current?.phase === 'receipt-recorded') {
        await refreshRef.current?.();
        return checkPublishedSource(current);
      }
      if (current?.phase === 'review-ready') {
        setTaskDraftPublishState({ kind: 'idle' });
        return;
      }
      if (current?.phase === 'conflict') {
        throw new Error('Cancel the conflicted publish request, refresh the tracker source, then review or discard each conflicting draft.');
      }
      if (current?.phase === 'canceled' && current.conflict !== undefined) {
        const conflictDrafts = parseTaskContentDraftOverlays(store.query(draftOverlayTable.select()));
        const unresolvedConflict = current.conflict.conflicts.some(conflict => {
          const field = TASK_EDITABLE_FIELDS.find(candidate => candidate === conflict.field);
          const draft = conflictDrafts.find(entry => entry.recordId === conflict.taskId);
          return field !== undefined && draft?.payload.fields[field] !== undefined;
        });
        if (unresolvedConflict) throw new Error('Resolve or discard each conflicted field draft before preparing another publish request.');
      }

      await waitForTaskEditHandoff(store, pendingEditSessionIds.current);
      const drafts = parseTaskContentDraftOverlays(store.query(draftOverlayTable.select()));
      if (drafts.length === 0) throw new Error('No saved local task drafts remain to publish.');
      const request = createFrozenTaskPublishRequest(drafts, crypto.randomUUID());
      const next = createPendingTaskPublishTransaction(request, new Date().toISOString());
      current = readTaskPublishTransaction();
      await persistTaskPublishTransaction(current, next);
      await prepareFrozenTaskPublish(next);
    });
  }, [checkPublishedSource, confirmPublishReceipt, persistTaskPublishTransaction, prepareFrozenTaskPublish, readTaskPublishTransaction, runPublishOperation, store]);
  const confirmPublish = useCallback((explicitlyReviewedTaskIds: readonly string[]) => {
    if (trackerInstanceConfig.publishing.kind === 'disabled') {
      setTaskDraftPublishState({ kind: 'failed', message: publishingDisabledMessage });
      return;
    }
    void runPublishOperation(async () => {
      const current = readTaskPublishTransaction();
      if (current?.phase === 'final-pending') return confirmPublishReceipt(current, true);
      if (current?.phase !== 'review-ready') throw new Error('This publish review is no longer current. Reopen the saved review before submitting.');
      const finalRequest = createFinalTaskPublishRequest(current, new Set(explicitlyReviewedTaskIds));
      const next: TaskPublishTransactionPayload = {
        ...current,
        phase: 'final-pending',
        finalRequest,
        updatedAt: new Date().toISOString(),
      };
      await persistTaskPublishTransaction(current, next);
      await confirmPublishReceipt(next);
    });
  }, [confirmPublishReceipt, persistTaskPublishTransaction, readTaskPublishTransaction, runPublishOperation]);
  const retryPublish = startPublish;
  const cancelPublishRequest = useCallback(() => {
    void runPublishOperation(async () => {
      const current = readTaskPublishTransaction();
      if (current === null || (current.phase !== 'prepare-pending' && current.phase !== 'conflict' && current.phase !== 'review-ready')) {
        throw new Error('Only an unsubmitted saved request or a conflicted request can be canceled.');
      }
      await persistTaskPublishTransaction(current, { ...current, phase: 'canceled', updatedAt: new Date().toISOString() });
      setTaskDraftPublishState({ kind: 'idle' });
    });
  }, [persistTaskPublishTransaction, readTaskPublishTransaction, runPublishOperation]);
  const discardConflictedField = useCallback((itemId: string, field: typeof TASK_EDITABLE_FIELDS[number]) => {
    void runPublishOperation(async () => {
      const transaction = readTaskPublishTransaction();
      if (transaction?.phase !== 'canceled' || transaction.conflict === undefined) {
        throw new Error('Cancel the conflicted request before discarding a field draft.');
      }
      const conflict = transaction.conflict.conflicts.find(entry => entry.taskId === itemId && entry.field === field);
      if (conflict === undefined) throw new Error('This field is not listed in the saved publish conflict.');
      const canonical = store.query(canonicalSnapshotTable.select().where({ id: 'canonical' }).first());
      if (canonical === undefined) throw new Error('No deployed tracker snapshot is available for this field.');
      const snapshot = parseTrackerSnapshot(JSON.parse(canonical.payloadJson));
      const item = snapshot.itemById.get(itemId);
      if (item === undefined) throw new Error('This task is not present in the deployed tracker snapshot. Refresh before resolving the conflict.');
      const canonicalValue = taskDraftFieldValue(item, field);
      if (!taskPublishFieldValuesMatch(field, canonicalValue, conflict.currentValue)) {
        throw new Error(`The repository reports “${conflict.currentValue}”, while the deployed tracker snapshot shows “${canonicalValue}”. Refresh and wait for the source update before discarding this local field draft.`);
      }
      const fieldLock = await acquireTaskFieldLock({ itemId, field });
      if (fieldLock.kind === 'busy') throw new Error('Another tracker tab is editing this field. Close or finish that edit, then retry.');
      if (fieldLock.kind === 'unsupported') throw new Error('This browser cannot safely lock the task field across tracker tabs.');
      try {
        const latestCanonical = store.query(canonicalSnapshotTable.select().where({ id: 'canonical' }).first());
        if (latestCanonical?.sourceCommit !== canonical.sourceCommit || latestCanonical.contentRevision !== canonical.contentRevision) {
          throw new Error('The deployed tracker snapshot changed while resolving the conflict. Refresh and retry.');
        }
        const draft = parseTaskContentDraftOverlays(store.query(draftOverlayTable.select())).find(entry => entry.recordId === itemId);
        const fieldState = draft?.payload.fields[field] ?? null;
        if (fieldState === null) throw new Error('The local field draft has already changed or been removed.');
        const previousStatus = store.syncStatus();
        store.commit(trackerEvents.taskDraftConflictDiscarded({
          requestId: transaction.request.requestId,
          actionId: crypto.randomUUID(),
          itemId,
          field,
          repositoryCurrentValue: conflict.currentValue,
          expectedFieldState: fieldState,
          sourceCommit: canonical.sourceCommit,
          contentRevision: canonical.contentRevision,
          updatedAt: new Date().toISOString(),
        }));
        const currentDraft = parseTaskContentDraftOverlays(store.query(draftOverlayTable.select())).find(entry => entry.recordId === itemId);
        if (currentDraft?.payload.fields[field] !== undefined) throw new Error('The field changed before discard could be applied. Refresh and review the current draft.');
        await waitForStoreAcknowledgement(store, previousStatus, 15_000, 'conflicted task field discard');
        setTaskDraftPublishState({ kind: 'idle' });
      } finally {
        fieldLock.release();
        await fieldLock.released;
      }
    });
  }, [readTaskPublishTransaction, runPublishOperation, store]);
  const beginTaskEditSession = useCallback(async (input: Parameters<TaskEditController['beginSession']>[0]) => {
    if (taskEditOwnerState !== 'ready') return taskEditOwnerState === 'checking' ? 'not-ready' : 'unsupported';
    const fieldKey = `${input.itemId}:${input.field}`;
    const localHandoff = closingFieldLockHandoffs.current.get(fieldKey);
    if (localHandoff !== undefined) await localHandoff;
    const openSameField = parseTaskEditSessionRows(store.query(taskEditSessionTable.select().where({ itemId: input.itemId })))
      .find(session => session.field === input.field);
    if (openSameField?.ownerId === taskEditDocumentOwner.ownerId) return 'pending';
    const fieldLock = await acquireTaskFieldLock({ itemId: input.itemId, field: input.field });
    if (fieldLock.kind === 'busy') return 'busy';
    if (fieldLock.kind === 'unsupported') return 'unsupported';

    const payload = createTaskEditSessionPayload({
      ...input,
      ownerId: taskEditDocumentOwner.ownerId,
      startedAt: new Date().toISOString(),
    });
    fieldLockReleases.current.set(input.sessionId, { release: fieldLock.release, released: fieldLock.released });
    const acknowledgement = persistTaskEditEvent(
      () => store.commit(trackerEvents.taskEditSessionBegan({ payloadJson: JSON.stringify(payload) })),
      'task edit session start',
    );
    const savedSession = store.query(taskEditSessionTable.select().where({ id: input.sessionId }).first());
    if (savedSession?.ownerId !== taskEditDocumentOwner.ownerId) {
      void acknowledgement.catch(() => {});
      fieldLock.release();
      fieldLockReleases.current.delete(input.sessionId);
      return 'busy';
    }
    // The local materializer now owns the session. Keep buffered keystrokes flowing
    // without waiting for the cross-tab/server acknowledgement; the public status
    // watcher updates Saving/Saved in the background.
    void acknowledgement.catch(() => {});
    return 'started';
  }, [persistTaskEditEvent, store, taskEditOwnerState]);
  const changeTaskEditSessionValue = useCallback((sessionId: string, value: string) => {
    void persistTaskEditEvent(() => store.commit(trackerEvents.taskEditSessionValueChanged({
      sessionId,
      ownerId: taskEditDocumentOwner.ownerId,
      value,
      updatedAt: new Date().toISOString(),
    })), 'task edit value').catch(() => {});
  }, [persistTaskEditEvent, store]);
  const closeTaskEditSession = useCallback((sessionId: string, kind: 'finish' | 'cancel') => {
    const sessionRow = store.query(taskEditSessionTable.select().where({ id: sessionId }).first());
    const session = sessionRow === undefined ? null : parseTaskEditSessionPayload(sessionRow.payloadJson);
    const fieldKey = session === null ? null : `${session.itemId}:${session.field}`;
    let resolveHandoff = () => {};
    const handoff = fieldKey === null ? null : new Promise<void>(resolve => { resolveHandoff = resolve; });
    if (fieldKey !== null && handoff !== null) closingFieldLockHandoffs.current.set(fieldKey, handoff);
    const event = kind === 'finish'
      ? trackerEvents.taskEditSessionFinished({ sessionId, ownerId: taskEditDocumentOwner.ownerId, updatedAt: new Date().toISOString() })
      : trackerEvents.taskEditSessionCanceled({ sessionId, ownerId: taskEditDocumentOwner.ownerId, updatedAt: new Date().toISOString() });
    return persistTaskEditEvent(() => store.commit(event), `task edit session ${kind}`)
      .finally(async () => {
        const heldLock = fieldLockReleases.current.get(sessionId);
        heldLock?.release();
        if (heldLock !== undefined) await heldLock.released;
        fieldLockReleases.current.delete(sessionId);
        if (fieldKey !== null && closingFieldLockHandoffs.current.get(fieldKey) === handoff) {
          closingFieldLockHandoffs.current.delete(fieldKey);
        }
        resolveHandoff();
      });
  }, [persistTaskEditEvent, store]);
  const requestTaskHistoryMove = useCallback((direction: 'undo' | 'redo', expectedActionId: string) => {
    const event = direction === 'undo'
      ? trackerEvents.taskEditHistoryUndoRequested({ requesterOwnerId: taskEditDocumentOwner.ownerId, expectedActionId, updatedAt: new Date().toISOString() })
      : trackerEvents.taskEditHistoryRedoRequested({ requesterOwnerId: taskEditDocumentOwner.ownerId, expectedActionId, updatedAt: new Date().toISOString() });
    void persistTaskEditEvent(() => store.commit(event), `task edit history ${direction}`).catch(() => {});
  }, [persistTaskEditEvent, store]);
  const skipUnavailableTaskHistory = useCallback((direction: 'undo' | 'redo', expectedActionId: string) => {
    void persistTaskEditEvent(() => store.commit(trackerEvents.taskEditHistoryUnavailableSkipped({
      direction,
      expectedActionId,
      requesterOwnerId: taskEditDocumentOwner.ownerId,
      updatedAt: new Date().toISOString(),
    })), 'unavailable task edit skipped').catch(() => {});
  }, [persistTaskEditEvent, store]);

  useEffect(() => {
    let active = true;
    let sweepInProgress = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const recoverAbandonedOwners = async () => {
      if (!active || sweepInProgress) return;
      sweepInProgress = true;
      const ownerReady = await taskEditDocumentOwner.ready;
      if (!active) {
        sweepInProgress = false;
        return;
      }
      if (!ownerReady) {
        setTaskEditOwnerState('unsupported');
        sweepInProgress = false;
        return;
      }

      const sessions = parseTaskEditSessionRows(store.query(taskEditSessionTable.select()));
      const foreignOwners = [...new Set(sessions
        .map(session => session.ownerId)
        .filter(ownerId => ownerId !== taskEditDocumentOwner.ownerId))];
      for (const ownerId of foreignOwners) {
        if (recoveringOwners.current.has(ownerId)) continue;
        recoveringOwners.current.add(ownerId);
        try {
          await withAbandonedTaskEditOwnerLock({
            ownerId,
            run: async () => {
              const ownerSessions = parseTaskEditSessionRows(store.query(taskEditSessionTable.select()))
                .filter(session => session.ownerId === ownerId);
              for (const session of ownerSessions) {
                const stillOpen = store.query(taskEditSessionTable.select().where({ id: session.sessionId }).first());
                if (stillOpen?.ownerId !== ownerId) continue;
                await persistTaskEditEvent(() => store.commit(trackerEvents.taskEditSessionRecovered({
                  sessionId: session.sessionId,
                  ownerId,
                  recoveredByOwnerId: taskEditDocumentOwner.ownerId,
                  updatedAt: new Date().toISOString(),
                })), 'interrupted task edit recovery');
              }
            },
          });
        } catch (error) {
          console.error('LiveStore could not recover an interrupted task edit.', error);
        } finally {
          recoveringOwners.current.delete(ownerId);
        }
      }
      if (active) {
        setTaskEditOwnerState('ready');
        const remainingSessions = parseTaskEditSessionRows(store.query(taskEditSessionTable.select()));
        const hasForeignSessions = remainingSessions.some(session => session.ownerId !== taskEditDocumentOwner.ownerId);
        if (hasForeignSessions && retryTimer === null) {
          retryTimer = setTimeout(() => {
            retryTimer = null;
            void recoverAbandonedOwners();
          }, 2_000);
        }
      }
      sweepInProgress = false;
    };

    const retryNow = () => {
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      void recoverAbandonedOwners();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') retryNow();
    };

    void recoverAbandonedOwners();
    window.addEventListener('focus', retryNow);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      active = false;
      if (retryTimer !== null) clearTimeout(retryTimer);
      window.removeEventListener('focus', retryNow);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [persistTaskEditEvent, store]);

  const taskEditController = useMemo<TaskEditController>(() => ({
    ownerId: taskEditDocumentOwner.ownerId,
    ownerState: taskEditOwnerState,
    sessions: parsedTaskEdits.sessions,
    history: parsedTaskEdits.history ?? { schemaVersion: 2, undo: [], redo: [], skipped: [] },
    saveState: taskDraftSaveState,
    publishState: taskDraftPublishState,
    publishTransaction: parsedTaskPublish.transaction,
    registerPendingSession: registerPendingEditSession,
    releasePendingSession: releasePendingEditSession,
    beginSession: beginTaskEditSession,
    changeSessionValue: changeTaskEditSessionValue,
    finishSession: sessionId => closeTaskEditSession(sessionId, 'finish'),
    cancelSession: sessionId => closeTaskEditSession(sessionId, 'cancel'),
    startPublish,
    confirmPublish,
    retryPublish,
    cancelPublishRequest,
    discardConflictedField,
    refreshCanonical: () => { void refreshRef.current?.(); },
    requestHistoryMove: requestTaskHistoryMove,
    skipUnavailable: skipUnavailableTaskHistory,
  }), [
    beginTaskEditSession,
    changeTaskEditSessionValue,
    closeTaskEditSession,
    startPublish,
    confirmPublish,
    retryPublish,
    cancelPublishRequest,
    discardConflictedField,
    parsedTaskEdits,
    parsedTaskPublish,
    registerPendingEditSession,
    releasePendingEditSession,
    requestTaskHistoryMove,
    skipUnavailableTaskHistory,
    taskDraftSaveState,
    taskDraftPublishState,
    taskEditOwnerState,
  ]);

  if (effectiveSnapshot !== null && routerRef.current === null) {
    routerRef.current = createTrackerRouter(effectiveSnapshot, {
      canonicalData: snapshot ?? effectiveSnapshot,
      draftOverlays,
      taskDrafts: projection?.drafts ?? [],
      taskDraftSaveState,
      taskEdit: taskEditController,
    });
  }
  const router = routerRef.current;

  const refresh = useCallback((): Promise<void> => {
    if (inFlight.current !== null) return inFlight.current;
    if (navigator.onLine === false) {
      const current = store.query(canonicalSnapshotTable.select().first());
      setStatus(current === undefined
        ? { kind: 'unavailable', message: 'This device is offline and has no saved tracker snapshot.' }
        : { kind: 'stale', message: 'This device is offline.', checkedAt: null });
      return Promise.resolve();
    }

    setStatus({ kind: 'checking' });
    const pending = refreshCanonicalSnapshot({ store, onSaving: () => setStatus({ kind: 'saving' }) })
      .then(() => setStatus({ kind: 'current', checkedAt: new Date().toISOString() }))
      .catch(error => {
        if (error instanceof SnapshotAcknowledgementTimeout) {
          setStatus({ kind: 'save-failed', message: error.message });
          return;
        }
        const current = store.query(canonicalSnapshotTable.select().first());
        const message = `Could not refresh canonical tracker data (${errorMessage(error)}).`;
        setStatus(current === undefined
          ? { kind: 'unavailable', message }
          : { kind: 'stale', message: `${message} Showing the saved snapshot.`, checkedAt: null });
      })
      .finally(() => { inFlight.current = null; });
    inFlight.current = pending;
    return pending;
  }, [store]);

  refreshRef.current = refresh;

  useEffect(() => {
    if (trackerInstanceConfig.publishing.kind === 'disabled') return;
    const transaction = parsedTaskPublish.transaction;
    if (transaction === null || (transaction.phase !== 'prepare-pending' && transaction.phase !== 'final-pending')) return;
    const attemptKey = `${transaction.request.requestId}:${transaction.phase}`;
    if (automaticPublishAttempts.current.has(attemptKey)) return;
    automaticPublishAttempts.current.add(attemptKey);
    const pending = runPublishOperation(async () => {
      const current = readTaskPublishTransaction();
      if (current?.request.requestId !== transaction.request.requestId) return;
      if (current.phase === 'prepare-pending') await prepareFrozenTaskPublish(current);
      else if (current.phase === 'final-pending') await confirmPublishReceipt(current, true);
    });
    void pending;
  }, [confirmPublishReceipt, parsedTaskPublish.transaction, prepareFrozenTaskPublish, readTaskPublishTransaction, runPublishOperation]);

  useEffect(() => {
    if (trackerInstanceConfig.publishing.kind === 'disabled') return;
    const transaction = parsedTaskPublish.transaction;
    if (transaction === null || transaction.phase !== 'receipt-recorded') return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      if (!active) return;
      const pending = runPublishOperation(async () => {
        const current = readTaskPublishTransaction();
        if (current?.request.requestId !== transaction.request.requestId || current.phase !== 'receipt-recorded') return;
        setTaskDraftPublishState({ kind: 'checking-source' });
        await refreshRef.current?.();
        await checkPublishedSource(readTaskPublishTransaction() ?? current);
      });
      if (pending !== null) await pending;
      if (active) timer = setTimeout(() => { void poll(); }, 15_000);
    };
    void poll();
    return () => {
      active = false;
      if (timer !== null) clearTimeout(timer);
    };
  }, [checkPublishedSource, parsedTaskPublish.transaction, readTaskPublishTransaction, runPublishOperation]);

  useEffect(() => {
    const onFocus = () => { void refresh(); };
    const onOnline = () => { void refresh(); };
    const onOffline = () => {
      const current = store.query(canonicalSnapshotTable.select().first());
      setStatus(current === undefined
        ? { kind: 'unavailable', message: 'This device is offline and has no saved tracker snapshot.' }
        : { kind: 'stale', message: 'This device is offline.', checkedAt: null });
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    const interval = window.setInterval(() => { void refresh(); }, 5 * 60 * 1000);

    void refresh();
    window.addEventListener('focus', onFocus);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [refresh, store]);

  useEffect(() => {
    if (effectiveSnapshot === null || router === null) return;
    void router.invalidate().catch(() => {});
  }, [router, effectiveSnapshot, draftOverlays, taskDraftSaveState, taskEditController]);

  if (parsed.error !== null) return <SnapshotError error={parsed.error} />;
  if (parsedTaskEdits.error !== null) return <SnapshotError error={parsedTaskEdits.error} />;
  if (parsedTaskPublish.error !== null) return <SnapshotError error={parsedTaskPublish.error} />;
  if (effectiveSnapshot === null || projection === null || saved === undefined || router === null) {
    if (status.kind === 'unavailable') return <SnapshotError error={new Error(status.message)} />;
    return <SnapshotLoading />;
  }

  return <>
    <PublishingStatusHost
      taskEdit={taskEditController}
      taskDrafts={projection.drafts}
      canonicalData={snapshot ?? effectiveSnapshot}
      saved={saved}
      snapshotSync={status}
      storageMode={store.storageMode}
    />
    <RouterProvider router={router} context={{
      data: effectiveSnapshot,
      canonicalData: snapshot ?? effectiveSnapshot,
      draftOverlays,
      taskDrafts: projection.drafts,
      taskDraftSaveState,
      taskEdit: taskEditController,
    }} />
  </>;
}

class StoreErrorBoundary extends Component<{ readonly children: ReactNode }, { readonly error: Error | null }> {
  state: { readonly error: Error | null } = { error: null };

  static getDerivedStateFromError(error: unknown): { readonly error: Error } {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  render() {
    if (this.state.error === null) return this.props.children;
    return taskStoreSchemaTablesAreMissing(this.state.error)
      ? <TaskEditSchemaUpgradeRequired />
      : <SnapshotError error={this.state.error} />;
  }
}

function TrackerApplication() {
  const store = useStore(trackerStoreOptions);
  return <StoredSnapshot store={store} />;
}

function mountTracker() {
  const element = document.getElementById('root');
  if (!element) throw new Error('Tracker root element is missing.');
  const migratedLocation = legacyLocationPath(window.location);
  if (migratedLocation !== null) window.history.replaceState(window.history.state, '', migratedLocation);
  createRoot(element).render(<StrictMode>
    <Toaster />
    <StoreRegistryProvider storeRegistry={storeRegistry}>
      <StoreErrorBoundary>
        <Suspense fallback={<SnapshotLoading />}><TrackerApplication /></Suspense>
      </StoreErrorBoundary>
    </StoreRegistryProvider>
  </StrictMode>);
}

mountTracker();
