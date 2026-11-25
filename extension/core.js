// Pure DOM helpers shared by the content agent and by bun tests.
// Classic script (no imports): loaded by contentScripts.register and importable
// from a Bun test for the side effect of setting globalThis.FFBCore.
(function (g) {
  'use strict';

  var MAX_NAME = 80;
  var MAX_VALUE = 40;
  var MAX_LINES = 1500;

  var INPUT_ROLES = {
    button: 'button',
    submit: 'button',
    reset: 'button',
    image: 'button',
    checkbox: 'checkbox',
    radio: 'radio',
    range: 'slider',
    file: 'file',
    color: 'color',
    hidden: null,
  };

  var TAG_ROLES = {
    a: 'link',
    button: 'button',
    select: 'combobox',
    textarea: 'textbox',
    summary: 'button',
    option: 'option',
    h1: 'heading',
    h2: 'heading',
    h3: 'heading',
    h4: 'heading',
    h5: 'heading',
    h6: 'heading',
    img: 'img',
    iframe: 'frame',
    nav: 'navigation',
    main: 'main',
    header: 'banner',
    footer: 'contentinfo',
    form: 'form',
    table: 'table',
    ul: 'list',
    ol: 'list',
  };

  function clean(s, max) {
    max = max || MAX_NAME;
    if (s === null || s === undefined) return '';
    var t = String(s).replace(/\s+/g, ' ').trim();
    if (t.length > max) t = t.slice(0, max - 1) + '…';
    return t;
  }

  function tag(el) {
    return (el && el.tagName ? el.tagName : '').toLowerCase();
  }

  function attr(el, name) {
    return el && el.getAttribute ? el.getAttribute(name) : null;
  }

  function roleOf(el) {
    var explicit = clean(attr(el, 'role'), 40);
    if (explicit) return explicit;
    var t = tag(el);
    if (t === 'input') {
      var type = String((el.type || 'text')).toLowerCase();
      if (Object.prototype.hasOwnProperty.call(INPUT_ROLES, type)) return INPUT_ROLES[type];
      return 'textbox';
    }
    if (el.isContentEditable) return 'textbox';
    return TAG_ROLES[t] || null;
  }

  function labelledBy(el) {
    var ids = clean(attr(el, 'aria-labelledby'), 200);
    if (!ids) return '';
    var doc = el.ownerDocument;
    if (!doc) return '';
    var parts = [];
    ids.split(' ').forEach(function (id) {
      if (!id) return;
      var ref = doc.getElementById ? doc.getElementById(id) : null;
      if (ref) parts.push(ref.textContent || '');
    });
    return clean(parts.join(' '));
  }

  function labelText(el) {
    if (el.labels && el.labels.length) {
      var joined = [];
      for (var i = 0; i < el.labels.length; i++) joined.push(el.labels[i].textContent || '');
      var text = clean(joined.join(' '));
      if (text) return text;
    }
    var doc = el.ownerDocument;
    var id = attr(el, 'id');
    if (doc && id && doc.querySelector) {
      try {
        var forLabel = doc.querySelector('label[for="' + id.replace(/"/g, '\\"') + '"]');
        if (forLabel) return clean(forLabel.textContent);
      } catch (e) {
        /* invalid id for a selector: fall through */
      }
    }
    return '';
  }

  function nameOf(el) {
    var name =
      clean(attr(el, 'aria-label')) ||
      labelledBy(el) ||
      labelText(el) ||
      clean(attr(el, 'placeholder')) ||
      clean(attr(el, 'alt')) ||
      clean(attr(el, 'title')) ||
      clean(attr(el, 'name'), 40) ||
      clean(el.textContent, MAX_NAME);
    if (!name && tag(el) === 'input' && String(el.type || '').toLowerCase() !== 'password') {
      name = clean(el.value, MAX_NAME);
    }
    return name;
  }

  function isVisible(el) {
    if (!el || typeof el.getClientRects !== 'function') return true;
    if (tag(el) === 'input' && String(el.type).toLowerCase() === 'hidden') return false;
    if (attr(el, 'aria-hidden') === 'true') return false;
    var rects = el.getClientRects();
    if (!rects || rects.length === 0) return false;
    var doc = el.ownerDocument;
    var win = doc && doc.defaultView;
    if (win && win.getComputedStyle) {
      var cs = win.getComputedStyle(el);
      if (!cs) return true;
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      if (parseFloat(cs.opacity) === 0) return false;
    }
    return true;
  }

  function stateOf(el) {
    var bits = [];
    if (el.disabled) bits.push('disabled');
    if (el.checked) bits.push('checked');
    if (el.multiple) bits.push('multiple');
    if (attr(el, 'aria-expanded')) bits.push('expanded=' + attr(el, 'aria-expanded'));
    if (attr(el, 'aria-selected')) bits.push('selected=' + attr(el, 'aria-selected'));
    if (el.readOnly) bits.push('readonly');
    if (el.required) bits.push('required');
    return bits;
  }

  function valueOf(el) {
    var t = tag(el);
    if (t !== 'input' && t !== 'textarea' && t !== 'select') return '';
    if (String(el.type || '').toLowerCase() === 'password') return el.value ? '••••' : '';
    return clean(el.value, MAX_VALUE);
  }

  // One snapshot line: `e7 textbox "Email" value="a@b.c" required`
  function describe(el, ref) {
    var role = roleOf(el);
    var name = nameOf(el);
    var parts = [ref, role || tag(el) || 'element'];
    if (name) parts.push(JSON.stringify(name));
    var value = valueOf(el);
    if (value) parts.push('value=' + JSON.stringify(value));
    if (tag(el) === 'iframe') parts.push('src=' + JSON.stringify(clean(el.src, 120)));
    var state = stateOf(el);
    if (state.length) parts.push(state.join(','));
    return parts.join(' ');
  }

  function isCandidate(el) {
    if (!el || el.nodeType !== 1) return false;
    var t = tag(el);
    if (['script', 'style', 'meta', 'link', 'head', 'html', 'body'].indexOf(t) !== -1) return false;
    if (t === 'input' && String(el.type).toLowerCase() === 'hidden') return false;
    if (attr(el, 'aria-hidden') === 'true') return false;
    if (roleOf(el)) return true;
    if (attr(el, 'onclick')) return true;
    if (attr(el, 'tabindex') !== null) return true;
    if (attr(el, 'aria-label') || attr(el, 'aria-labelledby')) return true;
    if (el.isContentEditable) return true;
    return false;
  }

  function capLines(lines, max) {
    max = max || MAX_LINES;
    if (lines.length <= max) return { lines: lines, truncated: 0 };
    return { lines: lines.slice(0, max), truncated: lines.length - max };
  }

  g.FFBCore = {
    MAX_LINES: MAX_LINES,
    clean: clean,
    tag: tag,
    attr: attr,
    roleOf: roleOf,
    nameOf: nameOf,
    valueOf: valueOf,
    isVisible: isVisible,
    isCandidate: isCandidate,
    describe: describe,
    capLines: capLines,
  };
  // In a Firefox content script the sandbox global is not `window`; mirror the
  // export so callers reading either one find it.
  if (typeof window !== 'undefined' && window !== g) window.FFBCore = g.FFBCore;
})(typeof globalThis !== 'undefined' ? globalThis : this);
