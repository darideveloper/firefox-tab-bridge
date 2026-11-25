// WebSocket bridge between the MCP server (this process) and the Firefox add-on.
// Auth: a 0600 token file plus a moz-extension Origin. Bind is 127.0.0.1 only.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

export type BridgeError = Error & { code?: string };

export function bridgeError(code: string, message: string): BridgeError {
  const error = new Error(message) as BridgeError;
  error.code = code;
  return error;
}

export const CONFIG_DIR = join(homedir(), '.config', 'ff-tab-bridge');
export const TOKEN_PATH = join(CONFIG_DIR, 'token');
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export function loadToken(path: string = TOKEN_PATH): string {
  if (existsSync(path)) {
    const existing = readFileSync(path, 'utf8').trim();
    if (existing.length >= 16) return existing;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString('hex');
  writeFileSync(path, token + '\n', { mode: 0o600 });
  chmodSync(path, 0o600);
  return token;
}

export function isExtensionOrigin(origin: string | null | undefined): boolean {
  return typeof origin === 'string' && origin.startsWith('moz-extension://');
}

export function tokensMatch(expected: string, presented: string | undefined): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(presented || '');
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

const REFUSED_DIRS = ['.ssh', '.gnupg', '.aws'].map((name) => join(homedir(), name) + '/');

export function readUpload(path: string, tokenPath: string = TOKEN_PATH) {
  const expanded = path.startsWith('~') ? join(homedir(), path.slice(1)) : path;
  const absolute = resolve(expanded);
  if (absolute === resolve(tokenPath)) throw bridgeError('FILE_REFUSED', 'Refusing to upload the bridge token.');
  for (const denied of REFUSED_DIRS) {
    if (absolute === denied.slice(0, -1) || absolute.startsWith(denied)) {
      throw bridgeError('FILE_REFUSED', 'Refusing to upload from ' + denied.slice(0, -1) + '.');
    }
  }
  if (!existsSync(absolute)) throw bridgeError('FILE_NOT_FOUND', 'No such file: ' + absolute);
  const info = statSync(absolute);
  if (!info.isFile()) throw bridgeError('NOT_A_FILE', 'Not a regular file: ' + absolute);
  if (info.size > MAX_UPLOAD_BYTES) {
    throw bridgeError('FILE_TOO_LARGE', 'File is ' + info.size + ' bytes; the cap is ' + MAX_UPLOAD_BYTES + '.');
  }
  return {
    path: absolute,
    name: basename(absolute),
    size: info.size,
    b64: readFileSync(absolute).toString('base64'),
  };
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: BridgeError) => void;
  timer: ReturnType<typeof setTimeout>;
};

type Socket = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  data: { origin: string; kind?: 'agent' | 'client' };
};

// Any local process can claim a moz-extension origin, just as it can claim any other
// header; the 0600 token is what actually authenticates. The origin gate only keeps
// ordinary web pages out, so a sibling MCP process uses this one.
const CLIENT_ORIGIN = 'moz-extension://ffbridge-client';

function isPortBusy(error: any): boolean {
  return error?.code === 'EADDRINUSE';
}

export class Bridge {
  readonly port: number;
  readonly token: string;
  /** 'host' owns the WebSocket the add-on connects to; 'client' relays through another session's host. */
  mode: 'host' | 'client' = 'host';
  private server: ReturnType<typeof Bun.serve> | null = null;
  private socket: Socket | null = null;
  private clients = new Set<Socket>();
  private relays = new Map<number, { socket: Socket; id: number }>();
  private upstream: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  ready = false;
  attached: number[] = [];

  constructor(options: { port?: number; token?: string } = {}) {
    this.port = options.port ?? Number(process.env.FFB_PORT || 8788);
    this.token = options.token ?? loadToken();
  }

