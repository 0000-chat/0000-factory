import { createContext, useContext, type ReactNode } from 'react';

const BrowseSelectionContext = createContext<((itemId: string) => void) | null>(null);

export function BrowseSelectionProvider({ children, onSelectItem }: { children: ReactNode; onSelectItem: (itemId: string) => void }) {
  return <BrowseSelectionContext.Provider value={onSelectItem}>{children}</BrowseSelectionContext.Provider>;
}

export function useBrowseItemSelection(): (itemId: string) => void {
  const onSelectItem = useContext(BrowseSelectionContext);
  if (onSelectItem === null) throw new Error('browse selection needs the root controller');
  return onSelectItem;
}
