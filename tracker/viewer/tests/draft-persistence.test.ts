import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'bun:test';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';
import {
  SnapshotAcknowledgementTimeout,
  type StoreAcknowledgementBaseline,
  type StoreAcknowledgementSource,
  waitForStoreAcknowledgement,
} from '../src/snapshot-sync';

type SyncStatus = ReturnType<StoreAcknowledgementSource['syncStatus']>;

const status = (localHead: string, upstreamHead: string, pendingCount: number): SyncStatus => ({
  localHead,
  upstreamHead,
  pendingCount,
  isSynced: pendingCount === 0,
});

const baseline = (localHead: string, upstreamHead: string): StoreAcknowledgementBaseline => ({ localHead, upstreamHead });

test('draft acknowledgement waits for the post-commit sync update', async () => {
  let current = status('e0.3', 'e0', 1);
  const store: StoreAcknowledgementSource = {
    syncStatus: () => current,
  };

  let resolved = false;
  const acknowledgement = waitForStoreAcknowledgement(store, baseline('e0.2', 'e0'), 1000, 'draft event')
    .then(() => {
      resolved = true;
    });
  await Promise.resolve();
  assert.equal(resolved, false);

  current = status('e0.3', 'e0.3', 0);
  await acknowledgement;
  assert.equal(resolved, true);
});

test('draft acknowledgement reports a stalled leader instead of resolving early', async () => {
  const stalled = status('e0.3', 'e0.1', 0);
  const store: StoreAcknowledgementSource = {
    syncStatus: () => stalled,
  };

  await assert.rejects(
    waitForStoreAcknowledgement(store, baseline('e0.2', 'e0'), 5, 'draft event'),
    (error: unknown) => error instanceof SnapshotAcknowledgementTimeout,
  );
});

test('an acknowledgement already visible at the first poll resolves immediately', async () => {
  const acknowledged = status('e0.3', 'e0.3', 0);
  const store: StoreAcknowledgementSource = {
    syncStatus: () => acknowledged,
  };

  await waitForStoreAcknowledgement(store, baseline('e0.2', 'e0'), 1000, 'draft event');
});

test('concurrent waiters require their own latest frontier and both observe one public status source', async () => {
  let current = status('e0.3', 'e0.1', 0);
  const store: StoreAcknowledgementSource = { syncStatus: () => current };
  let firstResolved = false;
  let secondResolved = false;
  const first = waitForStoreAcknowledgement(store, baseline('e0.2', 'e0'), 1000, 'first draft event').then(() => {
    firstResolved = true;
  });
  const second = waitForStoreAcknowledgement(store, baseline('e0.2', 'e0'), 1000, 'second draft event').then(() => {
    secondResolved = true;
  });

  await Promise.resolve();
  assert.equal(firstResolved, false);
  assert.equal(secondResolved, false);

  // The leader has only acknowledged an older queued frontier. Neither waiter
  // may treat it as acknowledgement of the newer local commit.
  current = status('e0.4', 'e0.3', 0);
  await Promise.resolve();
  assert.equal(firstResolved, false);
  assert.equal(secondResolved, false);

  current = status('e0.4', 'e0.4', 0);
  await Promise.all([first, second]);
  assert.equal(firstResolved, true);
  assert.equal(secondResolved, true);
});

