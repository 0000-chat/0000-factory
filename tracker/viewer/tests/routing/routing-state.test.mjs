import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { createMemoryHistory } from '@tanstack/react-router';
import {
  BrowseFilterMemory,
  compactPlansSearch,
  compactTeamSearch,
  compactTodaySearch,
  compactWorkSearch,
  parsePlansSearch,
  parseTeamSearch,
  parseTodaySearch,
  parseWorkSearch,
} from '../../src/routing-state.ts';
import {
  closeItemMutation,
  classifySupportedPath,
  formatUrl,
  internalLinkTarget,
  legacyHashPath,
  replaceFiltersMutation,
  selectItemMutation,
  validatedReturnTo,
  workItemPath,
} from '../../src/navigation.ts';
import { configureRouteFilters, stripDynamicSearchDefaults, validateTeamRouteSearch, validateWorkRouteSearch } from '../../src/route-data.ts';

function currentLocation(history) {
  return {
    pathname: history.location.pathname,
    search: Object.fromEntries(new URLSearchParams(history.location.search)),
  };
}

function applyMutation(history, mutation) {
  if (mutation.kind === 'none') return;
  const query = {};
  for (const [key, value] of Object.entries(mutation.search)) {
    if (typeof value === 'string') query[key] = value;
    else if (typeof value === 'boolean') query[key] = String(value);
    else if (Array.isArray(value)) query[key] = JSON.stringify(value);
  }
  history[mutation.kind](formatUrl(mutation.pathname, query));
}

test('work and today search parsers validate values and omit their defaults', () => {
  const projectIds = new Set(['project-alpha', 'milestone-stream']);
  assert.deepEqual(parseWorkSearch({}, { projectIds }), {
    scope: 'all', mode: 'gantt', preset: 'none', people: [], activity: 'all', completed: false, planned: true, drafts: false,
    q: '', owners: [], statuses: [], undated: 'include',
  });
  assert.deepEqual(parseWorkSearch({ scope: 'missing', mode: 'bogus', completed: 'yes', planned: 'false', drafts: true, item: '' }, { projectIds }), {
    scope: 'all', mode: 'gantt', preset: 'none', people: [], activity: 'all', completed: false, planned: false, drafts: true,
    q: '', owners: [], statuses: [], undated: 'include',
  });
  assert.deepEqual(parseWorkSearch({ scope: 'milestone-stream', mode: 'table', completed: 'true', planned: false }, { projectIds }), {
    scope: 'milestone-stream', mode: 'table', preset: 'none', people: [], activity: 'all', completed: true, planned: false, drafts: false,
    q: '', owners: [], statuses: [], undated: 'include',
  });
  assert.equal(parseWorkSearch({ activity: 'invalid' }, { projectIds }).activity, 'all');
  assert.deepEqual(compactWorkSearch(parseWorkSearch({}, { projectIds }), { projectIds }), {});
  assert.deepEqual(compactWorkSearch(parseWorkSearch({ scope: 'project-alpha', mode: 'table', completed: true }, { projectIds }), { projectIds }), {
    scope: 'project-alpha', mode: 'table', completed: 'true',
  });
  const workOptions = {
    projectIds,
    ownerValues: new Set(['don', 'unrostered', '__unassigned__']),
    statusValues: new Set(['active', 'queued']),
    managerPersonValues: new Set(['don', 'juan', '__unassigned__']),
  };
  const addedFilters = parseWorkSearch({
    q: ' invoice risk ',
    activity: 'attention',
    owners: '["unrostered","unknown","don","don"]',
    statuses: ['queued', 'active', 'stale', 'queued'],
    from: '2026-10-20',
    to: '2026-10-01',
    undated: 'only',
    date: '2026-10-14',
  }, workOptions);
  assert.deepEqual(addedFilters, {
    scope: 'all', mode: 'gantt', preset: 'none', people: [], activity: 'attention', completed: false, planned: true, drafts: false,
    q: ' invoice risk ', owners: ['don', 'unrostered'], statuses: ['active', 'queued'],
    from: '2026-10-01', to: '2026-10-20', undated: 'only', date: '2026-10-14',
  });
  assert.deepEqual(compactWorkSearch(addedFilters, workOptions), {
    activity: 'attention', q: ' invoice risk ', owners: '["don","unrostered"]', statuses: '["active","queued"]',
    from: '2026-10-01', to: '2026-10-20', undated: 'only', date: '2026-10-14',
  });
  assert.deepEqual(parseWorkSearch({
    activity: 'invalid', owners: '[bad-json', statuses: ['stale'], from: '2026-02-29', to: '2026-10-03', date: 'not-a-date',
  }, workOptions), {
    scope: 'all', mode: 'gantt', preset: 'none', people: [], activity: 'all', completed: false, planned: true, drafts: false,
    q: '', owners: [], statuses: [], to: '2026-10-03', undated: 'include',
  });
  assert.deepEqual(compactWorkSearch(parseWorkSearch({ activity: 'quiet' }, { projectIds }), { projectIds }), {
    activity: 'quiet',
  });

  const managerSearch = parseWorkSearch({
    preset: 'moving', people: '["juan","unassigned","don","don","unknown"]',
    mode: 'tree', scope: 'milestone-stream', activity: 'quiet',
  }, workOptions);
  assert.deepEqual(managerSearch, {
    scope: 'milestone-stream', mode: 'tree', preset: 'moving', people: ['__unassigned__', 'don', 'juan'],
    activity: 'quiet', completed: false, planned: true, drafts: false,
    q: '', owners: [], statuses: [], undated: 'include',
  });
  assert.deepEqual(compactWorkSearch(managerSearch, workOptions), {
    scope: 'milestone-stream', mode: 'tree', preset: 'moving', people: '["__unassigned__","don","juan"]', activity: 'quiet',
  });
  assert.equal(parseWorkSearch({ preset: 'unknown' }, workOptions).preset, 'none');

  const noBusinessProject = { projectIds: new Set(['milestone-stream']) };
  assert.deepEqual(parseTodaySearch({ scope: 'missing' }, noBusinessProject), {
    scope: 'all', completed: false, planned: true, drafts: false,
  });
  assert.deepEqual(parseTodaySearch({}, { projectIds }), {
    scope: 'all', completed: false, planned: true, drafts: false,
  });
  assert.deepEqual(compactTodaySearch(parseTodaySearch({ scope: 'project-alpha' }, { projectIds }), { projectIds }), {
    scope: 'project-alpha',
  });
  assert.deepEqual(compactTodaySearch(parseTodaySearch({}, noBusinessProject), noBusinessProject), {});
});

