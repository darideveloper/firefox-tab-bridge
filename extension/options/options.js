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
    'site access: ' + (status.permission ? 'granted' : 'not granted (click the toolbar button)') + ' · ' +
    'attached tabs: ' + attached +
    (status.patchError ? ' · patch: <span class="bad">' + status.patchError + '</span>' : '');
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
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab) return;
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
