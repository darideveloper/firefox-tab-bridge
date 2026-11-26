// Background page: socket to the local MCP server, the attached-tab lease,
// command routing, content-script registration and screenshots.
'use strict';

const DEFAULT_PORT = 8788;
const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 5000;
const HEARTBEAT_MS = 20000;
const SILENCE_MS = 60000;
const NAV_TIMEOUT_MS = 30000;
const MAX_TILES = 20;

const state = {
  port: DEFAULT_PORT,
  token: '',
  attached: new Set(),
  ws: null,
  ready: false,
  backoff: RECONNECT_MIN_MS,
  lastMessage: 0,
  agentReg: null,
  patchesReg: null,
  patchError: null,
  navigating: new Set(),
};

function ffbError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// Last failure, so the options page can show it instead of a bare ERR badge.
let lastError = null;

function noteError(where, error) {
  lastError = { where, message: String((error && error.message) || error) };
  try {
    browser.storage.local.set({ lastError });
  } catch (e) {
    /* ignore */
  }
}

// ---- badge ---------------------------------------------------------------

function setBadge(text, color) {
  try {
    browser.browserAction.setBadgeText({ text });
    if (color) browser.browserAction.setBadgeBackgroundColor({ color });
  } catch (e) {
    /* ignore */
  }
}

function updateBadge(tabId) {
  try {
    if (state.attached.has(tabId)) {
      browser.browserAction.setBadgeText({ tabId, text: 'ON' });
      browser.browserAction.setBadgeBackgroundColor({ tabId, color: '#2b8a3e' });
    } else if (!state.ready) {
      browser.browserAction.setBadgeText({ tabId, text: 'OFF' });
      browser.browserAction.setBadgeBackgroundColor({ tabId, color: '#a61e1e' });
    } else {
      browser.browserAction.setBadgeText({ tabId, text: '' });
    }
  } catch (e) {
    /* tab is gone */
  }
}

function refreshBadges() {
  browser.tabs.query({}).then((tabs) => tabs.forEach((tab) => updateBadge(tab.id)));
}

// ---- socket --------------------------------------------------------------

function notifyServer(frame) {
  if (state.ws && state.ws.readyState === 1) {
    try {
      state.ws.send(JSON.stringify(frame));
    } catch (e) {
      /* ignore */
    }
  }
}

function broadcastState() {
  notifyServer({ event: 'state', attached: Array.from(state.attached), ready: state.ready });
}

function scheduleReconnect() {
  const delay = state.backoff;
  state.backoff = Math.min(state.backoff * 2, RECONNECT_MAX_MS);
  setTimeout(connect, delay);
}

function connect() {
  if (state.ws && (state.ws.readyState === 0 || state.ws.readyState === 1)) return;
  let ws;
  try {
    ws = new WebSocket('ws://127.0.0.1:' + state.port);
  } catch (e) {
    scheduleReconnect();
    return;
  }
  state.ws = ws;
  ws.onopen = () => {
    ws.send(JSON.stringify({ event: 'hello', token: state.token, version: browser.runtime.getManifest().version }));
  };
  ws.onmessage = (event) => {
    state.lastMessage = Date.now();
    let frame;
    try {
      frame = JSON.parse(event.data);
    } catch (e) {
      return;
    }
    handleFrame(frame);
  };
  ws.onclose = () => {
    if (state.ws !== ws) return;
    state.ws = null;
    state.ready = false;
    setBadge('OFF', '#a61e1e');
    refreshBadges();
    scheduleReconnect();
  };
  ws.onerror = () => {
    /* onclose follows */
  };
}

function handleFrame(frame) {
  if (!frame || typeof frame !== 'object') return;
  if (frame.event === 'ready') {
    state.ready = true;
    state.backoff = RECONNECT_MIN_MS;
    setBadge('', '#2b8a3e');
    refreshBadges();
    broadcastState();
    return;
  }
  if (frame.event === 'pong') {
    notifyServer({ event: 'pong' });
    return;
  }
  if (frame.id === undefined || !frame.tool) return;
  runTool(frame.tool, frame.args || {})
    .then((result) => notifyServer({ id: frame.id, ok: true, result }))
    .catch((error) =>
      notifyServer({
        id: frame.id,
        ok: false,
        error: { code: (error && error.code) || 'ERROR', message: String((error && error.message) || error) },
      })
    );
}

