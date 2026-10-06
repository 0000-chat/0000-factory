import assert from 'node:assert/strict';
import { test } from 'bun:test';
import {
  appendTaskEditAction,
  createTaskEditSessionPayload,
  emptyTaskEditHistory,
  fieldStateForHistoryTarget,
  moveTaskEditHistory,
  parseCanonicalTaskFieldValue,
  parseTaskEditHistoryPayload,
  parseTaskEditSessionPayload,
  skipUnavailableTaskEdit,
  taskEditSessionIsMeaningful,
  updateTaskEditSessionPayload,
} from '../src/task-edit-history';

const canonicalAtStart = {
  value: 'Canonical before refresh',
  sourceCommit: 'source-1',
  contentRevision: 'content-1',
};

function changedSession(itemId: string, field: 'title' | 'sections.outcome', sessionId: string) {
  const started = createTaskEditSessionPayload({
    sessionId,
    itemId,
    field,
    ownerId: 'document-1',
    beforeValue: `Before ${itemId}`,
    beforeFieldState: null,
    canonicalAtStart: { ...canonicalAtStart, value: `Before ${itemId}` },
    startedAt: '2026-10-03T00:00:00.000Z',
  });
  return updateTaskEditSessionPayload({
    session: started,
    value: `After ${itemId}`,
    fieldState: {
      value: `After ${itemId}`,
      baseValue: `Before ${itemId}`,
      baseSourceCommit: canonicalAtStart.sourceCommit,
      baseContentRevision: canonicalAtStart.contentRevision,
    },
    updatedAt: '2026-10-03T00:00:01.000Z',
  });
}

test('global history groups one session and orders actions across different tasks', () => {
  const first = changedSession('task-a', 'title', 'session-a');
  const second = changedSession('task-b', 'sections.outcome', 'session-b');
  assert.equal(taskEditSessionIsMeaningful(first), true);

  const afterFirst = appendTaskEditAction(emptyTaskEditHistory(), first, '2026-10-03T00:00:02.000Z');
  const afterSecond = appendTaskEditAction(afterFirst, second, '2026-10-03T00:00:03.000Z');
  const undoSecond = moveTaskEditHistory(afterSecond, 'undo');
  assert.equal(undoSecond?.action.itemId, 'task-b');
  const undoFirst = moveTaskEditHistory(undoSecond?.history ?? emptyTaskEditHistory(), 'undo');
  assert.equal(undoFirst?.action.itemId, 'task-a');

  const redoFirst = moveTaskEditHistory(undoFirst?.history ?? emptyTaskEditHistory(), 'redo');
  assert.equal(redoFirst?.action.itemId, 'task-a');
  const redoSecond = moveTaskEditHistory(redoFirst?.history ?? emptyTaskEditHistory(), 'redo');
  assert.equal(redoSecond?.action.itemId, 'task-b');
});

test('a new meaningful checkpoint clears redo while cancel or net-zero does not append', () => {
  const first = changedSession('task-a', 'title', 'session-a');
  const firstCheckpoint = appendTaskEditAction(emptyTaskEditHistory(), first, 'time-1');
  const undone = moveTaskEditHistory(firstCheckpoint, 'undo');
  assert.ok(undone);
  assert.equal(undone.history.redo.length, 1);

  const netZero = updateTaskEditSessionPayload({
    session: first,
    value: first.beforeValue,
    fieldState: null,
    updatedAt: 'time-2',
  });
  assert.equal(taskEditSessionIsMeaningful(netZero), false);
  assert.equal(undone.history.redo.length, 1);

  const newBranch = appendTaskEditAction(undone.history, changedSession('task-b', 'title', 'session-b'), 'time-3');
  assert.equal(newBranch.redo.length, 0);
  assert.equal(newBranch.undo.at(-1)?.itemId, 'task-b');
});

