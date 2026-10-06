import { createRouter as createTanStackRouter, type RouterHistory } from '@tanstack/react-router';
import type { TrackerSnapshot } from './snapshot';
import type { TrackerRouterContext } from './router-context';
import { configureRouteFilters } from './route-data';
import { routeTree } from './routeTree.gen';

export function createTrackerRouter(
  data: TrackerSnapshot,
  context: Omit<TrackerRouterContext, 'data'>,
  history?: RouterHistory,
) {
  configureRouteFilters(data);
  return createTanStackRouter({
    routeTree,
    context: { data, ...context },
    history,
    scrollRestoration: true,
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 0,
  });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createTrackerRouter>;
  }
}

declare module '@tanstack/history' {
  interface HistoryState {
    returnTo?: string;
  }
}
