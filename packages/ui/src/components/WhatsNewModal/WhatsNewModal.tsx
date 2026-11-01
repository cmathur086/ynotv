import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import changelogContent from '@root/CHANGELOG.md?raw';
import './WhatsNewModal.css';

interface WhatsNewModalProps {
  isOpen: boolean;
  onClose: () => void;
  version: string;
}

export function WhatsNewModal({ isOpen, onClose, version }: WhatsNewModalProps) {
  const { t } = useTranslation('updates');
  useEffect(() => {
    if (!isOpen) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="whats-new-overlay" onClick={onClose}>
      {/* role="dialog" + data-action="close" let remote/controller spatial
          navigation trap focus here and close it with Back. */}
      <div className="whats-new-panel" role="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="whats-new-header">
          <div className="whats-new-title-area">
            <span className="whats-new-sparkle" role="img" aria-label={t('sparkles')}>✨</span>
            <h2>{t('whatsNew')}</h2>
          </div>
          {version && <span className="whats-new-badge">v{version}</span>}
          <button className="whats-new-close" data-action="close" onClick={onClose} aria-label={t('close')}>
            ✕
          </button>
        </div>

        <div className="whats-new-content">
          <div className="whats-new-intro">
            <p>{t('welcome')}</p>
          </div>
          <div className="whats-new-changelog">
            <ReactMarkdown>{changelogContent}</ReactMarkdown>
          </div>
        </div>

        <div className="whats-new-footer">
          <button className="whats-new-btn-primary" onClick={onClose}>
            {t('getStarted')}
          </button>
        </div>
      </div>
    </div>
  );
}

export default WhatsNewModal;
