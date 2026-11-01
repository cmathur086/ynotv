import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import { validateAccessToken } from '../../services/tmdb';
import { validateRpdbApiKey, getRpdbTier, rpdbSupportsBackdrops } from '../../services/rpdb';
import { SERVICES, type StreamingService } from '../../constants/streamingProviders';
import { useSettingsStore } from '../../stores/settingsStore';
import { signInToMediaCore, signOutOfMediaCore, useMediaCoreStore } from '../../services/mediacore';
import './PlaybackTab.css'; // Reuse existing tab styles

export type MetadataSubTabId = 'tmdb' | 'rpdb';

// TMDB-supported locales shown in the metadata language picker. Labels are
// native language names (standard practice — no i18n needed).
const TMDB_LANGUAGES: Array<{ code: string; label: string }> = [
  { code: 'en-US', label: 'English' },
  { code: 'es-ES', label: 'Español' },
  { code: 'fr-FR', label: 'Français' },
  { code: 'de-DE', label: 'Deutsch' },
  { code: 'it-IT', label: 'Italiano' },
  { code: 'pt-BR', label: 'Português (Brasil)' },
  { code: 'pt-PT', label: 'Português (Portugal)' },
  { code: 'ru-RU', label: 'Русский' },
  { code: 'uk-UA', label: 'Українська' },
  { code: 'pl-PL', label: 'Polski' },
  { code: 'nl-NL', label: 'Nederlands' },
  { code: 'tr-TR', label: 'Türkçe' },
  { code: 'ar-SA', label: 'العربية' },
  { code: 'fa-IR', label: 'فارسی' },
  { code: 'hi-IN', label: 'हिन्दी' },
  { code: 'ur-PK', label: 'اردو' },
  { code: 'zh-CN', label: '简体中文' },
  { code: 'zh-TW', label: '繁體中文' },
  { code: 'ja-JP', label: '日本語' },
  { code: 'ko-KR', label: '한국어' },
  { code: 'el-GR', label: 'Ελληνικά' },
  { code: 'hr-HR', label: 'Hrvatski' },
  { code: 'bs-BA', label: 'Bosanski' },
  { code: 'sr-RS', label: 'Српски' },
  { code: 'sq-AL', label: 'Shqip' },
  { code: 'vi-VN', label: 'Tiếng Việt' },
  { code: 'sv-SE', label: 'Svenska' },
  { code: 'da-DK', label: 'Dansk' },
  { code: 'fi-FI', label: 'Suomi' },
  { code: 'no-NO', label: 'Norsk' },
  { code: 'cs-CZ', label: 'Čeština' },
  { code: 'hu-HU', label: 'Magyar' },
  { code: 'ro-RO', label: 'Română' },
  { code: 'bg-BG', label: 'Български' },
  { code: 'he-IL', label: 'עברית' },
  { code: 'th-TH', label: 'ไทย' },
  { code: 'id-ID', label: 'Bahasa Indonesia' },
  { code: 'ms-MY', label: 'Bahasa Melayu' },
];

interface TmdbTabProps {
  initialSubTab?: MetadataSubTabId;
  tmdbApiKey: string;
  tmdbKeyValid: boolean | null;
  onApiKeyChange: (key: string) => void;
  onApiKeyValidChange: (valid: boolean | null) => void;
  rpdbApiKey: string;
  rpdbKeyValid: boolean | null;
  onRpdbApiKeyChange: (key: string) => void;
  onRpdbKeyValidChange: (valid: boolean | null) => void;
  rpdbBackdropsEnabled: boolean;
  onRpdbBackdropsEnabledChange: (enabled: boolean) => void;
  streamingCatalogsEnabled: boolean;
  onStreamingCatalogsEnabledChange: (enabled: boolean) => void;
  enabledStreamingServices: string[];
  onEnabledStreamingServicesChange: (services: string[]) => void;
}

