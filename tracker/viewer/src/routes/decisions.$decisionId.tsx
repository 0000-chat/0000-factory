import { createFileRoute } from '@tanstack/react-router';
import { DecisionItemPage } from '../route-pages';

export const Route = createFileRoute('/decisions/$decisionId')({
  component: function DecisionRoute() {
    const { decisionId } = Route.useParams();
    return <DecisionItemPage decisionId={decisionId} />;
  },
});
