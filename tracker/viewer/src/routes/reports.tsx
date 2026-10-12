import { createFileRoute, redirect } from '@tanstack/react-router';
import { ReportsPage } from '../reports-page';
import { reportsRouteSearchDefaults, stripDynamicSearchDefaults, validateReportsRouteSearch } from '../route-data';
import type { ReportsSearch } from '../reports-state';
import { parseWorkSearch } from '../routing-state';
import { isTeamProjection } from '../team-mode';

export const Route = createFileRoute('/reports')({
  beforeLoad: ({ context }) => {
    if (isTeamProjection(context.data)) {
      throw redirect({ to: '/work', search: parseWorkSearch({}), replace: true });
    }
  },
  validateSearch: (search: Record<string, unknown>) => validateReportsRouteSearch(search),
  search: { middlewares: [stripDynamicSearchDefaults<ReportsSearch>(reportsRouteSearchDefaults)] },
  component: ReportsPage,
});