  start() {
    this.stopped = false;
    try {
      this.server = this.listen();
      this.mode = 'host';
    } catch (error: any) {
      if (!isPortBusy(error)) throw error;
      // Another opencode session already owns the port: share it instead of dying.
      this.mode = 'client';
      this.connect();
    }
    return this.server;
  }

  private listen(): ReturnType<typeof Bun.serve> {
    return Bun.serve({
      hostname: '127.0.0.1',
      port: this.port,
      fetch: (request, server) => {
        const origin = request.headers.get('origin');
        if (!isExtensionOrigin(origin)) {
          return new Response('forbidden origin', { status: 403 });
        }
        if (server.upgrade(request, { data: { origin: origin as string } })) return undefined;
        return new Response('websocket upgrade required', { status: 426 });
      },
      websocket: {
        maxPayloadLength: 64 * 1024 * 1024,
        idleTimeout: 120,
        open: () => {
          /* auth happens on the hello frame */
        },
        message: (socket, raw) => this.onMessage(socket as unknown as Socket, String(raw)),
        close: (socket) => this.onClose(socket as unknown as Socket),
      },
    });
  }

  private onMessage(socket: Socket, raw: string) {
    let frame: any;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    if (!frame || typeof frame !== 'object') return;

    if (frame.event === 'hello') {
      if (!tokensMatch(this.token, typeof frame.token === 'string' ? frame.token : undefined)) {
        socket.close(1008, 'bad token');
        return;
      }
      if (frame.role === 'client') {
        socket.data.kind = 'client';
        this.clients.add(socket);
        socket.send(JSON.stringify({ event: 'ready' }));
        return;
      }
      socket.data.kind = 'agent';
      if (this.socket && this.socket !== socket) {
        try {
          this.socket.close(1000, 'replaced by a newer connection');
        } catch {
          /* ignore */
        }
      }
      this.socket = socket;
      this.ready = true;
      socket.send(JSON.stringify({ event: 'ready' }));
      return;
    }

    if (frame.event === 'ping') {
      socket.send(JSON.stringify({ event: 'pong' }));
      return;
    }
    if (socket.data.kind === 'client') {
      this.onClientCall(socket, frame);
      return;
    }

    if (frame.event === 'state') {
      this.attached = Array.isArray(frame.attached) ? frame.attached : [];
      return;
    }
    if (frame.event === 'tab_gone') {
      this.attached = this.attached.filter((id) => id !== frame.tabId);
      return;
    }
    if (frame.event) return;

    if (typeof frame.id !== 'number') return;

    const relay = this.relays.get(frame.id);
    if (relay) {
      this.relays.delete(frame.id);
      this.send(relay.socket, { id: relay.id, ok: frame.ok, result: frame.result, error: frame.error });
      return;
    }

    const pending = this.pending.get(frame.id);
    if (!pending) return;
    this.pending.delete(frame.id);
    clearTimeout(pending.timer);
    if (frame.ok) {
      pending.resolve(frame.result);
    } else {
      pending.reject(bridgeError(...errorOf(frame)));
    }
  }

  // A sibling opencode session's MCP process relays its tool calls through us.
  private onClientCall(socket: Socket, frame: any) {
    if (typeof frame.id !== 'number') return;
    if (!this.socket || !this.ready) {
      this.send(socket, {
        id: frame.id,
        ok: false,
        error: { code: 'NOT_CONNECTED', message: 'Another session owns the bridge but the add-on is not connected to it.' },
      });
      return;
    }
    const id = this.nextId++;
    this.relays.set(id, { socket, id: frame.id });
    this.send(this.socket, { id, tool: frame.tool, args: frame.args ?? {} });
  }

  private send(socket: { send(data: string): void }, frame: unknown) {
    try {
      socket.send(JSON.stringify(frame));
    } catch {
      /* the peer is gone; its close handler cleans up */
    }
  }

