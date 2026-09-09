/**
 *
 * The CYB-98 visual element picker: inlined by preview-proxy.ts into every
 * HTML response that flows through the dev-server preview proxy, so it runs
 * inside the previewed page itself — the parent (Hoshi App:Web) can't reach
 * across the iframe's origin boundary, but `postMessage` can. Inert until the
 * parent arms it (`hoshi:picker:start`); on pick it reports a selector + a
 * human-readable label back to the parent (`hoshi:picker:picked`) and
 * disarms. Treats the parent as semi-trusted (this only runs because the
 * parent legitimately embeds this exact page) but still checks
 * `event.source` and the message shape before acting — a compromised or
 * merely buggy previewed page could otherwise be fed garbage.
 *
 * Written as a plain ES2015+ IIFE (not TypeScript, not bundled) because it
 * ships inline as a literal <script> body inside someone else's HTML — no
 * build step runs on it.
 *
 **/
export const PREVIEW_PICKER_SCRIPT = `
(function () {
  if (window.__hoshiPicker) return;
  window.__hoshiPicker = true;

  var armed = false;
  var overlay = null;
  var hoverTarget = null;

  function ensureOverlay() {
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.setAttribute('data-hoshi-picker-overlay', '');
    Object.assign(overlay.style, {
      position: 'fixed',
      pointerEvents: 'none',
      zIndex: '2147483647',
      boxSizing: 'border-box',
      border: '2px solid #6d5efc',
      background: 'rgba(109, 94, 252, 0.15)',
      borderRadius: '3px',
      display: 'none',
      left: '0',
      top: '0',
      width: '0',
      height: '0',
    });
    (document.body || document.documentElement).appendChild(overlay);
    return overlay;
  }

  function showHighlight(el) {
    var box = ensureOverlay();
    var rect = el.getBoundingClientRect();
    box.style.display = 'block';
    box.style.left = rect.left + 'px';
    box.style.top = rect.top + 'px';
    box.style.width = rect.width + 'px';
    box.style.height = rect.height + 'px';
  }

  function hideHighlight() {
    if (overlay) overlay.style.display = 'none';
  }

  function cssEscape(value) {
    if (window.CSS && typeof CSS.escape === 'function') return CSS.escape(value);
    return String(value).replace(/([^a-zA-Z0-9_-])/g, '\\\\$1');
  }

  function classesOf(el) {
    if (!el.classList || el.classList.length === 0) return [];
    var out = [];
    for (var i = 0; i < el.classList.length; i++) out.push(el.classList[i]);
    return out;
  }

  // A short, resilient CSS path in the spirit of DevTools' "$0" reference:
  // prefer an id anywhere up the chain, otherwise a few classes, otherwise
  // fall back to an nth-child index — capped at 5 ancestors so it stays a
  // human-readable reference, not a brittle full DOM path.
  function buildSelector(el) {
    if (el.id) return '#' + cssEscape(el.id);
    var parts = [];
    var node = el;
    var depth = 0;
    while (node && node.nodeType === 1 && depth < 5) {
      if (node.id) {
        parts.unshift('#' + cssEscape(node.id));
        break;
      }
      var tag = node.tagName.toLowerCase();
      var classes = classesOf(node).filter(function (c) { return c && c.indexOf('hoshi-picker') === -1; }).slice(0, 2);
      var part = classes.length > 0 ? tag + '.' + classes.map(cssEscape).join('.') : tag;
      var parent = node.parentElement;
      if (classes.length === 0 && parent) {
        var siblings = [];
        for (var i = 0; i < parent.children.length; i++) {
          if (parent.children[i].tagName === node.tagName) siblings.push(parent.children[i]);
        }
        if (siblings.length > 1) {
          var index = 1;
          for (var j = 0; j < parent.children.length; j++) {
            if (parent.children[j] === node) { index = j + 1; break; }
          }
          part = tag + ':nth-child(' + index + ')';
        }
      }
      parts.unshift(part);
      node = parent;
      depth++;
    }
    return parts.join(' > ');
  }

  function describe(el) {
    var tag = el.tagName.toLowerCase();
    var ariaLabel = el.getAttribute && el.getAttribute('aria-label');
    var text = (ariaLabel || el.innerText || el.textContent || el.value || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
    var role = el.getAttribute && el.getAttribute('role');
    return { tag: tag, label: text, role: role || null };
  }

  function onMouseMove(e) {
    var el = e.target;
    if (!el || el === overlay || el.nodeType !== 1) return;
    hoverTarget = el;
    showHighlight(el);
  }

  function onClick(e) {
    var el = hoverTarget || e.target;
    e.preventDefault();
    e.stopPropagation();
    if (!el || el.nodeType !== 1) return;
    var meta = describe(el);
    var selector = buildSelector(el);
    disarm();
    parent.postMessage({ type: 'hoshi:picker:picked', selector: selector, tag: meta.tag, label: meta.label, role: meta.role }, '*');
  }

  function onKeydown(e) {
    if (e.key === 'Escape') {
      disarm();
      parent.postMessage({ type: 'hoshi:picker:cancelled' }, '*');
    }
  }

  function arm() {
    if (armed) return;
    armed = true;
    document.addEventListener('mousemove', onMouseMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKeydown, true);
    if (document.body) document.body.style.cursor = 'crosshair';
  }

  function disarm() {
    if (!armed) return;
    armed = false;
    hoverTarget = null;
    document.removeEventListener('mousemove', onMouseMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKeydown, true);
    if (document.body) document.body.style.cursor = '';
    hideHighlight();
  }

  window.addEventListener('message', function (event) {
    // Only the embedding parent frame may arm/disarm the picker — a random
    // third party cannot be window.parent of a page it doesn't itself embed.
    if (event.source !== window.parent) return;
    var data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.type === 'hoshi:picker:start') arm();
    else if (data.type === 'hoshi:picker:stop') disarm();
  });
})();
`
