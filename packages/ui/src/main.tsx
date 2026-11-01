import React, { useState, useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { SourceVersionProvider } from './contexts/SourceVersionContext';
import { I18nextProvider } from 'react-i18next';
import i18n from './i18n';
import { ErrorBoundary } from './components/ErrorBoundary';
import { RecoveryScreen } from './components/RecoveryScreen';
import { getDbHealth, isDbUnhealthy, RECOVERY_SCREEN_ENABLED, type DbHealth } from './services/recovery';
import { installSafeStorage } from './services/safeStorage';
import './App.css';
import './services/tauri-bridge'; // Initialize Tauri bridge and polyfills
import { ensureSettingsHydration } from './stores/settingsStoreHydration';
import { ensureLocalLibraryLoaded } from './services/local-library/local-library';
// Side-effect import AFTER the settings store: self-initializes the single
// DOM applier (subscribes to the store at module load) so the first paint is
// already correct from the localStorage-seeded store state. Imported here —
// after the store modules have fully evaluated — to avoid the circular
// import deadlock that a store-side import would cause (the applier reads
// useSettingsStore at module scope).
import './stores/settingsDomApplier';
import { useSportsSettingsStore } from './stores/sportsSettingsStore';
// Side-effect import AFTER the settings store + applier: self-initializes the
// scroll listener that toggles the `scroll-turbo` class (drops backdrop blur
// and blob blending while scrolling, restores on idle). Reads the
// reduceEffectsWhileScrolling setting from the store at event time.
import './utils/scrollTurbo';
import { installTvRemote } from './services/tvRemote';
import { installMediaCoreTmdbProxy } from './services/mediacore';

// Must run before any component mounts: a localStorage write that exceeds the
// WebView2 quota must never crash the (transparent) window.
installSafeStorage();

// Android TV: route the remote's D-pad / OK / Back through spatial navigation.
installTvRemote();

// TMDB requests made on behalf of a MediaCore account go through its server.
installMediaCoreTmdbProxy();

// Kick off the single boot-time settings load (the store seeds synchronously
// from localStorage for first paint; this reconciles the authoritative values
// from the Tauri store in the background — exactly once per run).
ensureSettingsHydration();

// Load the Local VOD library from SQLite at boot (migrating the legacy
// localStorage copy). The library is stored in the SQLite app_kv table — not
// localStorage — so large libraries (tens of thousands of entries) never hit
// the WebView2 localStorage quota (~10 MB), which previously made big folder
// scans silently fail to persist.
ensureLocalLibraryLoaded().catch(() => {});

// Boot-time sports settings load. The sports settings store (live leagues,
// autoSwapDeadStreams, …) previously hydrated only when a Sports-view
// component mounted (SportsHub, tabs, or the overlay widget). That left the
// "Autoswap dead streams" toggle at its default OFF whenever a team-linked
// channel was played from Live TV before ever visiting Sports — so team
// failover silently never fired. Loading here makes the persisted value
// authoritative from startup; the components' `if (!loaded)` guards keep
// their later calls no-ops.
useSportsSettingsStore.getState().loadSettings().catch(() => {});

/**
 * Checks the database before mounting the main app. If the database is
 * oversized or unopenable (a multi-GB EPG cache, or a huge WAL left by a
 * forced close), the app can hang or render an invisible transparent window.
 * In that case a recovery screen is shown first so the user can export their
 * data, rebuild the cache, or import a backup.
 */
function RecoveryGate() {
  const [state, setState] = useState<{ checking: boolean; health: DbHealth | null }>({
    checking: true,
    health: null,
  });

  useEffect(() => {
    // Disabled by default — only run the health check on startup when the
    // recovery screen is enabled (a recovery build). See RECOVERY_SCREEN_ENABLED.
    if (!RECOVERY_SCREEN_ENABLED) {
      setState({ checking: false, health: null });
      return;
    }
    let cancelled = false;
    getDbHealth()
      .then((health) => {
        if (!cancelled) setState({ checking: false, health });
      })
      .catch(() => {
        // If the health check itself fails, don't block the app.
        if (!cancelled) setState({ checking: false, health: null });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.checking) return null;
  if (RECOVERY_SCREEN_ENABLED && state.health && isDbUnhealthy(state.health)) {
    return (
      <RecoveryScreen
        health={state.health}
        onContinue={() => setState({ checking: false, health: null })}
      />
    );
  }
  return <App />;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <I18nextProvider i18n={i18n}>
        <SourceVersionProvider>
          <RecoveryGate />
        </SourceVersionProvider>
      </I18nextProvider>
    </ErrorBoundary>
  </React.StrictMode>
);
