'use strict';

const portInput = document.getElementById('port');
const tokenInput = document.getElementById('token');
const savedLabel = document.getElementById('saved');
const statusLine = document.getElementById('status');
const results = document.getElementById('results');

function renderStatus(status) {
  if (!status) {
    statusLine.textContent = 'background page did not answer';
    statusLine.className = 'bad';
    return;
  }
  const socket = status.ready ? 'connected' : 'not connected';
  const attached = status.attached.length ? status.attached.join(', ') : 'none';
  statusLine.innerHTML =
    'socket: <strong class="' + (status.ready ? 'ok' : 'bad') + '">' + socket + '</strong> · ' +
    'port: ' + status.port + ' · ' +
    'site access: ' + (status.permission ? 'granted' : 'missing — reload the add-on from about:debugging') + ' · ' +
    'attached tabs: ' + attached +
    (status.patchError ? ' · patch: <span class="bad">' + status.patchError + '</span>' : '') +
    (status.lastError
      ? ' · last error (' + status.lastError.where + '): <span class="bad">' + status.lastError.message + '</span>'
      : '');
}

async function refresh() {
  try {
    renderStatus(await browser.runtime.sendMessage({ type: 'status' }));
  } catch (error) {
    renderStatus(null);
  }
}

async function load() {
  const settings = await browser.storage.local.get({ port: 8788, token: '' });
  portInput.value = settings.port;
  tokenInput.value = settings.token;
  await refresh();
}

document.getElementById('save').addEventListener('click', async () => {
  const port = Number(portInput.value) || 8788;
  const token = tokenInput.value.trim();
  await browser.runtime.sendMessage({ type: 'save', port, token });
  savedLabel.textContent = 'saved';
  savedLabel.className = 'ok';
  setTimeout(() => {
    savedLabel.textContent = '';
  }, 2000);
  await refresh();
});

document.getElementById('attach').addEventListener('click', async () => {
  // The options page is itself a tab, so "the active tab" is usually this page.
  // Pick the most recently focused normal tab that a bridge can actually drive.
  const own = browser.runtime.getURL('');
  const tabs = await browser.tabs.query({ active: true });
  const tab = tabs
    .filter((candidate) => /^(https?|file):/i.test(candidate.url || '') && !(candidate.url || '').startsWith(own))
    .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
  results.innerHTML = '';
  if (!tab) {
    results.innerHTML = '<li class="bad">No drivable tab is active. Open the page in another window, or use the toolbar button.</li>';
    return;
  }
  const status = await browser.runtime.sendMessage({ type: 'status' });
  const attached = status && status.attached.indexOf(tab.id) !== -1;
  results.innerHTML = '';
  try {
    await browser.runtime.sendMessage({ type: attached ? 'detach' : 'attach', tabId: tab.id });
  } catch (error) {
    results.innerHTML = '<li class="bad">' + String((error && error.message) || error) + '</li>';
  }
  await refresh();
});

document.getElementById('selftest').addEventListener('click', async () => {
  results.innerHTML = '<li>running…</li>';
  try {
    const status = await browser.runtime.sendMessage({ type: 'status' });
    const tabId = status && status.attached[0];
    if (!tabId) throw new Error('Attach the fixture tab first (toolbar button or the button above).');
    const report = await browser.runtime.sendMessage({ type: 'selftest', args: { tabId } });
    results.innerHTML = '';
    report.results.forEach((entry) => {
      const item = document.createElement('li');
      item.className = entry.ok ? 'ok' : 'bad';
      item.textContent = (entry.ok ? 'PASS ' : 'FAIL ') + entry.name + (entry.detail ? ' — ' + entry.detail : '');
      results.appendChild(item);
    });
    const summary = document.createElement('li');
    summary.textContent = report.passed + ' passed, ' + report.failed + ' failed';
    results.appendChild(summary);
  } catch (error) {
    results.innerHTML = '<li class="bad">' + String((error && error.message) || error) + '</li>';
  }
});

load();
setInterval(refresh, 2000);
