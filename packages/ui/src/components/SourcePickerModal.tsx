import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import type { StremioStream, StremioStreamBadge, InstalledAddon } from '../types/stremio';
import { fetchStreams } from '../services/stremio-addon';
import { extractStreamBadges, isLightColor, formatVideoSize } from '../utils/streamBadges';
import './SourcePickerModal.css';

interface SourcePickerModalProps {
  source: 'stremio';
  type: string;
  id: string;
  currentAddonName?: string;
  currentUrl?: string;
  compiledBadgeRules?: { pattern: RegExp; badge: StremioStreamBadge }[];
  onSelect: (stream: StremioStream) => void;
  onClose: () => void;
}

interface CacheEntry {
  streams: StremioStream[];
  timestamp: number;
}

const streamCache = new Map<string, CacheEntry>();
const CACHE_TTL = 5 * 60 * 1000;

export function SourcePickerModal({
  source,
  type,
  id,
  currentAddonName,
  currentUrl,
  compiledBadgeRules = [],
  onSelect,
  onClose,
}: SourcePickerModalProps) {
  const { t } = useTranslation('player');
  const [streams, setStreams] = useState<StremioStream[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedAddonFilter, setSelectedAddonFilter] = useState('All');
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  const addonsRef = useRef<InstalledAddon[]>([]);

  useEffect(() => {
    const cacheKey = `${source}:${type}:${id}`;
    const cached = streamCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      setStreams(cached.streams);
      setLoading(false);
      return;
    }

    let active = true;
    const load = async () => {
      try {
        const { useStremioAddonStore } = await import('../stores/stremioAddonStore');
        const addons: InstalledAddon[] = useStremioAddonStore.getState().enabledAddons;
        addonsRef.current = addons;

        const collected: StremioStream[] = [];
        const result = await fetchStreams(addons, type, id, (incoming) => {
          if (!active) return;
          collected.push(...incoming);
          setStreams([...collected]);
        });
        if (!active) return;
        setStreams(result);
        streamCache.set(cacheKey, { streams: result, timestamp: Date.now() });
      } catch (err) {
        if (!active) return;
        setError('Failed to load streams');
      } finally {
        if (active) setLoading(false);
      }
    };
    load();
    return () => { active = false; };
  }, [source, type, id, refreshTrigger]);

  const handleRefresh = useCallback(() => {
    const cacheKey = `${source}:${type}:${id}`;
    streamCache.delete(cacheKey);
    setLoading(true);
    setError(null);
    setRefreshTrigger((prev) => prev + 1);
  }, [source, type, id]);

  const addonNames = Array.from(new Set(streams.map((s) => s.addonName).filter(Boolean))).sort() as string[];

  const filteredStreams = streams.filter((s) => {
    if (selectedAddonFilter === 'All') return true;
    return s.addonName === selectedAddonFilter;
  });

  const handleStreamClick = useCallback((stream: StremioStream) => {
    onSelect(stream);
  }, [onSelect]);

  const renderBadges = (stream: StremioStream) => {
    const badges = extractStreamBadges(stream, compiledBadgeRules);
    if (stream.behaviorHints?.videoSize) {
      const sizeStr = formatVideoSize(stream.behaviorHints.videoSize);
      if (sizeStr) {
        badges.push({ label: sizeStr, color: '#4b5563' });
      }
    }
    if (badges.length === 0) return null;
    return (
      <div className="spm-badges">
        {badges.map((badge) => {
          const bgColor = badge.color || '#1a1a1a';
          const isLight = isLightColor(bgColor);
          const textColor = badge.textColor || (isLight ? '#000000' : '#ffffff');
          return badge.imageUrl ? (
            <span
              key={badge.label}
              className="spm-badge-img"
              style={{
                backgroundColor: bgColor,
                borderColor: badge.borderColor,
              }}
            >
              <img src={badge.imageUrl} alt={badge.label} title={badge.label} />
            </span>
          ) : (
            <span
              key={badge.label}
              className="spm-badge"
              style={{
                backgroundColor: bgColor,
                color: textColor,
                borderColor: badge.borderColor,
              }}
            >
              {badge.label}
            </span>
          );
        })}
      </div>
    );
  };

  return createPortal(
    <div className="spm-overlay" onClick={onClose}>
      <div className="spm-modal" onClick={(e) => e.stopPropagation()}>
        <div className="spm-header">
          <h3 className="spm-title">
            Source Picker
            {currentAddonName && (
              <span className="spm-current-source">Current: {currentAddonName}</span>
            )}
          </h3>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <button
              className="spm-refresh-btn"
              onClick={handleRefresh}
              disabled={loading}
              title={t('refreshStreams')}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                width="12"
                height="12"
                className={loading ? 'spm-spin' : ''}
              >
                <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
              </svg>
              Refresh
            </button>
            <button className="spm-close" onClick={onClose}>✕</button>
          </div>
        </div>

        <div className="spm-body">
          {addonNames.length > 1 && (
            <div className="spm-filters">
              <button
                className={`spm-filter-btn ${selectedAddonFilter === 'All' ? 'active' : ''}`}
                onClick={() => setSelectedAddonFilter('All')}
              >
                All
              </button>
              {addonNames.map((name) => (
                <button
                  key={name}
                  className={`spm-filter-btn ${selectedAddonFilter === name ? 'active' : ''}`}
                  onClick={() => setSelectedAddonFilter(name)}
                >
                  {name}
                </button>
              ))}
            </div>
          )}

          {loading ? (
            <div className="spm-loading">
              <div className="spm-spinner" />
              <span>{t('loadingStreams')}</span>
            </div>
          ) : error ? (
            <div className="spm-empty">{error}</div>
          ) : filteredStreams.length === 0 ? (
            <div className="spm-empty">{t('noStreamsAvailable')}</div>
          ) : (
            <div className="spm-list">
              {filteredStreams.map((stream, idx) => {
                const name = stream.name || '';
                const desc = stream.description || stream.title || '';
                const displayName = name || desc || `Stream #${idx + 1}`;
                const displayDesc = name ? desc : '';
                const streamUrl = stream.url || (stream.infoHash ? `infoHash:${stream.infoHash}${stream.fileIdx !== undefined ? `:${stream.fileIdx}` : ''}` : null);
                const isActive = !!(currentUrl && streamUrl && streamUrl === currentUrl);

                return (
                  <div
                    key={`${stream.addonName}-${idx}`}
                    className={`spm-item ${isActive ? 'spm-item-active' : ''}`}
                    onClick={() => handleStreamClick(stream)}
                  >
                    <div className="spm-item-header">
                      <div className="spm-item-name">{displayName}</div>
                      {stream.addonName && (
                        <span className="spm-item-addon">
                          via {stream.addonName}
                        </span>
                      )}
                    </div>
                    {renderBadges(stream)}
                    {displayDesc && <div className="spm-item-desc">{displayDesc}</div>}
                    {stream.infoHash && (
                      <div className="spm-item-hash">
                        infoHash: {stream.infoHash.substring(0, 16)}...
                        {stream.fileIdx !== undefined && ` | fileIdx: ${stream.fileIdx}`}
                      </div>
                    )}
                    {isActive && <div className="spm-item-active-tag">{t('currentlyPlaying')}</div>}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
