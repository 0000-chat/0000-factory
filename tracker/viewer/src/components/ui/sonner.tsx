import { useSyncExternalStore, type CSSProperties } from 'react';
import { Toaster as SonnerToaster } from 'sonner';
import { themeStore } from '../../theme';
import type { ResolvedTheme } from '../../theme';
import { trackerInstanceConfig } from '../../instance-config';
import './sonner.css';

const toasterStyle = {
  '--normal-bg': 'var(--card)',
  '--normal-border': 'var(--border)',
  '--normal-text': 'var(--foreground)',
  '--success-bg': 'var(--success-subtle)',
  '--success-border': 'color-mix(in srgb, var(--success) 40%, var(--border))',
  '--success-text': 'var(--success)',
  '--info-bg': 'var(--accent)',
  '--info-border': 'var(--border)',
  '--info-text': 'var(--foreground)',
  '--warning-bg': 'var(--warning-subtle)',
  '--warning-border': 'color-mix(in srgb, var(--warning) 40%, var(--border))',
  '--warning-text': 'var(--warning)',
  '--error-bg': 'var(--danger-subtle)',
  '--error-border': 'color-mix(in srgb, var(--destructive) 40%, var(--border))',
  '--error-text': 'var(--destructive)',
} as CSSProperties;

export function Toaster() {
  const theme = useSyncExternalStore<ResolvedTheme>(
    themeStore.subscribe,
    themeStore.getResolvedTheme,
    () => 'light',
  );

  return (
    <SonnerToaster
      theme={theme}
      position="bottom-center"
      expand
      visibleToasts={4}
      closeButton
      richColors
      duration={5000}
      className="tracker-sonner"
      style={toasterStyle}
      toastOptions={{ closeButton: true, duration: 5000, className: `tracker-${trackerInstanceConfig.id}-toast` }}
    />
  );
}
