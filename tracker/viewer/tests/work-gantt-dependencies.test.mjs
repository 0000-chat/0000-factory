import assert from 'node:assert/strict';
import { test } from 'bun:test';
import {
  buildWorkGanttDependencySummary,
  layoutWorkGanttDependencies,
  normalizeWorkGanttDependencyEdges,
  selectWorkGanttDependencyPaths,
} from '../src/work-gantt-dependencies.mjs';

function row(id, { approved = true } = {}) {
  return { id, entry: { id, title: `Title ${id}` }, marks: approved ? [{ sourceKind: 'approved' }] : [] };
}

function anchor(left, right, top, bottom, point = false) {
  return { left, right, top, bottom, point };
}

test('edges are sorted, deduplicated by relationship, and safe when the graph has cycles', () => {
  const edges = normalizeWorkGanttDependencyEdges([
    { id: 'z', fromId: 'b', toId: 'a' },
    { id: 'c', fromId: 'a', toId: 'b' },
    { id: 'a', fromId: 'a', toId: 'b' },
    { id: 'self', fromId: 'b', toId: 'b' },
    { id: '', fromId: 'x', toId: 'y' },
  ]);

  assert.deepEqual(edges, [
    { id: 'a', fromId: 'a', toId: 'b' },
    { id: 'z', fromId: 'b', toId: 'a' },
  ]);

  const paths = layoutWorkGanttDependencies({
    rows: [row('a'), row('b')],
    dependencyEdges: edges,
    anchors: new Map([
      ['a', anchor(20, 40, 0, 8)],
      ['b', anchor(80, 100, 32, 40)],
    ]),
  });
  assert.equal(paths.length, 2);
  assert.deepEqual(paths.map(path => path.id), ['a', 'z']);
  assert.deepEqual(paths.map(path => path.channelIndex), [0, 1]);
});

test('forward routes attach at both mark edges and use the source row gutter', () => {
  const [path] = layoutWorkGanttDependencies({
    rows: [row('source'), row('target')],
    dependencyEdges: [{ id: 'source->target', fromId: 'source', toId: 'target' }],
    rowBounds: new Map([
      ['source', { top: 0, bottom: 80 }],
      ['target', { top: 80, bottom: 160 }],
    ]),
    anchors: new Map([
      ['source', anchor(10, 30, 36, 44)],
      ['target', anchor(80, 100, 116, 124)],
    ]),
  });

  assert.equal(path.fromX, 30);
  assert.equal(path.fromY, 40);
  assert.equal(path.toX, 80);
  assert.equal(path.toY, 120);
  assert.equal(path.backwardsDates, false);
  assert.equal(path.path, 'M 30 40 L 42 40 L 42 80 L 68 80 L 68 120 L 80 120');
});

test('backward dates route outside the later endpoint and return to the target', () => {
  const [path] = layoutWorkGanttDependencies({
    rows: [row('source'), row('target')],
    dependencyEdges: [{ id: 'backward', fromId: 'source', toId: 'target' }],
    rowBounds: new Map([
      ['source', { top: 0, bottom: 80 }],
      ['target', { top: 80, bottom: 160 }],
    ]),
    anchors: new Map([
      ['source', anchor(100, 140, 36, 44)],
      ['target', anchor(20, 50, 116, 124)],
    ]),
  });

  assert.equal(path.backwardsDates, true);
  assert.equal(path.path, 'M 140 40 L 152 40 L 152 80 L 8 80 L 8 120 L 20 120');
  assert.ok(path.fromX > 100);
});

test('routes to a row above use the source row top as their gutter', () => {
  const [path] = layoutWorkGanttDependencies({
    rows: [row('target'), row('source')],
    dependencyEdges: [{ id: 'source->target', fromId: 'source', toId: 'target' }],
    rowBounds: new Map([
      ['target', { top: 0, bottom: 80 }],
      ['source', { top: 80, bottom: 160 }],
    ]),
    anchors: new Map([
      ['target', anchor(80, 100, 36, 44)],
      ['source', anchor(10, 30, 116, 124)],
    ]),
  });

  assert.equal(path.path, 'M 30 120 L 42 120 L 42 80 L 68 80 L 68 40 L 80 40');
});

