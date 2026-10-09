import { createFileRoute } from '@tanstack/react-router';
import { WeeklyPlanningPage } from '../weekly-planning-page';

export const Route = createFileRoute('/weekly-planning')({
  component: WeeklyPlanningPage,
});
