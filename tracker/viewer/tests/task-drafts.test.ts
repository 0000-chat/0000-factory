import assert from 'node:assert/strict';
import { test } from 'bun:test';
import {
  parseTaskDraftPayload,
  restoreTaskDraftPayloadField,
  updateTaskDraftPayload,
} from '../src/task-drafts';

test('task field drafts preserve their first canonical baseline across edits and refreshes', () => {
  const first = updateTaskDraftPayload({
    existing: null,
    field: 'sections.outcome',
    value: 'First local edit',
    canonicalValue: 'Original canonical outcome',
    sourceCommit: 'source-1',
    contentRevision: 'content-1',
  });
  assert.deepEqual(first?.fields['sections.outcome'], {
    value: 'First local edit',
    baseValue: 'Original canonical outcome',
    baseSourceCommit: 'source-1',
    baseContentRevision: 'content-1',
  });

  const refreshed = updateTaskDraftPayload({
    existing: first,
    field: 'sections.outcome',
    value: 'Second local edit',
    canonicalValue: 'New canonical outcome',
    sourceCommit: 'source-2',
    contentRevision: 'content-2',
  });
  assert.deepEqual(refreshed?.fields['sections.outcome'], {
    value: 'Second local edit',
    baseValue: 'Original canonical outcome',
    baseSourceCommit: 'source-1',
    baseContentRevision: 'content-1',
  });
});

test('field updates preserve other task drafts and restore an exact prior field state', () => {
  const titleDraft = updateTaskDraftPayload({
    existing: null,
    field: 'title',
    value: 'Local title',
    canonicalValue: 'Canonical title',
    sourceCommit: 'source-1',
    contentRevision: 'content-1',
  });
  const bothFields = updateTaskDraftPayload({
    existing: titleDraft,
    field: 'sections.evidence',
    value: 'Local evidence',
    canonicalValue: 'Canonical evidence',
    sourceCommit: 'source-1',
    contentRevision: 'content-1',
  });
  assert.ok(bothFields);
  assert.equal(bothFields.fields.title?.value, 'Local title');

  const priorEvidence = bothFields.fields['sections.evidence'];
  const temporarilyRemoved = updateTaskDraftPayload({
    existing: bothFields,
    field: 'sections.evidence',
    value: 'Canonical evidence',
    canonicalValue: 'Canonical evidence',
    sourceCommit: 'source-2',
    contentRevision: 'content-2',
  });
  assert.ok(temporarilyRemoved);
  assert.equal(temporarilyRemoved.fields['sections.evidence'], undefined);

  const restored = restoreTaskDraftPayloadField({
    existing: temporarilyRemoved,
    field: 'sections.evidence',
    fieldState: priorEvidence ?? null,
  });
  assert.deepEqual(restored, bothFields);
});

test('saved task draft payloads reject fields outside the task content whitelist', () => {
  assert.throws(() => parseTaskDraftPayload(JSON.stringify({
    schemaVersion: 1,
    fields: {
      title: {
        value: 'Draft title',
        baseValue: 'Canonical title',
        baseSourceCommit: 'source-1',
        baseContentRevision: 'content-1',
      },
      status: {
        value: 'done',
        baseValue: 'active',
        baseSourceCommit: 'source-1',
        baseContentRevision: 'content-1',
      },
    },
  })));
});
