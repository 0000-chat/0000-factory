import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { itemAncestors } from '../src/item-breadcrumbs.tsx';

function record(id, parent = null) {
  return { id, title: id, parent };
}

test('item breadcrumb ancestry is root first and stops at a missing parent', () => {
  const root = record('root');
  const middle = record('middle', 'root');
  const current = record('current', 'middle');
  const itemById = new Map([[root.id, root], [middle.id, middle]]);

  assert.deepEqual(itemAncestors(current, itemById).map(item => item.id), ['root', 'middle']);
  assert.deepEqual(itemAncestors(record('orphan', 'missing'), itemById), []);
});

test('item breadcrumb ancestry stops before repeating a cycle', () => {
  const first = record('first', 'second');
  const second = record('second', 'first');
  const itemById = new Map([[first.id, first], [second.id, second]]);

  assert.deepEqual(itemAncestors(record('current', 'first'), itemById).map(item => item.id), ['second', 'first']);
});
