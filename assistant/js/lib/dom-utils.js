export function getFocusableElements(container) {
  if (!container) return [];
  const candidates = Array.from(container.querySelectorAll(
    'a[href], area[href], button, input, select, textarea, summary, iframe, audio[controls], video[controls], [contenteditable], [tabindex]'
  )).filter(el => {
    if (el.tabIndex < 0 && !(el.isContentEditable && !el.hasAttribute('tabindex'))) return false;
    if (el.isContentEditable && el.parentElement?.isContentEditable && !el.hasAttribute('tabindex')) return false;
    if (el.matches(':disabled, input[type="hidden"]') || el.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
    if (!el.getClientRects().length || ['hidden', 'collapse'].includes(getComputedStyle(el).visibility)) return false;
    if (el.matches('summary') && !el.hasAttribute('tabindex') &&
        (!el.parentElement?.matches('details') || el.parentElement.querySelector(':scope > summary') !== el)) return false;
    for (let parent = el.parentElement; parent; parent = parent.parentElement) {
      if (parent.matches('details:not([open])') && !parent.querySelector(':scope > summary')?.contains(el)) return false;
    }
    return true;
  });
  return candidates.filter(el => {
    if (!el.matches('input[type="radio"]') || !el.name) return true;
    const group = candidates.filter(other => other.matches('input[type="radio"]') && other.name === el.name && other.form === el.form);
    return el === (group.find(other => other.checked) || group[0]);
  }).sort((a, b) => (a.tabIndex > 0 ? a.tabIndex : Infinity) - (b.tabIndex > 0 ? b.tabIndex : Infinity));
}

export function trapFocus(container, e) {
  if (e.key !== 'Tab') return;
  const focusable = getFocusableElements(container);
  if (focusable.length === 0) {
    e.preventDefault();
    if (container && typeof container.focus === 'function') container.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const outsideTabOrder = !focusable.includes(document.activeElement);
  if (e.shiftKey && (document.activeElement === first || outsideTabOrder)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (document.activeElement === last || outsideTabOrder)) {
    e.preventDefault();
    first.focus();
  }
}
