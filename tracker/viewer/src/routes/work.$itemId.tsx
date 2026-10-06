import { createFileRoute } from '@tanstack/react-router';
import { WorkItemPage } from '../route-pages';

export const Route = createFileRoute('/work/$itemId')({
  component: function WorkItemRoute() {
    const { itemId } = Route.useParams();
    return <WorkItemPage itemId={itemId} />;
  },
});