export function TmdbTab({
  initialSubTab,
  tmdbApiKey,
  tmdbKeyValid,
  onApiKeyChange,
  onApiKeyValidChange,
  rpdbApiKey,
  rpdbKeyValid,
  onRpdbApiKeyChange,
  onRpdbKeyValidChange,
  rpdbBackdropsEnabled,
  onRpdbBackdropsEnabledChange,
  streamingCatalogsEnabled,
  onStreamingCatalogsEnabledChange,
  enabledStreamingServices,
  onEnabledStreamingServicesChange,
}: TmdbTabProps) {
  useTranslation();
  const tmdbLanguage = useSettingsStore((s) => s.tmdbLanguage);
  const setTmdbLanguage = useSettingsStore((s) => s.setTmdbLanguage);
  const savedTmdbKey = useSettingsStore((s) => s.tmdbApiKey);
  const mediacoreUser = useMediaCoreStore((s) => s.user);
  const [activeSubTab, setActiveSubTab] = useState<MetadataSubTabId>('tmdb');
  const [tmdbValidating, setTmdbValidating] = useState(false);
  const [rpdbValidating, setRpdbValidating] = useState(false);
  const [showTmdbKey, setShowTmdbKey] = useState(false);
  const [mcIdentifier, setMcIdentifier] = useState('');
  const [mcPassword, setMcPassword] = useState('');
  const [mcBusy, setMcBusy] = useState(false);
  const [mcError, setMcError] = useState<string | null>(null);

  // Metadata is available from a valid personal key, or from the MediaCore
  // account when no personal key is saved.
  const usingMediaCore = mediacoreUser !== null && !savedTmdbKey.trim();
  const metadataReady = tmdbKeyValid === true || usingMediaCore;

  async function handleMediaCoreSignIn() {
    if (!mcIdentifier.trim() || !mcPassword) return;
    setMcBusy(true);
    setMcError(null);
    try {
      await signInToMediaCore(mcIdentifier, mcPassword);
      setMcPassword('');
    } catch (e) {
      setMcError(typeof e === 'string' ? e : (e as Error)?.message ?? String(e));
    } finally {
      setMcBusy(false);
    }
  }

  async function handleMediaCoreSignOut() {
    setMcBusy(true);
    try {
      await signOutOfMediaCore();
    } finally {
      setMcBusy(false);
    }
  }

  useEffect(() => {
    if (initialSubTab) {
      setActiveSubTab(initialSubTab);
    }
  }, [initialSubTab]);

  const tier = getRpdbTier(rpdbApiKey);
  const supportsBackdrops = rpdbSupportsBackdrops(rpdbApiKey);

  async function saveTmdbApiKey() {
    if (!window.storage) return;
    setTmdbValidating(true);
    onApiKeyValidChange(null);

    // Validate the key first
    const isValid = tmdbApiKey ? await validateAccessToken(tmdbApiKey) : true;
    onApiKeyValidChange(isValid);

    if (isValid) {
      // Store setter persists and dispatches `ynotv:tmdb-key-changed`.
      useSettingsStore.getState().setTmdbApiKey(tmdbApiKey);
    }

    setTmdbValidating(false);
  }

  async function saveRpdbApiKey() {
    if (!window.storage) return;
    setTmdbValidating(true);
    onRpdbKeyValidChange(null);

    // Validate the key first
    const isValid = rpdbApiKey ? await validateRpdbApiKey(rpdbApiKey) : true;
    onRpdbKeyValidChange(isValid);

    if (isValid) {
      useSettingsStore.getState().setPosterDbApiKey(rpdbApiKey);
    }

    setTmdbValidating(false);
  }

  async function handleBackdropsToggle(enabled: boolean) {
    if (!window.storage) return;
    onRpdbBackdropsEnabledChange(enabled);
    useSettingsStore.getState().setRpdbBackdropsEnabled(enabled);
  }

  return (
    <div className="playback-tab-content" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="settings-tabs" style={{ padding: '0 20px', flexShrink: 0 }}>
        <button
          className={`settings-tab ${activeSubTab === 'tmdb' ? 'active' : ''}`}
          onClick={() => setActiveSubTab('tmdb')}
        >
          {i18n.t('settings:tmdb.tabs.tmdb')}
        </button>
        <button
          className={`settings-tab ${activeSubTab === 'rpdb' ? 'active' : ''}`}
          onClick={() => setActiveSubTab('rpdb')}
        >
          {i18n.t('settings:tmdb.tabs.rpdb')}
        </button>
      </div>

      <div className="settings-tab-content">
        {activeSubTab === 'tmdb' && (
          <div className="settings-section">
            {/* MediaCore account: metadata without a personal TMDB key */}
            <div className="section-header">
              <h3>{i18n.t('settings:tmdb.mediacore.title')}</h3>
            </div>
            <p className="section-description">{i18n.t('settings:tmdb.mediacore.description')}</p>

            {mediacoreUser ? (
              <div className="tmdb-form" style={{ marginBottom: '28px' }}>
                <div className="form-group inline">
                  <label>
                    {i18n.t('settings:tmdb.mediacore.signedInAs', {
                      name: mediacoreUser.displayName || mediacoreUser.username,
                    })}
                  </label>
                  <button type="button" onClick={handleMediaCoreSignOut} disabled={mcBusy}>
                    {i18n.t('settings:tmdb.mediacore.signOut')}
                  </button>
                </div>
                <p className="form-hint">
                  {usingMediaCore
                    ? i18n.t('settings:tmdb.mediacore.usingAccount')
                    : i18n.t('settings:tmdb.mediacore.personalKeyWins')}
                </p>
              </div>
            ) : (
              <form
                className="tmdb-form"
                style={{ marginBottom: '28px' }}
                onSubmit={(e) => {
                  e.preventDefault();
                  void handleMediaCoreSignIn();
                }}
              >
                <div className="form-group inline">
                  <label>{i18n.t('settings:tmdb.mediacore.identifierLabel')}</label>
                  <input
                    type="text"
                    autoComplete="username"
                    value={mcIdentifier}
                    onChange={(e) => setMcIdentifier(e.target.value)}
                  />
                </div>
                <div className="form-group inline">
                  <label>{i18n.t('settings:tmdb.mediacore.passwordLabel')}</label>
                  <input
                    type="password"
                    autoComplete="current-password"
                    value={mcPassword}
                    onChange={(e) => setMcPassword(e.target.value)}
                  />
                  <button type="submit" disabled={mcBusy || !mcIdentifier.trim() || !mcPassword}>
                    {mcBusy ? i18n.t('settings:tmdb.mediacore.signingIn') : i18n.t('settings:tmdb.mediacore.signIn')}
                  </button>
                </div>
                {mcError && (
                  <p className="form-hint" style={{ color: 'var(--error-color, #ff6b6b)' }}>{mcError}</p>
                )}
              </form>
            )}

            {/* TMDB Section */}
            <div className="section-header">
              <h3>{i18n.t('settings:tmdb.title')}</h3>
            </div>
            {!savedTmdbKey.trim() && (
              <p className="form-hint" style={{ marginTop: 0 }}>{i18n.t('settings:tmdb.mediacore.orPersonalKey')}</p>
            )}

            <p className="section-description">
              {i18n.t('settings:tmdb.description')}{' '}
              <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noopener noreferrer" className="tmdb-link">
                from here
              </a>.
            </p>

            <p className="section-description" style={{ marginBottom: '16px' }}>
              {i18n.t('settings:tmdb.guideLink')}{' '}
              <a href="https://duckkota.gitlab.io/guides/tmdb/" target="_blank" rel="noopener noreferrer" className="tmdb-link">
                https://duckkota.gitlab.io/guides/tmdb/
              </a>
            </p>

            <div className="tmdb-form">
              <div className="form-group inline">
                <label>{i18n.t('settings:tmdb.accessTokenLabel')}</label>
                <div style={{ position: 'relative', display: 'flex', alignItems: 'center', flex: 1 }}>
                  <input
                    type={showTmdbKey ? 'text' : 'password'}
                    value={tmdbApiKey}
                    onChange={(e) => {
                      onApiKeyChange(e.target.value);
                      onApiKeyValidChange(null);
                    }}
                    placeholder={i18n.t('settings:tmdb.placeholder')}
                    style={{ flex: 1, paddingRight: '36px', boxSizing: 'border-box' }}
                  />
                  <button
                    type="button"
                    onClick={() => setShowTmdbKey(!showTmdbKey)}
                    title={showTmdbKey ? i18n.t('settings:tmdb.hideKey') : i18n.t('settings:tmdb.showKey')}
                    style={{
                      position: 'absolute',
                      right: '6px',
                      top: '50%',
                      transform: 'translateY(-50%)',
                      background: 'transparent',
                      border: 'none',
                      color: 'var(--text-muted)',
                      cursor: 'pointer',
                      padding: '4px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      borderRadius: '4px',
                      transition: 'color 0.2s, background 0.2s',
                      minWidth: 'unset',
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--text-primary)'; e.currentTarget.style.background = 'var(--surface-color)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)'; e.currentTarget.style.background = 'transparent'; }}
                  >
                    {showTmdbKey ? (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                        <line x1="1" y1="1" x2="23" y2="23" />
                      </svg>
                    ) : (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                        <circle cx="12" cy="12" r="3" />
                      </svg>
                    )}
                  </button>
                </div>
                <button
                  type="button"
                  onClick={saveTmdbApiKey}
                  disabled={tmdbValidating}
                  className={tmdbKeyValid === true ? 'success' : tmdbKeyValid === false ? 'error' : ''}
                >
                  {tmdbValidating ? i18n.t('settings:tmdb.validating') : tmdbKeyValid === true ? i18n.t('settings:tmdb.keyValid') : tmdbKeyValid === false ? i18n.t('settings:tmdb.keyInvalid') : i18n.t('settings:tmdb.saveKey')}
                </button>
              </div>
              <p className="form-hint">
                {i18n.t('settings:tmdb.getAccountHint')}{' '}
                <a href="https://www.themoviedb.org/signup" target="_blank" rel="noopener noreferrer">
                  themoviedb.org
                </a>
              </p>
            </div>

            {/* Metadata Language */}
            <div className="form-group inline" style={{ marginTop: '18px' }}>
              <label>{i18n.t('settings:tmdb.languageLabel')}</label>
              <select
                className="tmdb-language-select"
                value={tmdbLanguage}
                onChange={(e) => setTmdbLanguage(e.target.value)}
              >
                {TMDB_LANGUAGES.map((lang) => (
                  <option key={lang.code} value={lang.code}>
                    {lang.label}
                  </option>
                ))}
              </select>
            </div>
            <p className="form-hint" style={{ marginTop: '-8px' }}>
              {i18n.t('settings:tmdb.languageHint')}
            </p>

            {/* Streaming Catalogs Section */}
            <div className={`streaming-catalogs-section ${!metadataReady ? 'disabled' : ''}`} style={{ marginTop: '2rem' }}>
              <div className="section-header" style={{ marginBottom: '12px' }}>
                <h4 style={{ margin: 0, textTransform: 'uppercase', fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)', letterSpacing: '0.05em' }}>
                  {i18n.t('settings:tmdb.catalogsTitle')}
                </h4>
              </div>

              <div className="timeshift-settings" style={{ marginTop: 0 }}>
                <div className="timeshift-toggle-row" style={{ padding: '8px 0', borderBottom: 'none' }}>
                  <div className="timeshift-toggle-info">
                    <span className="timeshift-toggle-label" style={{ color: metadataReady ? 'var(--text-primary)' : 'var(--text-muted)' }}>{i18n.t('settings:tmdb.enableStremioCatalogs')}</span>
                    <span className="timeshift-toggle-sub">{i18n.t('settings:tmdb.enableStremioCatalogsSub')}</span>
                  </div>
                  <label className="toggle-switch" style={{ opacity: metadataReady ? 1 : 0.5, cursor: metadataReady ? 'pointer' : 'not-allowed' }}>
                    <input
                      type="checkbox"
                      checked={streamingCatalogsEnabled}
                      disabled={!metadataReady}
                      onChange={(e) => onStreamingCatalogsEnabledChange(e.target.checked)}
                    />
                    <span className="toggle-slider" />
                  </label>
                </div>
              </div>

              {/* Streaming providers checkboxes grid */}
              {(() => {
                const catalogsEnabled = streamingCatalogsEnabled;
                return (
                  <div 
                    className="streaming-providers-grid" 
                    style={{ 
                      display: 'grid', 
                      gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', 
                      gap: '10px', 
                      marginTop: '1.2rem',
                      opacity: (catalogsEnabled && metadataReady) ? 1 : 0.5,
                      pointerEvents: (catalogsEnabled && metadataReady) ? 'auto' : 'none',
                      transition: 'opacity 0.2s ease',
                    }}
                  >
                    {Object.keys(SERVICES).map((svcKey) => {
                      const svc = SERVICES[svcKey as StreamingService];
                      const isEnabled = enabledStreamingServices.includes(svcKey);
                      return (
                        <label 
                          key={svcKey}
                          className={`streaming-provider-card ${isEnabled ? 'checked' : ''}`}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '10px',
                            padding: '8px 12px',
                            background: '#000000',
                            border: isEnabled ? '1px solid var(--accent-primary)' : '1px solid var(--surface-border)',
                            borderRadius: '8px',
                            cursor: (catalogsEnabled && metadataReady) ? 'pointer' : 'default',
                            transition: 'all 0.2s ease',
                        userSelect: 'none',
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={isEnabled}
                        onChange={(e) => {
                          if (e.target.checked) {
                            onEnabledStreamingServicesChange([...enabledStreamingServices, svcKey]);
                          } else {
                            onEnabledStreamingServicesChange(enabledStreamingServices.filter(k => k !== svcKey));
                          }
                        }}
                        style={{ display: 'none' }}
                      />
                      {/* Custom SVG Checkbox indicator */}
                      <div 
                        className="custom-checkbox-indicator"
                        style={{
                          width: '16px',
                          height: '16px',
                          borderRadius: '4px',
                          border: isEnabled ? '1px solid #00d4ff' : '1px solid var(--surface-border)',
                          background: isEnabled ? '#00d4ff' : 'transparent',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          flexShrink: 0,
                          transition: 'all 0.15s ease',
                        }}
                      >
                        {isEnabled && (
                          <svg viewBox="0 0 24 24" fill="none" stroke="#000" strokeWidth="3" style={{ width: '12px', height: '12px' }}>
                            <path d="M20 6L9 17l-5-5" />
                          </svg>
                        )}
                      </div>
                      {/* Logo Image */}
                      <img 
                        src={svc.logo} 
                        alt={svc.name} 
                        style={{ 
                          height: svc.logoHeightHome ? `${svc.logoHeightHome * 0.75}px` : '18px', 
                          width: 'auto',
                          filter: 'brightness(0) invert(1)',
                          opacity: isEnabled ? 1 : 0.4,
                          transition: 'opacity 0.2s'
                        }} 
                      />
                    </label>
                  );
                })}
              </div>
            );
          })()}

              {!metadataReady && (
                <p className="form-hint" style={{ color: 'var(--text-muted)', marginTop: '0.5rem' }}>
                  {i18n.t('settings:tmdb.requiresToken')}
                </p>
              )}
            </div>

            <p className="settings-disclaimer" style={{ marginTop: '2rem' }}>
              {i18n.t('settings:tmdb.disclaimer')}
            </p>
          </div>
        )}

        {activeSubTab === 'rpdb' && (
          <div className="settings-section">
            {/* RPDB Section */}
            <div className="section-header">
              <h3>{i18n.t('settings:tmdb.rpdbTitle')}</h3>
              {tier != null && rpdbKeyValid === true && (
                <span className="tier-badge">Tier {tier}</span>
              )}
            </div>

            <p className="section-description">
              {i18n.t('settings:tmdb.rpdbDescription')}{' '}
              <a
                href="https://manager.ratingposterdb.com/"
                target="_blank"
                rel="noopener noreferrer"
                className="tmdb-link"
              >
                manager.ratingposterdb.com
              </a>
              .
            </p>

            <div className="tmdb-form">
              <div className="form-group inline">
                <label>{i18n.t('settings:tmdb.rpdbApiKeyLabel')}</label>
                <input
                  type="password"
                  value={rpdbApiKey}
                  onChange={(e) => {
                    onRpdbApiKeyChange(e.target.value);
                    onRpdbKeyValidChange(null);
                  }}
                  placeholder={i18n.t('settings:tmdb.rpdbPlaceholder')}
                />
                <button
                  type="button"
                  onClick={saveRpdbApiKey}
                  disabled={rpdbValidating}
                  className={rpdbKeyValid === true ? 'success' : rpdbKeyValid === false ? 'error' : ''}
                >
                  {rpdbValidating ? i18n.t('settings:tmdb.validating') : rpdbKeyValid === true ? i18n.t('settings:tmdb.keyValid') : rpdbKeyValid === false ? i18n.t('settings:tmdb.keyInvalid') : i18n.t('settings:tmdb.saveKey')}
                </button>
              </div>
              <p className="form-hint">
                {i18n.t('settings:tmdb.rpdbAccountHint')}{' '}
                <a href="https://ratingposterdb.com/" target="_blank" rel="noopener noreferrer">
                  ratingposterdb.com
                </a>
              </p>
            </div>

            {/* Backdrops option - only show if key is valid */}
            {rpdbKeyValid === true && (
              <div className="tmdb-form" style={{ marginTop: '1.5rem' }}>
                <label
                  className="genre-checkbox"
                  style={{ maxWidth: '280px' }}
                >
                  <input
                    type="checkbox"
                    checked={rpdbBackdropsEnabled && supportsBackdrops}
                    onChange={(e) => handleBackdropsToggle(e.target.checked)}
                    disabled={!supportsBackdrops}
                  />
                  <span className="genre-name">{i18n.t('settings:tmdb.rpdbBackdrops')}</span>
                </label>
                {!supportsBackdrops && (
                  <p className="form-hint" style={{ marginTop: '0.5rem' }}>
                    {i18n.t('settings:tmdb.rpdbTierRequired')}
                  </p>
                )}
              </div>
            )}

            <p className="settings-disclaimer" style={{ marginTop: '2rem' }}>
              {i18n.t('settings:tmdb.rpdbDisclaimerPrefix')}{' '}
              <a href="https://ratingposterdb.com/" target="_blank" rel="noopener noreferrer" className="tmdb-link">
                ratingposterdb.com
              </a>{' '}
              {i18n.t('settings:tmdb.rpdbDisclaimerSuffix')}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