test('the public title editor retains a failed edit, retries latest text, and keeps history undoable', async () => {
  const tempRoot = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'tracker-draft-editor-'));
  const entryPath = join(tempRoot, 'entry.jsx');
  const bundlePath = join(tempRoot, 'bundle.js');
  const pagePath = join(tempRoot, 'index.html');
  const detailsPath = resolve(import.meta.dir, '../src/features/details.jsx');
  const entry = `
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { EditableTaskTitle } from ${JSON.stringify(detailsPath)};

const originalTitle = 'Original synthetic title';
const canonicalAtStart = { value: originalTitle, sourceCommit: 'fixture-source', contentRevision: 'fixture-revision' };

function fieldState(value, baseValue) {
  return { value, baseValue, baseSourceCommit: 'fixture-source', baseContentRevision: 'fixture-revision' };
}

function Harness() {
  const [title, setTitle] = useState(originalTitle);
  const [draftFieldState, setDraftFieldState] = useState(null);
  const [history, setHistory] = useState({ schemaVersion: 2, undo: [], redo: [], skipped: [] });
  const activeSession = useRef(null);
  const finishCalls = useRef(0);
  const rejectFirstFinish = useRef(null);

  useEffect(() => {
    window.__rejectFirstSyntheticFinish = () => {
      rejectFirstFinish.current?.(new Error('synthetic leader acknowledgement failed'));
      rejectFirstFinish.current = null;
    };
    return () => { delete window.__rejectFirstSyntheticFinish; };
  }, []);

  const taskEdit = {
    ownerId: 'synthetic-owner', ownerState: 'ready', sessions: [], history,
    saveState: { kind: 'saved' }, publishState: { kind: 'idle' }, publishTransaction: null,
    registerPendingSession: () => {}, releasePendingSession: () => {},
    beginSession: async input => {
      activeSession.current = { ...input, currentValue: input.beforeValue };
      return 'started';
    },
    changeSessionValue: (sessionId, value) => {
      if (activeSession.current?.sessionId === sessionId) activeSession.current.currentValue = value;
    },
    finishSession: sessionId => {
      const session = activeSession.current;
      if (!session || session.sessionId !== sessionId) return Promise.reject(new Error('synthetic session is missing'));
      finishCalls.current += 1;
      if (finishCalls.current === 1) {
        const afterValue = session.currentValue;
        setTitle(afterValue);
        setDraftFieldState(fieldState(afterValue, originalTitle));
        setHistory(previous => ({
          ...previous,
          undo: [...previous.undo, {
            actionId: session.sessionId, itemId: 'fixture-task', field: 'title',
            beforeValue: originalTitle, afterValue, beforeFieldState: null,
            afterFieldState: fieldState(afterValue, originalTitle), canonicalAtStart,
          }],
        }));
        return new Promise((resolve, reject) => { rejectFirstFinish.current = reject; });
      }
      const beforeValue = session.beforeValue;
      const afterValue = session.currentValue;
      setTitle(afterValue);
      setDraftFieldState(afterValue === originalTitle ? null : fieldState(afterValue, beforeValue));
      setHistory(previous => ({
        ...previous,
        undo: [...previous.undo, {
          actionId: session.sessionId, itemId: 'fixture-task', field: 'title',
          beforeValue, afterValue, beforeFieldState: fieldState(beforeValue, originalTitle),
          afterFieldState: fieldState(afterValue, beforeValue), canonicalAtStart,
        }],
      }));
      return Promise.resolve();
    },
    cancelSession: async () => {},
    startPublish: () => {}, confirmPublish: () => {}, retryPublish: () => {}, cancelPublishRequest: () => {},
    discardConflictedField: () => {}, refreshCanonical: () => {}, skipUnavailable: () => {},
    requestHistoryMove: (direction, expectedActionId) => {
      if (direction !== 'undo') return;
      setHistory(previous => {
        const action = previous.undo.at(-1);
        if (!action || action.actionId !== expectedActionId) return previous;
        return { ...previous, undo: previous.undo.slice(0, -1), redo: [...previous.redo, action] };
      });
    },
  };

  const undo = () => {
    const action = history.undo.at(-1);
    if (!action) return;
    setTitle(action.beforeValue);
    setDraftFieldState(action.beforeValue === originalTitle ? null : fieldState(action.beforeValue, originalTitle));
    taskEdit.requestHistoryMove('undo', action.actionId);
  };

  return <main>
    <EditableTaskTitle
      itemId="fixture-task"
      value={title}
      fieldState={draftFieldState}
      canonicalAtStart={canonicalAtStart}
      taskEdit={taskEdit}
    />
    <button type="button" onClick={undo}>Undo synthetic history</button>
    <output data-testid="history">{JSON.stringify(history)}</output>
  </main>;
}

createRoot(document.getElementById('root')).render(<Harness />);
`;
  let browser;
  try {
    writeFileSync(entryPath, entry);
    writeFileSync(pagePath, '<!doctype html><html><body><div id="root"></div><script src="./bundle.js"></script></body></html>');
    await build({
      entryPoints: [entryPath],
      outfile: bundlePath,
      bundle: true,
      absWorkingDir: resolve(import.meta.dir, '../../..'),
      nodePaths: [resolve(import.meta.dir, '../../..', 'node_modules')],
      format: 'iife',
      platform: 'browser',
      target: 'es2022',
      loader: { '.css': 'empty' },
      define: { 'process.env.NODE_ENV': '"production"' },
      logLevel: 'silent',
    });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(new URL(`file://${pagePath}`).href);

    const editButton = page.getByRole('button', { name: 'Edit title', exact: true });
    await editButton.click();
    const input = page.getByRole('textbox', { name: 'Edit title', exact: true });
    await input.fill('First committed synthetic title');
    await input.press('Control+Enter');
    await expect(input).toBeVisible();
    await expect(input).toHaveAttribute('aria-busy', 'true');

    await page.evaluate(() => window.__rejectFirstSyntheticFinish?.());
    await expect(page.getByRole('status').filter({ hasText: 'Could not confirm that this task edit was saved.' })).toBeVisible();
    await input.fill('Latest synthetic title after failure');
    await page.getByRole('button', { name: 'Retry editing this field', exact: true }).click();
    await expect(editButton).toBeVisible();
    await expect(editButton).toContainText('Latest synthetic title after failure');

    const savedHistory = JSON.parse(await page.getByTestId('history').textContent() ?? '{}');
    assert.equal(savedHistory.undo.length, 2);
    assert.notEqual(savedHistory.undo[0].actionId, savedHistory.undo[1].actionId);
    assert.equal(savedHistory.undo[1].beforeValue, 'First committed synthetic title');
    assert.equal(savedHistory.undo[1].afterValue, 'Latest synthetic title after failure');

    await page.getByRole('button', { name: 'Undo synthetic history', exact: true }).click();
    await expect(editButton).toContainText('First committed synthetic title');
    await page.getByRole('button', { name: 'Undo synthetic history', exact: true }).click();
    await expect(editButton).toContainText('Original synthetic title');
    const undoneHistory = JSON.parse(await page.getByTestId('history').textContent() ?? '{}');
    assert.equal(undoneHistory.undo.length, 0);
    assert.equal(undoneHistory.redo.length, 2);
  } finally {
    await browser?.close();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
