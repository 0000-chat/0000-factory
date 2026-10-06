import { createFileRoute } from '@tanstack/react-router';
import { TeamPage } from '../route-pages';
import { stripDynamicSearchDefaults, teamRouteSearchDefaults, validateTeamRouteSearch } from '../route-data';
import type { TeamSearch } from '../routing-state';

export const Route = createFileRoute('/team/$memberSlug')({
  validateSearch: (search: Record<string, unknown>) => validateTeamRouteSearch(search),
  search: { middlewares: [stripDynamicSearchDefaults<TeamSearch>(teamRouteSearchDefaults)] },
  component: function TeamMemberPage() {
    const { memberSlug } = Route.useParams();
    return <TeamPage memberSlug={memberSlug} />;
  },
});
