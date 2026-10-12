import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  CalendarDays,
  ChevronDown,
  ChevronRight,
  Maximize2,
  Minimize2,
  RotateCcw,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { Button } from './components/ui/button.tsx';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from './components/ui/dialog.tsx';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from './components/ui/tooltip.tsx';
import {
  GanttFeatureList,
  GanttFeatureListGroup,
  GanttFeatureRow,
  GanttHeader,
  GanttProvider,
  GanttSidebar,
  GanttSidebarGroup,
  GanttTimeline,
  GanttMarker,
  useGantt,
} from './components/kibo-ui/gantt/index.tsx';
import {
  WorkActivityIndicator,
  WorkActivitySummary,
  WorkOwnership,
} from './work-activity-ui.jsx';
import { WorkManagerRowMetadata } from './work-manager-controls';
import {
  buildWorkGanttModel,
  addCalendarDay,
  clampGanttZoom,
  chartDateForDay,
  directMarksForWorkEntry,
  fitZoomForGanttDateRange,
  formatGanttZoom,
  ganttDateTickInterval,
  groupWorkGanttRowsByOwner,
  GANTT_DEFAULT_ZOOM,
  GANTT_DAILY_COLUMN_WIDTH,
  GANTT_FIT_PADDING_DAYS,
  GANTT_SELECTED_WEEK_PADDING_DAYS,
  GANTT_MAX_ZOOM,
  GANTT_MIN_ZOOM,
  GANTT_ZOOM_STEP,
  marksForWorkEntry,
  hasForecastMarks,
  manilaTodayForChart,
  paddedGanttDateRange,
  primaryWorkMark,
  proposedEnvelopeLabel,
  shortWorkDate,
  selectedWeekGanttDateRange,
  workGanttFitDateRange,
  workGanttDepthExpansion,
  workMarkDescription,
} from './work-gantt-model.mjs';
import {
  WORK_GANTT_ROW_HEIGHT,
  placeWorkGanttRollups,
} from './work-gantt-layout.mjs';
import { WorkGanttDependencies } from './work-gantt-dependencies.jsx';
import { WorkGanttInvestigation } from './work-gantt-investigation.jsx';
import { getWorkDateDetails } from './work-schedule-labels.mjs';
import { trackerInstanceConfig } from './instance-config';
import './work-gantt.css';

const UNSCHEDULED_COLLAPSED_STORAGE_KEY = trackerInstanceConfig.browser.unscheduledCollapsedKey;
const GANTT_INITIAL_LOOKBACK_DAYS = 3;
const EMPTY_MAP = new Map();
const EMPTY_SET = new Set();
const EXPANSION_LEVELS = [1, 2, 3, 'all'];
const PARTIAL_APPROVED_HELP = 'Some work in this schedule has missing or incomplete approved dates.';

function WorkGanttTooltip({ label, children }) {
  return <Tooltip>
    <TooltipTrigger asChild>{children}</TooltipTrigger>
    <TooltipContent side="top" sideOffset={6} className="work-gantt-tooltip">{label}</TooltipContent>
  </Tooltip>;
}

