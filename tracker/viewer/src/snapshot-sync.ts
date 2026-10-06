import type { Store } from '@livestore/livestore';
import type { ReactApi } from '@livestore/react';
import { EventSequenceNumber } from '@livestore/common/schema';
import {
  canonicalSnapshotMatches,
  fetchCanonicalTrackerSnapshot,
  type CanonicalSnapshotPayload,
  type TrackerSnapshot,
} from './snapshot';
import { trackerEvents, trackerSchema, trackerTables } from './livestore-schema';

export type TrackerStore = Store<typeof trackerSchema> & ReactApi;
export type SnapshotRefreshResult =
  | { readonly kind: 'updated'; readonly snapshot: TrackerSnapshot }
  | { readonly kind: 'unchanged'; readonly snapshot: TrackerSnapshot };

export class SnapshotAcknowledgementTimeout extends Error {
  constructor(timeoutMs: number, operation: string, observedState: string) {
    super(`LiveStore did not acknowledge the ${operation} within ${timeoutMs} ms. Last observed state: ${observedState}.`);
    this.name = 'SnapshotAcknowledgementTimeout';
  }
}

export type StoreAcknowledgementSource = Pick<TrackerStore, 'syncStatus'>;
export type StoreAcknowledgementBaseline = Pick<ReturnType<TrackerStore['syncStatus']>, 'localHead' | 'upstreamHead'>;

function sequenceAtOrAfter(candidate: string, expected: string): boolean {
  try {
    return EventSequenceNumber.Client.compare(
      EventSequenceNumber.Client.fromString(candidate),
      EventSequenceNumber.Client.fromString(expected),
    ) >= 0;
  } catch {
    return false;
  }
}

export function waitForStoreAcknowledgement(
  store: StoreAcknowledgementSource,
  previousStatus: StoreAcknowledgementBaseline,
  timeoutMs: number,
  operation: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let observedState = 'status not read';
    let targetLocalHead: string | null = null;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    const timeout = setTimeout(() => {
      settled = true;
      cleanup();
      reject(new SnapshotAcknowledgementTimeout(timeoutMs, operation, observedState));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      if (pollTimer !== null) clearTimeout(pollTimer);
    };
    const observe = () => {
      if (settled) return;
      const status = store.syncStatus();
      observedState = `localHead=${status.localHead}, pendingCount=${status.pendingCount}, isSynced=${status.isSynced}`;
      // A client-only commit is materialized in this tab first. The leader then
      // processes it and advances upstreamHead before sending the committed
      // batch back through the client session. Track the latest local frontier
      // observed after this operation so an earlier queued acknowledgement
      // cannot satisfy this wait.
      if (targetLocalHead === null) {
        if (status.localHead === previousStatus.localHead) return;
        targetLocalHead = status.localHead;
      } else if (sequenceAtOrAfter(status.localHead, targetLocalHead)) {
        targetLocalHead = status.localHead;
      }
      if (targetLocalHead !== null && sequenceAtOrAfter(status.upstreamHead, targetLocalHead) && status.isSynced) {
        settled = true;
        cleanup();
        resolve();
      }
    };
    const poll = () => {
      if (settled) return;
      observe();
      if (!settled) pollTimer = setTimeout(poll, 25);
    };
    poll();
  });
}

export async function refreshCanonicalSnapshot({
  store,
  fetchSnapshot = fetchCanonicalTrackerSnapshot,
  onSaving = () => {},
  acknowledgementTimeoutMs = 15_000,
}: {
  readonly store: TrackerStore;
  readonly fetchSnapshot?: () => Promise<CanonicalSnapshotPayload>;
  readonly onSaving?: () => void;
  readonly acknowledgementTimeoutMs?: number;
}): Promise<SnapshotRefreshResult> {
  const incoming = await fetchSnapshot();
  const saved = store.query(trackerTables.canonicalSnapshot.select().first());
  if (canonicalSnapshotMatches(saved, incoming.snapshot)) {
    return { kind: 'unchanged', snapshot: incoming.snapshot };
  }

  const previousStatus = store.syncStatus();
  store.commit(trackerEvents.canonicalSnapshotReceived({
    payloadJson: incoming.payloadJson,
    sourceCommit: incoming.snapshot.source.commit ?? 'unknown',
    contentRevision: incoming.snapshot.source.contentRevision
      ?? incoming.snapshot.source.commit
      ?? 'unknown',
    snapshotSchemaVersion: incoming.snapshot.schemaVersion,
    savedAt: incoming.fetchedAt,
  }));
  onSaving();
  await waitForStoreAcknowledgement(store, previousStatus, acknowledgementTimeoutMs, 'snapshot event');

  return { kind: 'updated', snapshot: incoming.snapshot };
}
