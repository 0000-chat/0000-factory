import { describe, expect, test } from 'bun:test';
import {
  compactReportsSearch,
  parseReportsSearch,
  reportsSearchDefaults,
  ReportsFilterMemory,
} from '../src/reports-state';
import { UNASSIGNED_OWNER } from '../src/routing-state';

describe('reports route search', () => {
  const options = {
    projectIds: new Set(['project-alpha', 'mobile-app']),
    ownerValues: new Set(['don', 'alex', UNASSIGNED_OWNER]),
  };

  test('uses all projects, incomplete records, and all owners by default', () => {
    expect(reportsSearchDefaults(options)).toEqual({
      scope: 'all',
      completed: false,
      owners: [],
    });
    expect(parseReportsSearch(null, options)).toEqual(reportsSearchDefaults(options));
  });

  test('validates scope, boolean, and JSON or decoded owner arrays', () => {
    expect(parseReportsSearch({
      scope: 'missing-project',
      completed: 'true',
      owners: '["alex","unknown","don","alex","unassigned"]',
    }, options)).toEqual({
      scope: 'all',
      completed: true,
      owners: [UNASSIGNED_OWNER, 'alex', 'don'],
    });
    expect(parseReportsSearch({ scope: 'mobile-app', completed: 'bad', owners: ['alex', 'unknown'] }, options)).toEqual({
      scope: 'mobile-app',
      completed: false,
      owners: ['alex'],
    });
    expect(parseReportsSearch({ owners: 'not-json' }, options).owners).toEqual([]);
  });

  test('compacts defaults and serializes a normalized owner list', () => {
    expect(compactReportsSearch({ scope: 'project-alpha', completed: false, owners: [] }, options)).toEqual({ scope: 'project-alpha' });
    expect(compactReportsSearch({ scope: 'all', completed: true, owners: [UNASSIGNED_OWNER, 'don'] }, options)).toEqual({
      completed: 'true',
      owners: JSON.stringify([UNASSIGNED_OWNER, 'don']),
    });
  });

  test('session memory remains independent and revalidates against restored options', () => {
    const memory = new ReportsFilterMemory();
    memory.remember({ scope: 'mobile-app', completed: true, owners: ['don'] }, options);
    expect(memory.restore(options)).toEqual({ scope: 'mobile-app', completed: true, owners: ['don'] });
    expect(memory.restore({ projectIds: new Set(['project-alpha']), ownerValues: new Set(['alex']) })).toEqual({
      scope: 'all',
      completed: true,
      owners: [],
    });
    expect(memory.restore(options)).toEqual({ scope: 'mobile-app', completed: true, owners: ['don'] });
  });
});
