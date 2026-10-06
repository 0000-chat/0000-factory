import { createFileRoute } from '@tanstack/react-router';
import { TodayPage } from '../route-pages';
import { stripDynamicSearchDefaults, todayRouteSearchDefaults, validateTodayRouteSearch } from '../route-data';
import type { TodaySearch } from '../routing-state';

export const Route = createFileRoute('/today')({
  validateSearch: (search: Record<string, unknown>) => validateTodayRouteSearch(search),
  search: { middlewares: [stripDynamicSearchDefaults<TodaySearch>(todayRouteSearchDefaults)] },
  component: TodayPage,
});