setInterval(() => {
  if (state.ws && state.ws.readyState === 1) {
    if (state.ready && Date.now() - state.lastMessage > SILENCE_MS) {
      try {
        state.ws.close();
      } catch (e) {
        /* ignore */
      }
      return;
    }
    notifyServer({ event: 'ping' });
  }
}, HEARTBEAT_MS);

// ---- content scripts -----------------------------------------------------

async function permissionGranted() {
  try {
    return await browser.permissions.contains({ origins: ['<all_urls>'] });
  } catch (e) {
    return false;
  }
}

async function ensureRegistered() {
  if (!(await permissionGranted())) return false;
  if (!state.agentReg) {
    try {
      state.agentReg = await browser.contentScripts.register({
        matches: ['<all_urls>'],
        js: [{ file: 'core.js' }, { file: 'agent.js' }],
        runAt: 'document_idle',
        allFrames: false,
      });
    } catch (e) {
      console.error('[ffbridge] agent registration failed', e);
    }
  }
  if (!state.patchesReg) {
    try {
      state.patchesReg = await browser.contentScripts.register({
        matches: ['<all_urls>'],
        js: [{ file: 'patches.js' }],
        runAt: 'document_start',
        world: 'MAIN',
        allFrames: false,
      });
      state.patchError = null;
    } catch (e) {
      // No MAIN world here: patches are injected per document as a <script>
      // tag from injectInto(), which strict CSP may block.
      state.patchError = String(e);
    }
  }
  return true;
}

function supportsTab(url) {
  return typeof url === 'string' && /^(https?|file):/i.test(url);
}

// Firefox's tabs.executeScript takes one file per call and gives each call its own
// sandbox, so core.js's FFBCore global would be invisible to agent.js. Concatenate
// them into one code payload instead: same sandbox, no build step.
let agentBundlePromise = null;

function agentBundle() {
  if (!agentBundlePromise) {
    agentBundlePromise = Promise.all(
      ['core.js', 'agent.js'].map((file) =>
        fetch(browser.runtime.getURL(file)).then((response) => response.text())
      )
    ).then(([core, agent]) => core + '\n;\n' + agent);
  }
  return agentBundlePromise;
}

async function injectInto(tabId, force) {
  if (!(await ensureRegistered())) {
    throw ffbError('PERMISSION_NEEDED', 'Click the ff-tab-bridge toolbar button once to grant site access, then retry.');
  }
  let hasAgent = false;
  let hasPatches = false;
  try {
    const probe = await browser.tabs.executeScript(tabId, {
      code: '[!!window.__ffbAgentToken, !!(window.wrappedJSObject && window.wrappedJSObject.__ffb)]',
    });
    if (probe && probe[0]) {
      hasAgent = !!probe[0][0];
      hasPatches = !!probe[0][1];
    }
  } catch (e) {
    /* first injection into this document */
  }
  if (force || !hasAgent) {
    try {
      await browser.tabs.executeScript(tabId, { code: await agentBundle() });
      hasAgent = true;
    } catch (e) {
      throw ffbError('INJECT_FAILED', 'Cannot run in this tab: ' + e.message);
    }
  }
  // Pages loaded before registration have no MAIN-world patch yet. A script tag
  // is the only injection route into the page world; strict CSP can block it.
  if (!hasPatches) {
    try {
      await browser.tabs.executeScript(tabId, {
        code:
          '(function(){if(document.getElementById("__ffb_patch"))return;' +
          'var s=document.createElement("script");s.id="__ffb_patch";s.src=' +
          JSON.stringify(browser.runtime.getURL('patches.js')) +
          ';s.onload=function(){s.remove()};document.documentElement.appendChild(s);})()',
      });
    } catch (e) {
      state.patchError = String(e);
    }
  }
  return { hasAgent, hasPatches };
}

// ---- lease ---------------------------------------------------------------

function requireAttached(tabId) {
  if (!state.attached.has(tabId)) {
    throw ffbError('TAB_NOT_ATTACHED', 'Tab ' + tabId + ' is not attached. Call tabs to see attached tabs, or attach it first.');
  }
}

