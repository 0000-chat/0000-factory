import { useSyncExternalStore } from 'react';
import { ThemeSwitcher } from './components/kibo-ui/theme-switcher';
import { themeStore } from './theme';

export function ThemeControl() {
  const preference = useSyncExternalStore(
    themeStore.subscribe,
    themeStore.getPreference,
    themeStore.getPreference,
  );

  return (
    <div className="theme-control">
      <ThemeSwitcher value={preference} onChange={themeStore.setPreference} />
    </div>
  );
}
