import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Bridge,
  MAX_UPLOAD_BYTES,
  isExtensionOrigin,
  loadToken,
  readUpload,
  tokensMatch,
} from '../server/bridge.ts';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

describe('token file', () => {
  test('is created 0600 and reused', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ffb-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'nested', 'token');
    const first = loadToken(path);
    expect(first.length).toBe(64);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, 'utf8').trim()).toBe(first);
    expect(loadToken(path)).toBe(first);
  });

  test('tokensMatch is exact and length-safe', () => {
    expect(tokensMatch('abc', 'abc')).toBe(true);
    expect(tokensMatch('abc', 'abd')).toBe(false);
    expect(tokensMatch('abc', 'abcd')).toBe(false);
    expect(tokensMatch('abc', undefined)).toBe(false);
  });
});

describe('origin gate', () => {
  test('only moz-extension origins pass', () => {
    expect(isExtensionOrigin('moz-extension://4f9c4a1a-1111-2222-3333-444455556666')).toBe(true);
    expect(isExtensionOrigin('https://evil.example')).toBe(false);
    expect(isExtensionOrigin(null)).toBe(false);
    expect(isExtensionOrigin(undefined)).toBe(false);
  });
});

describe('upload guard', () => {
  function tempDir() {
    const dir = mkdtempSync(join(tmpdir(), 'ffb-files-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
  }

  test('reads a normal file as base64', () => {
    const dir = tempDir();
    const file = join(dir, 'notes.txt');
    writeFileSync(file, 'hello');
    const result = readUpload(file, join(dir, 'token'));
    expect(result.name).toBe('notes.txt');
    expect(result.size).toBe(5);
    expect(Buffer.from(result.b64, 'base64').toString()).toBe('hello');
  });

  test('refuses a missing file', () => {
    const dir = tempDir();
    expect(() => readUpload(join(dir, 'nope.bin'), join(dir, 'token'))).toThrow(/No such file/);
  });

  test('refuses secret directories', () => {
    const dir = tempDir();
    expect(() => readUpload('~/.ssh/id_ed25519', join(dir, 'token'))).toThrow(/Refusing/);
    expect(() => readUpload('~/.aws/credentials', join(dir, 'token'))).toThrow(/Refusing/);
  });

  test('refuses the token file itself', () => {
    const dir = tempDir();
    const tokenPath = join(dir, 'token');
    writeFileSync(tokenPath, 't'.repeat(64));
    expect(() => readUpload(tokenPath, tokenPath)).toThrow(/bridge token/);
  });

  test('refuses files over the cap', () => {
    const dir = tempDir();
    const huge = join(dir, 'huge.bin');
    writeFileSync(huge, '');
    truncateSync(huge, MAX_UPLOAD_BYTES + 1);
    expect(() => readUpload(huge, join(dir, 'token'))).toThrow(/cap is/);
  });
});

// ---- socket ---------------------------------------------------------------

function openSocket(url: string, origin: string): Promise<WebSocket> {
  return new Promise((resolveOpen, rejectOpen) => {
    const socket = new WebSocket(url, { headers: { Origin: origin } } as any);
    const timer = setTimeout(() => rejectOpen(new Error('socket open timed out')), 3000);
    socket.onopen = () => {
      clearTimeout(timer);
      resolveOpen(socket);
    };
    socket.onerror = () => {
      clearTimeout(timer);
      rejectOpen(new Error('socket failed'));
    };
  });
}

function waitForMessage(socket: WebSocket, predicate: (frame: any) => boolean): Promise<any> {
  return new Promise((resolveFrame, rejectFrame) => {
    const timer = setTimeout(() => rejectFrame(new Error('frame timed out')), 3000);
    socket.onmessage = (event) => {
      const frame = JSON.parse(String(event.data));
      if (!predicate(frame)) return;
      clearTimeout(timer);
      resolveFrame(frame);
    };
  });
}

describe('bridge socket', () => {
  test('rejects a non-extension origin before the upgrade', async () => {
    const bridge = new Bridge({ port: 0, token: 'a'.repeat(64) });
    const server = bridge.start()!;
    cleanups.push(() => bridge.stop());
    const response = await fetch(`http://127.0.0.1:${server.port}/`, { headers: { Origin: 'https://evil.example' } });
    expect(response.status).toBe(403);
  });

  test('rejects a bad token and accepts the right one', async () => {
    const token = 'b'.repeat(64);
    const bridge = new Bridge({ port: 0, token });
    const server = bridge.start()!;
    cleanups.push(() => bridge.stop());
    const url = `ws://127.0.0.1:${server.port}`;

    const bad = await openSocket(url, 'moz-extension://test');
    const closed = new Promise<number>((resolveClose) => {
      bad.onclose = (event) => resolveClose(event.code);
    });
    bad.send(JSON.stringify({ event: 'hello', token: 'wrong' }));
    expect(await closed).toBe(1008);

    const good = await openSocket(url, 'moz-extension://test');
    const ready = waitForMessage(good, (frame) => frame.event === 'ready');
    good.send(JSON.stringify({ event: 'hello', token }));
    expect(await ready).toEqual({ event: 'ready' });
    expect(bridge.ready).toBe(true);
    good.close();
  });

  test('round-trips a tool call and rejects a timeout', async () => {
    const bridge = new Bridge({ port: 0, token: 'c'.repeat(64) });
    const server = bridge.start()!;
    cleanups.push(() => bridge.stop());
    const socket = await openSocket(`ws://127.0.0.1:${server.port}`, 'moz-extension://test');
    socket.send(JSON.stringify({ event: 'hello', token: 'c'.repeat(64) }));
    await waitForMessage(socket, (frame) => frame.event === 'ready');

    socket.onmessage = (event) => {
      const frame = JSON.parse(String(event.data));
      if (frame.id === undefined) return;
      if (frame.tool === 'silent') return;
      socket.send(JSON.stringify({ id: frame.id, ok: true, result: { tool: frame.tool, args: frame.args } }));
    };

    const result = await bridge.call('tabs', {});
    expect(result).toEqual({ tool: 'tabs', args: {} });

    await expect(bridge.call('silent', {}, 100)).rejects.toMatchObject({ code: 'TIMEOUT' });
    socket.close();
  });
});

describe('shared bridge', () => {
  async function until(check: () => boolean, ms = 3000) {
    const deadline = Date.now() + ms;
    while (!check() && Date.now() < deadline) await Bun.sleep(25);
    return check();
  }

  test('a second instance relays through the host, then takes the port over', async () => {
    const token = 'd'.repeat(64);
    const host = new Bridge({ port: 0, token });
    const server = host.start()!;
    const port = server.port;
    const socket = await openSocket(`ws://127.0.0.1:${port}`, 'moz-extension://test');
    socket.send(JSON.stringify({ event: 'hello', token }));
    await waitForMessage(socket, (frame) => frame.event === 'ready');
    socket.onmessage = (event) => {
      const frame = JSON.parse(String(event.data));
      if (typeof frame.id !== 'number') return;
      socket.send(JSON.stringify({ id: frame.id, ok: true, result: { tool: frame.tool } }));
    };

    const second = new Bridge({ port, token });
    cleanups.push(() => second.stop());
    second.start();
    expect(second.mode).toBe('client');
    expect(await until(() => second.ready)).toBe(true);
    expect(await second.call('tabs', {})).toEqual({ tool: 'tabs' });

    // The opencode session holding the host exits: the survivor must take the port.
    host.stop();
    expect(await until(() => second.mode === 'host')).toBe(true);
    expect(second.ready).toBe(false);
  });
});
