import { createFileRoute, redirect } from '@tanstack/react-router';
import { parseWorkSearch } from '../routing-state';

export const Route = createFileRoute('/')({
  beforeLoad: () => {
    throw redirect({ to: '/work', search: parseWorkSearch({}), replace: true });
  },
});
