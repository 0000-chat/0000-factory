import { expect, test } from 'bun:test';
import { statusColumn, statusLabel } from '../src/work-modes.jsx';

test('started source status uses the Active board column while retaining its raw label', () => {
  const item = { status: 'started' };
  expect(statusColumn(item)).toBe('active');
  expect(statusLabel(item)).toBe('started');
});

test('missing source status remains explicit in the unmapped label', () => {
  expect(statusColumn({})).toBeNull();
  expect(statusLabel({})).toBe('Status not recorded');
});
