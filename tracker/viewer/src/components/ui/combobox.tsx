"use client"

import * as React from "react"
import { CheckIcon, ChevronsUpDownIcon } from "lucide-react"
import { Button } from "./button"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "./command"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "./popover"

export interface ComboboxOption {
  value: string
  label: string
}

export interface ComboboxProps {
  id?: string
  value: string
  options: readonly ComboboxOption[]
  onValueChange: (value: string) => void
  ariaLabel: string
  placeholder: string
  searchLabel: string
  searchPlaceholder: string
  emptyMessage: string
}

export function Combobox({
  id,
  value,
  options,
  onValueChange,
  ariaLabel,
  placeholder,
  searchLabel,
  searchPlaceholder,
  emptyMessage,
}: ComboboxProps) {
  const [open, setOpen] = React.useState(false)
  const selectedOption = options.find(option => option.value === value)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-label={ariaLabel}
          aria-expanded={open}
          className="tracker-combobox-trigger"
        >
          <span className="tracker-combobox-value">{selectedOption?.label ?? placeholder}</span>
          <ChevronsUpDownIcon aria-hidden="true" className="tracker-combobox-chevron" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={4}
        className="tracker-combobox-popover"
      >
        <Command className="tracker-combobox-command" loop>
          <CommandInput
            aria-label={searchLabel}
            placeholder={searchPlaceholder}
          />
          <CommandList>
            <CommandEmpty>{emptyMessage}</CommandEmpty>
            <CommandGroup>
              {options.map(option => (
                <CommandItem
                  key={option.value}
                  value={`${option.label} ${option.value}`}
                  onSelect={() => {
                    onValueChange(option.value)
                    setOpen(false)
                  }}
                  className="tracker-combobox-option"
                >
                  <CheckIcon
                    aria-hidden="true"
                    className="tracker-combobox-check"
                    data-current={option.value === value}
                  />
                  <span>{option.label}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