async function agentCall(tabId, cmd, params) {
  requireAttached(tabId);
  const frame = { __ffb: true, cmd, params: params || {} };
  let reply;
  try {
    reply = await browser.tabs.sendMessage(tabId, frame);
  } catch (e) {
    await injectInto(tabId, true);
    reply = await browser.tabs.sendMessage(tabId, frame);
    // The retry means a fresh document: its overlay has to be mounted there too.
    await pushOverlay(tabId, true);
  }
  if (!reply) throw ffbError('NO_RESPONSE', 'The page did not answer (it may be navigating).');
  if (!reply.ok) throw ffbError(reply.error.code, reply.error.message);
  return reply.result;
}

// ---- overlay -------------------------------------------------------------

function overlayParams(tabId, attached) {
  return { attached, busy: state.navigating.has(tabId) ? 'navigate' : null };
}

// The page draws the marker; this is the only thing that says which tabs and
// which command. Best effort by design: a document mid-navigation or not yet
// injected gets it from the next onCompleted push.
async function pushOverlay(tabId, attached, extra) {
  if (!state.attached.has(tabId) && attached !== false) return;
  try {
    await browser.tabs.sendMessage(tabId, {
      __ffb: true,
      cmd: 'overlay',
      params: Object.assign(overlayParams(tabId, attached), extra || {}),
    });
  } catch (e) {
    /* tab mid-navigation, or the agent is not in this document yet */
  }
}

// ---- attach / detach -----------------------------------------------------

async function attach(tabId) {
  const tab = await browser.tabs.get(tabId);
  if (!supportsTab(tab.url)) {
    throw ffbError('TAB_UNSUPPORTED', 'Only http(s) and file tabs can be attached.');
  }
  await injectInto(tabId, true);
  state.attached.add(tabId);
  lastError = null;
  updateBadge(tabId);
  broadcastState();
  await pushOverlay(tabId, true);
  return { tabId, attached: true, title: tab.title || '', url: tab.url || '' };
}

async function detach(tabId) {
  // While the lease still holds, so the page accepts the command and drops the marker.
  if (state.attached.has(tabId)) await pushOverlay(tabId, false);
  const had = state.attached.delete(tabId);
  updateBadge(tabId);
  broadcastState();
  return { tabId, attached: false, was: had };
}

browser.browserAction.onClicked.addListener(async (tab) => {
  try {
    // Firefox only accepts permissions.request() synchronously inside the gesture, which an
    // await breaks, so <all_urls> is a declared permission instead: it is granted at load.
    if (!(await permissionGranted())) {
      noteError(
        'toolbar click',
        ffbError('PERMISSION_NEEDED', 'Site access is not granted. Reload the add-on from about:debugging.')
      );
      setBadge('OFF', '#a61e1e');
      return;
    }
    await ensureRegistered();
    if (state.attached.has(tab.id)) await detach(tab.id);
    else await attach(tab.id);
  } catch (error) {
    console.error('[ffbridge] toolbar click failed', error);
    noteError('toolbar click', error);
    setBadge('ERR', '#a61e1e');
  }
});

browser.tabs.onRemoved.addListener((tabId) => {
  if (state.attached.delete(tabId)) {
    notifyServer({ event: 'tab_gone', tabId });
    broadcastState();
  }
});

browser.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  if (!state.attached.has(details.tabId)) return;
  notifyServer({ event: 'navigated', tabId: details.tabId, url: details.url });
});

browser.webNavigation.onCompleted.addListener((details) => {
  if (details.frameId !== 0) return;
  if (!state.attached.has(details.tabId)) return;
  // Re-inject for documents loaded before registration, and after a reload of
  // the add-on. Skipped when the page already has everything.
  injectInto(details.tabId)
    .then(() => pushOverlay(details.tabId, true))
    .catch(() => {});
});

browser.tabs.onUpdated.addListener((tabId, info) => {
  if (state.attached.has(tabId) && (info.url || info.status === 'complete')) broadcastState();
});

// ---- navigation ----------------------------------------------------------

