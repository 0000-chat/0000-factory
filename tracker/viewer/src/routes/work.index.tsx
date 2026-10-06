import { createFileRoute } from '@tanstack/react-router';
import { WorkPage } from '../route-pages';
import { stripDynamicSearchDefaults, validateWorkRouteSearch, workRouteSearchDefaults } from '../route-data';
import type { WorkSearch } from '../routing-state';

export const Route = createFileRoute('/work/')({
  validateSearch: (search: Record<string, unknown>) => validateWorkRouteSearch(search),
  search: { middlewares: [stripDynamicSearchDefaults<WorkSearch>(workRouteSearchDefaults)] },
  component: WorkPage,
});
