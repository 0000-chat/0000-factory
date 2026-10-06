import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
} from './components/ui/breadcrumb.tsx';
import { parseWorkSearch } from './routing-state';
import type { TrackerItem, TrackerSnapshot } from './snapshot';

type ItemAncestryRecord = Pick<TrackerItem, 'id' | 'parent' | 'title'>;

export function itemAncestors(
  item: ItemAncestryRecord,
  itemById: ReadonlyMap<string, ItemAncestryRecord>,
): ItemAncestryRecord[] {
  const ancestors: ItemAncestryRecord[] = [];
  const visited = new Set([item.id]);
  let parentId = item.parent;

  while (parentId) {
    if (visited.has(parentId)) break;
    visited.add(parentId);

    const parent = itemById.get(parentId);
    if (!parent) break;

    ancestors.push(parent);
    parentId = parent.parent;
  }

  return ancestors.reverse();
}

interface ItemBreadcrumbsProps {
  item: TrackerItem;
  data: TrackerSnapshot;
  renderItemLink?: (itemId: string, label: string) => ReactNode;
}

export function ItemBreadcrumbs({ item, data, renderItemLink }: ItemBreadcrumbsProps) {
  const ancestors = itemAncestors(item, data.itemById);

  return <Breadcrumb className="detail-hierarchy" aria-label="Work item hierarchy">
    <BreadcrumbList>
      <BreadcrumbItem>
        <BreadcrumbLink asChild><Link to="/work" search={parseWorkSearch({})}>Work</Link></BreadcrumbLink>
      </BreadcrumbItem>
      {ancestors.map(ancestor => {
        const customLink = renderItemLink?.(ancestor.id, ancestor.title);
        return <BreadcrumbItem key={ancestor.id}>
          <BreadcrumbLink asChild>{customLink ?? <Link to="/work/$itemId" params={{ itemId: ancestor.id }}>{ancestor.title}</Link>}</BreadcrumbLink>
        </BreadcrumbItem>;
      })}
      <BreadcrumbItem>
        <BreadcrumbPage>{item.title}</BreadcrumbPage>
      </BreadcrumbItem>
    </BreadcrumbList>
  </Breadcrumb>;
}