function waitForLoad(tabId, timeoutMs) {
  return new Promise((resolveLoad, rejectLoad) => {
    const timer = setTimeout(() => {
      browser.webNavigation.onCompleted.removeListener(listener);
      rejectLoad(ffbError('NAV_TIMEOUT', 'Navigation did not finish within ' + timeoutMs + 'ms'));
    }, timeoutMs);
    function listener(details) {
      if (details.tabId !== tabId || details.frameId !== 0) return;
      clearTimeout(timer);
      browser.webNavigation.onCompleted.removeListener(listener);
      resolveLoad(details);
    }
    browser.webNavigation.onCompleted.addListener(listener);
  });
}

async function navigate(args) {
  const tabId = Number(args.tabId);
  requireAttached(tabId);
  // The document that would show the pill is replaced by the navigation, so the
  // name comes from here and the onCompleted push re-reads it in the new page.
  state.navigating.add(tabId);
  await pushOverlay(tabId, true);
  try {
    const loading = waitForLoad(tabId, NAV_TIMEOUT_MS);
    if (args.url) await browser.tabs.update(tabId, { url: args.url });
    else if (args.back) await browser.tabs.goBack(tabId);
    else if (args.forward) await browser.tabs.goForward(tabId);
    else if (args.reload) await browser.tabs.reload(tabId);
    else throw ffbError('BAD_ARGS', 'Pass url, back, forward or reload.');
    const details = await loading;
    try {
      await agentCall(tabId, 'wait_for', { quiet: true, timeoutMs: 5000 });
    } catch (e) {
      /* a page may already be quiet, or the agent is not ready yet */
    }
    const tab = await browser.tabs.get(tabId);
    return { tabId, url: (details && details.url) || tab.url, title: tab.title || '' };
  } finally {
    state.navigating.delete(tabId);
    await pushOverlay(tabId, true);
  }
}

// ---- screenshots ---------------------------------------------------------

function loadImage(dataUrl) {
  return new Promise((resolveImage, rejectImage) => {
    const image = new Image();
    image.onload = () => resolveImage(image);
    image.onerror = () => rejectImage(ffbError('IMAGE_DECODE', 'Could not decode a captured frame.'));
    image.src = dataUrl;
  });
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function screenshot(args) {
  const tabId = Number(args.tabId);
  requireAttached(tabId);
  // The marker is ours, never the page's: a capture shows what the page shows.
  await pushOverlay(tabId, true, { hidden: true });
  await sleep(80);
  try {
    if (!args.fullPage) {
      const dataUrl = await browser.tabs.captureTab(tabId);
      return { dataUrl, fullPage: false };
    }

    const start = await agentCall(tabId, 'metrics', {});
    const viewport = start.innerHeight || 800;
    const pageHeight = Math.min(start.scrollHeight || viewport, viewport * MAX_TILES);
    const offsets = [];
    for (let y = 0; y < pageHeight; y += viewport) offsets.push(y);

    const frames = [];
    for (const y of offsets) {
      await agentCall(tabId, 'scroll_to', { x: 0, y });
      await sleep(140);
      frames.push({ y, dataUrl: await browser.tabs.captureTab(tabId) });
    }
    await agentCall(tabId, 'scroll_to', { x: start.scrollX || 0, y: start.scrollY || 0 });

    const images = [];
    for (const frame of frames) images.push(await loadImage(frame.dataUrl));
    const scale = images[0].width / (start.innerWidth || images[0].width);
    const width = Math.round((start.scrollWidth || start.innerWidth) * scale);
    const height = Math.round(pageHeight * scale);

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, width);
    canvas.height = Math.max(1, height);
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    images.forEach((image, index) => {
      context.drawImage(image, 0, Math.round(offsets[index] * scale));
    });

    return {
      dataUrl: canvas.toDataURL('image/png'),
      fullPage: true,
      tiles: images.length,
      width: canvas.width,
      height: canvas.height,
      truncated: (start.scrollHeight || 0) > pageHeight,
    };
  } finally {
    await pushOverlay(tabId, true, { hidden: false });
  }
}

// ---- self-test -----------------------------------------------------------

