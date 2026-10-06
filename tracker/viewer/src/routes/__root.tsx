import { createRootRouteWithContext } from '@tanstack/react-router';
import { AppShell } from '../app-shell';
import { TrackerNotFound } from '../app-shell';
import type { TrackerRouterContext } from '../router-context';

export const Route = createRootRouteWithContext<TrackerRouterContext>()({
  component: AppShell,
  notFoundComponent: TrackerNotFound,
});