test('undo after canonical refresh restores the prior visible value with its original baseline', () => {
  assert.deepEqual(fieldStateForHistoryTarget({
    targetValue: 'Before refresh',
    targetFieldState: null,
    canonicalValueNow: 'External canonical value',
    canonicalAtStart,
  }), {
    value: 'Before refresh',
    baseValue: 'Canonical before refresh',
    baseSourceCommit: 'source-1',
    baseContentRevision: 'content-1',
  });

  assert.equal(fieldStateForHistoryTarget({
    targetValue: 'Before refresh',
    targetFieldState: null,
    canonicalValueNow: 'Before refresh',
    canonicalAtStart,
  }), null);

  const existing = {
    value: 'Existing draft',
    baseValue: 'Older canonical',
    baseSourceCommit: 'source-0',
    baseContentRevision: 'content-0',
  };
  assert.equal(fieldStateForHistoryTarget({
    targetValue: existing.value,
    targetFieldState: existing,
    canonicalValueNow: 'New canonical',
    canonicalAtStart,
  }), existing);
});

test('cancel after same-field canonical refresh keeps the value seen at focus as a conflict-safe draft', () => {
  const beforeValue = 'Canonical value when the editor opened';
  assert.deepEqual(fieldStateForHistoryTarget({
    targetValue: beforeValue,
    targetFieldState: null,
    canonicalValueNow: 'External value received while editing',
    canonicalAtStart: {
      value: beforeValue,
      sourceCommit: 'focus-commit',
      contentRevision: 'focus-revision',
    },
  }), {
    value: beforeValue,
    baseValue: beforeValue,
    baseSourceCommit: 'focus-commit',
    baseContentRevision: 'focus-revision',
  });
});

test('a removed canonical task keeps its orphan value safe without fabricating a canonical record', () => {
  const canonicalJson = JSON.stringify({
    items: [{ id: 'another-task', title: 'Another task', sections: { outcome: 'Other outcome' } }],
  });
  assert.equal(parseCanonicalTaskFieldValue(canonicalJson, 'removed-task', 'title'), null);
  assert.deepEqual(fieldStateForHistoryTarget({
    targetValue: 'Value from the interrupted edit',
    targetFieldState: null,
    canonicalValueNow: null,
    canonicalAtStart: {
      value: 'Original canonical value',
      sourceCommit: 'before-removal',
      contentRevision: 'before-removal-content',
    },
  }), {
    value: 'Value from the interrupted edit',
    baseValue: 'Original canonical value',
    baseSourceCommit: 'before-removal',
    baseContentRevision: 'before-removal-content',
  });
});

test('skipping an unavailable top action retains it while exposing older global history', () => {
  const older = changedSession('task-a', 'title', 'session-a');
  const missing = changedSession('removed-task', 'sections.outcome', 'session-removed');
  const withTwo = appendTaskEditAction(
    appendTaskEditAction(emptyTaskEditHistory(), older, 'time-1'),
    missing,
    'time-2',
  );
  const skipped = skipUnavailableTaskEdit(withTwo, 'undo', 'session-removed', 'time-3');

  assert.equal(skipped?.undo.at(-1)?.actionId, 'session-a');
  assert.equal(skipped?.redo.length, 0);
  assert.deepEqual(skipped?.skipped, [{ direction: 'undo', action: withTwo.undo[1], skippedAt: 'time-3' }]);
  assert.equal(moveTaskEditHistory(skipped ?? emptyTaskEditHistory(), 'undo')?.action.actionId, 'session-a');
  assert.equal(skipUnavailableTaskEdit(withTwo, 'undo', 'stale-action-id', 'time-4'), null);
});

test('persisted sessions and history reject extra fields and keep the exact session baseline', () => {
  const session = changedSession('task-a', 'sections.outcome', 'session-a');
  const parsed = parseTaskEditSessionPayload(JSON.stringify(session));
  assert.equal(parsed.canonicalAtStart.value, 'Before task-a');
  assert.equal(parsed.canonicalAtStart.sourceCommit, canonicalAtStart.sourceCommit);
  assert.equal(parsed.canonicalAtStart.contentRevision, canonicalAtStart.contentRevision);
  assert.throws(() => parseTaskEditSessionPayload(JSON.stringify({ ...session, status: 'done' })));
  assert.throws(() => parseTaskEditHistoryPayload(JSON.stringify({ schemaVersion: 1, undo: [], redo: [], status: 'approved' })));
  assert.deepEqual(parseTaskEditHistoryPayload(JSON.stringify({ schemaVersion: 1, undo: [], redo: [] })), {
    schemaVersion: 2,
    undo: [],
    redo: [],
    skipped: [],
  });
});
