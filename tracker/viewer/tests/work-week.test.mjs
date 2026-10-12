import assert from 'node:assert/strict';
import test from 'node:test';
import { parseWorkSearch } from '../src/routing-state.ts';
import { shiftWorkWeek, workWeekForManilaDay, workWindowForFocusWeek, workflowSearch } from '../src/work-week.ts';

test('Manila work weeks are Monday through Friday and navigate by seven days', () => {
  const current = workWeekForManilaDay('2026-10-12');
  assert.deepEqual(current, { start: '2026-10-12', end: '2026-10-16' });
  assert.deepEqual(shiftWorkWeek(current, 1), { start: '2026-10-19', end: '2026-10-23' });
  assert.deepEqual(shiftWorkWeek(current, -1), { start: '2026-10-05', end: '2026-10-09' });
  assert.deepEqual(workWeekForManilaDay('2026-10-18'), current);
});

test('This week uses a four-work-week context while retaining the selected focus week', () => {
  const focus = workWeekForManilaDay('2026-10-12');
  assert.deepEqual(workWindowForFocusWeek(focus), {
    start: '2026-10-05',
    end: '2026-10-30',
    focus,
  });
});

test('workflow entry defaults preserve the current week for review and advance for planning', () => {
  const base = { scope: 'all', mode: 'gantt', preset: 'none', people: [], activity: 'all', completed: false, planned: true, drafts: false, q: '', owners: [], statuses: [], undated: 'include' };
  const current = workWeekForManilaDay('2026-10-12');
  assert.equal(workflowSearch(base, 'this-week', current).from, current.start);
  assert.deepEqual(workflowSearch(base, 'next-week', shiftWorkWeek(current, 1)).to, '2026-10-23');
});

test('route refinements stay sticky after workflow entry', () => {
  const base = { scope: 'all', mode: 'gantt', preset: 'none', people: [], activity: 'all', completed: false, planned: true, drafts: false, q: '', owners: [], statuses: [], undated: 'include' };
  const entered = workflowSearch(base, 'this-week', workWeekForManilaDay('2026-10-12'));
  const refined = parseWorkSearch({ ...entered, mode: 'tree', q: 'James', groupByOwner: 'true', presentationMode: 'true' });
  assert.equal(refined.mode, 'tree');
  assert.equal(refined.q, 'James');
  assert.equal(refined.groupByOwner, true);
  assert.equal(refined.presentationMode, true);
});
