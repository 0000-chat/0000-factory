import { createFileRoute } from '@tanstack/react-router';
import { ReportsPage } from '../reports-page';
import { reportsRouteSearchDefaults, stripDynamicSearchDefaults, validateReportsRouteSearch } from '../route-data';
import type { ReportsSearch } from '../reports-state';

export const Route = createFileRoute('/reports')({
  validateSearch: (search: Record<string, unknown>) => validateReportsRouteSearch(search),
  search: { middlewares: [stripDynamicSearchDefaults<ReportsSearch>(reportsRouteSearchDefaults)] },
  component: ReportsPage,
});
