import { createFileRoute, redirect } from '@tanstack/react-router';
import { WeeklyPlanningPage } from '../weekly-planning-page';
import { parseWorkSearch } from '../routing-state';
import { trackerInstanceConfig } from '../instance-config';

export const Route = createFileRoute('/weekly-planning')({
  beforeLoad: () => {
    if (!trackerInstanceConfig.features.weeklyPlanning) {
      throw redirect({ to: '/work', search: parseWorkSearch({}), replace: true });
    }
  },
  component: WeeklyPlanningPage,
});
