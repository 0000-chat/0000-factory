import type { TaskEditableField } from './task-drafts';
import { trackerInstanceConfig } from './instance-config';

export type TaskEditFieldLockResult =
  | { readonly kind: 'acquired'; readonly release: () => void; readonly released: Promise<void> }
  | { readonly kind: 'busy' }
  | { readonly kind: 'unsupported' };

export interface TaskEditDocumentOwner {
  readonly ownerId: string;
  readonly ready: Promise<boolean>;
}

function taskEditLockManager(): LockManager | null {
  return typeof navigator === 'undefined' || navigator.locks === undefined
    ? null
    : navigator.locks;
}

function taskEditLockName(scope: 'owner' | 'field', key: string): string {
  return `${trackerInstanceConfig.browser.editLockPrefix}:${scope}:${key}`;
}

export function createTaskEditDocumentOwner(): TaskEditDocumentOwner {
  const ownerId = crypto.randomUUID();
  const locks = taskEditLockManager();
  if (locks === null) return { ownerId, ready: Promise.resolve(false) };

  let resolveReady: (ready: boolean) => void = () => {};
  let holdLock: () => void = () => {};
  const ready = new Promise<boolean>(resolve => { resolveReady = resolve; });
  const held = new Promise<void>(resolve => { holdLock = resolve; });

  void locks.request(taskEditLockName('owner', ownerId), { ifAvailable: true }, async lock => {
    if (lock === null) {
      resolveReady(false);
      return;
    }
    resolveReady(true);
    await held;
  }).catch(() => resolveReady(false));

  // The browser releases a document lock when the document is discarded. Keeping this
  // promise pending also keeps the lock through the back-forward cache lifecycle.
  void holdLock;
  return { ownerId, ready };
}

export async function acquireTaskFieldLock({
  itemId,
  field,
}: {
  readonly itemId: string;
  readonly field: TaskEditableField;
}): Promise<TaskEditFieldLockResult> {
  const locks = taskEditLockManager();
  if (locks === null) return { kind: 'unsupported' };

  let resolveResult: (result: TaskEditFieldLockResult) => void = () => {};
  let resolveReleased: () => void = () => {};
  let holdLock: () => void = () => {};
  const result = new Promise<TaskEditFieldLockResult>(resolve => { resolveResult = resolve; });
  const releasedPromise = new Promise<void>(resolve => { resolveReleased = resolve; });
  const held = new Promise<void>(resolve => { holdLock = resolve; });
  const lockName = taskEditLockName('field', `${itemId}:${field}`);

  void locks.request(lockName, { ifAvailable: true }, async lock => {
    if (lock === null) {
      resolveResult({ kind: 'busy' });
      resolveReleased();
      return;
    }
    let lockReleased = false;
    resolveResult({
      kind: 'acquired',
      released: releasedPromise,
      release: () => {
        if (lockReleased) return;
        lockReleased = true;
        holdLock();
      },
    });
    await held;
  }).then(resolveReleased).catch(() => {
    resolveResult({ kind: 'unsupported' });
    resolveReleased();
  });

  return result;
}

export async function withAbandonedTaskEditOwnerLock<T>({
  ownerId,
  run,
}: {
  readonly ownerId: string;
  readonly run: () => Promise<T>;
}): Promise<{ readonly kind: 'claimed'; readonly value: T } | { readonly kind: 'live' | 'unsupported' }> {
  const locks = taskEditLockManager();
  if (locks === null) return { kind: 'unsupported' };

  type LockAttempt =
    | { readonly kind: 'claimed'; readonly value: T }
    | { readonly kind: 'live' }
    | { readonly kind: 'run-failed'; readonly error: unknown };

  let attempt: LockAttempt;
  try {
    const handleLock = async (lock: Lock | null): Promise<LockAttempt> => {
      if (lock === null) return { kind: 'live' };
      try {
        return { kind: 'claimed', value: await run() };
      } catch (error) {
        return { kind: 'run-failed', error };
      }
    };
    attempt = await locks.request(taskEditLockName('owner', ownerId), { ifAvailable: true }, handleLock);
  } catch {
    return { kind: 'unsupported' };
  }

  if (attempt.kind === 'run-failed') throw attempt.error;
  return attempt;
}