function rowStatusLabel(entry) {
  if (entry.completed) return 'Done';
  const words = String(entry.status ?? 'Unknown').replace(/[-_]+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : 'Unknown';
}

function attentionDetails(reason, entry) {
  switch (reason) {
    case 'blocked': return { label: 'Blocked', tone: 'red' };
    case 'quiet': return { label: 'Quiet', tone: 'amber' };
    case 'overdue': {
      const age = entry.timeline.overdueCalendarDays;
      return age > 0 ? { label: `${age} calendar days overdue`, tone: 'amber' } : null;
    }
    case 'missing-evidence': return { label: 'No activity recorded', tone: 'slate' };
    default: return null;
  }
}

function readUnscheduledCollapsed() {
  try {
    return window.localStorage.getItem(UNSCHEDULED_COLLAPSED_STORAGE_KEY) !== 'false';
  } catch {
    return true;
  }
}

function activityMotionRange(entry, mark, collapsed) {
  if (entry.completed || entry.own.state !== 'recent') {
    if (!collapsed || entry.completed || entry.descendants.recentIds.length === 0) return null;
  }

  // Collapsed rows summarize descendant movement across their rolled range.
  // Expanded rows keep the rollup bar but animate only the row's own evidence.
  if (collapsed) return { left: 0, width: 100 };

  const start = entry.own.firstDate;
  const end = entry.own.lastDate;
  if (!start || !end || start < mark.startDay || end > mark.endDay || start > end) return null;
  const ordinal = day => {
    const [year, month, date] = day.split('-').map(Number);
    return Math.floor(Date.UTC(year, month - 1, date) / 86400000);
  };
  const fullDays = ordinal(mark.endDay) - ordinal(mark.startDay) + 1;
  if (fullDays <= 0) return null;
  const first = ordinal(start) - ordinal(mark.startDay);
  const last = ordinal(end) - ordinal(mark.startDay) + 1;
  return {
    left: (first / fullDays) * 100,
    width: ((last - first) / fullDays) * 100,
  };
}

function ganttTimelineKey(timelineData) {
  const months = (timelineData ?? []).flatMap(year => (year?.quarters ?? []).flatMap(quarter => quarter?.months ?? []));
  const first = months[0];
  const last = months.at(-1);
  const firstYear = timelineData?.[0]?.year;
  const lastYear = timelineData?.at(-1)?.year;
  return `${firstYear ?? ''}-${first?.month ?? ''}:${lastYear ?? ''}-${last?.month ?? ''}`;
}

function extendDateRangeToAnchor(dateRange, anchor) {
  if (!dateRange || !anchor) return dateRange;
  const anchorMonthStart = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const anchorMonthEnd = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
  const startAt = anchorMonthStart < dateRange.startAt ? anchorMonthStart : dateRange.startAt;
  const endAt = anchorMonthEnd > dateRange.endAt ? anchorMonthEnd : dateRange.endAt;
  return startAt === dateRange.startAt && endAt === dateRange.endAt
    ? dateRange
    : { startAt, endAt };
}

// The legacy chart rendered daily cells at provider zoom 60. Keep that
// physical density while presenting 100% as the neutral UI zoom.
const GANTT_PROVIDER_ZOOM_SCALE = 0.6;

function dayOrdinal(day) {
  if (typeof day !== 'string') return null;
  const parts = day.split('-').map(Number);
  if (parts.length !== 3 || parts.some(part => !Number.isFinite(part))) return null;
  return Math.floor(Date.UTC(parts[0], parts[1] - 1, parts[2]) / 86400000);
}

function dateDayKey(date) {
  if (!(date instanceof Date) || !Number.isFinite(date.valueOf())) return null;
  return [
    String(date.getFullYear()).padStart(4, '0'),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

function timelineStartDay(timelineData) {
  const firstYear = timelineData?.[0]?.year;
  const firstMonth = timelineData?.[0]?.quarters?.flatMap(quarter => quarter?.months ?? [])?.[0]?.month;
  if (!Number.isFinite(firstYear) || !Number.isFinite(firstMonth)) return null;
  return dateDayKey(new Date(firstYear, firstMonth, 1));
}

function dayWidth(mark, pixelsPerDay) {
  const start = dayOrdinal(mark?.startDay);
  const end = dayOrdinal(mark?.endDay);
  if (start === null || end === null || end < start) return 0;
  return (end - start + 1) * pixelsPerDay;
}

function dayLeft(mark, startDay, pixelsPerDay) {
  const start = dayOrdinal(mark?.startDay);
  const origin = dayOrdinal(startDay);
  if (start === null || origin === null) return null;
  return (start - origin) * pixelsPerDay;
}

function workGanttRangeLabel(mark) {
  if (!mark?.startDay || !mark?.endDay) return 'Dates incomplete';
  const start = shortWorkDate(mark.startDay);
  const end = shortWorkDate(mark.endDay);
  return start === end ? start : `${start}–${end}`;
}

function sameIdsWithin(controlledIds, expandedIds, currentIds) {
  for (const id of controlledIds) {
    if (currentIds.has(id) !== expandedIds.has(id)) return false;
  }
  return true;
}

function rowHighlight(row, activeId, relatedIds, selectedId) {
  if (row.id === activeId) return 'active';
  if (relatedIds.has(row.id)) return 'related';
  if (row.id === selectedId) return 'selected';
  return 'none';
}

function workGanttInteractionLane() {
  // Every source shares one centered Kibo row so bar thickness never varies
  // with source kind, parent state, or overlap count.
  return { index: 0, count: 1 };
}

function accessibleMarkDescription(mark) {
  const description = workMarkDescription(mark);
  return mark?.sourceKind === 'approved' && mark.partial
    ? `${description} · ${PARTIAL_APPROVED_HELP}`
    : description;
}

function scrollLimit(scrollElement) {
  return Math.max(0, scrollElement.scrollWidth - scrollElement.clientWidth);
}

function ganttViewport(scrollElement) {
  if (!scrollElement) return null;
  const sidebar = scrollElement.querySelector('[data-roadmap-ui="gantt-sidebar"]');
  const sidebarRect = sidebar?.getBoundingClientRect();
  const sidebarVisible = Boolean(sidebar && ((sidebar.getClientRects?.().length ?? 0) > 0 || (sidebarRect?.width ?? 0) > 0));
  const sidebarWidth = sidebarVisible ? (sidebarRect?.width || 300) : 0;
  const viewportWidth = Math.max(0, scrollElement.clientWidth - sidebarWidth);
  return { sidebarWidth, viewportWidth };
}

function WorkGanttZoomControls({ zoom, onZoomOut, onZoomIn, onZoomChange, onReset, onFitAll, canFitAll, onFitFocusWindow, canFitFocusWindow, onFitSelectedWeek, canFitSelectedWeek, compact = false }) {
  const zoomLabel = formatGanttZoom(zoom);
  const handleSliderKeyDown = event => {
    const isArrow = event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'ArrowUp' || event.key === 'ArrowDown';
    const isPage = event.key === 'PageUp' || event.key === 'PageDown';
    if (!isArrow && !isPage) return;
    event.preventDefault();
    const direction = event.key === 'ArrowLeft' || event.key === 'ArrowDown' || event.key === 'PageDown' ? -1 : 1;
    const increment = isPage ? 10 : zoom < 1 ? GANTT_ZOOM_STEP : 1;
    onZoomChange(zoom + direction * increment);
  };
  return <div className="work-gantt-zoom-controls" aria-label="Gantt zoom controls">
    <Button
      size="sm"
      variant="outline"
      type="button"
      aria-label="Zoom out"
      title="Zoom out"
      disabled={zoom <= GANTT_MIN_ZOOM}
      onClick={onZoomOut}
    ><ZoomOut size={14} aria-hidden="true" /></Button>
    <label className="work-gantt-zoom-slider">
      <span className="sr-only">Zoom level</span>
      <input
        type="range"
        min={GANTT_MIN_ZOOM}
        max={GANTT_MAX_ZOOM}
        step={GANTT_ZOOM_STEP}
        value={zoom}
        aria-label="Zoom level"
        aria-valuetext={zoomLabel}
        onKeyDown={handleSliderKeyDown}
        onChange={event => onZoomChange(event.target.value)}
      />
      <output aria-live="polite">{zoomLabel}</output>
    </label>
    <Button
      size="sm"
      variant="outline"
      type="button"
      aria-label="Zoom in"
      title="Zoom in"
      disabled={zoom >= GANTT_MAX_ZOOM}
      onClick={onZoomIn}
    ><ZoomIn size={14} aria-hidden="true" /></Button>
    {compact ? null : <Button size="sm" variant="outline" type="button" onClick={onReset} title="Reset zoom to 100%">
      <RotateCcw size={14} aria-hidden="true" />Reset
    </Button>}
    {compact ? null : <Button size="sm" variant="outline" type="button" onClick={onFitAll} disabled={!canFitAll} title="Fit all visible dated work">
      Fit all
    </Button>}
    {onFitFocusWindow ? <Button className="work-gantt-fit-context" size="sm" variant="default" type="button" onClick={onFitFocusWindow} disabled={!canFitFocusWindow} title="Fit the four-week meeting context">
      Fit 4 weeks
    </Button> : null}
    {onFitSelectedWeek ? <Button size="sm" variant="outline" type="button" onClick={onFitSelectedWeek} disabled={!canFitSelectedWeek} title="Fit the selected Monday to Friday week">
      Fit selected week
    </Button> : null}
  </div>;
}

function WorkGanttInitialPosition({ feature, navigationDate = null }) {
  const gantt = useGantt();
  const positioned = useRef(null);
  const timelineKey = ganttTimelineKey(gantt.timelineData);
  const positionKey = feature
    ? [feature.id, feature.startAt.valueOf(), navigationDate ?? 'feature', timelineKey].join(':')
    : null;

  useEffect(() => {
    const scrollElement = gantt.ref?.current;
    if (!feature || !positionKey || positioned.current === positionKey || !scrollElement?.clientWidth || !gantt.sidebarWidth) return undefined;
    let frame = 0;
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        if (positioned.current === positionKey) return;
        gantt.scrollToFeature(feature, { behavior: 'instant' });
        if (navigationDate) {
          // The scroll target has no rendered mark, so leave a small gap after
          // the fixed sidebar using the chart's date coordinate directly.
          scrollElement.scrollTo({ left: Math.max(0, scrollElement.scrollLeft - 8), behavior: 'instant' });
        } else {
          const sidebar = scrollElement.querySelector('[data-roadmap-ui="gantt-sidebar"]');
          const anchor = [...scrollElement.querySelectorAll('.gantt-feature-button')]
            .find(button => button.getAttribute('data-feature-id') === feature.id);
          const sidebarRight = sidebar?.getBoundingClientRect().right;
          const anchorLeft = anchor?.getBoundingClientRect().left;
          if (Number.isFinite(sidebarRight) && Number.isFinite(anchorLeft)) {
            const targetLeft = sidebarRight + 8;
            const nextScrollLeft = Math.max(0, scrollElement.scrollLeft + anchorLeft - targetLeft);
            scrollElement.scrollTo({ left: nextScrollLeft, behavior: 'instant' });
          }
        }
        positioned.current = positionKey;
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [feature, gantt.ref, gantt.scrollToFeature, gantt.sidebarWidth, positionKey]);

  return null;
}

function WorkGanttOwnerGroupRow({ row }) {
  return <div
    className="work-gantt-owner-group-row"
    data-owner-group-id={row.ownerGroupKey}
    data-work-row-id={row.id}
    data-contextual="true"
    aria-label={`${row.ownerGroupLabel} · ${row.ownerGroupCount} work item${row.ownerGroupCount === 1 ? '' : 's'}`}
  >
    <span className="work-gantt-owner-group-label">{row.ownerGroupLabel}</span>
    <span className="work-gantt-owner-group-count">{row.ownerGroupCount} work item{row.ownerGroupCount === 1 ? '' : 's'}</span>
  </div>;
}

function WorkGanttSidebarRow({
  row,
  item,
  data,
  selectedId,
  activeId,
  relatedIds,
  onSelect,
  onHover,
  onFocus,
  onBlur,
  toggleExpanded,
  workActivity,
  showActivity,
  managerProjection,
  managerEnabled,
}) {
  const { entry } = row;
  const title = item?.title ?? entry.title;
  const contextual = row.contextual === true || item?.contextOnly === true;
  const itemKind = String(item?.type ?? item?.data?.type ?? '').toLowerCase();
  const kindLabel = itemKind === 'project' ? 'Project' : itemKind === 'workstream' ? 'Workstream' : null;
  const summaryLabel = row.hasChildren
    ? entry.timeline.partial ? 'Partial summary' : 'Summary'
    : entry.timeline.partial ? 'Partial plan' : null;
  const attentionFilter = workActivity?.activityFilter === 'attention';
  const reasons = attentionFilter && !row.contextual
    ? entry.attentionReasons.map(reason => attentionDetails(reason, entry)).filter(Boolean)
    : [];
  if (!reasons.some(reason => reason.tone === 'amber' && reason.label.includes('calendar days overdue'))
    && entry.timeline.overdueCalendarDays > 0) {
    reasons.push(attentionDetails('overdue', entry));
  }
  const status = contextual ? null : rowStatusLabel(entry);
  const inferred = row.marks.some(mark => mark.sourceKind === 'approved' && mark.inferred);
  const highlight = rowHighlight(row, activeId, relatedIds, selectedId);
  const childSummary = `Direct children · ${row.eligibleChildCount ?? 0} eligible · ${row.undatedChildCount ?? 0} undated`;

  return <div
    className={'work-gantt-sidebar-row' + (highlight === 'selected' ? ' is-selected' : '') + (row.collapsed ? ' is-collapsed' : '')}
    data-item-id={row.id}
    data-depth={row.depth}
    data-highlight={highlight}
    data-contextual={row.contextual ? 'true' : undefined}
    data-summary-partial={entry.timeline.partial ? 'true' : undefined}
    onPointerEnter={event => onHover(row.id, event)}
    onFocusCapture={event => onFocus(row.id, event)}
    onBlurCapture={onBlur}
  >
    <span className="work-gantt-tree-guides" aria-hidden="true" style={{ width: `${row.depth * 20}px` }}>
      {(row.ancestorIds ?? []).map((ancestorId, index) => <span
        className="work-gantt-tree-guide"
        key={`${ancestorId}-${index}`}
        style={{ left: `${index * 20}px` }}
        data-continuation={row.ancestorContinuation?.[index] ? 'true' : 'false'}
        data-current={index === row.depth - 1 ? 'true' : undefined}
      />)}
    </span>
    {row.canExpand
      ? <button
        className="work-gantt-expander"
        type="button"
        aria-label={(row.collapsed ? 'Expand ' : 'Collapse ') + title}
        title={childSummary}
        aria-expanded={!row.collapsed}
        onClick={() => toggleExpanded(row.id)}
      >{row.collapsed ? <ChevronRight size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}</button>
      : <span className="work-gantt-expander-spacer" aria-hidden="true" />}
    <div className="work-gantt-row-main">
      <WorkGanttTooltip label={title}>
        <button
          className="work-gantt-title-button"
          type="button"
          aria-label={'Open details for ' + title}
          aria-current={selectedId === row.id ? 'true' : undefined}
          onClick={() => onSelect(row.id)}
        >
          {item?.referenceCode ? <code className="work-reference-code work-gantt-reference-code">{item.referenceCode}</code> : null}
          <span className="work-gantt-title">{title}</span>
          {kindLabel ? <span className="work-gantt-kind" title={`Work kind · ${kindLabel}`}>{kindLabel}</span> : null}
          <span className="work-gantt-title-meta">
            {status ? <span className="work-gantt-row-meta work-gantt-status" title={'Lifecycle status · ' + status}>{status}</span> : null}
            {contextual ? <span className="work-gantt-row-meta">Context</span> : kindLabel ? <span className="work-gantt-row-meta" title={`Work kind · ${kindLabel}`}>{kindLabel}</span> : summaryLabel ? <span className="work-gantt-row-meta" title={summaryLabel}>{summaryLabel}</span> : null}
            {row.ownerContextLabel ? <span className="work-gantt-row-meta work-gantt-owner-context" title={`Hierarchy context · ${row.ownerContextLabel}`}>In {row.ownerContextLabel}</span> : null}
            {entry.timeline.partial ? <span className="work-gantt-row-meta work-gantt-partial-badge" title={PARTIAL_APPROVED_HELP} aria-label={PARTIAL_APPROVED_HELP}>Partial dates</span> : null}
            {inferred ? <span className="work-gantt-row-meta work-gantt-inferred-badge" title="Approved display start is inferred from recorded evidence">Inferred start</span> : null}
            {reasons.map((reason, index) => <span
              className={'work-gantt-reason work-gantt-reason-' + reason.tone}
              key={reason.label + '-' + index}
              title={reason.label}
              aria-label={reason.label}
            >{reason.label}</span>)}
          </span>
        </button>
      </WorkGanttTooltip>
      <div className="work-gantt-row-details">
        {contextual ? null : <div className="work-gantt-row-ownership">
          <WorkOwnership item={item ?? entry} data={data} entry={entry} collapsed={row.collapsed} showName size="sm" assignment />
        </div>}
        {showActivity ? <div className="work-gantt-row-activity" aria-label="Activity summary">
          <WorkActivityIndicator entry={entry} evidence={data?.activityEvidence} projection={workActivity.projection} collapsed={row.collapsed} paused={workActivity.animationsPaused} />
          {row.hasChildren ? <WorkActivitySummary entry={entry} evidence={data?.activityEvidence} projection={workActivity.projection} compact /> : null}
        </div> : null}
      </div>
      <div className="work-gantt-row-manager">
        <WorkManagerRowMetadata
          entry={managerProjection?.byId?.get(row.id)}
          people={data?.people ?? []}
          itemTitle={title}
          enabled={managerEnabled}
          compact
        />
        {row.collapsed && row.hasChildren ? <WorkGanttTooltip label={childSummary}>
          <span
            className="work-gantt-child-count"
            title={childSummary}
            aria-label={childSummary}
            role="img"
            tabIndex={0}
          >{String(row.eligibleChildCount ?? 0) + ' children · ' + String(row.undatedChildCount ?? 0) + ' without approved dates'}</span>
        </WorkGanttTooltip> : null}
      </div>
    </div>
  </div>;
}

function WorkGanttUnscheduledList({ ids, data, projection, onSelect }) {
  const [collapsed, setCollapsed] = useState(readUnscheduledCollapsed);
  useEffect(() => {
    try {
      window.localStorage.setItem(UNSCHEDULED_COLLAPSED_STORAGE_KEY, String(collapsed));
    } catch {
      // Keep this small display preference local when storage is available.
    }
  }, [collapsed]);

  if (!ids.length) return null;
  return <section className={'unscheduled-list' + (collapsed ? ' is-collapsed' : '')} aria-labelledby="work-gantt-unscheduled-heading">
    <div className="unscheduled-list-header">
      <div className="unscheduled-list-heading">
        <h3 id="work-gantt-unscheduled-heading">Work without plan dates</h3>
        <span>{ids.length} item{ids.length === 1 ? '' : 's'} without approved, proposed, or forecast plan dates</span>
      </div>
      <button className="unscheduled-list-toggle" type="button" aria-expanded={!collapsed} aria-controls="work-gantt-unscheduled-items" onClick={() => setCollapsed(value => !value)}>
        <ChevronRight size={15} aria-hidden="true" /><span>{collapsed ? 'Expand' : 'Collapse'}</span>
      </button>
    </div>
    {collapsed ? null : <div id="work-gantt-unscheduled-items" className="work-gantt-unscheduled-items">
      {ids.map(id => {
        const item = data?.itemById?.get(id);
        const title = item?.title ?? projection.get(id)?.title ?? id;
        return <button className="work-gantt-unscheduled-item" key={id} type="button" onClick={() => onSelect(id)}>{title}</button>;
      })}
    </div>}
  </section>;
}

function WorkGanttDeadlines({ releases = [] }) {
  const known = releases.filter(release => release?.target && release.target !== 'unknown');
  if (!known.length) return null;
  return <div className="deadline-markers" aria-label="Known release deadlines">
    {known.map(release => <div className="deadline-marker" key={release.id}>
      <CalendarDays size={14} aria-hidden="true" />
      <span><strong>{release.title}</strong><small>Known target · {release.target}</small></span>
    </div>)}
  </div>;
}

function agendaDate(mark) {
  if (mark.point) return 'due ' + shortWorkDate(mark.endDay);
  const start = shortWorkDate(mark.startDay);
  const end = shortWorkDate(mark.endDay);
  return start === end ? start : start + '–' + end;
}

function WorkGanttMobileAgenda({ rows, data, onSelect, showForecast, showActivity }) {
  const eligibleRows = rows.map(row => {
    const marks = row.marks.filter(mark => (showActivity || mark.sourceKind !== 'observed') && (showForecast || mark.sourceKind !== 'forecast'));
    return { ...row, marks, primary: primaryWorkMark(marks) };
  }).filter(row => row.primary);
  if (!eligibleRows.length) return null;
  const names = { approved: 'Approved', observed: 'Observed', proposed: 'Proposed', forecast: 'Forecast' };

  return <div className="mobile-schedule-agenda" aria-label="Work schedule agenda">
    {eligibleRows.map(row => {
      const item = data?.itemById?.get(row.id) ?? row.entry;
      const title = item?.title ?? row.entry.title;
      const dateDetails = row.marks.map(mark => names[mark.sourceKind] + ' · ' + agendaDate(mark)).join(' · ');
      return <button
        className={'agenda-row' + (row.primary.sourceKind === 'approved' ? ' agenda-baseline' : '')}
        key={row.id}
        type="button"
        aria-label={'Open details for ' + title + ' · ' + dateDetails}
        onClick={() => onSelect(row.id)}
      >
        <span className="agenda-copy">
          <strong>{names[row.primary.sourceKind]} · {title}</strong>
          <small>{dateDetails}</small>
        </span>
      </button>;
    })}
  </div>;
}

function observedOverrunRange(mark, pixelsPerDay) {
  if (!mark.observedOverrun || !mark.dueDay) return null;
  const firstOverrunDay = addCalendarDay(mark.dueDay);
  if (!firstOverrunDay || firstOverrunDay > mark.endDay) return null;
  const ordinal = day => {
    const [year, month, date] = day.split('-').map(Number);
    return Math.floor(Date.UTC(year, month - 1, date) / 86400000);
  };
  const totalDays = ordinal(mark.endDay) - ordinal(mark.startDay) + 1;
  if (totalDays <= 0) return null;
  const firstIndex = Math.max(0, ordinal(firstOverrunDay) - ordinal(mark.startDay));
  return {
    left: firstIndex * pixelsPerDay,
    width: (totalDays - firstIndex) * pixelsPerDay,
  };
}

function WorkGanttTimeline({
  rows,
  data,
  projection,
  dependencyEdges,
  selectedId,
  activeId,
  relatedIds,
  onSelect,
  toggleExpanded,
  workActivity,
  managerProjection,
  managerEnabled,
  onHover,
  onFocus,
  onBlur,
  onPointerIntent,
  onClearHover,
  dateRange,
  selectedWeek,
  focusWindow = null,
  groupByOwner = false,
  itemsById = new Map(),
  presentationMode = false,
  showForecast,
  showActivity,
  initialFeature,
  navigationDate,
  showAllDependencies,
  zoom,
  onZoomChange,
  className = '',
}) {
  const today = manilaTodayForChart();
  const sourceRows = groupByOwner ? groupWorkGanttRowsByOwner(rows, itemsById) : rows;
  const displayedRows = sourceRows.map(row => {
    const sourceMarks = row.hasChildren
      ? directMarksForWorkEntry(row.entry)
      : row.marks.slice();
    // Parent proposed ranges compete with the approved parent/child tracks in
    // the compact schedule. They remain available through the full work
    // details surface while the default chart stays approved-focused.
    const marks = sourceMarks.filter(mark => !row.hasChildren || mark.sourceKind !== 'proposed' || mark.acceptedProposal === true);
    const visibleMarks = marks.filter(mark => (showActivity || mark.sourceKind !== 'observed') && (showForecast || mark.sourceKind !== 'forecast'));
    const collapsedChildEnvelopes = row.collapsed && row.hasChildren
      ? [row.childApprovedEnvelope, row.childProposedEnvelope, showActivity ? row.childObservedEnvelope : null].filter(Boolean)
      : [];
    const summaryMarks = collapsedChildEnvelopes.flatMap(envelope => envelope.marks ?? []);
    const visibleSummaryMarks = summaryMarks
        .filter(mark => (showActivity || mark.sourceKind !== 'observed') && (showForecast || mark.sourceKind !== 'forecast'))
        .filter(mark => mark.sourceKind !== 'proposed' || mark.acceptedProposal === true);
    return {
      ...row,
      marks: visibleMarks,
      fitMarks: [...visibleMarks, ...visibleSummaryMarks],
      primaryMark: primaryWorkMark(visibleMarks),
    };
  });
  const selectedWeekRange = useMemo(
    () => selectedWeekGanttDateRange(selectedWeek),
    [selectedWeek?.start, selectedWeek?.end],
  );
  const focusWindowRange = useMemo(
    () => selectedWeekGanttDateRange(focusWindow),
    [focusWindow?.start, focusWindow?.end],
  );
  const canFitAll = displayedRows.some(row => row.fitMarks.length > 0);
  const canFitSelectedWeek = Boolean(selectedWeekRange);
  const shellRef = useRef(null);
  const zoomRef = useRef(zoom);
  const pendingScrollRef = useRef(null);
  zoomRef.current = zoom;

  const applyPendingScroll = useCallback(() => {
    const pending = pendingScrollRef.current;
    if (!pending || typeof window === 'undefined') return;
    pendingScrollRef.current = null;
    const apply = () => {
      const scrollElement = shellRef.current?.querySelector('.gantt');
      if (!scrollElement) return;
      const left = Math.min(Math.max(0, pending.left), scrollLimit(scrollElement));
      scrollElement.scrollLeft = left;
    };
    apply();
    window.requestAnimationFrame(apply);
  }, []);

  useEffect(() => {
    const pending = pendingScrollRef.current;
    if (!pending || pending.zoom !== zoom) return undefined;
    applyPendingScroll();
    return undefined;
  }, [applyPendingScroll, zoom]);

  const changeZoom = useCallback((value, { preserveCenter = true, targetLeft = null } = {}) => {
    const currentZoom = zoomRef.current;
    const nextZoom = clampGanttZoom(value);
    const scrollElement = shellRef.current?.querySelector('.gantt');
    const viewport = ganttViewport(scrollElement);

    if (targetLeft !== null && Number.isFinite(targetLeft)) {
      pendingScrollRef.current = { zoom: nextZoom, left: targetLeft };
    } else if (preserveCenter && scrollElement && viewport?.viewportWidth > 0 && currentZoom > 0 && nextZoom !== currentZoom) {
      const centerOffset = scrollElement.scrollLeft + viewport.viewportWidth / 2;
      pendingScrollRef.current = {
        zoom: nextZoom,
        left: centerOffset * (nextZoom / currentZoom) - viewport.viewportWidth / 2,
      };
    }

    if (nextZoom === currentZoom) {
      if (pendingScrollRef.current) applyPendingScroll();
      return;
    }
    onZoomChange(nextZoom);
  }, [applyPendingScroll, onZoomChange]);

  const fitRange = useCallback((range, paddingDays = GANTT_FIT_PADDING_DAYS) => {
    if (!range) return;
    const padded = paddedGanttDateRange(range.startDay, range.endDay, paddingDays);
    const scrollElement = shellRef.current?.querySelector('.gantt');
    const viewport = ganttViewport(scrollElement);
    const timelineStartDay = dateDayKey(dateRange?.startAt);
    const timelineStartOrdinal = dayOrdinal(timelineStartDay);
    const paddedStartOrdinal = dayOrdinal(padded?.startDay);
    if (!padded || !viewport || viewport.viewportWidth <= 0 || timelineStartOrdinal === null || paddedStartOrdinal === null) return;

    const fitZoom = fitZoomForGanttDateRange(
      range.startDay,
      range.endDay,
      viewport.viewportWidth,
      GANTT_DAILY_COLUMN_WIDTH,
      paddingDays,
    );
    if (fitZoom === null) return;
    const targetLeft = (paddedStartOrdinal - timelineStartOrdinal)
      * GANTT_DAILY_COLUMN_WIDTH * fitZoom / 100;
    changeZoom(fitZoom, { preserveCenter: false, targetLeft });
  }, [changeZoom, dateRange]);

  const fitAll = useCallback(() => {
    const datedMarks = displayedRows.flatMap(row => row.fitMarks).filter(mark => mark?.startDay && mark?.endDay);
    const fitDays = datedMarks.flatMap(mark => [mark.startDay, mark.endDay]);
    if (!fitDays.length) return;
    const startDay = fitDays.reduce((earliest, day) => day < earliest ? day : earliest, fitDays[0]);
    const endDay = fitDays.reduce((latest, day) => day > latest ? day : latest, fitDays[0]);
    fitRange(workGanttFitDateRange({ startDay, endDay }));
  }, [displayedRows, fitRange]);

  const fitSelectedWeek = useCallback(() => fitRange(selectedWeekRange, GANTT_SELECTED_WEEK_PADDING_DAYS), [fitRange, selectedWeekRange]);
  const fitFocusWindow = useCallback(
    () => fitRange(focusWindowRange ?? selectedWeekRange, focusWindowRange ? GANTT_FIT_PADDING_DAYS : GANTT_SELECTED_WEEK_PADDING_DAYS),
    [fitRange, focusWindowRange, selectedWeekRange],
  );

  useEffect(() => {
    if (!focusWindowRange && !selectedWeekRange) return undefined;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => fitFocusWindow());
    });
    return () => cancelAnimationFrame(frame);
  }, [fitFocusWindow, focusWindowRange?.startDay, focusWindowRange?.endDay, selectedWeekRange?.startDay, selectedWeekRange?.endDay]);

  return <div
    ref={shellRef}
    className={'gantt-shell tracker-gantt tracker-work-gantt ' + className}
    aria-label="Work activity and approved schedule"
    aria-readonly="true"
    data-animations-paused={workActivity.animationsPaused ? 'true' : 'false'}
    onPointerDownCapture={onPointerIntent}
    onPointerLeave={onClearHover}
  >
    <WorkGanttZoomControls
      zoom={zoom}
      onZoomOut={() => changeZoom(zoom - 10)}
      onZoomIn={() => changeZoom(zoom + 10)}
      onZoomChange={value => changeZoom(value)}
      onReset={() => changeZoom(GANTT_DEFAULT_ZOOM)}
      onFitAll={fitAll}
      canFitAll={canFitAll}
      onFitFocusWindow={focusWindowRange ? fitFocusWindow : null}
      canFitFocusWindow={Boolean(focusWindowRange)}
      onFitSelectedWeek={fitSelectedWeek}
      canFitSelectedWeek={canFitSelectedWeek}
      compact={presentationMode}
    />
    <GanttProvider
      range="daily"
      zoom={zoom * GANTT_PROVIDER_ZOOM_SCALE}
      dailyTickEvery={ganttDateTickInterval(zoom)}
      dateRange={dateRange}
      rowHeight={WORK_GANTT_ROW_HEIGHT}
    >
      <WorkGanttTimelineContent
        rows={displayedRows}
        data={data}
        dependencyEdges={dependencyEdges}
        selectedId={selectedId}
        activeId={activeId}
        relatedIds={relatedIds}
        onSelect={onSelect}
        onHover={onHover}
        onFocus={onFocus}
        onBlur={onBlur}
        toggleExpanded={toggleExpanded}
        workActivity={workActivity}
        managerProjection={managerProjection}
        managerEnabled={managerEnabled}
        today={today}
        firstFeature={initialFeature}
        navigationDate={navigationDate}
        showAllDependencies={showAllDependencies}
        showActivity={showActivity}
        focusWeek={focusWindow?.focus ?? selectedWeek}
        layoutKey={`${zoom}:${className.includes('expanded') ? 'expanded' : 'compact'}:${rows.map(row => row.id).join(',')}`}
      />
    </GanttProvider>
  </div>;
}

function WorkGanttTimelineContent({
  rows,
  data,
  dependencyEdges,
  selectedId,
  activeId,
  relatedIds,
  onSelect,
  onHover,
  onFocus,
  onBlur,
  toggleExpanded,
  workActivity,
  managerProjection,
  managerEnabled,
  today,
  firstFeature,
  navigationDate,
  showAllDependencies,
  showActivity,
  focusWeek,
  layoutKey,
}) {
  const gantt = useGantt();
  const pixelsPerDay = gantt.columnWidth * gantt.zoom / 100;
  const chartStartDay = timelineStartDay(gantt.timelineData);
  const chartWidth = gantt.timelineData
    .flatMap(year => year?.quarters?.flatMap(quarter => quarter?.months ?? []) ?? [])
    .reduce((total, month) => total + (month?.days ?? 0), 0) * pixelsPerDay;
  const focusWeekRange = selectedWeekGanttDateRange(focusWeek);
  const focusWeekLeft = focusWeekRange ? dayLeft(focusWeekRange, chartStartDay, pixelsPerDay) : null;
  const focusWeekWidth = focusWeekRange ? dayWidth(focusWeekRange, pixelsPerDay) : 0;
  const bodyRef = useRef(null);

  return <>
    <WorkGanttInitialPosition feature={firstFeature} navigationDate={navigationDate} />
    <GanttSidebar primaryHeader="Task" secondaryHeader="Owner">
      <GanttSidebarGroup name="Work hierarchy">
        {rows.map(row => {
          if (row.ownerGroup) return <WorkGanttOwnerGroupRow key={row.id} row={row} />;
          const item = data?.itemById?.get(row.id) ?? row.entry;
          return <WorkGanttSidebarRow
            key={row.id}
            row={row}
            item={item}
            data={data}
            selectedId={selectedId}
            activeId={activeId}
            relatedIds={relatedIds}
            onSelect={onSelect}
            onHover={onHover}
            onFocus={onFocus}
            onBlur={onBlur}
            toggleExpanded={toggleExpanded}
            workActivity={workActivity}
            showActivity={showActivity}
            managerProjection={managerProjection}
            managerEnabled={managerEnabled}
          />;
        })}
      </GanttSidebarGroup>
    </GanttSidebar>
    <GanttTimeline>
      <GanttHeader />
      {today ? <GanttMarker id="manila-today" date={today} label="Today" className="tracker-work-gantt-today" /> : null}
      <GanttFeatureList className="work-gantt-feature-list">
        <GanttFeatureListGroup>
          <div ref={bodyRef} className="work-gantt-row-body">
          {focusWeekLeft !== null && focusWeekWidth > 0 ? <span
            className="work-gantt-focus-week"
            aria-hidden="true"
            data-focus-week-start={focusWeekRange.startDay}
            data-focus-week-end={focusWeekRange.endDay}
            style={{ left: `${focusWeekLeft}px`, width: `${focusWeekWidth}px` }}
          /> : null}
          <div className="work-gantt-container-layer" aria-hidden="true">
            {rows.map(row => {
              if (!row.isExpanded || !row.parentEnvelope || row.rowIndex === undefined) return null;
              const left = dayLeft(row.parentEnvelope, chartStartDay, pixelsPerDay);
              const width = dayWidth(row.parentEnvelope, pixelsPerDay);
              if (left === null || width <= 0) return null;
              const rowCount = Math.max(1, (row.lastVisibleDescendantRowIndex ?? row.rowIndex) - row.rowIndex + 1);
              const containerSchedule = getWorkDateDetails(row).label;
              const containerScheduleLabel = row.childSummaryIncomplete && containerSchedule === 'Scheduled'
                ? 'Dates incomplete'
                : containerSchedule;
              const containerScheduleSuffix = containerScheduleLabel && containerScheduleLabel !== 'Scheduled'
                ? ` · ${containerScheduleLabel}`
                : '';
              return <span
                className="work-gantt-parent-container"
                key={row.id}
                data-container-id={row.id}
                data-work-parent-id={row.id}
                data-parent-state="expanded"
                data-container-source-kind={row.parentEnvelope.primaryKind ?? 'mixed'}
                data-container-completed={row.entry.completed ? 'true' : undefined}
                role="img"
                aria-label={`${row.entry.title} parent container · ${row.parentEnvelope.startDay} to ${row.parentEnvelope.endDay}${containerScheduleSuffix}`}
                title={`${row.entry.title} · parent container · ${row.parentEnvelope.startDay} to ${row.parentEnvelope.endDay}${containerScheduleSuffix}`}
                data-container-depth={row.depth}
                style={{
                  left: `${left}px`,
                  top: `${row.rowIndex * WORK_GANTT_ROW_HEIGHT}px`,
                  width: `${width}px`,
                  height: `${rowCount * WORK_GANTT_ROW_HEIGHT}px`,
                  zIndex: row.depth + 1,
                }}
              />;
            })}
          </div>
          {rows.map(row => {
            if (row.ownerGroup) return <div
              className="work-gantt-owner-group-chart-row"
              key={row.id}
              data-work-row-id={row.id}
              data-owner-group-id={row.ownerGroupKey}
              aria-hidden="true"
            />;
            const item = data?.itemById?.get(row.id) ?? row.entry;
            const title = item.title ?? row.entry.title;
            const referenceCode = item.referenceCode;
            const titleWithReference = referenceCode ? `${referenceCode} · ${title}` : title;
            const primaryId = row.primaryMark?.id;
            const visibleChildIntervals = (row.childSummaryIntervals ?? []).filter(interval => showActivity || interval.sourceKind !== 'observed');
            const rollups = row.collapsed && row.hasChildren
              ? placeWorkGanttRollups(visibleChildIntervals.length ? visibleChildIntervals : row.childRollups ?? [])
              : { positionedRollups: [], overflowCount: 0 };
            const rollupSummary = `Direct child schedules · ${row.eligibleChildCount ?? 0} eligible child${row.eligibleChildCount === 1 ? '' : 'ren'} · ${row.undatedChildCount ?? 0} undated`;
            const rollupSources = [...new Set(visibleChildIntervals.map(interval => interval.sourceKind))].join(', ');
            const rollupIntervals = visibleChildIntervals.map(interval => `${interval.sourceKind} ${interval.startDay}–${interval.endDay}`).join('; ');
            const rollupDescription = rollups.overflowCount
              ? `${rollupSummary} · ${rollups.overflowCount} additional approved date mark${rollups.overflowCount === 1 ? '' : 's'} summarized as +${rollups.overflowCount}.`
                + (rollupSources ? ` Sources: ${rollupSources}.` : '')
                + (rollupIntervals ? ` Intervals: ${rollupIntervals}.` : '')
              : rollupSummary + (rollupIntervals ? ` · Intervals: ${rollupIntervals}.` : '');
            const childApprovedEnvelope = row.childApprovedEnvelope;
            const childObservedEnvelope = row.childObservedEnvelope;
            const childProposedEnvelope = row.childProposedEnvelope;
            const visibleChildSummaryEnvelope = childApprovedEnvelope ?? (showActivity ? childObservedEnvelope : null);
            const collapsedSummaryEnvelope = childApprovedEnvelope ?? childProposedEnvelope;
            const collapsedActivityEnvelope = !childApprovedEnvelope && showActivity
              ? childObservedEnvelope
              : null;
            const collapsedEnvelope = collapsedSummaryEnvelope;
            const parentEnvelopeLeft = row.parentEnvelope
              ? dayLeft(row.parentEnvelope, chartStartDay, pixelsPerDay)
              : null;
            const parentEnvelopeWidth = row.parentEnvelope
              ? dayWidth(row.parentEnvelope, pixelsPerDay)
              : 0;
            const collapsedEnvelopeLeft = collapsedEnvelope
              ? dayLeft(collapsedEnvelope, chartStartDay, pixelsPerDay)
              : null;
            const collapsedEnvelopeWidth = collapsedEnvelope
              ? dayWidth(collapsedEnvelope, pixelsPerDay)
              : 0;
            const envelopeLeft = row.collapsed && collapsedEnvelope
              ? collapsedEnvelopeLeft
              : null;
            const envelopeWidth = row.collapsed && collapsedEnvelope
              ? collapsedEnvelopeWidth
              : 0;
            const envelopeRight = envelopeLeft === null ? null : envelopeLeft + envelopeWidth;
            const parentLabelRange = collapsedEnvelope ?? row.parentEnvelope;
            const parentLabelText = parentLabelRange
              ? `${title} · ${workGanttRangeLabel(parentLabelRange)}`
              : title;
            const dateDetails = getWorkDateDetails(row);
            const scheduleLabel = dateDetails.label;
            const incompleteScheduleLabel = row.childSummaryIncomplete && scheduleLabel === 'Scheduled'
              ? 'Dates incomplete'
              : scheduleLabel;
            const missingDatesSuffix = incompleteScheduleLabel && incompleteScheduleLabel !== 'Scheduled'
              ? ` · ${incompleteScheduleLabel}`
              : '';
            const collapsedParentDescription = `${title} · parent timeline · ${collapsedEnvelope?.sourceKinds?.join(', ') ?? row.parentEnvelope?.sourceKinds?.join(', ') ?? 'approved'} · ${collapsedEnvelope?.startDay ?? row.parentEnvelope?.startDay ?? 'unknown'} to ${collapsedEnvelope?.endDay ?? row.parentEnvelope?.endDay ?? 'unknown'}${missingDatesSuffix}`;
            const expandedParentDescription = `${title} · parent timeline · ${row.parentEnvelope?.sourceKinds?.join(', ') ?? 'approved'} · ${row.parentEnvelope?.startDay ?? 'unknown'} to ${row.parentEnvelope?.endDay ?? 'unknown'}${missingDatesSuffix}`;
            const parentLabelNeedsCallout = parentEnvelopeWidth > 0 && parentEnvelopeWidth < 180;
            const expandedParentLabelWidth = row.isExpanded && parentLabelNeedsCallout
              ? Math.min(220, chartWidth)
              : parentEnvelopeWidth;
            const expandedParentLabelLeft = row.isExpanded && parentLabelNeedsCallout
              ? Math.max(0, Math.min(parentEnvelopeLeft ?? 0, chartWidth - expandedParentLabelWidth))
              : parentEnvelopeLeft;
            const primaryLeft = row.primaryMark ? dayLeft(row.primaryMark, chartStartDay, pixelsPerDay) : null;
            const rawOverflowLeft = primaryLeft === null
              ? 3
              : primaryLeft + dayWidth(row.primaryMark, pixelsPerDay) + 3;
            const overflowLeft = envelopeRight === null || envelopeWidth < 24
              ? rawOverflowLeft
              : Math.max(envelopeLeft + 3, Math.min(rawOverflowLeft, envelopeRight - 24));
            const highlight = rowHighlight(row, activeId, relatedIds, selectedId);
            const hasOwnApprovedPlan = Boolean(row.ownApprovedMark);
            const childLabel = childApprovedEnvelope ? `Child schedule · ${workGanttRangeLabel(childApprovedEnvelope)}` : null;
            const proposedChildLabel = childProposedEnvelope ? `${proposedEnvelopeLabel(childProposedEnvelope)} · ${workGanttRangeLabel(childProposedEnvelope)}` : null;
            const planLabel = row.ownApprovedMark ? `Plan · ${workGanttRangeLabel(row.ownApprovedMark)}` : null;
            const trackLabelLeft = mark => {
              const left = mark ? dayLeft(mark, chartStartDay, pixelsPerDay) : envelopeLeft;
              const width = mark ? dayWidth(mark, pixelsPerDay) : 0;
              return `${Math.max(4, (left ?? 0) + width + 6)}px`;
            };
            return <div
              className={'work-gantt-feature-row-wrap' + (row.collapsed && row.hasChildren ? ' is-collapsed-parent' : '') + (row.isExpanded ? ' is-expanded-parent' : '')}
              key={row.id}
              data-work-row-id={row.id}
              data-highlight={highlight}
              onPointerEnter={event => onHover(row.id, event)}
              onFocusCapture={event => onFocus(row.id, event)}
              onBlurCapture={onBlur}
            >
              {envelopeLeft !== null && envelopeWidth > 0 ? <WorkGanttTooltip label={collapsedParentDescription}><button
                className="work-gantt-parent-envelope"
                type="button"
                data-work-parent-id={row.id}
                data-parent-state="collapsed"
                data-envelope-source-kind={collapsedEnvelope?.primaryKind ?? row.parentEnvelope?.primaryKind ?? 'mixed'}
                data-envelope-completed={row.entry.completed ? 'true' : undefined}
                data-envelope-has-own-plan={hasOwnApprovedPlan ? 'true' : undefined}
                aria-label={`Open details for ${collapsedParentDescription}`}
                style={{ left: `${envelopeLeft}px`, width: `${envelopeWidth}px` }}
                onClick={() => onSelect(row.id)}
                onPointerDown={event => event.stopPropagation()}
              ><span className="work-gantt-parent-envelope-label">{item.referenceCode ? <code className="work-reference-code">{item.referenceCode}</code> : null}{parentLabelText}</span></button></WorkGanttTooltip> : null}
              {row.collapsed && hasOwnApprovedPlan && childApprovedEnvelope ? <>
                <span className="work-gantt-parent-track-label work-gantt-parent-track-label-plan" style={{ left: trackLabelLeft(row.ownApprovedMark) }}>{planLabel}</span>
                <span className="work-gantt-parent-track-label work-gantt-parent-track-label-child" style={{ left: trackLabelLeft(childApprovedEnvelope) }}>{childLabel}</span>
              </> : null}
              {row.collapsed && childProposedEnvelope ? <WorkGanttTooltip label={`${title} · ${proposedChildLabel}${missingDatesSuffix}`}>
                <span
                  className="work-gantt-child-proposed-summary"
                  data-work-parent-id={row.id}
                  data-parent-state="collapsed"
                  data-summary-source-kind="proposed"
                  aria-label={`${title} · ${proposedChildLabel}${missingDatesSuffix}`}
                  title={`${title} · ${proposedChildLabel}${missingDatesSuffix}`}
                  role="img"
                  tabIndex={0}
                  style={{ left: `${dayLeft(childProposedEnvelope, chartStartDay, pixelsPerDay)}px`, width: `${Math.max(3, dayWidth(childProposedEnvelope, pixelsPerDay))}px` }}
                ><span className="work-gantt-child-proposed-summary-label">{proposedChildLabel}</span></span>
              </WorkGanttTooltip> : null}
              {row.collapsed && collapsedActivityEnvelope ? <WorkGanttTooltip label={`${title} · recorded activity · ${collapsedActivityEnvelope.startDay} to ${collapsedActivityEnvelope.endDay}${missingDatesSuffix}`}>
                <span
                  className="work-gantt-child-activity-summary"
                  data-work-parent-id={row.id}
                  data-parent-state="collapsed"
                  data-summary-source-kind="observed"
                  aria-label={`${title} · recorded activity · ${collapsedActivityEnvelope.startDay} to ${collapsedActivityEnvelope.endDay}${missingDatesSuffix}`}
                  title={`${title} · recorded activity · ${collapsedActivityEnvelope.startDay} to ${collapsedActivityEnvelope.endDay}${missingDatesSuffix}`}
                  role="img"
                  tabIndex={0}
                  style={{
                    left: `${dayLeft(collapsedActivityEnvelope, chartStartDay, pixelsPerDay)}px`,
                    width: `${Math.max(3, dayWidth(collapsedActivityEnvelope, pixelsPerDay))}px`,
                  }}
                ><span
                  className="work-gantt-child-summary-bracket-label"
                  style={{ left: `${Math.max(4, dayWidth(collapsedActivityEnvelope, pixelsPerDay) + 6)}px` }}
                >Recorded activity · {workGanttRangeLabel(collapsedActivityEnvelope)}</span></span>
              </WorkGanttTooltip> : null}
              {row.isExpanded && row.parentEnvelope && parentEnvelopeLeft !== null && parentEnvelopeWidth > 0 ? <WorkGanttTooltip label={expandedParentDescription}><button
                className="work-gantt-expanded-parent-label"
                type="button"
                data-work-parent-id={row.id}
                data-parent-state="expanded"
                data-parent-source-kind={row.parentEnvelope.primaryKind ?? 'mixed'}
                data-parent-completed={row.entry.completed ? 'true' : undefined}
                data-parent-has-own-plan={hasOwnApprovedPlan ? 'true' : undefined}
                aria-label={`Open details for ${expandedParentDescription}`}
                style={{ left: `${expandedParentLabelLeft}px`, width: `${expandedParentLabelWidth}px` }}
                onClick={() => onSelect(row.id)}
                onPointerDown={event => event.stopPropagation()}
              ><span className="work-gantt-expanded-parent-label-text">{item.referenceCode ? <code className="work-reference-code">{item.referenceCode}</code> : null}{parentLabelText}</span></button></WorkGanttTooltip> : null}
              {row.isExpanded && visibleChildSummaryEnvelope ? childApprovedEnvelope ? <WorkGanttTooltip label={`${title} · child schedule · ${visibleChildSummaryEnvelope.startDay} to ${visibleChildSummaryEnvelope.endDay}${missingDatesSuffix}`}><button
                className="work-gantt-child-summary-bracket"
                type="button"
                data-work-parent-id={row.id}
                data-parent-state="expanded"
                data-summary-source-kind={visibleChildSummaryEnvelope.primaryKind ?? 'mixed'}
                data-summary-incomplete={row.childSummaryIncomplete ? 'true' : undefined}
                aria-label={`Open details for ${title} · child schedule · ${visibleChildSummaryEnvelope.startDay} to ${visibleChildSummaryEnvelope.endDay}${missingDatesSuffix}`}
                title={`${title} · child schedule · ${visibleChildSummaryEnvelope.startDay} to ${visibleChildSummaryEnvelope.endDay}${missingDatesSuffix}`}
                style={{
                  left: `${dayLeft(visibleChildSummaryEnvelope, chartStartDay, pixelsPerDay)}px`,
                  width: `${Math.max(3, dayWidth(visibleChildSummaryEnvelope, pixelsPerDay))}px`,
                }}
                onClick={() => onSelect(row.id)}
                onPointerDown={event => event.stopPropagation()}
              ><span
                className="work-gantt-child-summary-bracket-label"
                style={{ left: `${Math.max(4, dayWidth(visibleChildSummaryEnvelope, pixelsPerDay) + 6)}px` }}
              >{hasOwnApprovedPlan ? childLabel : workGanttRangeLabel(visibleChildSummaryEnvelope)}</span></button></WorkGanttTooltip> : <WorkGanttTooltip label={`${title} · recorded activity · ${visibleChildSummaryEnvelope.startDay} to ${visibleChildSummaryEnvelope.endDay}${missingDatesSuffix}`}><span
                className="work-gantt-child-activity-summary"
                data-work-parent-id={row.id}
                data-parent-state="expanded"
                data-summary-source-kind="observed"
                data-summary-incomplete={row.childSummaryIncomplete ? 'true' : undefined}
                aria-label={`${title} · recorded activity · ${visibleChildSummaryEnvelope.startDay} to ${visibleChildSummaryEnvelope.endDay}${missingDatesSuffix}`}
                title={`${title} · recorded activity · ${visibleChildSummaryEnvelope.startDay} to ${visibleChildSummaryEnvelope.endDay}${missingDatesSuffix}`}
                role="img"
                tabIndex={0}
                style={{
                  left: `${dayLeft(visibleChildSummaryEnvelope, chartStartDay, pixelsPerDay)}px`,
                  width: `${Math.max(3, dayWidth(visibleChildSummaryEnvelope, pixelsPerDay))}px`,
                }}
              ><span
                className="work-gantt-child-summary-bracket-label"
                style={{ left: `${Math.max(4, dayWidth(visibleChildSummaryEnvelope, pixelsPerDay) + 6)}px` }}
              >Recorded activity · {workGanttRangeLabel(visibleChildSummaryEnvelope)}</span></span></WorkGanttTooltip> : null}
              {row.isExpanded && childProposedEnvelope ? <WorkGanttTooltip label={`${title} · ${proposedChildLabel}${missingDatesSuffix}`}><button
                className="work-gantt-child-summary-bracket work-gantt-child-proposed-summary"
                type="button"
                data-work-parent-id={row.id}
                data-parent-state="expanded"
                data-summary-source-kind="proposed"
                aria-label={`Open details for ${title} · ${proposedChildLabel}${missingDatesSuffix}`}
                title={`${title} · ${proposedChildLabel}${missingDatesSuffix}`}
                style={{ left: `${dayLeft(childProposedEnvelope, chartStartDay, pixelsPerDay)}px`, width: `${Math.max(3, dayWidth(childProposedEnvelope, pixelsPerDay))}px` }}
                onClick={() => onSelect(row.id)}
                onPointerDown={event => event.stopPropagation()}
              ><span className="work-gantt-child-summary-bracket-label">{proposedChildLabel}</span></button></WorkGanttTooltip> : null}
              {row.isExpanded && hasOwnApprovedPlan && childApprovedEnvelope ? <span
                className="work-gantt-parent-track-label work-gantt-parent-track-label-expanded-plan"
                style={{ left: trackLabelLeft(row.ownApprovedMark) }}
              >{planLabel}</span> : null}
              {row.childSummaryIncomplete && row.hasChildren ? <WorkGanttTooltip label={`${incompleteScheduleLabel}; summary shows known dates.`}><span
                className="work-gantt-missing-dates"
                role="note"
                title={`${incompleteScheduleLabel}; summary shows known dates.`}
                aria-label={incompleteScheduleLabel}
                tabIndex={0}
                style={{ left: trackLabelLeft(childApprovedEnvelope ?? collapsedEnvelope ?? row.parentEnvelope) }}
              >{incompleteScheduleLabel}</span></WorkGanttTooltip> : null}
              {row.marks.length ? <GanttFeatureRow
                rowId={row.id}
                features={row.marks}
                overlapMode="overlay"
                hitTesting="lanes"
                getInteractionLane={feature => workGanttInteractionLane(row, feature)}
                getAriaLabel={feature => titleWithReference + ' · ' + accessibleMarkDescription(feature)}
                getTitle={feature => titleWithReference + ' · ' + accessibleMarkDescription(feature)}
                getClassName={feature => {
                  const classes = ['work-gantt-mark', 'work-gantt-mark-' + feature.sourceKind];
                  if (row.hasChildren && row.collapsed && !row.ownApprovedMark) classes.push('work-gantt-summary');
                  if (row.hasChildren && row.isExpanded) classes.push('work-gantt-expanded-parent-mark');
                  if (row.ownApprovedMark?.id === feature.id) classes.push('work-gantt-own-plan');
                  if (feature.point) classes.push('work-gantt-point');
                  if (feature.inferred) classes.push('work-gantt-inferred');
                  if (feature.observedOverrun) classes.push('work-gantt-overrun');
                  if (row.entry.completed) classes.push('work-gantt-completed');
                  return classes.join(' ');
                }}
                onSelect={() => onSelect(row.id)}
                className="work-gantt-feature-row"
              >
                {feature => {
                  const motion = feature.sourceKind === 'observed'
                    ? activityMotionRange(row.entry, feature, row.collapsed)
                    : null;
                  const overrun = feature.sourceKind === 'observed' ? observedOverrunRange(feature, pixelsPerDay) : null;
                  const featureWidth = dayWidth(feature, pixelsPerDay);
                  const dateLabel = feature.startDay === feature.endDay
                    ? shortWorkDate(feature.endDay)
                    : `${shortWorkDate(feature.startDay)}–${shortWorkDate(feature.endDay)}`;
                  const label = row.hasChildren
                    ? null
                    : feature.sourceKind === 'approved'
                      ? featureWidth >= 240 ? `${title} · ${dateLabel}` : featureWidth >= 120 ? dateLabel : null
                      : null;
                  return <span className={'work-gantt-feature-content work-gantt-lane-' + feature.laneKey}>
                    <span
                      className="work-gantt-lane-mark"
                      data-work-approved-anchor={feature.sourceKind === 'approved' && !feature.point ? row.id : undefined}
                      aria-hidden="true"
                    />
                    {feature.sourceKind === 'approved' && feature.point
                      ? <span className="work-gantt-point-glyph" data-work-approved-anchor={row.id} data-work-approved-point="true" aria-hidden="true" />
                      : feature.sourceKind === 'approved' ? <span className="work-gantt-due-marker" aria-hidden="true" /> : null}
                    {overrun ? <span
                      className="work-gantt-overrun-segment"
                      aria-hidden="true"
                      style={{ '--overrun-left': String(overrun.left) + 'px', '--overrun-width': String(overrun.width) + 'px' }}
                    /> : null}
                    {motion ? <span
                      className="work-gantt-motion"
                      aria-hidden="true"
                      style={{ '--motion-left': String(motion.left) + '%', '--motion-width': String(motion.width) + '%' }}
                    /> : null}
                    {label && feature.id === primaryId ? <span className="gantt-feature-label work-gantt-label">{referenceCode ? <code className="work-reference-code">{referenceCode}</code> : null}{label}</span> : null}
                  </span>;
                }}
              </GanttFeatureRow> : null}
              {!row.hasChildren ? row.marks.filter(mark => mark.sourceKind === 'approved').map(mark => {
                const left = dayLeft(mark, chartStartDay, pixelsPerDay);
                const width = dayWidth(mark, pixelsPerDay);
                if (left === null || width <= 0) return null;
                return <span
                  key={`${mark.id}:date-label`}
                  className="work-gantt-external-date-label"
                  style={{ left: `${left + width + 6}px` }}
                >{workGanttRangeLabel(mark)}</span>;
              }) : null}
              {rollups.positionedRollups.map(rollup => {
                const left = dayLeft(rollup, chartStartDay, pixelsPerDay);
                if (left === null) return null;
                const width = rollup.point ? 3 : Math.max(3, dayWidth(rollup, pixelsPerDay));
                return <span
                  key={`${rollup.childId}:${rollup.sourceKind ?? 'approved'}:${rollup.startDay}:${rollup.endDay}`}
                  className={'work-gantt-child-rollup work-gantt-child-rollup-' + (rollup.sourceKind ?? 'approved') + (rollup.point ? ' is-point' : '')}
                  data-rollup-track={rollup.trackIndex}
                  data-rollup-source-kind={rollup.sourceKind ?? 'approved'}
                  style={{ left: `${left}px`, width: `${width}px` }}
                  aria-hidden="true"
                />;
              })}
              {row.collapsed && row.hasChildren && rollups.overflowCount > 0 ? <WorkGanttTooltip label={rollupDescription}><span
                className="work-gantt-rollup-overflow"
                role="img"
                aria-label={rollupDescription}
                title={rollupDescription}
                tabIndex={0}
                style={{ left: `${Math.max(2, overflowLeft)}px` }}
              >+{rollups.overflowCount}</span></WorkGanttTooltip> : null}
              {!row.hasChildren && row.entry.timeline.partial ? <WorkGanttTooltip label={PARTIAL_APPROVED_HELP}><span
                className="work-gantt-missing-dates work-gantt-missing-dates-leaf"
                title={PARTIAL_APPROVED_HELP}
                aria-label="Dates incomplete"
                role="note"
                tabIndex={0}
              >Dates incomplete</span></WorkGanttTooltip> : null}
            </div>;
          })}
            <WorkGanttDependencies
              bodyRef={bodyRef}
              rows={rows}
              dependencyEdges={dependencyEdges}
              activeId={activeId}
              showAll={showAllDependencies}
              layoutKey={layoutKey}
            />
          </div>
        </GanttFeatureListGroup>
      </GanttFeatureList>
    </GanttTimeline>
  </>;
}

function WorkGanttExpansionControls({ selectedDepth, onChange, testId = 'work-gantt-expansion-controls' }) {
  return <div className="work-gantt-expansion-controls" role="group" aria-label="Expand hierarchy" data-testid={testId}>
    {EXPANSION_LEVELS.map(depth => <Button
      key={depth}
      type="button"
      size="sm"
      variant={selectedDepth === depth ? 'default' : 'outline'}
      aria-pressed={selectedDepth === depth}
      data-expansion-level={depth}
      title={depth === 'all' ? 'Expand all levels' : `Expand to level ${depth}`}
      onClick={() => onChange(depth)}
    >{depth === 'all' ? 'All' : `Level ${depth}`}</Button>)}
    {selectedDepth === undefined ? <span className="work-gantt-expansion-custom" data-testid={`${testId}-custom`}>Custom</span> : null}
  </div>;
}

const WORK_GANTT_DEPENDENCY_HELP = 'Recorded prerequisite; arrow placement does not establish a scheduling constraint.';

function WorkGanttScheduleControls({ selectedDepth, onDepthChange, showAllDependencies, onToggleDependencies, idPrefix }) {
  const dependencyHelpId = `${idPrefix}-dependency-help`;
  const expansionTestId = `${idPrefix}-expansion-controls`;

  return <div className="work-gantt-schedule-controls">
    <WorkGanttExpansionControls selectedDepth={selectedDepth} onChange={onDepthChange} testId={expansionTestId} />
    <Button
      size="sm"
      variant={showAllDependencies ? 'default' : 'outline'}
      type="button"
      aria-pressed={showAllDependencies}
      aria-describedby={dependencyHelpId}
      title={WORK_GANTT_DEPENDENCY_HELP}
      onClick={onToggleDependencies}
    >All dependencies</Button>
    <span id={dependencyHelpId} className="sr-only">{WORK_GANTT_DEPENDENCY_HELP}</span>
  </div>;
}

/** Render activity, ownership, and source-backed schedule marks on each task row. */
export function WorkGantt({
  items = [],
  data,
  onSelect,
  selectedId,
  visibleIds,
  contextualIds = new Set(),
  workActivity,
  managerProjection,
  managerEnabled = false,
  navigationDate,
  selectedWeek = null,
  focusWindow = null,
  groupByOwner = false,
  presentationMode = false,
  onExitPresentationMode,
}) {
  const [expanded, setExpanded] = useState(false);
  const forecastStatusId = useId();
  const [showForecast, setShowForecast] = useState(false);
  const [showActivity, setShowActivity] = useState(true);
  const [investigationId, setInvestigationId] = useState(null);
  const investigationTriggerRef = useRef(null);
  const [showAllDependencies, setShowAllDependencies] = useState(false);
  const [hoveredId, setHoveredId] = useState(null);
  const [keyboardFocusId, setKeyboardFocusId] = useState(null);
  const focusClearFrame = useRef(0);
  useEffect(() => () => {
    if (focusClearFrame.current) cancelAnimationFrame(focusClearFrame.current);
  }, []);
  const [zoom, setZoom] = useState(GANTT_DEFAULT_ZOOM);
  const selectWorkItem = itemId => {
    if (expanded) setExpanded(false);
    if (model.rows.some(row => row.id === itemId)) {
      const trigger = document.activeElement;
      investigationTriggerRef.current = trigger instanceof HTMLElement ? trigger : null;
      setInvestigationId(itemId);
    } else {
      // Collapsed descendants still appear in the mobile agenda and the
      // unscheduled list. They are not rendered rows, so let the existing
      // work details route handle them instead of opening an empty panel.
      investigationTriggerRef.current = null;
      setInvestigationId(null);
      onSelect?.(itemId);
    }
  };
  useEffect(() => {
    if (!investigationId) return undefined;
    const handleKeyDown = event => {
      if (event.key === 'Escape') closeInvestigation();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [investigationId]);
  const projection = workActivity?.projection ?? EMPTY_MAP;
  const fallbackItemIds = useMemo(() => items.map(item => item?.id ?? item?.data?.id).filter(Boolean), [items]);
  const itemIds = visibleIds ?? fallbackItemIds;
  const eligibleIds = useMemo(() => new Set(itemIds), [itemIds]);
  const expandedIds = workActivity?.expandedIds ?? data?.defaultExpanded ?? EMPTY_SET;
  const toggleExpanded = workActivity?.toggleExpanded ?? (() => {});
  const initializeGanttExpansion = workActivity?.initializeGanttExpansion;
  const setExpandedForIds = workActivity?.setExpandedForIds;
  const releases = data?.releases ?? [];
  const releaseDates = useMemo(() => releases.map(release => release?.target).filter(Boolean), [releases]);
  const expansionTargets = useMemo(() => new Map(EXPANSION_LEVELS.map(depth => [
    depth,
    workGanttDepthExpansion(projection, eligibleIds, depth),
  ])), [projection, eligibleIds]);
  const allExpansion = expansionTargets.get('all');
  const selectedExpansionDepth = EXPANSION_LEVELS.find(depth => {
    const target = expansionTargets.get(depth);
    return target && sameIdsWithin(allExpansion?.controlledIds ?? target.controlledIds, target.expandedIds, expandedIds);
  });
  useEffect(() => {
    if (!eligibleIds.size || !allExpansion?.controlledIds?.size || typeof initializeGanttExpansion !== 'function') return;
    const initial = expansionTargets.get(3);
    if (initial) initializeGanttExpansion(initial.expandedIds, allExpansion.controlledIds);
  }, [eligibleIds, allExpansion, expansionTargets, initializeGanttExpansion]);

  const model = useMemo(() => buildWorkGanttModel({
    projection,
    visibleIds: itemIds,
    // Owner mode is a filtered workload view: include every matching leaf
    // regardless of the hierarchy depth preset used by the normal tree.
    expandedIds: groupByOwner ? (allExpansion?.expandedIds ?? expandedIds) : expandedIds,
    contextualIds,
    releaseDates,
    itemsById: data?.itemById,
    showForecast,
  }), [allExpansion?.expandedIds, contextualIds, data?.itemById, expandedIds, groupByOwner, itemIds, projection, releaseDates, showForecast]);
  const navigationAnchor = useMemo(
    () => typeof navigationDate === 'string' ? chartDateForDay(navigationDate) : null,
    [navigationDate],
  );
  const validNavigationDate = navigationAnchor ? navigationDate : null;
  const initialPositionDate = useMemo(() => {
    if (validNavigationDate) return validNavigationDate;
    const today = manilaTodayForChart();
    if (!today) return null;
    return dateDayKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - GANTT_INITIAL_LOOKBACK_DAYS));
  }, [validNavigationDate]);
  const initialPositionAnchor = useMemo(
    () => initialPositionDate ? chartDateForDay(initialPositionDate) : null,
    [initialPositionDate],
  );
  const selectedWeekRange = useMemo(
    () => selectedWeekGanttDateRange(selectedWeek),
    [selectedWeek?.start, selectedWeek?.end],
  );
  const focusWindowRange = useMemo(
    () => selectedWeekGanttDateRange(focusWindow),
    [focusWindow?.start, focusWindow?.end],
  );
  const selectedWeekStartAnchor = useMemo(
    () => selectedWeekRange ? chartDateForDay(selectedWeekRange.startDay) : null,
    [selectedWeekRange],
  );
  const selectedWeekEndAnchor = useMemo(
    () => selectedWeekRange ? chartDateForDay(selectedWeekRange.endDay) : null,
    [selectedWeekRange],
  );
  const viewportDateRange = useMemo(
    () => extendDateRangeToAnchor(
      extendDateRangeToAnchor(
        extendDateRangeToAnchor(model.dateRange, initialPositionAnchor),
        focusWindowRange ? chartDateForDay(focusWindowRange.startDay) : selectedWeekStartAnchor,
      ),
      focusWindowRange ? chartDateForDay(focusWindowRange.endDay) : selectedWeekEndAnchor,
    ),
    [focusWindowRange, model.dateRange, initialPositionAnchor, selectedWeekEndAnchor, selectedWeekStartAnchor],
  );
  const contextual = contextualIds instanceof Set ? contextualIds : new Set(contextualIds ?? []);
  const unscheduledIds = model.unscheduledIds.filter(id => !contextual.has(id));
  const hasDisplayedMarks = model.rows.some(row => row.marks.some(mark => (
    (showActivity || mark.sourceKind !== 'observed') && (showForecast || mark.sourceKind !== 'forecast')
  )));
  const forecastAvailable = hasForecastMarks(projection, itemIds);
  const scrollTarget = initialPositionAnchor
    ? { id: (validNavigationDate ? 'navigation-date:' : 'initial-date:') + initialPositionDate, startAt: initialPositionAnchor, endAt: initialPositionAnchor }
    : null;
  const mobileAgendaRows = [...itemIds].map(id => {
    const entry = projection.get(id);
    if (!entry) return null;
    // Grouping rows own only the fields returned by directMarksForWorkEntry.
    // Their projected timeline also contains descendant ranges; using it here
    // would label a child schedule as the parent's approved plan.
    const marks = entry.childIds?.length ? directMarksForWorkEntry(entry) : marksForWorkEntry(entry);
    return { id, entry, marks };
  }).filter(Boolean);
  const rowIds = useMemo(() => new Set(model.rows.map(row => row.id)), [model.rows]);
  useEffect(() => {
    if (hoveredId && !rowIds.has(hoveredId)) setHoveredId(null);
    if (keyboardFocusId && !rowIds.has(keyboardFocusId)) {
      if (focusClearFrame.current) cancelAnimationFrame(focusClearFrame.current);
      focusClearFrame.current = 0;
      setKeyboardFocusId(null);
    }
  }, [rowIds, hoveredId, keyboardFocusId]);
  const selectedWorkId = investigationId ?? selectedId;
  const investigationRow = useMemo(
    () => investigationId ? model.rows.find(row => row.id === investigationId) ?? null : null,
    [investigationId, model.rows],
  );
  const openFullDetails = useCallback((itemId) => {
    setInvestigationId(null);
    investigationTriggerRef.current = null;
    onSelect?.(itemId);
  }, [onSelect]);
  const closeInvestigation = useCallback(() => {
    setInvestigationId(null);
    const trigger = investigationTriggerRef.current;
    investigationTriggerRef.current = null;
    if (trigger?.isConnected) requestAnimationFrame(() => trigger.focus?.());
  }, []);
  useEffect(() => {
    if (!presentationMode || typeof onExitPresentationMode !== 'function') return undefined;
    const handleKeyDown = event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onExitPresentationMode();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onExitPresentationMode, presentationMode]);
  const activeId = (keyboardFocusId && rowIds.has(keyboardFocusId) ? keyboardFocusId : null)
    ?? (hoveredId && rowIds.has(hoveredId) ? hoveredId : null)
    ?? (rowIds.has(selectedWorkId) ? selectedWorkId : null);
  const activeRow = model.rows.find(row => row.id === activeId);
  const relatedIds = useMemo(() => new Set([
    ...(activeRow?.ancestorIds ?? []),
    ...(activeRow?.visibleDescendantIds ?? []),
  ]), [activeRow]);
  useEffect(() => {
    if (!expanded || !keyboardFocusId) return undefined;
    const frame = requestAnimationFrame(() => {
      const chart = document.querySelector('.work-gantt-dialog-chart .tracker-work-gantt.gantt-shell-expanded');
      const focusedElement = document.activeElement;
      if (!chart || !focusedElement || !chart.contains(focusedElement)) return;
      const focusedRow = focusedElement.closest('.work-gantt-sidebar-row, .work-gantt-feature-row-wrap');
      const focusedId = focusedRow?.getAttribute('data-item-id') ?? focusedRow?.getAttribute('data-work-row-id');
      if (focusedId !== keyboardFocusId) return;
      const scroller = chart.querySelector('.gantt');
      if (!scroller || !focusedRow || !scroller.contains(focusedRow)) return;
      const scrollport = scroller.getBoundingClientRect();
      const rowBounds = focusedRow.getBoundingClientRect();
      const visibleTop = scrollport.top + scroller.clientTop;
      const visibleBottom = visibleTop + scroller.clientHeight;
      if (rowBounds.top < visibleTop) scroller.scrollTop += rowBounds.top - visibleTop;
      else if (rowBounds.bottom > visibleBottom) scroller.scrollTop += rowBounds.bottom - visibleBottom;
    });
    return () => cancelAnimationFrame(frame);
  }, [expanded, keyboardFocusId]);
  const cancelFocusClear = () => {
    if (!focusClearFrame.current) return;
    cancelAnimationFrame(focusClearFrame.current);
    focusClearFrame.current = 0;
  };
  const handlePointerIntent = () => {
    cancelFocusClear();
    setKeyboardFocusId(null);
  };
  const handleHover = (id, event) => {
    if (event?.pointerType === 'touch') return;
    setHoveredId(id);
  };
  const handleFocus = (id, event) => {
    cancelFocusClear();
    if (event?.target?.matches?.(':focus-visible')) setKeyboardFocusId(id);
    else setKeyboardFocusId(null);
  };
  const handleBlur = event => {
    if (event.currentTarget.contains(event.relatedTarget)) return;
    const chart = event.currentTarget.closest('.tracker-work-gantt');
    const nextRow = event.relatedTarget?.closest?.('.work-gantt-sidebar-row, .work-gantt-feature-row-wrap');
    if (chart && nextRow && chart.contains(nextRow)) return;
    cancelFocusClear();
    focusClearFrame.current = requestAnimationFrame(() => {
      focusClearFrame.current = 0;
      const focusedRow = document.activeElement?.closest?.('.work-gantt-sidebar-row, .work-gantt-feature-row-wrap');
      if (!chart?.contains(focusedRow)) setKeyboardFocusId(null);
    });
  };
  const changeExpansion = depth => {
    const target = expansionTargets.get(depth);
    if (target && allExpansion?.controlledIds && typeof setExpandedForIds === 'function') {
      setExpandedForIds(target.expandedIds, allExpansion.controlledIds);
    }
  };

  const timeline = className => <WorkGanttTimeline
    rows={model.rows}
    data={data}
    projection={projection}
    dependencyEdges={model.dependencyEdges ?? []}
    selectedId={selectedWorkId}
    activeId={activeId}
    relatedIds={relatedIds}
    onSelect={selectWorkItem}
    onHover={handleHover}
    onFocus={handleFocus}
    onBlur={handleBlur}
    onPointerIntent={handlePointerIntent}
    onClearHover={() => setHoveredId(null)}
    toggleExpanded={toggleExpanded}
    workActivity={workActivity}
    managerProjection={managerProjection}
    managerEnabled={managerEnabled}
    dateRange={viewportDateRange}
    releases={releases}
    selectedWeek={selectedWeek}
    focusWindow={focusWindow}
    groupByOwner={groupByOwner}
    itemsById={data?.itemById ?? EMPTY_MAP}
    presentationMode={presentationMode}
    showForecast={showForecast}
    showActivity={showActivity}
    initialFeature={scrollTarget}
    navigationDate={initialPositionDate}
    showAllDependencies={showAllDependencies}
    zoom={zoom}
    onZoomChange={setZoom}
    className={className}
  />;

  return <TooltipProvider delayDuration={350}><div className={'schedule-view work-gantt-view' + (presentationMode ? ' work-gantt-presentation-mode' : '')} data-presentation-mode={presentationMode ? 'true' : undefined}>
    <div className="schedule-legend work-gantt-legend">
      <span><i className="legend-dot baseline" />Approved plan</span>
      <button
        className="work-gantt-activity-toggle"
        type="button"
        aria-pressed={showActivity}
        onClick={() => setShowActivity(value => !value)}
      aria-label={showActivity ? 'Hide recorded activity' : 'Show recorded activity'}
      ><i className="legend-dot work-gantt-legend-observed" aria-hidden="true" />Recorded activity · {showActivity ? 'Hide' : 'Show'}</button>
      <span><i className="legend-dot proposed" />Proposed schedule</span>
      <button
        className="work-gantt-forecast-toggle"
        type="button"
        aria-pressed={showForecast}
        aria-describedby={forecastAvailable ? undefined : `work-gantt-forecast-status${forecastStatusId}`}
        onClick={() => setShowForecast(value => !value)}
      >
        <i className="legend-dot forecast" aria-hidden="true" />{showForecast ? 'Hide forecast' : 'Show forecast'}
      </button>
      {!forecastAvailable ? <span id={`work-gantt-forecast-status${forecastStatusId}`} className="work-gantt-forecast-status" role="status">No forecast dates recorded for visible work.</span> : null}
      <span className="schedule-readonly">Dates come from approved plans, explicit proposals, and qualifying source activity.</span>
    </div>
    {presentationMode && typeof onExitPresentationMode === 'function' ? <Button className="work-gantt-presentation-return" size="sm" variant="outline" type="button" onClick={onExitPresentationMode} aria-label="Return to full work view">
      Return to full view
    </Button> : null}
    <WorkGanttDeadlines releases={releases} />
    {!hasDisplayedMarks ? <div className="schedule-empty work-gantt-empty">
      <CalendarDays size={24} aria-hidden="true" />
      <h3>No timeline marks yet</h3>
      <p>Work without approved dates remains visible in the hierarchy and unscheduled list. Dated activity appears when qualifying source evidence is recorded.</p>
    </div> : null}
    <div className="gantt-toolbar work-gantt-toolbar">
      <span>Work activity timeline</span>
      <div className="work-gantt-toolbar-actions">
        <WorkGanttScheduleControls
          selectedDepth={selectedExpansionDepth}
          onDepthChange={changeExpansion}
          showAllDependencies={showAllDependencies}
          onToggleDependencies={() => setShowAllDependencies(value => !value)}
          idPrefix="work-gantt"
        />
        <Dialog open={expanded} onOpenChange={setExpanded}>
          <DialogTrigger asChild><Button size="sm" variant="outline"><Maximize2 size={15} aria-hidden="true" />Expand</Button></DialogTrigger>
          <DialogContent className="gantt-dialog-content" overlayClassName="gantt-dialog-overlay" showCloseButton={false}>
            <DialogHeader className="gantt-dialog-header">
              <div>
                <DialogTitle>Work activity timeline</DialogTitle>
                <DialogDescription>Select any schedule mark or work item to open its details.</DialogDescription>
              </div>
              <DialogClose asChild><Button size="sm" variant="outline"><Minimize2 size={15} aria-hidden="true" />Collapse</Button></DialogClose>
            </DialogHeader>
            <div className="gantt-dialog-body work-gantt-dialog-body">
              <WorkGanttScheduleControls
                selectedDepth={selectedExpansionDepth}
                onDepthChange={changeExpansion}
                showAllDependencies={showAllDependencies}
                onToggleDependencies={() => setShowAllDependencies(value => !value)}
                idPrefix="work-gantt-dialog"
              />
              <div className="work-gantt-dialog-chart">{timeline('gantt-shell-expanded')}</div>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </div>
    <div className={'work-gantt-chart-region' + (investigationRow ? ' has-investigation' : '')}>
      <div className="work-gantt-chart-main">{timeline('')}</div>
      {investigationRow ? <WorkGanttInvestigation
        row={investigationRow}
        data={data}
        onClose={closeInvestigation}
        onOpenFullDetails={openFullDetails}
      /> : null}
    </div>
    <WorkGanttMobileAgenda rows={mobileAgendaRows} data={data} onSelect={selectWorkItem} showForecast={showForecast} showActivity={showActivity} />
    <WorkGanttUnscheduledList ids={unscheduledIds} data={data} projection={projection} onSelect={selectWorkItem} />
  </div></TooltipProvider>;
}
