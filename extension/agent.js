// Isolated-world agent. Lives in the attached tab's document, answers the
// background page, and reads page-world state through window.wrappedJSObject.
(function () {
  'use strict';
  // Each injection takes ownership. Older listeners from a previous add-on
  // reload stay registered but become no-ops, so a command runs exactly once.
  var AGENT_TOKEN = Date.now() + ':' + Math.random();
  window.__ffbAgentToken = AGENT_TOKEN;

  // core.js publishes FFBCore on the content-script global (globalThis); `window`
  // is the page's Xray wrapper here, so it cannot see that property.
  var G = typeof globalThis !== 'undefined' ? globalThis : window;
  var C = G.FFBCore || window.FFBCore;
  var page = window.wrappedJSObject || window;
  var state = { snapshot: 0, refs: new Map(), elements: [] };

  function fail(code, message) {
    var error = new Error(message);
    error.code = code;
    return error;
  }

  // Events must be constructed in the content-script compartment. A page-world
  // event (new page.Event, new page.KeyboardEvent) dispatched from here never
  // reaches the page's listeners, which is why React saw nothing.
  function pageEvent(type, init) {
    try {
      return new Event(type, init || {});
    } catch (e) {
      return new page.Event(type, init || {});
    }
  }

  function mouse(type, init) {
    var opts = Object.assign({ bubbles: true, cancelable: true, view: window, button: 0 }, init || {});
    try {
      if (type.indexOf('pointer') === 0 && typeof PointerEvent === 'function') return new PointerEvent(type, opts);
      return new MouseEvent(type, opts);
    } catch (e) {
      return new Event(type, { bubbles: true, cancelable: true });
    }
  }

  // ---- page-world readback -------------------------------------------------

  function pageState() {
    try {
      return page.__ffb || window.__ffb || null;
    } catch (e) {
      return null;
    }
  }

  function buffer(name) {
    var p = pageState();
    if (!p || !p[name]) return [];
    var list = [];
    try {
      var length = p[name].length;
      for (var i = 0; i < length; i++) {
        var entry = p[name][i];
        if (name === 'shadows') {
          list.push({ mode: entry.mode, host: entry.host });
        } else {
          list.push({
            t: entry.t,
            level: entry.level,
            text: entry.text,
            kind: entry.kind,
            method: entry.method,
            url: entry.url,
            status: entry.status,
            ok: entry.ok,
            ms: entry.ms,
            error: entry.error,
            message: entry.message,
            answer: entry.answer,
          });
        }
      }
    } catch (e) {
      /* page went away mid-read */
    }
    return list;
  }

  // ---- refs ----------------------------------------------------------------

  function checkSnapshot(params) {
    if (params && params.snapshot !== undefined && params.snapshot !== null && params.snapshot !== state.snapshot) {
      throw fail('STALE_SNAPSHOT', 'Snapshot ' + params.snapshot + ' is stale (current ' + state.snapshot + '). Take a new snapshot.');
    }
  }

  function resolve(params) {
    checkSnapshot(params);
    if (params && params.ref) {
      var el = state.refs.get(String(params.ref));
      if (!el || !el.isConnected) throw fail('REF_NOT_FOUND', 'Ref ' + params.ref + ' is not in the current snapshot.');
      return el;
    }
    if (params && params.selector) {
      var found = document.querySelector(params.selector);
      if (!found) throw fail('SELECTOR_NOT_FOUND', 'No element matches ' + params.selector);
      return found;
    }
    throw fail('BAD_ARGS', 'Pass either ref or selector.');
  }

  function targetLabel(el) {
    return { role: C.roleOf(el), name: C.nameOf(el) };
  }

  // ---- overlay -------------------------------------------------------------
  // A fixed frame plus a status pill, drawn inside a closed shadow root: page
  // CSS cannot select into it, and the host's inline !important declarations
  // beat any author rule, so page CSS cannot hide it. Ceiling: a transform on
  // <html> still shifts a fixed layer. A closed root is invisible to the
  // snapshot walk; shadowRoots() skips it anyway, because the page-world patch
  // records it in __ffb.shadows.

  var HOST_TAG = 'ffb-overlay';
  var PILL_IDLE = 'attached';
  var overlay = null; // { host, root, pill }
  var overlayState = { busy: null, pulse: 0 };

  var OVERLAY_CSS = [
    '.frame{position:absolute;inset:0;border:3px solid #0060df;box-sizing:border-box}',
    '.pill{position:absolute;right:16px;bottom:16px;max-width:60vw;padding:5px 12px;border-radius:999px;',
    'background:#0060df;color:#fff;font:600 13px/1.4 system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.35);',
    'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.pill.busy{animation:ffb-pulse .7s ease-in-out infinite}',
    '@keyframes ffb-pulse{50%{opacity:.55;transform:scale(1.06)}}',
  ].join('');

  var HOST_STYLE = {
    position: 'fixed',
    inset: '0',
    display: 'block',
    visibility: 'visible',
    opacity: '1',
    margin: '0',
    padding: '0',
    border: '0',
    background: 'transparent',
    transform: 'none',
    filter: 'none',
    'clip-path': 'none',
    'mix-blend-mode': 'normal',
    'pointer-events': 'none',
    overflow: 'visible',
    transition: 'none',
    animation: 'none',
    'z-index': '2147483647',
  };

  function mountOverlay() {
    if (overlay && overlay.host.isConnected) return overlay;
    try {
      var host = document.createElement(HOST_TAG);
      host.setAttribute('aria-hidden', 'true');
      Object.keys(HOST_STYLE).forEach(function (name) {
        host.style.setProperty(name, HOST_STYLE[name], 'important');
      });
      var root = host.attachShadow({ mode: 'closed' });
      var style = document.createElement('style');
      style.textContent = OVERLAY_CSS;
      var frame = document.createElement('div');
      frame.className = 'frame';
      var pill = document.createElement('div');
      pill.className = 'pill';
      pill.textContent = PILL_IDLE;
      root.appendChild(style);
      root.appendChild(frame);
      root.appendChild(pill);
      (document.documentElement || document.body).appendChild(host);
      overlay = { host: host, root: root, pill: pill };
      return overlay;
    } catch (e) {
      overlay = null;
      return null;
    }
  }

  function renderOverlay() {
    if (!overlay) return;
    overlay.pill.textContent = overlayState.busy || PILL_IDLE;
    overlay.pill.className = overlayState.busy ? 'pill busy' : 'pill';
  }

  // A command can finish in a few milliseconds; hold the label long enough to
  // be seen, and let a newer command win over the pending reset.
  function setBusy(name) {
    if (!overlay) return;
    var token = ++overlayState.pulse;
    if (name) {
      overlayState.busy = String(name);
      renderOverlay();
      return;
    }
    if (!overlayState.busy) return;
    setTimeout(function () {
      if (overlayState.pulse !== token) return;
      overlayState.busy = null;
      renderOverlay();
    }, 260);
  }

  function overlayCommand(params) {
    params = params || {};
    if (params.attached === false) {
      if (overlay) {
        try {
          overlay.host.remove();
        } catch (e) {
          /* host already gone */
        }
      }
      overlay = null;
      overlayState.pulse += 1;
      overlayState.busy = null;
      return { mounted: false };
    }
    var live = mountOverlay();
    if (!live) return { mounted: false };
    var hidden = params.hidden === true;
    live.host.style.setProperty('display', hidden ? 'none' : 'block', 'important');
    if (Object.prototype.hasOwnProperty.call(params, 'busy')) setBusy(params.busy);
    return { mounted: true, hidden: hidden, busy: overlayState.busy };
  }

  function isOverlayRoot(root) {
    if (!root) return true;
    if (overlay && root === overlay.root) return true;
    try {
      return String(root.host && root.host.tagName).toLowerCase() === HOST_TAG;
    } catch (e) {
      return false;
    }
  }

  // ---- snapshot ------------------------------------------------------------

  function shadowRoots() {
    var roots = [document];
    try {
      var walk = function (root) {
        var all = root.querySelectorAll('*');
        for (var i = 0; i < all.length; i++) {
          if (overlay && all[i] === overlay.host) continue;
          if (all[i].shadowRoot && !isOverlayRoot(all[i].shadowRoot)) {
            roots.push(all[i].shadowRoot);
            walk(all[i].shadowRoot);
          }
        }
      };
      walk(document);
    } catch (e) {
      /* ignore */
    }
    var p = pageState();
    if (p && p.shadows) {
      try {
        for (var i = 0; i < p.shadows.length; i++) {
          var root = p.shadows[i] && p.shadows[i].root;
          if (!root || isOverlayRoot(root)) continue;
          var known = false;
          for (var j = 0; j < roots.length; j++) if (roots[j] === root) known = true;
          if (!known) roots.push(root);
        }
      } catch (e) {
        /* ignore */
      }
    }
    return roots;
  }

  function snapshot(params) {
    params = params || {};
    state.snapshot += 1;
    state.refs = new Map();
    state.elements = [];
    state.dialogCursor = buffer('dialogs').length;

    var roots = shadowRoots();
    var lines = [];
    var ref = 0;
    for (var r = 0; r < roots.length; r++) {
      var all = roots[r].querySelectorAll('*');
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (!C.isCandidate(el)) continue;
        if (!C.isVisible(el)) continue;
        if (params.interactiveOnly) {
          var role = C.roleOf(el);
          if (!role || ['heading', 'img', 'navigation', 'main', 'banner', 'contentinfo', 'form', 'table', 'list', 'frame'].indexOf(role) !== -1) continue;
        }
        ref += 1;
        var id = 'e' + ref;
        state.refs.set(id, el);
        state.elements.push(el);
        lines.push(C.describe(el, id));
      }
    }

    var capped = C.capLines(lines, C.MAX_LINES);
    var body = capped.lines.join('\n');
    var head = '# ' + (document.title || '(untitled)') + '\n# ' + location.href;
    var more = capped.truncated ? '\n… ' + capped.truncated + ' more (snapshot truncated at ' + C.MAX_LINES + ' lines)' : '';
    return {
      snapshot: state.snapshot,
      url: location.href,
      title: document.title,
      count: ref,
      truncated: capped.truncated,
      text: head + '\n' + body + more,
    };
  }

  // ---- primitives ----------------------------------------------------------

  function nativeSet(el, value) {
    var text = String(value);
    try {
      var proto = el.tagName === 'TEXTAREA' ? page.HTMLTextAreaElement.prototype : page.HTMLInputElement.prototype;
      var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, text);
    } catch (e) {
      el.value = text;
    }
    el.dispatchEvent(pageEvent('input', { bubbles: true }));
    el.dispatchEvent(pageEvent('change', { bubbles: true }));
  }

  function newDialogs() {
    var dialogs = buffer('dialogs');
    var cursor = state.dialogCursor === undefined ? dialogs.length : state.dialogCursor;
    state.dialogCursor = dialogs.length;
    return dialogs.slice(cursor);
  }

  function effect(el, extra) {
    var out = { url: location.href, dialogs: newDialogs() };
    if (el) {
      var label = targetLabel(el);
      out.role = label.role;
      out.name = label.name;
      if (el.value !== undefined && el.tagName !== 'SELECT') out.value = C.valueOf(el);
      if (el.tagName === 'SELECT') out.value = el.value;
      out.focused = document.activeElement === el;
    }
    return Object.assign(out, extra || {});
  }

  function clickEl(el) {
    try {
      el.scrollIntoView({ block: 'center', inline: 'center' });
    } catch (e) {
      /* ignore */
    }
    try {
      el.focus({ preventScroll: true });
    } catch (e) {
      /* ignore */
    }
    ['pointerover', 'mouseover', 'pointerdown', 'mousedown', 'pointerup', 'mouseup'].forEach(function (type) {
      try {
        el.dispatchEvent(mouse(type, { button: 0 }));
      } catch (e) {
        /* ignore */
      }
    });
    var navigates = el.tagName === 'A' && el.href;
    if (navigates) {
      // Answer before the document is replaced.
      setTimeout(function () {
        try {
          el.click();
        } catch (e) {
          /* ignore */
        }
      }, 0);
      return { deferred: true };
    }
    if (typeof el.click === 'function') el.click();
    else el.dispatchEvent(mouse('click'));
    return {};
  }

  function click(params) {
    var el = resolve(params);
    var extra = clickEl(el);
    return effect(el, extra);
  }

  function type(params) {
    var el = resolve(params);
    var text = params.text === undefined || params.text === null ? '' : String(params.text);
    var clear = params.clear !== false;
    try {
      el.focus({ preventScroll: true });
    } catch (e) {
      /* ignore */
    }
    if (clear) {
      if (el.isContentEditable) {
        try {
          page.document.execCommand('selectAll', false, null);
        } catch (e) {
          /* ignore */
        }
      } else {
        nativeSet(el, '');
      }
    } else if (!el.isContentEditable && el.setSelectionRange && typeof el.value === 'string') {
      try {
        el.setSelectionRange(el.value.length, el.value.length);
      } catch (e) {
        /* some input types refuse a selection range */
      }
    }
    var inserted = false;
    try {
      inserted = page.document.execCommand('insertText', false, text);
    } catch (e) {
      inserted = false;
    }
    if (!inserted) {
      if (el.isContentEditable) {
        el.textContent = (clear ? '' : el.textContent || '') + text;
        el.dispatchEvent(pageEvent('input', { bubbles: true }));
      } else {
        nativeSet(el, (clear ? '' : el.value || '') + text);
      }
    }
    var submitted = false;
    if (params.submit) {
      try {
        var form = el.form || (el.closest && el.closest('form'));
        if (form && form.requestSubmit) {
          form.requestSubmit();
          submitted = true;
        } else if (form && form.submit) {
          form.submit();
          submitted = true;
        }
      } catch (e) {
        submitted = false;
      }
    }
    return effect(el, { submitted: submitted, inserted: inserted });
  }

  function pressKey(params) {
    var el = params && (params.ref || params.selector) ? resolve(params) : document.activeElement || document.body;
    var key = params && params.key ? String(params.key) : 'Enter';
    var opts = {
      key: key,
      code: params && params.code ? String(params.code) : key,
      bubbles: true,
      cancelable: true,
      view: window,
      ctrlKey: !!(params && params.ctrl),
      shiftKey: !!(params && params.shift),
      altKey: !!(params && params.alt),
      metaKey: !!(params && params.meta),
    };
    var allowed = true;
    ['keydown', 'keypress', 'keyup'].forEach(function (type) {
      try {
        var event = new KeyboardEvent(type, opts);
        if (!el.dispatchEvent(event)) allowed = false;
      } catch (e) {
        /* ignore */
      }
    });
    var submitted = false;
    if (allowed && key === 'Enter' && el.tagName === 'INPUT') {
      var form = el.form;
      if (form && form.requestSubmit) {
        try {
          form.requestSubmit();
          submitted = true;
        } catch (e) {
          /* ignore */
        }
      }
    }
    return effect(el, { defaultPrevented: !allowed, submitted: submitted });
  }

  function select(params) {
    var el = resolve(params);
    if (el.tagName !== 'SELECT') throw fail('NOT_A_SELECT', 'That ref is not a <select>.');
    var wanted = String(params.option === undefined ? '' : params.option);
    var matched = null;
    for (var i = 0; i < el.options.length; i++) {
      var option = el.options[i];
      if (option.value === wanted || C.clean(option.textContent) === wanted) {
        matched = option;
        break;
      }
    }
    if (!matched) throw fail('OPTION_NOT_FOUND', 'No option "' + wanted + '". Available: ' + Array.prototype.map.call(el.options, function (o) { return C.clean(o.textContent); }).join(', '));
    el.value = matched.value;
    el.dispatchEvent(pageEvent('input', { bubbles: true }));
    el.dispatchEvent(pageEvent('change', { bubbles: true }));
    return effect(el, { selected: C.clean(matched.textContent) });
  }

  function hover(params) {
    var el = resolve(params);
    try {
      el.scrollIntoView({ block: 'center' });
    } catch (e) {
      /* ignore */
    }
    ['pointerover', 'mouseover', 'mousemove'].forEach(function (type) {
      try {
        el.dispatchEvent(mouse(type));
      } catch (e) {
        /* ignore */
      }
    });
    return effect(el);
  }

  function scroll(params) {
    params = params || {};
    if (params.ref || params.selector) {
      var el = resolve(params);
      try {
        el.scrollIntoView({ block: params.block || 'center', inline: 'nearest', behavior: 'instant' });
      } catch (e) {
        el.scrollIntoView();
      }
      return effect(el, scrollOffsets());
    }
    var left = Number(params.dx || 0);
    var top = Number(params.dy || 0);
    window.scrollBy({ left: left, top: top, behavior: 'instant' });
    return { url: location.href, scrollX: scrollOffsets().scrollX, scrollY: scrollOffsets().scrollY, dialogs: newDialogs() };
  }

  function upload(params) {
    var el = resolve(params);
    if (el.tagName !== 'INPUT' || String(el.type).toLowerCase() !== 'file') {
      throw fail('NOT_A_FILE_INPUT', 'That ref is not a file input.');
    }
    var binary = atob(String(params.b64 || ''));
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    var file = new File([bytes], params.name || 'upload.bin', { type: params.type || 'application/octet-stream' });
    var transfer = new DataTransfer();
    transfer.items.add(file);
    el.files = transfer.files;
    el.dispatchEvent(pageEvent('input', { bubbles: true }));
    el.dispatchEvent(pageEvent('change', { bubbles: true }));
    return effect(el, { files: transfer.files.length, size: bytes.length });
  }

  // ---- waiting -------------------------------------------------------------

  function quietFor(ms) {
    return new Promise(function (resolveQuiet) {
      var observer = new MutationObserver(function () {
        clearTimeout(timer);
        timer = setTimeout(done, ms);
      });
      var done = function () {
        observer.disconnect();
        resolveQuiet(true);
      };
      var timer = setTimeout(done, ms);
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    });
  }

  function pageText() {
    return (document.body ? document.body.innerText : '') || '';
  }

  function waitFor(params) {
    params = params || {};
    var timeout = Number(params.timeoutMs || 5000);
    var began = Date.now();
    return new Promise(function (resolveWait, rejectWait) {
      var finish = function (extra) {
        resolveWait(Object.assign({ matched: true, waitedMs: Date.now() - began, url: location.href }, extra || {}));
      };
      var settle = function () {
        clearInterval(interval);
        clearTimeout(deadline);
        (params.quiet === false ? Promise.resolve() : quietFor(250)).then(function () {
          finish();
        });
      };
      var check = function () {
        try {
          if (params.quiet && !params.text && !params.selector && !params.ref && !params.gone && !params.urlIncludes) {
            settle();
            return true;
          }
          if (params.text && pageText().indexOf(String(params.text)) === -1) return false;
          if (params.urlIncludes && location.href.indexOf(String(params.urlIncludes)) === -1) return false;
          if (params.selector && !document.querySelector(params.selector)) return false;
          if (params.ref) {
            var el = state.refs.get(String(params.ref));
            if (!el || !el.isConnected) return false;
          }
          if (params.gone) {
            var gone = String(params.gone);
            if (pageText().indexOf(gone) !== -1) return false;
            if (document.querySelector(gone)) return false;
          }
          settle();
          return true;
        } catch (e) {
          return false;
        }
      };
      var interval = setInterval(check, 100);
      var deadline = setTimeout(function () {
        clearInterval(interval);
        rejectWait(fail('TIMEOUT', 'wait_for timed out after ' + timeout + 'ms'));
      }, timeout);
      check();
    });
  }

  // ---- internal ------------------------------------------------------------

  // window.scrollY reads 0 from the content sandbox (it reports the sandbox's
  // viewport), so read the document's own scroll offsets instead.
  function scrollOffsets() {
    var doc = document.documentElement || document.body;
    return {
      scrollX: Math.round((doc && doc.scrollLeft) || window.scrollX || 0),
      scrollY: Math.round((doc && doc.scrollTop) || window.scrollY || 0),
    };
  }

  function metrics() {
    var offsets = scrollOffsets();
    return {
      url: location.href,
      title: document.title,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      scrollX: offsets.scrollX,
      scrollY: offsets.scrollY,
      scrollHeight: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0),
      scrollWidth: Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0),
      dpr: window.devicePixelRatio || 1,
    };
  }

  function scrollTo(params) {
    window.scrollTo({ left: Number((params && params.x) || 0), top: Number((params && params.y) || 0), behavior: 'instant' });
    return new Promise(function (resolveScroll) {
      setTimeout(function () {
        resolveScroll(metrics());
      }, 80);
    });
  }

  var handlers = {
    overlay: overlayCommand,
    snapshot: snapshot,
    click: click,
    type: type,
    press_key: pressKey,
    select: select,
    hover: hover,
    scroll: scroll,
    upload: upload,
    wait_for: waitFor,
    console: function (params) {
      var all = buffer('console');
      var since = Math.max(0, Number((params && params.since) || 0));
      var items = all.slice(since);
      if (params && params.limit) items = items.slice(-Number(params.limit));
      return { total: all.length, items: items };
    },
    network: function (params) {
      var all = buffer('network');
      var since = Math.max(0, Number((params && params.since) || 0));
      var items = all.slice(since);
      if (params && params.failedOnly) items = items.filter(function (entry) { return entry.ok === false || entry.error; });
      if (params && params.limit) items = items.slice(-Number(params.limit));
      return { total: all.length, items: items };
    },
    dialogs: function () {
      return { items: buffer('dialogs') };
    },
    patch_status: function () {
      var p = pageState();
      return { present: !!p, shadows: buffer('shadows').length, errors: p ? { console: p.consoleError, dialogs: p.dialogError, network: p.networkError || p.xhrError, shadow: p.shadowError } : null };
    },
    metrics: metrics,
    scroll_to: scrollTo,
    ping: function () {
      return { pong: true, url: location.href };
    },
  };

  browser.runtime.onMessage.addListener(function (message) {
    if (!message || message.__ffb !== true) return;
    if (window.__ffbAgentToken !== AGENT_TOKEN) return;
    var handler = handlers[message.cmd];
    if (!handler) {
      return Promise.resolve({ ok: false, error: { code: 'UNKNOWN_COMMAND', message: 'Unknown command ' + message.cmd } });
    }
    // The pill names whatever runs and pulses while it runs; `overlay` is the
    // push that draws it, never something the user is waiting on.
    var busy = message.cmd !== 'overlay';
    if (busy) setBusy(message.cmd);
    return Promise.resolve()
      .then(function () {
        return handler(message.params || {});
      })
      .then(function (result) {
        if (busy) setBusy(null);
        return { ok: true, result: result };
      })
      .catch(function (error) {
        if (busy) setBusy(null);
        return { ok: false, error: { code: (error && error.code) || 'ERROR', message: String((error && error.message) || error) } };
      });
  });
})();
