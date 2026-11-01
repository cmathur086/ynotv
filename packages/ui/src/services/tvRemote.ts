/**
 * Android TV remote input.
 *
 * The Android WebView turns the remote's D-pad into arrow keys and OK into
 * Enter, but the Back button never reaches the page: MainActivity forwards it
 * to `window.__ynotvTvBack` instead. All three are routed through spatial
 * navigation — the same path the gamepad and phone remote use.
 *
 * A direction spatial nav can't use (fullscreen playback with nothing
 * focusable) is left alone, so it falls through to the keyboard shortcuts and
 * the remote still changes channel / seeks.
 */

import { dispatchSpatialNav } from './spatialNavigation';
import { setNavSource } from './controllerTextInput';

declare global {
  interface Window {
    __ynotvTvBack?: () => boolean;
  }
}

const DIRECTIONS: Record<string, 'up' | 'down' | 'left' | 'right'> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
};

export function isAndroid(): boolean {
  return typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);
}

function isTextEntry(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) {
    return !['button', 'checkbox', 'radio', 'range', 'submit', 'reset'].includes(el.type);
  }
  return (el as HTMLElement).isContentEditable === true;
}

function onKeyDown(e: KeyboardEvent) {
  if (e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey) return;

  if (e.key === 'MediaPlayPause') {
    window.dispatchEvent(new CustomEvent('ynotv:gamepad-play-pause'));
    e.preventDefault();
    return;
  }

  const dir = DIRECTIONS[e.key];
  const typing = isTextEntry(document.activeElement);

  if (dir) {
    // Left/right move the caret while typing; up/down leave the field.
    if (typing && (dir === 'left' || dir === 'right')) return;
    setNavSource('remote');
    if (dispatchSpatialNav(dir)) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
    return;
  }

  if (e.key === 'Enter' && !typing) {
    setNavSource('remote');
    if (dispatchSpatialNav('select')) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }
}

/** Install the remote handlers. No-op off Android. */
export function installTvRemote(): void {
  if (!isAndroid()) return;
  // Capture phase, so spatial nav sees the key before the playback shortcuts.
  window.addEventListener('keydown', onKeyDown, true);
  window.__ynotvTvBack = () => {
    setNavSource('remote');
    return dispatchSpatialNav('back');
  };
}
