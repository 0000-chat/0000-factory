import type { ComponentProps, ReactNode } from "react";
import { Fragment, createContext, useContext, useMemo, useState } from "react";
import {
  Table as TableRaw,
  TableBody as TableBodyRaw,
  TableCell as TableCellRaw,
  TableHead as TableHeadRaw,
  TableHeader as TableHeaderRaw,
  TableRow as TableRowRaw,
} from "@/tracker/viewer/src/components/ui/table";
import { cn } from "@/tracker/viewer/src/lib/utils";
import { stableSortBy } from "./sorting.mjs";

/**
 * Kibo's registry table composition, adapted to TanStack Table v9's headless
 * API. The registry source targets the v8 hook API; this surface keeps the
 * official Kibo composition available without pinning the viewer to v8.
 */
export type ColumnDef<TData = unknown, TValue = unknown> = {
  id?: string;
  accessorKey?: string;
  sortingAccessor?: (original: TData) => unknown;
  enableSorting?: boolean;
  header?: ReactNode | ((context: { column: Column<TData, TValue> }) => ReactNode);
  cell?: (context: { row: Row<TData>; getValue: () => TValue }) => ReactNode;
};

type SortDirection = "asc" | "desc";

type SortingState = { id: string; direction: SortDirection };

type Column<TData = unknown, TValue = unknown> = ColumnDef<TData, TValue> & {
  id: string;
  getCanSort: () => boolean;
  getIsSorted: () => SortDirection | false;
  getToggleSortingHandler: () => (() => void) | undefined;
  toggleSorting: () => void;
};

type Row<TData = unknown, TValue = unknown> = {
  id: string;
  original: TData;
  getVisibleCells: () => Cell<TData, TValue>[];
};

type Cell<TData = unknown, TValue = unknown> = {
  id: string;
  row: Row<TData, TValue>;
  column: Column<TData, TValue>;
  getValue: () => TValue;
};

function getAccessorKeyValue<TData>(original: TData, accessorKey: string): unknown {
  if (original === null || typeof original !== "object") return undefined;
  return (original as Record<string, unknown>)[accessorKey];
}

function getSortValue<TData, TValue>(column: Column<TData, TValue>, original: TData): unknown {
  if (column.sortingAccessor) return column.sortingAccessor(original);
  return column.accessorKey ? getAccessorKeyValue(original, column.accessorKey) : undefined;
}

type TableContextValue = {
  columns: Column<any, any>[];
  rows: Row<any, any>[];
};

const TableContext = createContext<TableContextValue>({ columns: [], rows: [] });

export type TableProviderProps<TData, TValue> = {
  columns: ColumnDef<TData, TValue>[];
  data: TData[];
  children: ReactNode;
  className?: string;
};

export function TableProvider<TData, TValue>({ columns, data, children, className }: TableProviderProps<TData, TValue>) {
  const [sorting, setSorting] = useState<SortingState | null>(null);
  const value = useMemo<TableContextValue>(() => {
    const normalizedColumns: Column<TData, TValue>[] = columns.map((column, index): Column<TData, TValue> => {
      const id = column.id ?? column.accessorKey ?? `column-${index}`;
      const getCanSort = () => column.enableSorting !== false && Boolean(column.accessorKey || column.sortingAccessor);
      const toggleSorting = () => {
        if (!getCanSort()) return;
        setSorting(current => current?.id === id
          ? { id, direction: current.direction === "asc" ? "desc" : "asc" }
          : { id, direction: "asc" });
      };
      return {
        ...column,
        id,
        getCanSort,
        getIsSorted: () => sorting?.id === id ? sorting.direction : false,
        getToggleSortingHandler: () => getCanSort() ? toggleSorting : undefined,
        toggleSorting,
      };
    });
    const rows = data.map((original, index): Row<TData, TValue> => {
      const row: Row<TData, TValue> = { id: String(index), original, getVisibleCells: () => [] };
      row.getVisibleCells = () => normalizedColumns.map(column => ({
        id: `${row.id}-${column.id}`,
        row,
        column,
        getValue: () => (column.accessorKey ? getAccessorKeyValue(original, column.accessorKey) : undefined) as TValue,
      }));
      return row;
    });
    const sortedColumn = sorting && normalizedColumns.find(column => column.id === sorting.id && column.getCanSort());
    const sortedRows: Row<TData, TValue>[] = sortedColumn
      ? stableSortBy(rows, (row: Row<TData, TValue>) => getSortValue(sortedColumn, row.original), sorting.direction)
      : rows;
    return { columns: normalizedColumns, rows: sortedRows };
  }, [columns, data, sorting]);

  return <TableContext.Provider value={value}><TableRaw className={cn("kibo-table", className)}>{children}</TableRaw></TableContext.Provider>;
}

