import type { TrackerSnapshot } from './snapshot';
import type { TrackerDraftOverlay } from './livestore-schema';
import type { ParsedTaskContentDraft, TaskDraftFieldValue, TaskEditableField } from './task-drafts';
import type { TaskEditCanonicalBaseline, TaskEditHistoryPayload, TaskEditSessionPayload } from './task-edit-history';
import type { TaskPublishTransactionPayload } from './task-publishing';

export interface BeginTaskEditSessionInput {
  readonly sessionId: string;
  readonly itemId: string;
  readonly field: TaskEditableField;
  readonly beforeValue: string;
  readonly beforeFieldState: TaskDraftFieldValue | null;
  readonly canonicalAtStart: TaskEditCanonicalBaseline;
}

export type BeginTaskEditSessionResult = 'started' | 'busy' | 'pending' | 'unsupported' | 'not-ready';

export type TaskDraftPublishState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'waiting' }
  | { readonly kind: 'preparing' }
  | { readonly kind: 'submitting' }
  | { readonly kind: 'checking-source' }
  | { readonly kind: 'failed'; readonly message: string };

export interface TaskEditController {
  readonly ownerId: string;
  readonly ownerState: 'checking' | 'ready' | 'unsupported';
  readonly sessions: readonly TaskEditSessionPayload[];
  readonly history: TaskEditHistoryPayload;
  readonly saveState: TaskDraftSaveState;
  readonly publishState: TaskDraftPublishState;
  readonly publishTransaction: TaskPublishTransactionPayload | null;
  registerPendingSession: (sessionId: string) => void;
  releasePendingSession: (sessionId: string) => void;
  beginSession: (input: BeginTaskEditSessionInput) => Promise<BeginTaskEditSessionResult>;
  changeSessionValue: (sessionId: string, value: string) => void;
  finishSession: (sessionId: string) => Promise<void>;
  cancelSession: (sessionId: string) => Promise<void>;
  startPublish: () => void;
  confirmPublish: (explicitlyReviewedTaskIds: readonly string[]) => void;
  retryPublish: () => void;
  cancelPublishRequest: () => void;
  discardConflictedField: (itemId: string, field: TaskEditableField) => void;
  refreshCanonical: () => void;
  requestHistoryMove: (direction: 'undo' | 'redo', expectedActionId: string) => void;
  skipUnavailable: (direction: 'undo' | 'redo', expectedActionId: string) => void;
}

export interface TrackerRouterContext {
  data: TrackerSnapshot;
  canonicalData: TrackerSnapshot;
  draftOverlays: readonly TrackerDraftOverlay[];
  taskDrafts: readonly ParsedTaskContentDraft[];
  taskDraftSaveState: TaskDraftSaveState;
  taskEdit: TaskEditController;
}

export type TaskDraftSaveState =
  | { readonly kind: 'saving' }
  | { readonly kind: 'saved' }
  | { readonly kind: 'failed'; readonly message: string };
