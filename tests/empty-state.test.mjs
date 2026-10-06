import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'bun:test';
import { loadTracker, validateTracker } from '../tooling/tracker/model.mjs';
import { buildTrackerData } from '../tracker/viewer/tooling/data.mjs';

const rootInstance = {
  data: { folderPath: '', evidence: { kind: 'none' } },
  github: { owner: 'synthetic-org', repo: 'synthetic-data', branch: 'main' },
};

test('an empty tracker fixture is a valid empty source', () => {
  const root = mkdtempSync(join(tmpdir(), '0000-empty-tracker-'));
  try {
    mkdirSync(join(root, 'tracker/items'), { recursive: true });
    writeFileSync(join(root, 'tracker/people.json'), '{"schemaVersion":1,"organizations":[],"people":[]}\n');
    const records = loadTracker({ dataRepo: root, instance: rootInstance });
    assert.deepEqual(validateTracker(records), []);
    assert.equal(records.items.length, 0);
    assert.equal(records.people.length, 0);
    assert.equal(records.updates.length, 0);

    const snapshot = buildTrackerData(records, { commit: 'unknown', dirty: false, builtAt: '2026-01-01T00:00:00.000Z' });
    assert.equal(snapshot.items.length, 0);
    assert.equal(snapshot.people.length, 0);
    assert.equal(snapshot.updates.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