export type TableHeadProps = { header: { id: string; isPlaceholder?: boolean; column: Column } };

export const TableHead = ({ header }: TableHeadProps) => {
  const content = typeof header.column.header === "function" ? header.column.header({ column: header.column }) : header.column.header;
  const sortable = header.column.getCanSort();
  const sorted = header.column.getIsSorted();
  const label = typeof content === "string" || typeof content === "number" ? String(content) : header.column.id;
  const nextDirection = sorted === "asc" ? "descending" : "ascending";
  const ariaSort = sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : "none";
  return (
    <TableHeadRaw key={header.id} aria-sort={sortable ? ariaSort : undefined}>
      {header.isPlaceholder ? null : sortable ? (
        <button
          type="button"
          className="kibo-table-sort-button"
          aria-label={`Sort by ${label}, ${nextDirection}`}
          onClick={header.column.getToggleSortingHandler()}
          style={{ background: "transparent", border: 0, color: "inherit", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: "0.3rem", font: "inherit", letterSpacing: "inherit", padding: 0, textAlign: "inherit", textTransform: "inherit" }}
        >
          {content ?? header.column.id}
          <span className="kibo-table-sort-indicator" aria-hidden="true">{sorted === "asc" ? "↑" : sorted === "desc" ? "↓" : "↕"}</span>
        </button>
      ) : content ?? header.column.id}
    </TableHeadRaw>
  );
};

export type TableHeaderGroupProps = { headerGroup: { id: string; headers: Array<{ id: string; column: Column }> }; children: (props: { header: { id: string; isPlaceholder?: boolean; column: Column } }) => ReactNode };

export const TableHeaderGroup = ({ headerGroup, children }: TableHeaderGroupProps) => <TableRowRaw key={headerGroup.id}>{headerGroup.headers.map(header => <Fragment key={header.id}>{children({ header })}</Fragment>)}</TableRowRaw>;

export type TableHeaderProps = { className?: string; children: (props: { headerGroup: { id: string; headers: Array<{ id: string; column: Column }> } }) => ReactNode };

export const TableHeader = ({ className, children }: TableHeaderProps) => {
  const { columns } = useContext(TableContext);
  return <TableHeaderRaw className={className}>{children({ headerGroup: { id: "header", headers: columns.map(column => ({ id: column.id, column })) } })}</TableHeaderRaw>;
};

export type TableCellProps = { cell: Cell; className?: string };

export const TableCell = ({ cell, className }: TableCellProps) => {
  const content = (cell.column.cell ? cell.column.cell({ row: cell.row, getValue: cell.getValue }) : cell.getValue()) as ReactNode;
  return <TableCellRaw className={className}>{content}</TableCellRaw>;
};

export type TableRowProps = { row: Row; children: (props: { cell: Cell }) => ReactNode } & Omit<ComponentProps<typeof TableRowRaw>, "children">;

export const TableRow = ({ row, children, ...props }: TableRowProps) => <TableRowRaw {...props} data-state="false" key={row.id}>{row.getVisibleCells().map(cell => <Fragment key={cell.id}>{children({ cell })}</Fragment>)}</TableRowRaw>;

export type TableBodyProps = { children: (props: { row: Row }) => ReactNode; className?: string };

export const TableBody = ({ children, className }: TableBodyProps) => {
  const { columns, rows } = useContext(TableContext);
  return <TableBodyRaw className={className}>{rows.length ? rows.map(row => <Fragment key={row.id}>{children({ row })}</Fragment>) : <TableRowRaw><TableCellRaw className="h-24 text-center" colSpan={columns.length}>No results.</TableCellRaw></TableRowRaw>}</TableBodyRaw>;
};
