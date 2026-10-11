import { createFileRoute, redirect } from '@tanstack/react-router';
import { DecisionItemPage } from '../route-pages';
import { parseWorkSearch } from '../routing-state';
import { isTeamProjection } from '../team-mode';

export const Route = createFileRoute('/decisions/$decisionId')({
  beforeLoad: ({ context }) => {
    if (isTeamProjection(context.data)) {
      throw redirect({ to: '/work', search: parseWorkSearch({}), replace: true });
    }
  },
  component: function DecisionRoute() {
    const { decisionId } = Route.useParams();
    return <DecisionItemPage decisionId={decisionId} />;
  },
});