test('plans and team search preserve raw query text and validate organization choices', () => {
  assert.deepEqual(parsePlansSearch({ q: '  launch  ', item: 'task-1' }), { q: '  launch  ', item: 'task-1' });
  assert.deepEqual(compactPlansSearch(parsePlansSearch({ q: '  launch  ', item: 'task-1' })), { q: '  launch  ', item: 'task-1' });

  const options = { organizationLabels: new Set(['0000', 'Unrecorded label']) };
  assert.deepEqual(parseTeamSearch({ q: ' Alpha ', organization: '0000' }, options), { q: ' Alpha ', organization: '0000' });
  assert.deepEqual(parseTeamSearch({ q: 'x', organization: '__unrecorded__' }, options), { q: 'x', organization: '__unrecorded__' });
  assert.deepEqual(parseTeamSearch({ q: 'x', organization: 'stale' }, options), { q: 'x', organization: 'all' });
  assert.deepEqual(compactTeamSearch(parseTeamSearch({}, options), options), {});
});

test('snapshot-aware route validators fall back when a project scope or organization is unavailable', () => {
  configureRouteFilters({
    items: [
      { id: 'milestone-stream', type: 'workstream', parent: 'project-alpha', childIds: [], owner: 'unmatched-handle', ownerName: 'Legacy Owner', status: 'active' },
      { id: 'unassigned-work', type: 'task', parent: 'milestone-stream', childIds: [], owner: 'unassigned', status: 'queued' },
    ],
    team: [{ organizations: ['0000'] }],
    people: [{ id: 'don', name: 'Don', status: 'active' }, { id: 'retired', name: 'Retired', status: 'inactive' }],
  });

  assert.equal(validateWorkRouteSearch({}).scope, 'all');
  assert.equal(validateWorkRouteSearch({ scope: 'project-alpha' }).scope, 'all');
  assert.equal(validateWorkRouteSearch({ scope: 'missing' }).scope, 'all');
  assert.equal(validateTeamRouteSearch({ organization: 'Stale Org' }).organization, 'all');
  assert.equal(validateTeamRouteSearch({ organization: '0000' }).organization, '0000');
  assert.deepEqual(validateWorkRouteSearch({
    owners: '["unmatched-handle","unknown","__unassigned__","unmatched-handle"]',
    statuses: ['active', 'unknown', 'queued', 'active'],
  }).owners, ['__unassigned__', 'unmatched-handle']);
  assert.deepEqual(validateWorkRouteSearch({
    owners: '["unmatched-handle","unknown","__unassigned__","unmatched-handle"]',
    statuses: ['active', 'unknown', 'queued', 'active'],
  }).statuses, ['active', 'queued']);
  assert.equal(validateWorkRouteSearch({ activity: 'quiet' }).activity, 'quiet');
  assert.deepEqual(validateWorkRouteSearch({ people: '["don","retired","unassigned"]' }).people, ['__unassigned__', 'don']);
});

