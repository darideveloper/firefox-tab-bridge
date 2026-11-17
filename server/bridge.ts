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
  data: { origin: string };
};

export class Bridge {
  readonly port: number;
  readonly token: string;
  private server: ReturnType<typeof Bun.serve> | null = null;
  private socket: Socket | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  ready = false;
  attached: number[] = [];

  constructor(options: { port?: number; token?: string } = {}) {
    this.port = options.port ?? Number(process.env.FFB_PORT || 8788);
    this.token = options.token ?? loadToken();
  }

  start() {
    this.server = Bun.serve({
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
    return this.server;
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
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    this.pending.delete(frame.id);
    clearTimeout(pending.timer);
    if (frame.ok) {
      pending.resolve(frame.result);
    } else {
      const error = frame.error || {};
      pending.reject(bridgeError(error.code || 'EXTENSION_ERROR', error.message || 'The add-on reported an error.'));
    }
  }

  private onClose(socket: Socket) {
    if (this.socket !== socket) return;
    this.socket = null;
    this.ready = false;
    this.attached = [];
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(bridgeError('DISCONNECTED', 'The Firefox add-on disconnected before answering.'));
      this.pending.delete(id);
    }
  }

  call(tool: string, args: Record<string, unknown> = {}, timeoutMs = 45000): Promise<any> {
    if (!this.socket || !this.ready) {
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
        this.socket!.send(JSON.stringify({ id, tool, args }));
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        rejectCall(bridgeError('SEND_FAILED', String(error)));
      }
    });
  }

  stop() {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(bridgeError('STOPPED', 'The bridge is shutting down.'));
      this.pending.delete(id);
    }
    try {
      this.socket?.close(1001, 'server shutting down');
    } catch {
      /* ignore */
    }
    this.server?.stop(true);
    this.server = null;
    this.socket = null;
    this.ready = false;
  }
}