  private onClose(socket: Socket) {
    if (socket.data.kind === 'client') {
      this.clients.delete(socket);
      for (const [id, relay] of this.relays) {
        if (relay.socket === socket) this.relays.delete(id);
      }
      return;
    }
    if (this.socket !== socket) return;
    this.socket = null;
    this.ready = false;
    this.attached = [];
    for (const [id, relay] of this.relays) {
      this.send(relay.socket, {
        id: relay.id,
        ok: false,
        error: { code: 'DISCONNECTED', message: 'The Firefox add-on disconnected before answering.' },
      });
      this.relays.delete(id);
    }
    this.failPending('DISCONNECTED', 'The Firefox add-on disconnected before answering.');
  }

  // ---- client mode: relay through another session's host -----------------

  private connect() {
    if (this.stopped) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(`ws://127.0.0.1:${this.port}`, { headers: { Origin: CLIENT_ORIGIN } } as any);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.upstream = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ event: 'hello', token: this.token, role: 'client' }));
    };
    ws.onmessage = (event) => this.onUpstreamMessage(String(event.data));
    ws.onclose = () => {
      if (this.upstream !== ws) return;
      this.upstream = null;
      this.ready = false;
      this.failPending('DISCONNECTED', 'The ff-tab-bridge host went away; reconnecting.');
      this.scheduleRetry();
    };
  }

  private onUpstreamMessage(raw: string) {
    let frame: any;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    if (!frame || typeof frame !== 'object') return;
    if (frame.event === 'ready') {
      this.ready = true;
      if (!this.pingTimer) {
        this.pingTimer = setInterval(() => this.send(this.upstream!, { event: 'ping' }), 45000);
      }
      return;
    }
    if (typeof frame.id !== 'number') return;
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    this.pending.delete(frame.id);
    clearTimeout(pending.timer);
    if (frame.ok) {
      pending.resolve(frame.result);
    } else {
      pending.reject(bridgeError(...errorOf(frame)));
    }
  }

  // The host is another opencode session; when it exits the port frees up and we take over.
  private scheduleRetry() {
    if (this.stopped || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.stopped) return;
      try {
        this.server = this.listen();
        this.mode = 'host';
        this.upstream = null;
        return;
      } catch (error: any) {
        if (!isPortBusy(error)) throw error;
      }
      this.connect();
    }, 1000);
  }

  private failPending(code: string, message: string) {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(bridgeError(code, message));
      this.pending.delete(id);
    }
  }

  call(tool: string, args: Record<string, unknown> = {}, timeoutMs = 45000): Promise<any> {
    const target = this.ready ? (this.mode === 'host' ? this.socket : this.upstream) : null;
    if (!target) {
      return Promise.reject(
        bridgeError(
          'NOT_CONNECTED',
          'The ff-tab-bridge add-on is not connected. Load it from about:debugging, paste the token in its options page, then retry.'
        )
      );
    }
    const id = this.nextId++;
    return new Promise((resolveCall, rejectCall) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectCall(bridgeError('TIMEOUT', `The add-on did not answer ${tool} within ${timeoutMs} ms.`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolveCall, reject: rejectCall, timer });
      try {
        target.send(JSON.stringify({ id, tool, args }));
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        rejectCall(bridgeError('SEND_FAILED', String(error)));
      }
    });
  }

  stop() {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.retryTimer = null;
    this.pingTimer = null;
    this.failPending('STOPPED', 'The bridge is shutting down.');
    this.relays.clear();
    for (const client of this.clients) {
      try {
        client.close(1001, 'server shutting down');
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
    try {
      this.socket?.close(1001, 'server shutting down');
    } catch {
      /* ignore */
    }
    try {
      this.upstream?.close(1001, 'server shutting down');
    } catch {
      /* ignore */
    }
    this.server?.stop(true);
    this.server = null;
    this.socket = null;
    this.upstream = null;
    this.ready = false;
  }
}

function errorOf(frame: any): [string, string] {
  const error = frame.error || {};
  return [error.code || 'EXTENSION_ERROR', error.message || 'The add-on reported an error.'];
}
