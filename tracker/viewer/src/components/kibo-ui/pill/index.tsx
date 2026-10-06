import type { ComponentProps } from 'react';
import { Avatar, AvatarFallback, AvatarImage } from '../../ui/avatar';
import { Badge } from '../../ui/badge';
import { Button } from '../../ui/button';
import { cn } from '../../../lib/utils';

export type PillProps = ComponentProps<typeof Badge>;

export function Pill({
  variant = 'secondary',
  className,
  ...props
}: PillProps) {
  return <Badge className={cn('person-pill gap-2 rounded-full px-3 py-1.5 font-normal', className)} variant={variant} {...props} />;
}

export type PillAvatarProps = ComponentProps<typeof AvatarImage> & {
  fallback?: string;
};

export function PillAvatar({ fallback, className, ...props }: PillAvatarProps) {
  return (
    <Avatar className={cn('person-pill-avatar -ml-1 h-4 w-4', className)}>
      <AvatarImage {...props} />
      <AvatarFallback>{fallback}</AvatarFallback>
    </Avatar>
  );
}

export type PillButtonProps = ComponentProps<typeof Button>;

export function PillButton({ className, ...props }: PillButtonProps) {
  return (
    <Button
      className={cn('pill-button -my-2 -mr-2 size-6 rounded-full p-0.5 hover:bg-foreground/5', className)}
      size="icon"
      variant="ghost"
      {...props}
    />
  );
}
