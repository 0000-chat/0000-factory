import { createFileRoute } from '@tanstack/react-router';
import { PlansPage } from '../route-pages';
import { plansRouteSearchDefaults, stripDynamicSearchDefaults, validatePlansRouteSearch } from '../route-data';
import type { PlansSearch } from '../routing-state';

export const Route = createFileRoute('/plans/')({
  validateSearch: (search: Record<string, unknown>) => validatePlansRouteSearch(search),
  search: { middlewares: [stripDynamicSearchDefaults<PlansSearch>(plansRouteSearchDefaults)] },
  component: () => <PlansPage />,
});
