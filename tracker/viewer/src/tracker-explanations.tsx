"use client"

import type { ReactNode } from "react"
import { CircleHelpIcon } from "lucide-react"
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTrigger,
} from "./components/ui/popover"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./components/ui/tooltip"

export interface TrackerExplanationProps {
  title: string
  tooltip: string
  children: ReactNode
  className?: string
}

export function TrackerExplanation({
  title,
  tooltip,
  children,
  className = "",
}: TrackerExplanationProps) {
  return (
    <Popover>
      <TooltipProvider delayDuration={350}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <button
                type="button"
                className={`tracker-explanation-trigger ${className}`.trim()}
                aria-label={`Explain ${title}`}
              >
                <CircleHelpIcon size={16} aria-hidden="true" />
              </button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={6} className="tracker-explanation-tooltip">
            {tooltip}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <PopoverContent
        align="start"
        sideOffset={8}
        aria-label={title}
        className="tracker-explanation-popover"
      >
        <PopoverHeader className="tracker-explanation-header">
          <h2 className="tracker-explanation-title">{title}</h2>
        </PopoverHeader>
        <div className="tracker-explanation-copy">{children}</div>
      </PopoverContent>
    </Popover>
  )
}
