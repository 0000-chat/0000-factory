import { createFileRoute, redirect } from '@tanstack/react-router';
import { PlansPage } from '../route-pages';
import { plansRouteSearchDefaults, stripDynamicSearchDefaults, validatePlansRouteSearch } from '../route-data';
import { parseWorkSearch, type PlansSearch } from '../routing-state';
import { isTeamProjection } from '../team-mode';

export const Route = createFileRoute('/plans/$planId')({
  beforeLoad: ({ context }) => {
    if (isTeamProjection(context.data)) {
      throw redirect({ to: '/work', search: parseWorkSearch({}), replace: true });
    }
  },
  validateSearch: (search: Record<string, unknown>) => validatePlansRouteSearch(search),
  search: { middlewares: [stripDynamicSearchDefaults<PlansSearch>(plansRouteSearchDefaults)] },
  component: function PlanPage() {
    const { planId } = Route.useParams();
    return <PlansPage selectedPlanId={planId} />;
  },
});
