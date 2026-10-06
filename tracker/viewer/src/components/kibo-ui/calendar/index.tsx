"use client";

// Read-only adaptation of Kibo UI's calendar registry component. The date grid,
// composable provider/body/header/item API, and month pagination follow the
// official source at https://github.com/shadcnblocks/kibo/tree/main/packages/calendar.
// The optional command/popover date pickers are omitted because this viewer
// only needs month navigation and a Today action.

import { getDay, getDaysInMonth } from "date-fns";
import { atom, useAtom } from "jotai";
import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  createContext,
  memo,
  useContext,
  useMemo,
  type ReactNode,
  type HTMLAttributes,
} from "react";
import { Button } from "../../ui/button.tsx";
import { cn } from "../../../lib/utils.ts";

export type CalendarState = {
  month: number;
  year: number;
};

const todayParts = (timeZone: string) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return {
    month: Number(values.month) - 1,
    year: Number(values.year),
  };
};

const initialCalendarDate = todayParts("Asia/Manila");
const monthAtom = atom(initialCalendarDate.month);
const yearAtom = atom(initialCalendarDate.year);

export const useCalendarMonth = () => useAtom(monthAtom);
export const useCalendarYear = () => useAtom(yearAtom);

type CalendarContextProps = {
  locale: Intl.LocalesArgument;
  startDay: number;
  timeZone: string;
};

const CalendarContext = createContext<CalendarContextProps>({
  locale: "en-PH",
  startDay: 0,
  timeZone: "Asia/Manila",
});

export type CalendarStatus = {
  id: string;
  name: string;
  color: string;
};

export type CalendarFeature = {
  id: string;
  name: string;
  startAt: Date;
  endAt: Date;
  status: CalendarStatus;
  itemId?: string;
  kind?: string;
  proposed?: boolean;
  rangeLabel?: string;
};

