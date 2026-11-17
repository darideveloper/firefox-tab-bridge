// Runs in the page's MAIN world at document_start, registered through
// browser.contentScripts.register({ world: "MAIN" }).
//
// The isolated agent reads this object through window.wrappedJSObject.__ffb.
// Nothing here talks to the extension: no messages, no storage, no network.
(function () {
  'use strict';
  if (window.__ffb) return;

  var MAX_ENTRIES = 200;
  var started = Date.now();

  var ffb = {
    started: started,
    console: [],
    network: [],
    dialogs: [],
    shadows: [],
    dialogAnswers: { confirm: false, prompt: null },
    record: function (kind, entry) {
      var list = ffb[kind];
      entry.t = Date.now() - started;
      list.push(entry);
      if (list.length > MAX_ENTRIES) list.splice(0, list.length - MAX_ENTRIES);
    },
  };
  window.__ffb = ffb;

  try {
    ['log', 'info', 'warn', 'error', 'debug'].forEach(function (level) {
      var original = console[level];
      console[level] = function () {
        try {
          var args = Array.prototype.slice.call(arguments);
          ffb.record('console', {
            level: level,
            text: args
              .map(function (a) {
                if (typeof a === 'string') return a;
                try {
                  return JSON.stringify(a);
                } catch (e) {
                  return String(a);
                }
              })
              .join(' ')
              .slice(0, 2000),
          });
        } catch (e) {
          /* never break the page */
        }
        return original.apply(console, arguments);
      };
    });
  } catch (e) {
    ffb.consoleError = String(e);
  }

  try {
    window.alert = function (message) {
      ffb.record('dialogs', { kind: 'alert', message: String(message) });
    };
    window.confirm = function (message) {
      ffb.record('dialogs', { kind: 'confirm', message: String(message), answer: !!ffb.dialogAnswers.confirm });
      return !!ffb.dialogAnswers.confirm;
    };
    window.prompt = function (message, fallback) {
      var answer = ffb.dialogAnswers.prompt;
      ffb.record('dialogs', { kind: 'prompt', message: String(message), answer: answer });
      return answer === null || answer === undefined ? (fallback === undefined ? null : fallback) : answer;
    };
  } catch (e) {
    ffb.dialogError = String(e);
  }

  try {
    var originalFetch = window.fetch;
    if (typeof originalFetch === 'function') {
      window.fetch = function (input, init) {
        var url = '';
        try {
          url = typeof input === 'string' ? input : input && input.url ? input.url : String(input);
        } catch (e) {
          url = '';
        }
        var method = (init && init.method) || (input && input.method) || 'GET';
        var began = Date.now();
        var entry = { kind: 'fetch', method: String(method).toUpperCase(), url: String(url).slice(0, 500) };
        return originalFetch.apply(this, arguments).then(
          function (response) {
            entry.status = response.status;
            entry.ok = response.ok;
            entry.ms = Date.now() - began;
            ffb.record('network', entry);
            return response;
          },
          function (error) {
            entry.error = String((error && error.message) || error).slice(0, 300);
            entry.ms = Date.now() - began;
            ffb.record('network', entry);
            throw error;
          }
        );
      };
    }
  } catch (e) {
    ffb.networkError = String(e);
  }

  try {
    var XHR = window.XMLHttpRequest;
    if (XHR && XHR.prototype) {
      var open = XHR.prototype.open;
      var sendRequest = XHR.prototype.send;
      XHR.prototype.open = function (method, url) {
        this.__ffb = { kind: 'xhr', method: String(method).toUpperCase(), url: String(url).slice(0, 500), began: Date.now() };
        return open.apply(this, arguments);
      };
      XHR.prototype.send = function () {
        var xhr = this;
        var entry = xhr.__ffb;
        if (entry) {
          xhr.addEventListener('loadend', function () {
            try {
              entry.status = xhr.status;
              entry.ok = xhr.status >= 200 && xhr.status < 400;
              entry.ms = Date.now() - entry.began;
              if (xhr.status === 0) entry.error = 'network error or blocked request';
              ffb.record('network', entry);
            } catch (e) {
              /* ignore */
            }
          });
        }
        return sendRequest.apply(this, arguments);
      };
    }
  } catch (e) {
    ffb.xhrError = String(e);
  }

  try {
    var attachShadow = Element.prototype.attachShadow;
    if (attachShadow) {
      Element.prototype.attachShadow = function (init) {
        var root = attachShadow.apply(this, arguments);
        try {
          ffb.record('shadows', { mode: (init && init.mode) || 'open', host: this.tagName.toLowerCase(), root: root });
        } catch (e) {
          /* ignore */
        }
        return root;
      };
    }
  } catch (e) {
    ffb.shadowError = String(e);
  }
})();
