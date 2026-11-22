'use strict';
/**
 * Forma Claude — interaction guard.
 *
 * Makes the Limit Reset control a plain button: no context menu, no drag, no
 * selection, no browser default menu anywhere in the overlay.
 *
 * Three layers, because one is never enough:
 *   1. main process   — suppress the native menu for every webContents
 *   2. preload        — capture-phase contextmenu/mousedown-2 on the overlay root
 *   3. element        — the buttons themselves carry oncontextmenu = deny
 */

const { Menu, webContents } = require('electron');

/**
 * Main-process layer. Attaches once per webContents and survives navigation,
 * because the listener lives on the webContents object, not on the document.
 */
function attachNativeMenuSuppression() {
  const hook = (wc) => {
    if (!wc || wc.__formaMenuHooked) return;
    wc.__formaMenuHooked = true;
    wc.on('context-menu', (event) => {
      event.preventDefault();
      // No menu. No inspect. No save-as. The overlay is a control, not a page.
    });
  };

  for (const wc of webContents.getAllWebContents()) hook(wc);
  const { app } = require('electron');
  app.on('web-contents-created', (_event, wc) => hook(wc));
}

/** Main-process layer for any Menu that would otherwise be shown by a window. */
function hardenWindow(win) {
  if (!win || win.__formaHardened) return win;
  win.__formaHardened = true;
  win.on('context-menu', (event) => event.preventDefault());
  return win;
}

/**
 * Preload layer. Returns the source of a capture-phase guard to be installed in
 * the renderer before any app script runs.
 */
const PRELOAD_GUARD_SOURCE = `
(function () {
  if (window.__formaGuardInstalled) return;
  window.__formaGuardInstalled = true;

  var deny = function (e) {
    e.preventDefault();
    e.stopPropagation();
    if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
    return false;
  };

  // Right click anywhere inside the overlay, and anywhere on our controls.
  document.addEventListener('contextmenu', function (e) {
    var t = e.target;
    if (!t) return;
    if (t.closest && t.closest('#fr-root, #fr-btn, #fr-arch, #fr-panel, #fr-backdrop')) deny(e);
  }, true);

  // Middle-click paste/autoscroll on the pill.
  document.addEventListener('auxclick', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    if (t.closest('#fr-btn, #fr-arch')) deny(e);
  }, true);

  // Drag must never lift the pill out of the composer.
  document.addEventListener('dragstart', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    if (t.closest('#fr-btn, #fr-arch')) deny(e);
  }, true);

  // Double-click must not select the label.
  document.addEventListener('selectstart', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    if (t.closest('#fr-btn, #fr-arch')) deny(e);
  }, true);

  // F12 / Ctrl+Shift+I / Ctrl+U inside the overlay do nothing.
  document.addEventListener('keydown', function (e) {
    var t = e.target;
    var inOverlay = t && t.closest && t.closest('#fr-root');
    if (!inOverlay) return;
    var k = (e.key || '').toLowerCase();
    if (e.key === 'F12') return deny(e);
    if (e.ctrlKey && e.shiftKey && (k === 'i' || k === 'j' || k === 'c')) return deny(e);
    if (e.ctrlKey && k === 'u') return deny(e);
  }, true);
})();
`;

/** Apply the element-level guard to a DOM node (idempotent). */
function applyElementGuard(el) {
  if (!el || el.__formaGuarded) return el;
  el.__formaGuarded = true;
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  el.addEventListener('dragstart', (e) => e.preventDefault());
  el.setAttribute('draggable', 'false');
  el.style.userSelect = 'none';
  el.style.webkitUserSelect = 'none';
  return el;
}

/** Menu.setApplicationMenu(null) plus a null default, so no accelerator opens one. */
function clearApplicationMenu() {
  try {
    Menu.setApplicationMenu(null);
  } catch {}
}

module.exports = {
  attachNativeMenuSuppression,
  hardenWindow,
  applyElementGuard,
  clearApplicationMenu,
  PRELOAD_GUARD_SOURCE,
};
