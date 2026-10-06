import type { ReactNode } from 'react';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from './components/ui/empty.tsx';

interface TrackerEmptyProps {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
  headerClassName?: string;
  titleClassName?: string;
  descriptionClassName?: string;
  contentClassName?: string;
}

export function TrackerEmpty({
  title,
  description,
  icon,
  action,
  className,
  headerClassName,
  titleClassName,
  descriptionClassName,
  contentClassName,
}: TrackerEmptyProps) {
  return <Empty className={className}>
    <EmptyHeader className={headerClassName}>
      {icon ? <EmptyMedia variant="icon">{icon}</EmptyMedia> : null}
      <EmptyTitle className={titleClassName}>{title}</EmptyTitle>
      {description ? <EmptyDescription className={descriptionClassName}>{description}</EmptyDescription> : null}
    </EmptyHeader>
    {action ? <EmptyContent className={contentClassName}>{action}</EmptyContent> : null}
  </Empty>;
}
