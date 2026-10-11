import { createFileRoute, redirect } from '@tanstack/react-router';
import { TodayPage } from '../route-pages';
import { stripDynamicSearchDefaults, todayRouteSearchDefaults, validateTodayRouteSearch } from '../route-data';
import type { TodaySearch } from '../routing-state';
import { isTeamProjection } from '../team-mode';
import { parseWorkSearch } from '../routing-state';

export const Route = createFileRoute('/today')({
  beforeLoad: ({ context }) => {
    if (isTeamProjection(context.data)) {
      throw redirect({ to: '/work', search: parseWorkSearch({}), replace: true });
    }
  },
  validateSearch: (search: Record<string, unknown>) => validateTodayRouteSearch(search),
  search: { middlewares: [stripDynamicSearchDefaults<TodaySearch>(todayRouteSearchDefaults)] },
  component: TodayPage,
});
