import { expect, test } from 'bun:test';
import React from 'react';
import { renderToString } from 'react-dom/server';
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import type { TrackerSnapshot } from '../src/snapshot';
import { TeamView } from '../src/team-view.jsx';

type RenderContext = { data: Pick<TrackerSnapshot, 'source'> };

const profile = {
  id: 'person-1',
  slug: 'person-1',
  name: 'Synthetic Person',
  fullName: 'Synthetic Person Example',
  handle: 'person-1',
  aliases: ['Synthetic Person'],
  status: 'active',
  organizations: ['Synthetic Org'],
  organizationIds: ['synthetic-org'],
  strongAt: 'Private capability note',
  experience: 'Private experience note',
  bestAssignments: 'Private assignment note',
  preference: 'Private preference note',
  current: 'Private current assignment note',
  observedWork: 'Private guide observation',
  observedWorkAt: '2026-10-01',
  observedWorkLinks: [],
  githubUrl: null,
  slackUrl: null,
  avatarUrl: null,
};

function createRenderRouter(teamProjection: boolean) {
  const rootRoute = createRootRouteWithContext<RenderContext>()({ component: () => <Outlet /> });
  const teamIndexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/team',
    component: () => null,
  });
  const teamMemberRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/team/$memberSlug',
    component: () => <TeamView
      profiles={[profile]}
      items={[]}
      teamProjection={teamProjection}
      memberSlug="person-1"
      search=""
      onSearchChange={() => {}}
      organizationFilter="all"
      onOrganizationChange={() => {}}
      onResetFilters={() => {}}
      onSelectItem={() => {}}
    />,
  });
  const routeTree = rootRoute.addChildren([teamIndexRoute, teamMemberRoute]);
  return createRouter({
    routeTree,
    context: { data: { source: { layout: teamProjection ? 'team-projection-v1' : 'tracker-v1', commit: 'synthetic' } } },
    history: createMemoryHistory({ initialEntries: ['/team/person-1'] }),
  });
}

async function renderTeamProfile(teamProjection: boolean) {
  const router = createRenderRouter(teamProjection);
  await router.load();
  return renderToString(<RouterProvider router={router} />);
}

test('team profile rendering keeps private guide sections private', async () => {
  const privateMarkup = await renderTeamProfile(false);
  expect(privateMarkup).toContain('Capability and fit');
  expect(privateMarkup).toContain('Guide context');
  expect(privateMarkup).toContain('Stated preference');
  expect(privateMarkup).toContain('Private capability note');
  expect(privateMarkup).toContain('Private guide observation');

  const sharedMarkup = await renderTeamProfile(true);
  expect(sharedMarkup).not.toContain('Capability and fit');
  expect(sharedMarkup).not.toContain('Guide context');
  expect(sharedMarkup).not.toContain('Stated preference');
  expect(sharedMarkup).not.toContain('Private capability note');
  expect(sharedMarkup).not.toContain('Private guide observation');
  expect(sharedMarkup).toContain('team-profile-grid-shared');
  expect(sharedMarkup).toContain('Synthetic Person');
});
