import type { ReactNode } from 'react';
import type { TrackerDecision, TrackerHealth, TrackerHistoryRecord, TrackerItem, TrackerSnapshot, TrackerSource } from '../snapshot';
import type { WorkActivityControls } from '../work-activity-controller';
import type { ParsedTaskContentDraft } from '../task-drafts';
import type { TaskEditController } from '../router-context';
import type { ManagerProjection } from '../work-manager-types';
import type { WorkWeek } from '../work-week';

export type WorkMode = 'tree' | 'table' | 'calendar' | 'kanban' | 'gantt';

export interface WorkViewProps {
  items: TrackerItem[];
  roots: TrackerItem[];
  data: TrackerSnapshot;
  selectedId: string | null;
  onSelectItem: (itemId: string) => void;
  mode: WorkMode;
  onModeChange: (mode: WorkMode) => void;
  externalItems?: TrackerItem[];
  visibleIds?: ReadonlySet<string>;
  contextualIds?: ReadonlySet<string>;
  managerProjection?: ManagerProjection;
  managerEnabled?: boolean;
  workActivity: WorkActivityControls;
  toolbarControls?: ReactNode;
  navigationControls?: ReactNode;
  navigationDate?: string | null;
  selectedWeek?: WorkWeek;
  workflow?: 'standard' | 'this-week' | 'daily-review' | 'next-week';
  onWorkflowChange?: (workflow: 'standard' | 'this-week' | 'daily-review' | 'next-week') => void;
  onWeekChange?: (direction: -1 | 1) => void;
  undatedActiveItems?: TrackerItem[];
  groupByOwner?: boolean;
  onGroupByOwnerChange?: (value: boolean) => void;
  presentationMode?: boolean;
  onPresentationModeChange?: (value: boolean) => void;
}

export interface TodayViewProps {
  items: TrackerItem[];
  decisions: TrackerDecision[];
  selectedItem: TrackerItem | null;
  onSelectItem: (itemId: string) => void;
}

export interface PlansViewProps {
  plans: TrackerSnapshot['plans'];
  data: TrackerSnapshot;
  search: string;
  onSearchChange: (search: string) => void;
  selectedPlanId: string | null;
  onSelectPlan: (planId: string) => void;
  onSelectItem: (itemId: string) => void;
  onOpenWork: (plan: TrackerSnapshot['plans'][number]) => void;
}

export interface TeamViewProps {
  profiles: TrackerSnapshot['team'];
  items: TrackerItem[];
  teamProjection?: boolean;
  memberSlug: string | null;
  search: string;
  onSearchChange: (search: string) => void;
  organizationFilter: string;
  onOrganizationChange: (organization: string) => void;
  onResetFilters: () => void;
  onSelectItem: (itemId: string) => void;
}

export interface ItemDetailSheetProps {
  item: TrackerItem | null;
  history: TrackerHistoryRecord | null;
  data: TrackerSnapshot;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus?: (event: Event) => void;
  onSelectItem: (itemId: string) => void;
  fullPageLink?: ReactNode;
}

export interface ItemPageProps {
  item: TrackerItem | null;
  history: TrackerHistoryRecord | null;
  data: TrackerSnapshot;
  canonicalData: TrackerSnapshot;
  taskDraft: ParsedTaskContentDraft | null;
  taskDrafts: readonly ParsedTaskContentDraft[];
  pendingDraftCount: number;
  taskEdit: TaskEditController;
  renderItemLink?: (itemId: string, label: string) => ReactNode;
  returnLink?: ReactNode;
  readOnly?: boolean;
}

export interface DecisionPageProps {
  decision: TrackerDecision | null;
  data: TrackerSnapshot;
}

export interface BadgeChipProps {
  children: ReactNode;
  tone?: 'slate' | 'blue' | 'green' | 'amber' | 'red';
  className?: string;
}

export interface MarkdownProps {
  value: unknown;
  className?: string;
  resolveLink?: (href: string) => string | null | undefined;
}

export interface ProjectSelectorProps {
  data: TrackerSnapshot;
  scopeId: string | null;
  onChange: (scopeId: string | null) => void;
  label?: string;
  compact?: boolean;
}

export interface VisibilityControlsProps {
  showPlanned?: boolean;
  setShowPlanned?: (value: boolean) => void;
  showDrafts?: boolean;
  setShowDrafts?: (value: boolean) => void;
  showPlannedControl?: boolean;
  showCompleted?: boolean;
  setShowCompleted?: (value: boolean) => void;
  visibleItemCount?: number;
}

export interface AttentionCardProps {
  item: TrackerItem;
  label?: string;
  onSelect: (itemId: string) => void;
}

export interface TodayFocusProps {
  item: TrackerItem | null;
  onSelect: (itemId: string) => void;
}

export interface EmptyInlineProps {
  icon: ReactNode;
  text: string;
}

export interface SnapshotFooterProps {
  source: TrackerSource;
}

export interface HealthSummaryProps {
  health: TrackerHealth | null | undefined;
}