test('filter memory stores validated browsing filters without selected item ids', () => {
  const memory = new BrowseFilterMemory();
  const projectOptions = { projectIds: new Set(['project-alpha', 'milestone-stream']) };
  const workOptions = {
    ...projectOptions,
    ownerValues: new Set(['don', 'mark']),
    statusValues: new Set(['active', 'queued']),
  };
  const teamOptions = { organizationLabels: new Set(['0000']) };
  memory.rememberWork({
    scope: 'milestone-stream', mode: 'table', activity: 'attention', completed: 'true', q: '  invoice ',
    owners: '["mark","don"]', statuses: ['queued'], from: '2026-10-20', to: '2026-10-01',
    undated: 'exclude', date: '2026-10-11', item: 'hidden-item',
  }, workOptions);
  memory.rememberToday({ scope: 'all', planned: 'false', item: 'another-item' }, projectOptions);
  memory.rememberPlans({ q: '  roadmap ', item: 'selected-item' });
  memory.rememberTeam({ q: '  alex ', organization: '0000', item: 'selected-item' }, teamOptions);

  assert.deepEqual(memory.restoreWork(workOptions), {
    scope: 'milestone-stream', mode: 'table', preset: 'none', people: [], activity: 'attention', completed: true, planned: true, drafts: false,
    q: '  invoice ', owners: ['don', 'mark'], statuses: ['queued'],
    from: '2026-10-01', to: '2026-10-20', undated: 'exclude', date: '2026-10-11',
  });
  assert.deepEqual(memory.restoreToday(projectOptions), {
    scope: 'all', completed: false, planned: false, drafts: false,
  });
  assert.deepEqual(memory.restorePlans(), { q: '  roadmap ' });
  assert.deepEqual(memory.restoreTeam(teamOptions), { q: '  alex ', organization: '0000' });
  assert.deepEqual(memory.restore('plans'), { q: '  roadmap ' });
  assert.deepEqual(memory.restore('work', { ...workOptions, ...teamOptions }), memory.restoreWork(workOptions));
});

test('selection pushes once, replaces on selection/filter changes, and Back/Forward closes and reopens the sheet', () => {
  const history = createMemoryHistory({ initialEntries: ['/work?mode=table&activity=quiet'] });
  applyMutation(history, selectItemMutation(currentLocation(history), 'first-item'));
  assert.equal(history.location.pathname, '/work');
  assert.equal(currentLocation(history).search.item, 'first-item');
  assert.equal(currentLocation(history).search.activity, 'quiet');
  assert.equal(history.length, 2);

  applyMutation(history, selectItemMutation(currentLocation(history), 'second-item'));
  assert.equal(currentLocation(history).search.item, 'second-item');
  assert.equal(history.length, 2);

  applyMutation(history, replaceFiltersMutation(currentLocation(history), {
    mode: 'kanban', scope: 'all', q: 'invoice', owners: ['don'], statuses: ['active'],
  }));
  assert.equal(currentLocation(history).search.item, 'second-item');
  assert.equal(currentLocation(history).search.mode, 'kanban');
  assert.equal(currentLocation(history).search.scope, 'all');
  assert.equal(currentLocation(history).search.activity, 'quiet');
  assert.equal(currentLocation(history).search.owners, '["don"]');
  assert.equal(currentLocation(history).search.statuses, '["active"]');
  assert.equal(history.length, 2);

  history.back();
  assert.equal(currentLocation(history).search.item, undefined);
  history.forward();
  assert.equal(currentLocation(history).search.item, 'second-item');

  applyMutation(history, closeItemMutation(currentLocation(history)));
  assert.equal(currentLocation(history).search.item, undefined);
  assert.equal(currentLocation(history).search.owners, '["don"]');
  assert.equal(history.length, 2);
});

