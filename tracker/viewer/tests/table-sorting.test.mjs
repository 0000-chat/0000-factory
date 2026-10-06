import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { compareSortValues, stableSortBy } from '../src/components/kibo-ui/table/sorting.mjs';

test('sorts scalar values in either direction while keeping ties stable and unknowns last', () => {
  const rows = [
    { id: 'unknown-first', value: null },
    { id: 'second-two', value: 2 },
    { id: 'three', value: 3 },
    { id: 'first-two', value: 2 },
    { id: 'unknown-second', value: undefined },
  ];

  assert.deepEqual(
    stableSortBy(rows, row => row.value, 'asc').map(row => row.id),
    ['second-two', 'first-two', 'three', 'unknown-first', 'unknown-second'],
  );
  assert.deepEqual(
    stableSortBy(rows, row => row.value, 'desc').map(row => row.id),
    ['three', 'second-two', 'first-two', 'unknown-first', 'unknown-second'],
  );
});

test('sorts dates chronologically and keeps invalid or missing dates last both ways', () => {
  const rows = [
    { id: 'unknown', value: null },
    { id: 'later', value: new Date('2026-10-02T00:00:00Z') },
    { id: 'invalid', value: new Date('invalid') },
    { id: 'earlier', value: new Date('2026-09-30T00:00:00Z') },
  ];

  assert.deepEqual(
    stableSortBy(rows, row => row.value, 'asc').map(row => row.id),
    ['earlier', 'later', 'unknown', 'invalid'],
  );
  assert.deepEqual(
    stableSortBy(rows, row => row.value, 'desc').map(row => row.id),
    ['later', 'earlier', 'unknown', 'invalid'],
  );
  assert.equal(compareSortValues(new Date('invalid'), new Date('2026-09-30'), 'desc'), 1);
});

test('sorts strings naturally without changing the display values', () => {
  const rows = [
    { id: 'ten', value: 'Task 10' },
    { id: 'two', value: 'Task 2' },
  ];
  assert.deepEqual(stableSortBy(rows, row => row.value).map(row => row.id), ['two', 'ten']);
  assert.deepEqual(rows.map(row => row.value), ['Task 10', 'Task 2']);
});
