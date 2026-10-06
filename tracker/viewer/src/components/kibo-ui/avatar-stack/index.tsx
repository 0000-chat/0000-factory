"use client";

import { Children, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "../../../lib/utils";

// Adapted from Kibo UI's AvatarStack (MIT):
// https://raw.githubusercontent.com/shadcnblocks/kibo/main/packages/avatar-stack/index.tsx
export type AvatarStackProps = Omit<HTMLAttributes<HTMLDivElement>, "children"> & {
  children: ReactNode;
  animate?: boolean;
  size?: number;
};

export const AvatarStack = ({
  children,
  className,
  animate = false,
  size = 40,
  ...props
}: AvatarStackProps) => (
  <div
    className={cn(
      "-space-x-1 flex items-center",
      animate && "hover:space-x-0 [&>*]:transition-all",
      className
    )}
    {...props}
  >
    {Children.map(children, (child, index) => {
      if (!child) return null;
      return (
        <div
          className={cn(
            "size-full shrink-0 overflow-hidden rounded-full",
            '[&_[data-slot="avatar"]]:size-full'
          )}
          style={{
            width: size,
            height: size,
            maskImage: index
              ? `radial-gradient(circle ${size / 2}px at -${size / 4 + size / 10}px 50%, transparent 99%, white 100%)`
              : undefined,
          }}
        >
          {child}
        </div>
      );
    })}
  </div>
);
