import { expect, test } from 'bun:test';
import { classifySupportedPath, currentBrowseSearch, internalLinkTarget, selectItemMutation, validatedReturnTo } from '../src/navigation';

const options = {
  projectIds: new Set(['project-alpha', '0000-legacy']),
  ownerValues: new Set(['owner', '__unassigned__']),
};

test('canonical details can return to Reports with its independent compact filters', () => {
  const input = '/reports?scope=all&completed=true&owners=%5B%22owner%22%5D&mode=table&item=archived-item';
  expect(validatedReturnTo(input, options)).toBe('/reports?completed=true&owners=%5B%22owner%22%5D');
  expect(currentBrowseSearch('/reports', { scope: 'all', completed: true, owners: ['owner'], mode: 'table' }, options)).toEqual({
    completed: 'true', owners: '["owner"]',
  });
});

test('Reports links are internal and record selection uses canonical pages rather than an item sheet', () => {
  expect(classifySupportedPath('/reports')).toEqual({ kind: 'reports' });
  expect(internalLinkTarget('/reports?scope=all', 'https://tracker.invalid/work')).toEqual({
    pathname: '/reports', search: { scope: 'all' }, hash: '',
  });
  expect(internalLinkTarget('https://other.invalid/reports', 'https://tracker.invalid/work')).toBeNull();
  expect(selectItemMutation({ pathname: '/reports', search: { scope: 'all' } }, 'archived-item')).toEqual({ kind: 'none' });
});