const dateKeyFromParts = (year: number, month: number, day: number) =>
  `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

const dateKeyInTimeZone = (date: Date, timeZone: string) => {
  if (Number.isNaN(date.valueOf())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  if (!values.year || !values.month || !values.day) return null;
  return `${values.year}-${values.month}-${values.day}`;
};

export type CalendarProviderProps = {
  locale?: Intl.LocalesArgument;
  startDay?: number;
  timeZone?: string;
  children: ReactNode;
  className?: string;
};

export const CalendarProvider = ({
  locale = "en-PH",
  startDay = 0,
  timeZone = "Asia/Manila",
  children,
  className,
}: CalendarProviderProps) => (
  <CalendarContext.Provider value={{ locale, startDay, timeZone }}>
    <div className={cn("relative flex min-w-0 flex-col", className)}>{children}</div>
  </CalendarContext.Provider>
);

export type CalendarDatePaginationProps = {
  className?: string;
};

export const CalendarDatePagination = ({ className }: CalendarDatePaginationProps) => {
  const [month, setMonth] = useCalendarMonth();
  const [year, setYear] = useCalendarYear();
  const { locale } = useContext(CalendarContext);
  const monthTitle = new Intl.DateTimeFormat(locale, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month, 1, 12)));

  const changeMonth = (delta: number) => {
    const next = new Date(Date.UTC(year, month + delta, 1, 12));
    setMonth(next.getUTCMonth());
    setYear(next.getUTCFullYear());
  };

  return (
    <div className={cn("flex items-center justify-between gap-3", className)}>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        aria-label="Previous month"
        onClick={() => changeMonth(-1)}
      >
        <ChevronLeft aria-hidden="true" />
      </Button>
      <h2 className="calendar-month-title" aria-live="polite">{monthTitle}</h2>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        aria-label="Next month"
        onClick={() => changeMonth(1)}
      >
        <ChevronRight aria-hidden="true" />
      </Button>
    </div>
  );
};

export const CalendarTodayButton = ({ className }: { className?: string }) => {
  const [month, setMonth] = useCalendarMonth();
  const [year, setYear] = useCalendarYear();
  const { timeZone } = useContext(CalendarContext);

  const goToToday = () => {
    const today = todayParts(timeZone);
    setMonth(today.month);
    setYear(today.year);
  };

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={className}
      aria-current={
        month === todayParts(timeZone).month && year === todayParts(timeZone).year
          ? "date"
          : undefined
      }
      onClick={goToToday}
    >
      Today
    </Button>
  );
};

export type CalendarDateProps = HTMLAttributes<HTMLDivElement>;

export const CalendarDate = ({ children, className, ...props }: CalendarDateProps) => (
  <div className={className} {...props}>{children}</div>
);

export type CalendarHeaderProps = {
  className?: string;
};

export const daysForLocale = (locale: Intl.LocalesArgument, startDay: number) => {
  const weekdays: string[] = [];
  const baseDate = new Date(2024, 0, startDay);

  for (let index = 0; index < 7; index += 1) {
    weekdays.push(new Intl.DateTimeFormat(locale, { weekday: "short" }).format(baseDate));
    baseDate.setDate(baseDate.getDate() + 1);
  }

  return weekdays;
};

export const CalendarHeader = ({ className }: CalendarHeaderProps) => {
  const { locale, startDay } = useContext(CalendarContext);
  const weekdays = useMemo(() => daysForLocale(locale, startDay), [locale, startDay]);

  return (
    <div
      className={cn("grid grid-cols-7", className)}
      aria-label="Days of the week"
    >
      {weekdays.map((day) => (
        <div className="calendar-weekday" key={day}>
          {day}
        </div>
      ))}
    </div>
  );
};

export type CalendarBodyProps = {
  features: CalendarFeature[];
  children: (props: { feature: CalendarFeature }) => ReactNode;
  className?: string;
};

export const CalendarBody = ({ features, children, className }: CalendarBodyProps) => {
  const [month] = useCalendarMonth();
  const [year] = useCalendarYear();
  const { startDay, timeZone, locale } = useContext(CalendarContext);
  const currentMonthDate = useMemo(() => new Date(year, month, 1), [year, month]);
  const daysInMonth = useMemo(() => getDaysInMonth(currentMonthDate), [currentMonthDate]);
  const firstDay = useMemo(
    () => (getDay(currentMonthDate) - startDay + 7) % 7,
    [currentMonthDate, startDay],
  );

  const featuresByDay = useMemo(() => {
    const grouped = new Map<string, CalendarFeature[]>();
    for (const feature of features) {
      const key = dateKeyInTimeZone(new Date(feature.endAt), timeZone);
      if (!key) continue;
      const list = grouped.get(key) ?? [];
      list.push(feature);
      grouped.set(key, list);
    }
    return grouped;
  }, [features, timeZone]);

  const dates = useMemo(() => {
    const count = Math.ceil((firstDay + daysInMonth) / 7) * 7;
    return Array.from({ length: count }, (_, index) => {
      const day = index - firstDay + 1;
      const date = new Date(year, month, day);
      const isCurrentMonth = date.getMonth() === month;
      const key = dateKeyFromParts(date.getFullYear(), date.getMonth(), date.getDate());
      return { date, day: date.getDate(), isCurrentMonth, key };
    });
  }, [daysInMonth, firstDay, month, year]);

  const todayKey = dateKeyInTimeZone(new Date(), timeZone);

  return (
    <div className={cn("grid grid-cols-7", className)} role="grid" aria-label="Calendar">
      {dates.map(({ date, day, isCurrentMonth, key }) => {
        const dayFeatures = featuresByDay.get(key) ?? [];
        const dateLabel = new Intl.DateTimeFormat(locale, {
          weekday: "long",
          month: "long",
          day: "numeric",
          year: "numeric",
          timeZone: "UTC",
        }).format(new Date(Date.UTC(date.getFullYear(), date.getMonth(), day, 12)));

        return (
          <CalendarDate
            className={cn(
              "calendar-day-cell",
              !isCurrentMonth && "calendar-day-outside",
              key === todayKey && "calendar-day-today",
            )}
            key={key}
            role="gridcell"
            aria-label={dateLabel}
            data-date={key}
            data-current-month={isCurrentMonth ? "true" : "false"}
            data-today={key === todayKey ? "true" : undefined}
          >
            <time className="calendar-day-number" dateTime={key}>{day}</time>
            <div className="calendar-day-features">
              {dayFeatures.map((feature) => (
                <span key={feature.id}>{children({ feature })}</span>
              ))}
            </div>
          </CalendarDate>
        );
      })}
    </div>
  );
};

export type CalendarItemProps = {
  feature: CalendarFeature;
  className?: string;
};

export const CalendarItem = memo(({ feature, className }: CalendarItemProps) => (
  <span className={cn("calendar-item", className)} title={feature.name}>
    <span
      className="calendar-item-dot"
      style={{ backgroundColor: feature.status.color }}
      aria-hidden="true"
    />
    <span className="calendar-item-name">{feature.name}</span>
  </span>
));

CalendarItem.displayName = "CalendarItem";