async function selfTest(args) {
  const tabId = Number(args.tabId);
  requireAttached(tabId);
  const results = [];
  const check = async (name, fn) => {
    try {
      const detail = await fn();
      results.push({ name, ok: true, detail: detail === undefined ? '' : detail });
    } catch (error) {
      results.push({ name, ok: false, detail: (error && error.message) || String(error) });
    }
  };

  let snap;
  await check('snapshot', async () => {
    snap = await agentCall(tabId, 'snapshot', {});
    return snap.count + ' elements, snapshot ' + snap.snapshot;
  });
  await check('snapshot sees fixture controls', async () => {
    if (!snap) throw new Error('no snapshot');
    if (snap.text.indexOf('Count a click') === -1) throw new Error('fixture button missing from snapshot');
    if (snap.text.indexOf('shadow input') === -1) throw new Error('closed shadow root not traversed');
    return 'ok';
  });
  await check('patches present', async () => {
    const status = await agentCall(tabId, 'patch_status', {});
    if (!status.present) throw new Error('window.__ffb missing (CSP blocked the page-world patch?)');
    return JSON.stringify(status.errors);
  });
  await check('type into input', async () => {
    const typed = await agentCall(tabId, 'type', { selector: '#name', text: 'ffbridge', clear: true });
    if (!/ffbridge/.test(typed.value || '')) throw new Error('value is ' + typed.value);
    return typed.value;
  });
  await check('input events reach the page', async () => {
    const after = await agentCall(tabId, 'snapshot', {});
    if (after.text.indexOf('input name') === -1) throw new Error('page never saw the input event');
    return 'ok';
  });
  await check('keyboard events reach the page', async () => {
    await agentCall(tabId, 'press_key', { selector: '#delegated-button', key: 'a' });
    const after = await agentCall(tabId, 'snapshot', {});
    if (after.text.indexOf('keydown a') === -1) throw new Error('page never saw the keydown');
    return 'ok';
  });
  await check('console capture', async () => {
    await agentCall(tabId, 'click', { selector: '#console' });
    const captured = await agentCall(tabId, 'console', { limit: 5 });
    if (!captured.items.length) throw new Error('no console entries');
    return captured.items[captured.items.length - 1].text;
  });
  await check('network capture', async () => {
    await agentCall(tabId, 'click', { selector: '#network' });
    await sleep(400);
    const captured = await agentCall(tabId, 'network', { limit: 5 });
    if (!captured.items.length) throw new Error('no network entries');
    return captured.items[captured.items.length - 1].url;
  });
  await check('dialog capture', async () => {
    await agentCall(tabId, 'click', { selector: '#dialog' });
    const again = await agentCall(tabId, 'dialogs', {});
    if (!again.items.length) throw new Error('no dialog recorded');
    return again.items[again.items.length - 1].message;
  });
  await check('select', async () => {
    const chosen = await agentCall(tabId, 'select', { selector: '#colour', option: 'green' });
    if (chosen.value !== 'green') throw new Error('value is ' + chosen.value);
    return chosen.value;
  });
  await check('wait_for text', async () => {
    await agentCall(tabId, 'click', { selector: '#delay' });
    return (await agentCall(tabId, 'wait_for', { text: 'loaded after delay', timeoutMs: 4000 })).waitedMs + 'ms';
  });
  await check('upload into file input', async () => {
    const uploaded = await agentCall(tabId, 'upload', {
      selector: '#file',
      name: 'selftest.txt',
      type: 'text/plain',
      b64: btoa('hello from the self-test'),
    });
    if (!uploaded.files) throw new Error('file input stayed empty');
    return uploaded.files + ' file(s)';
  });
  await check('screenshot', async () => {
    const shot = await screenshot({ tabId });
    if (!shot.dataUrl || shot.dataUrl.length < 1000) throw new Error('capture looks empty');
    return Math.round(shot.dataUrl.length / 1024) + ' KiB';
  });
  await check('overlay mounted', async () => {
    const marker = await agentCall(tabId, 'overlay', { attached: true });
    if (!marker.mounted) throw new Error('the overlay is not in the page');
    if (marker.hidden) throw new Error('the overlay is still hidden after the screenshot');
    return marker.busy ? 'busy ' + marker.busy : 'idle';
  });
  await check('overlay absent from snapshot', async () => {
    const after = await agentCall(tabId, 'snapshot', {});
    if (after.text.indexOf('ffb-overlay') !== -1) throw new Error('the overlay host is in the snapshot');
    if (after.text.indexOf('attached') !== -1) throw new Error('the pill text is in the snapshot');
    return after.count + ' elements, none of them the overlay';
  });

  return { tabId, passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
}

// ---- tool router ---------------------------------------------------------

const tools = {
  tabs: async () => {
    const tabs = await browser.tabs.query({});
    return tabs.map((tab) => ({
      tabId: tab.id,
      title: tab.title || '',
      url: tab.url || '',
      active: !!tab.active,
      pinned: !!tab.pinned,
      status: tab.status || '',
      attached: state.attached.has(tab.id),
    }));
  },
  attach: (args) => attach(Number(args.tabId)),
  detach: (args) => detach(Number(args.tabId)),
  snapshot: (args) => agentCall(Number(args.tabId), 'snapshot', args),
  click: (args) => agentCall(Number(args.tabId), 'click', args),
  type: (args) => agentCall(Number(args.tabId), 'type', args),
  press_key: (args) => agentCall(Number(args.tabId), 'press_key', args),
  select: (args) => agentCall(Number(args.tabId), 'select', args),
  hover: (args) => agentCall(Number(args.tabId), 'hover', args),
  scroll: (args) => agentCall(Number(args.tabId), 'scroll', args),
  wait_for: (args) => agentCall(Number(args.tabId), 'wait_for', args),
  console: (args) => agentCall(Number(args.tabId), 'console', args),
  network: (args) => agentCall(Number(args.tabId), 'network', args),
  upload: (args) => agentCall(Number(args.tabId), 'upload', args),
  navigate: (args) => navigate(args),
  screenshot: (args) => screenshot(args),
  selftest: (args) => selfTest(args),
  status: async () => {
    // Probe the attached document with the same sandbox rules the agent sees, so a
    // missing core export names itself instead of surfacing as a TypeError later.
    let diag = null;
    const [firstAttached] = Array.from(state.attached);
    if (firstAttached) {
      try {
        const probe = await browser.tabs.executeScript(firstAttached, {
          code: '[typeof globalThis.FFBCore, typeof window.FFBCore, typeof window.__ffbAgentToken]',
        });
        diag = (probe && probe[0]) || null;
      } catch (e) {
        diag = String(e);
      }
    }
    return {
      ready: state.ready,
      port: state.port,
      attached: Array.from(state.attached),
      patchError: state.patchError,
      lastError,
      diag,
      permission: await permissionGranted(),
    };
  },
};

async function runTool(tool, args) {
  const handler = tools[tool];
  if (!handler) throw ffbError('UNKNOWN_TOOL', 'Unknown tool ' + tool);
  return handler(args);
}

// ---- options-page messaging ---------------------------------------------

browser.runtime.onMessage.addListener((message, sender) => {
  if (!message || message.__ffb === true || sender.id !== browser.runtime.id) return;
  if (message.type === 'status') return tools.status();
  if (message.type === 'selftest') return runTool('selftest', message.args || {});
  if (message.type === 'save') {
    const port = Number(message.port) || DEFAULT_PORT;
    const token = String(message.token || '').trim();
    return browser.storage.local.set({ port, token }).then(() => {
      state.port = port;
      state.token = token;
      if (state.ws) {
        try {
          state.ws.close();
        } catch (e) {
          /* ignore */
        }
        state.ws = null;
      }
      state.backoff = RECONNECT_MIN_MS;
      connect();
      return { saved: true };
    });
  }
  if (message.type === 'attach') return runTool('attach', { tabId: message.tabId });
  if (message.type === 'detach') return runTool('detach', { tabId: message.tabId });
  return undefined;
});

// ---- boot ----------------------------------------------------------------

browser.storage.local.get({ port: DEFAULT_PORT, token: '', lastError: null }).then((settings) => {
  state.port = Number(settings.port) || DEFAULT_PORT;
  state.token = String(settings.token || '');
  lastError = settings.lastError || null;
  ensureRegistered().catch((e) => console.error('[ffbridge] registration', e));
  connect();
});

browser.runtime.onInstalled.addListener(() => {
  ensureRegistered().catch((e) => console.error('[ffbridge] registration', e));
});
