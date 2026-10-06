"use client";

// Read-only adaptation of Kibo UI's official Kanban registry component.
// Provider/board/card composition and layout follow
// https://github.com/shadcnblocks/kibo/tree/main/packages/kanban. The viewer
// intentionally removes dnd-kit sensors and state updates so status stays tied
// to the source tracker; cards remain regular, keyboard-accessible buttons.

import {
  createContext,
  Fragment,
  useContext,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { Card } from "../../ui/card.tsx";
import { ScrollArea, ScrollBar } from "../../ui/scroll-area.tsx";
import { cn } from "../../../lib/utils.ts";

export type KanbanItemProps = {
  id: string;
  name: string;
  column: string;
} & Record<string, unknown>;

export type KanbanColumnProps = {
  id: string;
  name: string;
} & Record<string, unknown>;

type KanbanContextProps = {
  data: KanbanItemProps[];
};

const KanbanContext = createContext<KanbanContextProps>({ data: [] });

export type KanbanProviderProps<
  T extends KanbanItemProps = KanbanItemProps,
  C extends KanbanColumnProps = KanbanColumnProps,
> = {
  children: (column: C) => ReactNode;
  className?: string;
  columns: C[];
  data: T[];
};

export const KanbanProvider = <
  T extends KanbanItemProps = KanbanItemProps,
  C extends KanbanColumnProps = KanbanColumnProps,
>({ children, className, columns, data }: KanbanProviderProps<T, C>) => (
  <KanbanContext.Provider value={{ data }}>
    <div className={cn("kanban-provider min-w-0", className)} role="region" aria-label="Read-only work board">
      <ScrollArea className="kanban-scroll-area">
        <div className="kanban-columns">
          {columns.map((column) => (
            <Fragment key={column.id}>{children(column)}</Fragment>
          ))}
        </div>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>
    </div>
  </KanbanContext.Provider>
);

export type KanbanBoardProps = {
  id: string;
  children: ReactNode;
  className?: string;
};

export const KanbanBoard = ({ id, children, className }: KanbanBoardProps) => (
  <section
    className={cn(
      "kanban-board flex min-h-40 min-w-0 flex-col divide-y overflow-hidden rounded-md border bg-secondary text-xs shadow-sm",
      className,
    )}
    data-column={id}
    aria-labelledby={`kanban-column-${id}`}
  >
    {children}
  </section>
);

export type KanbanHeaderProps = HTMLAttributes<HTMLDivElement>;

export const KanbanHeader = ({ className, ...props }: KanbanHeaderProps) => (
  <div
    className={cn("kanban-header m-0 p-2 text-sm font-semibold", className)}
    {...props}
  />
);

export type KanbanCardsProps<T extends KanbanItemProps = KanbanItemProps> =
  Omit<HTMLAttributes<HTMLDivElement>, "children" | "id"> & {
    children: (item: T) => ReactNode;
    id: string;
  };

export const KanbanCards = <T extends KanbanItemProps = KanbanItemProps>({
  children,
  className,
  id,
  ...props
}: KanbanCardsProps<T>) => {
  const { data } = useContext(KanbanContext);
  const cards = data.filter((item) => item.column === id) as T[];

  return (
    <div className={cn("kanban-cards flex min-h-32 flex-1 flex-col gap-2 p-2", className)} {...props}>
      {cards.length ? (
        cards.map((item) => children(item))
      ) : (
        <p className="kanban-empty m-0 rounded-md border border-dashed p-3 text-center text-muted-foreground">
          No work in this status.
        </p>
      )}
    </div>
  );
};

export type KanbanCardProps<T extends KanbanItemProps = KanbanItemProps> = T & {
  children?: ReactNode;
  className?: string;
};

export const KanbanCard = <T extends KanbanItemProps = KanbanItemProps>({
  id,
  name,
  children,
  className,
}: KanbanCardProps<T>) => (
  <Card
    className={cn("kanban-card gap-3 rounded-md p-0 shadow-sm", className)}
    data-item-id={id}
  >
    {children ?? <p className="m-0 p-3 font-medium text-sm">{name}</p>}
  </Card>
);
