import { useState, useEffect } from 'react';
import type { LayoutMode } from '../../hooks/useMultiview';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';

export interface SavedLayoutState {
  layout: LayoutMode;
  mainChannel: {
    channelName: string | null;
    channelUrl: string | null;
  };
  slots: {
    id: 2 | 3 | 4;
    channelName: string | null;
    channelUrl: string | null;
    active: boolean;
  }[];
}

interface StartupTabProps {
  rememberLastChannels: boolean;
  reopenLastOnStartup: boolean;
  savedLayoutState: SavedLayoutState | null;
  startupView: 'none' | 'guide' | 'movies' | 'series' | 'dvr' | 'sports' | 'calendar' | 'stremio';
  onRememberLastChannelsChange: (value: boolean) => void;
  onReopenLastOnStartupChange: (value: boolean) => void;
  onStartupViewChange: (value: 'none' | 'guide' | 'movies' | 'series' | 'dvr' | 'sports' | 'calendar' | 'stremio') => void;
}

export function StartupTab({
  rememberLastChannels,
  reopenLastOnStartup,
  savedLayoutState,
  startupView,
  onRememberLastChannelsChange,
  onReopenLastOnStartupChange,
  onStartupViewChange,
}: StartupTabProps) {
  useTranslation();
  const [localValue, setLocalValue] = useState(rememberLastChannels);
  const [localReopenValue, setLocalReopenValue] = useState(reopenLastOnStartup);

  useEffect(() => {
    setLocalValue(rememberLastChannels);
  }, [rememberLastChannels]);

  useEffect(() => {
    setLocalReopenValue(reopenLastOnStartup);
  }, [reopenLastOnStartup]);

  const handleToggle = (checked: boolean) => {
    setLocalValue(checked);
    onRememberLastChannelsChange(checked);

    // Automatically switch off 'reopen' if we just disabled 'remember'
    if (!checked) {
      setLocalReopenValue(false);
      // Let Settings.tsx handle pushing the dependent state correctly to DB
    }
  };

  const handleReopenToggle = (checked: boolean) => {
    if (!localValue && checked) return; // Prevent enabling if remember channels isn't enabled
    setLocalReopenValue(checked);
    onReopenLastOnStartupChange(checked);
  };

  const getLayoutLabel = (layout: LayoutMode): string => {
    switch (layout) {
      case 'main': return i18n.t('settings:startup.layouts.main');
      case 'pip': return i18n.t('settings:startup.layouts.pip');
      case '2x2': return i18n.t('settings:startup.layouts.grid2x2');
      case 'bigbottom': return i18n.t('settings:startup.layouts.bigbottom');
      default: return layout;
    }
  };

  const getActiveChannelCount = (): number => {
    if (!savedLayoutState) return 0;
    let count = savedLayoutState.mainChannel.channelUrl ? 1 : 0;
    count += savedLayoutState.slots.filter(s => s.active).length;
    return count;
  };

  return (
    <div className="settings-tab-content">
      {/* Remember Channels Section */}
      <div className="settings-section" style={{ paddingBottom: '8px' }}>
        <div className="section-header">
          <h3>{i18n.t('settings:startup.title')}</h3>
        </div>

        <p className="section-description" style={{ marginBottom: '12px' }}>
          {i18n.t('settings:startup.description')}
        </p>

        {/* Startup View Selector */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0.75rem 0',
            borderBottom: '1px solid var(--surface-border)',
          }}
        >
          <div style={{ flex: 1 }}>
            <div style={{ color: 'var(--text-primary)', fontSize: '0.95rem' }}>
              {i18n.t('settings:startup.startupView')}
            </div>
            <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginTop: '0.25rem' }}>
              {i18n.t('settings:startup.startupViewTooltip')}
            </div>
          </div>
          <select
            value={startupView}
            onChange={(e) => onStartupViewChange(e.target.value as StartupTabProps['startupView'])}
            style={{
              marginLeft: '1rem',
              padding: '0.4rem 0.6rem',
              borderRadius: '6px',
              border: '1px solid var(--surface-border)',
              background: 'var(--bg-tertiary)',
              color: 'var(--text-primary)',
              fontSize: '0.9rem',
              cursor: 'pointer',
              minWidth: '140px',
            }}
          >
            <option value="none">{i18n.t('settings:startup.views.none')}</option>
            <option value="guide">{i18n.t('settings:startup.views.guide')}</option>
            <option value="movies">{i18n.t('settings:startup.views.movies')}</option>
            <option value="series">{i18n.t('settings:startup.views.series')}</option>
            <option value="sports">{i18n.t('settings:startup.views.sports')}</option>
            <option value="calendar">{i18n.t('settings:startup.views.calendar')}</option>
            <option value="dvr">{i18n.t('settings:startup.views.dvr')}</option>
            <option value="stremio">{i18n.t('settings:startup.views.stremio')}</option>
          </select>
        </div>

        {/* Remember Last Channels Toggle */}
        <div style={{ marginTop: '1rem' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '0.75rem 0',
              borderBottom: '1px solid var(--surface-border)',
            }}
          >
            <div style={{ flex: 1 }}>
              <div style={{ color: 'var(--text-primary)', fontSize: '0.95rem' }}>
                {i18n.t('settings:startup.rememberLastChannels')}
              </div>
              <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginTop: '0.25rem' }}>
                {i18n.t('settings:startup.rememberLastChannelsDescription')}
              </div>
            </div>
            <input
              type="checkbox"
              checked={localValue}
              onChange={(e) => handleToggle(e.target.checked)}
              style={{ cursor: 'pointer', marginLeft: '1rem' }}
            />
          </div>

          {/* Reopen Last On Startup Toggle */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '0.75rem 0',
              borderBottom: '1px solid var(--surface-border)',
              opacity: localValue ? 1 : 0.5,
              transition: 'opacity 0.2s',
            }}
          >
            <div style={{ flex: 1 }}>
              <div style={{ color: 'var(--text-primary)', fontSize: '0.95rem' }}>
                {i18n.t('settings:startup.reopenLastOnStartup')}
              </div>
              <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginTop: '0.25rem' }}>
                {i18n.t('settings:startup.reopenLastOnStartupDescription')}
              </div>
            </div>
            <input
              type="checkbox"
              checked={localReopenValue}
              onChange={(e) => handleReopenToggle(e.target.checked)}
              disabled={!localValue}
              style={{ cursor: localValue ? 'pointer' : 'not-allowed', marginLeft: '1rem' }}
            />
          </div>
        </div>

        {/* Info about current saved state */}
        {localValue && savedLayoutState && (
          <div
            style={{
              marginTop: '1rem',
              padding: '1rem',
              background: 'var(--surface-glow)',
              border: '1px solid var(--accent-primary)',
              borderRadius: '8px',
            }}
          >
            <div style={{ color: 'var(--text-primary)', fontSize: '0.9rem', marginBottom: '0.5rem' }}>
              <strong>{i18n.t('settings:startup.savedState')}</strong>
            </div>
            <div style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
              <div>{i18n.t('settings:startup.layoutLabel', { layout: getLayoutLabel(savedLayoutState.layout) })}</div>
              <div>{i18n.t('settings:startup.activeChannels', { count: getActiveChannelCount() })}</div>
              {savedLayoutState.mainChannel.channelName && (
                <div style={{ marginTop: '0.5rem' }}>
                  {i18n.t('settings:startup.mainChannel', { name: savedLayoutState.mainChannel.channelName })}
                </div>
              )}
              {savedLayoutState.slots.filter(s => s.active).length > 0 && (
                <div style={{ marginTop: '0.25rem' }}>
                  {savedLayoutState.slots
                    .filter(s => s.active)
                    .map(s => i18n.t('settings:startup.slotChannel', { id: s.id, name: s.channelName }))
                    .join(', ')}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Feature explanation */}
        <div
          style={{
            marginTop: '1.5rem',
            padding: '1rem',
            background: 'var(--surface-color)',
            borderRadius: '8px',
          }}
        >
          <div style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
            <strong style={{ color: 'var(--text-primary)' }}>{i18n.t('settings:startup.howItWorks')}</strong>
            <ul style={{ marginTop: '0.5rem', marginLeft: '1.2rem', lineHeight: '1.6' }}>
              <li>{i18n.t('settings:startup.rule1')}</li>
              <li>{i18n.t('settings:startup.rule2')}</li>
              <li>{i18n.t('settings:startup.rule3')}</li>
              <li>{i18n.t('settings:startup.rule4')}</li>
              <li>{i18n.t('settings:startup.rule5')}</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