test('same-task dependency references are omitted instead of drawing a self-loop', () => {
  const paths = layoutWorkGanttDependencies({
    rows: [row('same')],
    dependencyEdges: [{ id: 'same-row', fromId: 'same', toId: 'same' }],
    anchors: new Map([['same', anchor(30, 50, 10, 18)]]),
  });

  assert.deepEqual(paths, []);
});

test('due-only point endpoints attach at their center', () => {
  const [path] = layoutWorkGanttDependencies({
    rows: [row('due'), row('bar')],
    dependencyEdges: [{ id: 'due->bar', fromId: 'due', toId: 'bar' }],
    rowBounds: new Map([
      ['due', { top: 0, bottom: 80 }],
      ['bar', { top: 80, bottom: 160 }],
    ]),
    anchors: new Map([
      ['due', anchor(45, 49, 36, 44, true)],
      ['bar', anchor(80, 100, 116, 124)],
    ]),
  });

  assert.equal(path.fromX, 47);
  assert.equal(path.toX, 80);
  assert.equal(path.path, 'M 47 40 L 59 40 L 59 80 L 68 80 L 68 120 L 80 120');
});

test('hidden rows and rows without approved dates are not drawn and are not rerouted', () => {
  const edges = [
    { id: 'visible->hidden', fromId: 'visible', toId: 'hidden' },
    { id: 'visible->undated', fromId: 'visible', toId: 'undated' },
    { id: 'visible->dated', fromId: 'visible', toId: 'dated' },
  ];
  const rows = [row('visible'), row('undated', { approved: false }), row('dated')];
  const paths = layoutWorkGanttDependencies({
    rows,
    dependencyEdges: edges,
    anchors: new Map([
      ['visible', anchor(10, 30, 0, 8)],
      ['undated', anchor(50, 70, 32, 40)],
      ['dated', anchor(90, 110, 64, 72)],
    ]),
  });

  assert.deepEqual(paths.map(path => path.id), ['visible->dated']);
  const summary = buildWorkGanttDependencySummary({
    activeId: 'visible',
    rows,
    dependencyEdges: edges,
    entries: new Map([
      ['hidden', { id: 'hidden', title: 'Hidden title' }],
      ['undated', { id: 'undated', title: 'Undated title' }],
      ['dated', { id: 'dated', title: 'Dated title' }],
    ]),
  });

  assert.deepEqual(summary.dependents.map(item => [item.title, item.missingReason]), [
    ['Dated title', null],
    ['Hidden title', 'Hidden in this view'],
    ['Undated title', 'No approved dates'],
  ]);
});

test('active-only and all-edge modes select cached paths without changing their layout', () => {
  const paths = layoutWorkGanttDependencies({
    rows: [row('a'), row('b'), row('c')],
    dependencyEdges: [
      { id: 'a->b', fromId: 'a', toId: 'b' },
      { id: 'b->c', fromId: 'b', toId: 'c' },
    ],
    anchors: new Map([
      ['a', anchor(0, 20, 0, 8)],
      ['b', anchor(40, 60, 32, 40)],
      ['c', anchor(80, 100, 64, 72)],
    ]),
  });

  assert.deepEqual(selectWorkGanttDependencyPaths(paths, { activeId: 'a' }).map(path => path.id), ['a->b']);
  assert.deepEqual(selectWorkGanttDependencyPaths(paths, { activeId: 'b' }).map(path => path.id), ['a->b', 'b->c']);
  assert.deepEqual(selectWorkGanttDependencyPaths(paths, { showAll: true }), paths);
});

test('dependency summary lists prerequisites and dependents with scheduling caveat context', () => {
  const summary = buildWorkGanttDependencySummary({
    activeId: 'middle',
    rows: [row('before'), row('middle'), row('after')],
    dependencyEdges: [
      { id: 'before->middle', fromId: 'before', toId: 'middle' },
      { id: 'middle->after', fromId: 'middle', toId: 'after' },
    ],
    entries: new Map([
      ['middle', { title: 'Middle task' }],
      ['before', { title: 'Previous task' }],
      ['after', { title: 'Next task' }],
    ]),
  });

  assert.equal(summary.activeTitle, 'Middle task');
  assert.deepEqual(summary.prerequisites.map(item => item.title), ['Previous task']);
  assert.deepEqual(summary.dependents.map(item => item.title), ['Next task']);
  assert.equal(summary.prerequisites[0].missingReason, null);
  assert.equal(summary.dependents[0].missingReason, null);
});