test('closing removes only the sheet selection and full-page return paths stay internal', () => {
  const history = createMemoryHistory({ initialEntries: ['/today?scope=all&completed=true&item=task-7'] });
  applyMutation(history, closeItemMutation(currentLocation(history)));
  assert.deepEqual(currentLocation(history).search, { scope: 'all', completed: 'true' });

  const options = {
    projectIds: new Set(['project-alpha']),
    organizationLabels: new Set(['0000']),
    ownerValues: new Set(['don', '__unassigned__']),
    statusValues: new Set(['active']),
  };
  assert.equal(validatedReturnTo('/team?q=%20Alex%20&organization=0000&item=ignored', options), '/team?q=+Alex+&organization=0000');
  assert.equal(validatedReturnTo('//evil.example/work', options), null);
  assert.equal(validatedReturnTo('https://evil.example/work', options), null);
  assert.equal(validatedReturnTo('/work/task-7', options), null);
  assert.equal(validatedReturnTo('/work?scope=unknown', options), '/work');
  assert.equal(
    validatedReturnTo('/work?q=%20invoice%20&owners=%5B%22don%22%5D&statuses=%5B%22active%22%5D&from=2026-10-10&to=2026-10-01&undated=exclude&date=2026-10-15&item=ignored', options),
    '/work?q=+invoice+&owners=%5B%22don%22%5D&statuses=%5B%22active%22%5D&from=2026-10-01&to=2026-10-10&undated=exclude&date=2026-10-15',
  );
  assert.equal(
    validatedReturnTo('/work?owners=%5Bbad-json&statuses=%5B%22unknown%22%5D&from=2026-02-29&date=not-a-date', options),
    '/work',
  );
  assert.equal(validatedReturnTo('/plans/roadmap?q=%20alpha%20&item=ignored', options), '/plans/roadmap?q=+alpha+');
  assert.equal(validatedReturnTo('/team/rosa?q=%20alpha%20&organization=stale', options), '/team/rosa?q=+alpha+');
  assert.equal(formatUrl(workItemPath('task/7'), {}), '/work/task%2F7');
});

test('work route defaults strip equivalent empty arrays by value', () => {
  const middleware = stripDynamicSearchDefaults(() => ({ owners: [], statuses: [], q: '', undated: 'include' }));
  const result = middleware({
    search: { owners: [], statuses: [], q: '', undated: 'include', mode: 'table' },
    next: search => search,
  });
  assert.deepEqual(result, { mode: 'table' });
});

test('supported-path parsing and Markdown links reject malformed, external, and unsupported targets', () => {
  assert.deepEqual(classifySupportedPath('/team/rosa-blanca'), { kind: 'team', memberSlug: 'rosa-blanca' });
  assert.deepEqual(classifySupportedPath('/team/a%2Fb'), { kind: 'invalid' });
  assert.deepEqual(classifySupportedPath('/work/%E0%A4%A'), { kind: 'invalid' });
  assert.deepEqual(classifySupportedPath('/not-a-route'), { kind: 'unknown' });
  assert.deepEqual(internalLinkTarget('/work/task-1?item=task-2', 'https://tracker.example/team'), {
    pathname: '/work/task-1', search: { item: 'task-2' }, hash: '',
  });
  assert.equal(internalLinkTarget('https://outside.example/work/task-1', 'https://tracker.example/team'), null);
  assert.equal(internalLinkTarget('/work/a%2Fb', 'https://tracker.example/team'), null);
  assert.equal(internalLinkTarget('/unsupported', 'https://tracker.example/team'), null);
});

test('legacy hash paths become ordinary route paths before router startup', () => {
  assert.equal(legacyHashPath('#/'), '/work');
  assert.equal(legacyHashPath('#/work/task-1?mode=table'), '/work/task-1?mode=table');
  assert.equal(legacyHashPath('#/team/rosa'), '/team/rosa');
  assert.equal(legacyHashPath('#/decisions/decision-1'), '/decisions/decision-1');
  assert.equal(legacyHashPath('#/team/a%2Fb'), '/__invalid_link__');
  assert.equal(legacyHashPath('#/'), '/work');
  assert.equal(legacyHashPath('#anchor'), null);
});
