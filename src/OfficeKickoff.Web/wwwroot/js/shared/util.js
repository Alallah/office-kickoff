// Small browser helpers shared by every page.
//
// The game is meant to run on an office intranet over plain http (http://some-server/kickoff),
// which is NOT a secure context. Several browser APIs simply do not exist there:
// navigator.clipboard, crypto.randomUUID / crypto.subtle, AudioWorklet, Web Locks, Wake Lock,
// Notifications. Never depend on them; use the helpers here.

/**
 * Copies text to the clipboard. Works on plain http pages too.
 * @param {string} text
 * @returns {Promise<boolean>} true when the text was copied
 */
export async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    document.body.appendChild(area);
    const previous = document.activeElement;
    area.select();
    area.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    area.remove();
    if (previous instanceof HTMLElement) previous.focus();
    return ok;
  } catch {
    return false;
  }
}

/** True when the user asked the system for reduced motion. */
export function prefersReducedMotion() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** True when the event target is something the user types into (so game keys must be left alone). */
export function isEditableTarget(target) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}
