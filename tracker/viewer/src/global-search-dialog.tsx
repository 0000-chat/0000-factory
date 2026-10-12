import { useEffect, useMemo, useRef, useState } from 'react';
import { BarChart3, CalendarDays, ClipboardList, LayoutDashboard, Search, Users } from 'lucide-react';
import { Button } from './components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from './components/ui/command';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from './components/ui/dialog';
import { searchSnapshot } from './global-search';
import type { TrackerSnapshot } from './snapshot';
import { TrackerEmpty } from './tracker-empty';

type SearchGroup = ReturnType<typeof searchSnapshot>[number];
export type GlobalSearchResult = SearchGroup['results'][number];

const shortcuts = [
  { label: 'Today', href: '/today', icon: CalendarDays },
  { label: 'Work', href: '/work', icon: LayoutDashboard },
  { label: 'Plans', href: '/plans', icon: ClipboardList },
  { label: 'Team', href: '/team', icon: Users },
  { label: 'Reports', href: '/reports', icon: BarChart3 },
] as const;

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]') !== null;
}

function shortcutLabel(): string {
  if (typeof navigator === 'undefined') return 'Ctrl K';
  return /Mac|iPhone|iPad|iPod/u.test(navigator.platform) ? '⌘ K' : 'Ctrl K';
}

export function GlobalSearchDialog({
  data,
  onNavigate,
  onSelectResult,
}: {
  data: TrackerSnapshot;
  onNavigate: (href: string) => void;
  onSelectResult: (result: GlobalSearchResult) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const hasQuery = query.trim().length > 0;
  const groups = useMemo(() => hasQuery ? searchSnapshot(data, query) : [], [data, hasQuery, query]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((!event.metaKey && !event.ctrlKey)
        || event.altKey
        || event.shiftKey
        || event.key.toLowerCase() !== 'k'
        || isEditableTarget(event.target)) return;
      event.preventDefault();
      setOpen(true);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const onOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) setQuery('');
  };

  const onCloseAutoFocus = (event: Event) => {
    event.preventDefault();
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const selectHref = (href: string) => {
    onNavigate(href);
    onOpenChange(false);
  };

  const selectResult = (result: GlobalSearchResult) => {
    onSelectResult(result);
    onOpenChange(false);
  };

  return <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button
          ref={triggerRef}
          type="button"
          variant="outline"
          className="global-search-trigger"
          aria-label="Search tracker"
        >
          <Search aria-hidden="true" />
          <span className="global-search-trigger-label">Search</span>
          <kbd className="global-search-trigger-shortcut" aria-hidden="true">{shortcutLabel()}</kbd>
        </Button>
      </DialogTrigger>
      <DialogContent className="global-search-dialog" onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader className="sr-only">
          <DialogTitle>Search the tracker</DialogTitle>
          <DialogDescription>Find work, plans, people, and decisions in the current snapshot.</DialogDescription>
        </DialogHeader>
        <Command shouldFilter={false} className="global-search-command">
          <CommandInput
            aria-label="Search tracker"
            placeholder="Search work, plans, people, and decisions…"
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            {!hasQuery ? <CommandGroup heading="Go to">
              {shortcuts.map(({ label, href, icon: Icon }) => <CommandItem
                key={href}
                value={`go to ${label}`}
                onSelect={() => selectHref(href)}
              >
                <Icon className="global-search-shortcut-icon" aria-hidden="true" />
                <span>{label}</span>
              </CommandItem>)}
            </CommandGroup> : null}
            {hasQuery ? groups.map(group => <CommandGroup key={group.kind} heading={`${group.label} (${group.total})`}>
              {group.results.map(result => <CommandItem
                key={`${group.kind}:${result.id}`}
                value={`${result.title} ${result.subtitle ?? ''} ${result.id} ${group.label}`}
                onSelect={() => selectResult(result)}
              >
                <span className="global-search-result-copy">
                  <span className="global-search-result-title">{result.title}</span>
                  {result.referenceCode ? <span className="global-search-result-code">{result.referenceCode}</span> : null}
                  {result.subtitle ? <span className="global-search-result-subtitle">{result.subtitle}</span> : null}
                </span>
              </CommandItem>)}
            </CommandGroup>) : null}
            {hasQuery ? <CommandEmpty className="global-search-no-results">
              <TrackerEmpty
                className="global-search-empty"
                title={<p>No matching results</p>}
                description={<p>No results for <span className="global-search-empty-query">“{query.trim()}”</span>.</p>}
                action={<Button type="button" variant="ghost" className="global-search-clear-button" onClick={() => setQuery('')}>Clear search</Button>}
              />
            </CommandEmpty> : null}
          </CommandList>
        </Command>
        <div className="global-search-footer" aria-hidden="true">
          <span><kbd>↑</kbd><kbd>↓</kbd> to move</span>
          <span><kbd>↵</kbd> to open</span>
          <span><kbd>Esc</kbd> to close</span>
        </div>
      </DialogContent>
    </Dialog>
  </>;
}
