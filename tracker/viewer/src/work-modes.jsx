import React, { useEffect, useMemo } from 'react';
import { CalendarDays, ChevronRight, ShieldAlert } from 'lucide-react';
import { PersonLink } from './person-link.tsx';
import { resolvePerson } from './person-identity.ts';
import {
  CalendarBody,
  CalendarDatePagination,
  CalendarHeader,
  CalendarItem,
  CalendarProvider,
  CalendarTodayButton,
  useCalendarMonth,
  useCalendarYear,
} from './components/kibo-ui/calendar/index.tsx';
import {
  KanbanBoard,
  KanbanCard,
  KanbanCards,
  KanbanHeader,
  KanbanProvider,
} from './components/kibo-ui/kanban/index.tsx';
import { commitmentLabel, isAccepted } from './view-model.mjs';

const TIME_ZONE = 'Asia/Manila';

const STATUS_COLUMNS = [
  { id: 'queued', name: 'Queued' },
  { id: 'active', name: 'Active' },
  { id: 'blocked', name: 'Blocked' },
  { id: 'done', name: 'Done' },
];

function dateFromValue(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.valueOf()) ? null : value;
  const raw = String(value).trim();
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T12:00:00+08:00` : raw);
  return Number.isNaN(date.valueOf()) ? null : date;
}

function formatManilaDate(value) {
  const date = dateFromValue(value);
  if (!date) return 'Date not recorded';
  return new Intl.DateTimeFormat('en-PH', { dateStyle: 'medium', timeZone: TIME_ZONE }).format(date);
}

function navigationMonth(value) {
  if (value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (match) {
      const year = Number(match[1]);
      const month = Number(match[2]);
      const day = Number(match[3]);
      const date = new Date(year, month - 1, day, 12);
      if (date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day) return { year, month: month - 1 };
    }
  }
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: 'numeric',
  }).formatToParts(new Date()).map(part => [part.type, part.value]));
  return { year: Number(values.year), month: Number(values.month) - 1 };
}

function CalendarNavigationMonth({ navigationDate }) {
  const [, setMonth] = useCalendarMonth();
  const [, setYear] = useCalendarYear();
  useEffect(() => {
    const target = navigationMonth(navigationDate);
    setMonth(target.month);
    setYear(target.year);
  }, [navigationDate, setMonth, setYear]);
  return null;
}

function releaseFeatures(releases) {
  return (Array.isArray(releases) ? releases : []).flatMap((release, index) => {
    const target = dateFromValue(release?.target);
    if (!target) return [];
    const id = String(release?.id ?? `release-${index + 1}`);
    const title = String(release?.title ?? 'Release');
    return [{
      id: `release-target-${id}`,
      name: `Target · ${title}`,
      startAt: target,
      endAt: target,
      status: { id: 'target', name: 'Known target', color: 'var(--warning)' },
      kind: 'target',
      target,
      releaseId: id,
    }];
  });
}

function dateFeatureLabel(feature) {
  if (feature.kind === 'baseline') return 'Approved baseline';
  if (feature.kind === 'forecast') return 'Forecast';
  if (feature.kind === 'proposed' || feature.proposed) return 'Proposed dates';
  return feature.status?.name ?? 'Recorded dates';
}

function CalendarEvent({ feature, item, team, selectedId, onSelect }) {
  if (!item) {
    return (
      <span className="calendar-target-event" title={`${feature.name} · ${formatManilaDate(feature.endAt)}`}>
        <CalendarItem feature={feature} />
        <span className="calendar-event-kind">Known target</span>
      </span>
    );
  }

  const selected = item.id === selectedId;
  const proposed = !isAccepted(item) || feature.proposed || feature.kind === 'proposed';
  const assigned = item.owner && item.owner !== 'unassigned';
  const person = assigned ? resolvePerson(team, item.owner, item.ownerName) : null;
  const ownerLabel = person?.name ?? person?.fullName ?? item.ownerName ?? item.owner;
  return (
    <div
      className={`calendar-work-event${proposed ? ' calendar-work-event-proposed' : ''}${selected ? ' is-selected' : ''}`}
    >
      <button
        className="calendar-event-select"
        type="button"
        onClick={() => onSelect(item.id)}
        title={`${dateFeatureLabel(feature)} · ${formatManilaDate(feature.endAt)}${assigned ? ` · Assigned to ${item.ownerName || item.owner}` : ''}`}
        aria-current={selected ? 'true' : undefined}
      >
        <CalendarItem feature={feature} />
        <span className="calendar-event-kind">{dateFeatureLabel(feature)}</span>
      </button>
      {assigned ? <span className={`calendar-event-assignee${person ? '' : ' calendar-event-assignee-unmatched'}`}><PersonLink value={item.owner} name={item.ownerName} avatar assignment className="calendar-event-assignee-link">{person ? <span className="profile-visually-hidden">{ownerLabel}</span> : undefined}</PersonLink></span> : null}
    </div>
  );
}

export function CalendarView({
  items = [],
  features = [],
  releases = [],
  team = [],
  contextualIds = new Set(),
  selectedId,
  onSelect,
  navigationDate,
}) {
  const visibleItems = items.filter((item) => !contextualIds.has(item.id));
  const itemById = useMemo(() => new Map(visibleItems.map((item) => [item.id, item])), [visibleItems]);
  const visibleFeatures = features.filter((feature) => (
    itemById.has(feature.itemId) && dateFromValue(feature.endAt)
  ));
  const targets = useMemo(() => releaseFeatures(releases), [releases]);
  const events = useMemo(() => [...visibleFeatures, ...targets], [targets, visibleFeatures]);
  const datedIds = new Set(visibleFeatures.map((feature) => feature.itemId));
  const undatedItems = visibleItems.filter((item) => !datedIds.has(item.id));

  return (
    <div className="calendar-view work-mode-calendar">
      <div className="calendar-view-heading">
        <div>
          <p className="eyebrow">Recorded schedule</p>
          <p className="source-note">Work appears on its recorded finish date. Proposed dates and release targets keep their own labels.</p>
        </div>
        <span className="calendar-readonly"><ShieldAlert size={14} aria-hidden="true" />Read-only calendar</span>
      </div>

      <CalendarProvider className="tracker-calendar" locale="en-PH" startDay={0} timeZone={TIME_ZONE}>
        <CalendarNavigationMonth navigationDate={navigationDate} />
        <div className="calendar-navigation">
          <CalendarDatePagination />
          <CalendarTodayButton />
        </div>
        <CalendarHeader className="tracker-calendar-weekdays" />
        <CalendarBody className="tracker-calendar-grid" features={events}>
          {({ feature }) => (
            <CalendarEvent
              key={feature.id}
              feature={feature}
              item={feature.itemId ? itemById.get(feature.itemId) : undefined}
              team={team}
              selectedId={selectedId}
              onSelect={onSelect}
            />
          )}
        </CalendarBody>
      </CalendarProvider>

      {targets.length ? (
        <section className="calendar-release-targets" aria-labelledby="calendar-release-targets-heading">
          <div className="calendar-section-heading">
            <h3 id="calendar-release-targets-heading">Known release targets</h3>
            <span>{targets.length}</span>
          </div>
          <ul>
            {targets.map((target) => (
              <li key={target.id}>
                <CalendarDays size={15} aria-hidden="true" />
                <span><strong>{target.name.replace(/^Target · /, '')}</strong><small>Known target · {formatManilaDate(target.target)}</small></span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="calendar-undated" aria-labelledby="calendar-undated-heading">
        <div className="calendar-section-heading">
          <div>
            <h3 id="calendar-undated-heading">Undated work</h3>
            <p className="source-note">No approved or forecast finish date is recorded.</p>
          </div>
          <span>{undatedItems.length}</span>
        </div>
        {undatedItems.length ? (
          <ul>
            {undatedItems.map((item) => (
              <li key={item.id}>
                <button
                  className={`calendar-undated-item${item.id === selectedId ? ' is-selected' : ''}`}
                  type="button"
                  onClick={() => onSelect(item.id)}
                  aria-current={item.id === selectedId ? 'true' : undefined}
                >
                  <span><strong>{item.title}</strong><small>{commitmentLabel(item)} · {item.id}</small></span>
                  <ChevronRight size={16} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        ) : <p className="empty-inline">All visible work has a recorded schedule feature.</p>}
      </section>
    </div>
  );
}

export function statusColumn(item) {
  const status = String(item?.status ?? '').trim().toLowerCase().replaceAll('_', '-');
  if (item?.completed === true || status === 'done' || status === 'complete' || status === 'completed') return 'done';
  if (status === 'queued') return 'queued';
  if (status === 'active' || status === 'started') return 'active';
  if (status === 'blocked') return 'blocked';
  return null;
}

export function statusLabel(item) {
  const status = String(item?.status ?? '').trim();
  return status || 'Status not recorded';
}

function KanbanTask({ item, selectedId, onSelect }) {
  const selected = item.id === selectedId;
  const assigned = item.owner && item.owner !== 'unassigned';
  const rawStatus = String(item.status ?? '').trim();
  return (
    <div className="kanban-task-shell">
      <button
        className={`kanban-task${selected ? ' is-selected' : ''}`}
        type="button"
        onClick={() => onSelect(item.id)}
        aria-current={selected ? 'true' : undefined}
      >
        <span className="kanban-task-title">{item.title}</span>
        {rawStatus ? <span className="kanban-task-status">{rawStatus}</span> : null}
        <span className={`kanban-commitment${!isAccepted(item) ? ' kanban-commitment-proposed' : ''}`}>
          {commitmentLabel(item)}
        </span>
        <span className="kanban-task-id">{item.id}</span>
      </button>
      {assigned ? <div className="kanban-task-assignee"><PersonLink value={item.owner} name={item.ownerName} avatar assignment className="kanban-owner-link" /></div> : null}
    </div>
  );
}

export function KanbanView({
  items = [],
  contextualIds = new Set(),
  selectedId,
  onSelect,
}) {
  const visibleItems = items.filter((item) => !contextualIds.has(item.id));
  const { cards, unmapped } = useMemo(() => {
    const mapped = [];
    const unmatched = [];
    for (const item of visibleItems) {
      const column = statusColumn(item);
      if (!column) {
        unmatched.push(item);
        continue;
      }
      mapped.push({ ...item, id: item.id, name: item.title, column });
    }
    return { cards: mapped, unmapped: unmatched };
  }, [visibleItems]);

  return (
    <div className="kanban-view work-mode-kanban">
      <div className="kanban-view-heading">
        <div>
          <p className="eyebrow">Work by status</p>
          <p className="source-note">Columns reflect the tracker status. Select a card to open its source record.</p>
        </div>
        <span className="kanban-readonly"><ShieldAlert size={14} aria-hidden="true" />Read-only board</span>
      </div>

      <KanbanProvider className="tracker-kanban" columns={STATUS_COLUMNS} data={cards}>
        {(column) => {
          const columnItems = cards.filter((item) => item.column === column.id);
          return (
            <KanbanBoard className="tracker-kanban-column" id={column.id} key={column.id}>
              <KanbanHeader className="tracker-kanban-header" id={`kanban-column-${column.id}`}>
                <span>{column.name}</span>
                <span className="kanban-column-count">{columnItems.length}</span>
              </KanbanHeader>
              <KanbanCards className="tracker-kanban-cards" id={column.id}>
                {(item) => (
                  <KanbanCard
                    className="tracker-kanban-card"
                    id={item.id}
                    key={item.id}
                    name={item.name}
                    column={item.column}
                  >
                    <KanbanTask item={item} selectedId={selectedId} onSelect={onSelect} />
                  </KanbanCard>
                )}
              </KanbanCards>
            </KanbanBoard>
          );
        }}
      </KanbanProvider>

      {unmapped.length ? (
        <section className="kanban-unmapped" aria-labelledby="kanban-unmapped-heading">
          <div className="calendar-section-heading">
            <div><h3 id="kanban-unmapped-heading">Other recorded statuses</h3><p className="source-note">These source statuses do not match the four board columns.</p></div>
            <span>{unmapped.length}</span>
          </div>
          <ul>
            {unmapped.map((item) => (
              <li key={item.id}>
                <button type="button" onClick={() => onSelect(item.id)}>
                  <span><strong>{item.title}</strong><small>{statusLabel(item)} · {commitmentLabel(item)}</small></span>
                  <ChevronRight size={16} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
