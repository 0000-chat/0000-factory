import { ArrowLeft, ArrowRight, CalendarDays, Presentation, Users } from 'lucide-react';
import { Button } from './components/ui/button.tsx';
import type { WorkWorkflow } from './routing-state';
import type { WorkWeek, WorkWeekWindow } from './work-week';
import { workWeekLabel } from './work-week';
import './work-week.css';

export type WorkWorkflowSelection = WorkWorkflow | 'standard';

interface WorkWeekControlsProps {
  readonly workflow: WorkWorkflowSelection;
  readonly selectedWeek: WorkWeek;
  readonly focusWindow?: WorkWeekWindow | null;
  readonly onWorkflowChange: (workflow: WorkWorkflowSelection) => void;
  readonly onWeekChange: (direction: -1 | 1) => void;
  readonly groupByOwner: boolean;
  readonly onGroupByOwnerChange: (value: boolean) => void;
  readonly presentationMode: boolean;
  readonly onPresentationModeChange: (value: boolean) => void;
}

const WORKFLOWS: ReadonlyArray<{ value: WorkWorkflow; label: string; description: string }> = [
  { value: 'this-week', label: 'This week', description: 'Scheduled accepted work and active undated commitments.' },
  { value: 'daily-review', label: 'Daily review', description: 'Evidence attention, blockers, and unknown current work.' },
  { value: 'next-week', label: 'Next week planning', description: 'Candidate queue and the recorded next-week schedule.' },
];

export function WorkWeekControls({
  workflow,
  selectedWeek,
  focusWindow,
  onWorkflowChange,
  onWeekChange,
  groupByOwner,
  onGroupByOwnerChange,
  presentationMode,
  onPresentationModeChange,
}: WorkWeekControlsProps) {
  return <section className="work-week-controls" aria-label="Work workflow and week">
    <div className="work-workflow-selector" role="group" aria-label="Work workflow">
      {WORKFLOWS.map(option => <Button
        key={option.value}
        className="work-workflow-option"
        size="sm"
        variant={workflow === option.value ? 'secondary' : 'ghost'}
        aria-pressed={workflow === option.value}
        title={option.description}
        onClick={() => onWorkflowChange(option.value)}
      >{option.label}</Button>)}
    </div>
    <div className="work-week-actions">
      <Button className="work-week-nav" size="sm" variant="outline" aria-label="Previous week" title="Previous week" onClick={() => onWeekChange(-1)}>
        <ArrowLeft size={15} aria-hidden="true" />
      </Button>
      <span className="work-week-label"><CalendarDays size={15} aria-hidden="true" /><span>{workWeekLabel(selectedWeek)}{focusWindow ? <small>4-week context · {focusWindow.start}–{focusWindow.end}</small> : null}</span></span>
      <Button className="work-week-nav" size="sm" variant="outline" aria-label="Next week" title="Next week" onClick={() => onWeekChange(1)}>
        <ArrowRight size={15} aria-hidden="true" />
      </Button>
      <Button
        className="work-week-toggle"
        size="sm"
        variant={groupByOwner ? 'secondary' : 'outline'}
        aria-pressed={groupByOwner}
        onClick={() => onGroupByOwnerChange(!groupByOwner)}
      ><Users size={15} aria-hidden="true" />Group by owner</Button>
      <Button
        className="work-week-toggle"
        size="sm"
        variant={presentationMode ? 'secondary' : 'outline'}
        aria-pressed={presentationMode}
        onClick={() => onPresentationModeChange(!presentationMode)}
      ><Presentation size={15} aria-hidden="true" />Present</Button>
    </div>
  </section>;
}
