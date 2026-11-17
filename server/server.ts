#!/usr/bin/env bun
// ff-tab-bridge MCP server: MCP over stdio, WebSocket for the Firefox add-on.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Bridge, TOKEN_PATH, loadToken, readUpload } from './bridge.ts';

const SCREENSHOT_DIR = '/tmp/opencode';
const VERSION = '0.1.0';

const port = Number(process.env.FFB_PORT || 8788);
const bridge = new Bridge({ port, token: loadToken() });
bridge.start();

const server = new McpServer({ name: 'ffbridge', version: VERSION });

const tabId = z.number().int().positive().describe('Tab id from the tabs tool.');
const ref = z.string().optional().describe('Element ref from the latest snapshot (e.g. e12).');
const selector = z.string().optional().describe('CSS selector, used when no ref is given.');
const snapshot = z
  .number()
  .int()
  .optional()
  .describe('Snapshot generation the ref came from; a stale generation is rejected.');

function render(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

function tool(
  name: string,
  description: string,
  inputSchema: Record<string, z.ZodTypeAny>,
  handler: (args: any) => Promise<unknown>
) {
  server.registerTool(name, { description, inputSchema }, async (args: any) => {
    try {
      const result = await handler(args);
      return { content: [{ type: 'text' as const, text: render(result) }] };
    } catch (error: any) {
      const code = error?.code || 'ERROR';
      return {
        isError: true,
        content: [{ type: 'text' as const, text: `${code}: ${error?.message || String(error)}` }],
      };
    }
  });
}

// ---- tabs and lease ------------------------------------------------------

tool('tabs', 'List every open Firefox tab with its tabId and whether it is attached.', {}, async () => {
  const tabs: any[] = await bridge.call('tabs');
  const lines = tabs.map((tab) => {
    const flags = [tab.attached ? 'ATTACHED' : '', tab.active ? 'active' : '', tab.pinned ? 'pinned' : '']
      .filter(Boolean)
      .join(' ');
    return `${tab.tabId}\t${flags || '-'}\t${tab.title || '(untitled)'}\t${tab.url || ''}`;
  });
  return lines.length ? lines.join('\n') : 'No tabs.';
});

tool('attach', 'Attach a tab so its commands are allowed. Needs the one-time <all_urls> grant (toolbar click).', { tabId }, (args) =>
  bridge.call('attach', { tabId: args.tabId })
);

tool('detach', 'Detach a tab. The agent loses all control of it immediately.', { tabId }, (args) =>
  bridge.call('detach', { tabId: args.tabId })
);

// ---- page state ----------------------------------------------------------

tool(
  'snapshot',
  'Read the attached tab: visible interactive elements and headings, each with a stable ref. Call this first.',
  { tabId, interactiveOnly: z.boolean().optional().describe('Skip headings and landmarks.') },
  async (args) => {
    const result = await bridge.call('snapshot', { tabId: args.tabId, interactiveOnly: args.interactiveOnly });
    return `${result.text}\n\n(snapshot ${result.snapshot} · ${result.count} elements${result.truncated ? ` · ${result.truncated} truncated` : ''})`;
  }
);

tool('click', 'Click an element by ref or selector.', { tabId, ref, selector, snapshot }, (args) =>
  bridge.call('click', { tabId: args.tabId, ref: args.ref, selector: args.selector, snapshot: args.snapshot })
);

tool(
  'type',
  'Type text into an input, textarea or contenteditable. Uses the native value setter and an execCommand fallback for React.',
  {
    tabId,
    ref,
    selector,
    snapshot,
    text: z.string(),
    clear: z.boolean().optional().describe('Replace existing content (default true).'),
    submit: z.boolean().optional().describe('Submit the surrounding form after typing.'),
  },
  (args) =>
    bridge.call('type', {
      tabId: args.tabId,
      ref: args.ref,
      selector: args.selector,
      snapshot: args.snapshot,
      text: args.text,
      clear: args.clear,
      submit: args.submit,
    })
);

tool(
  'press_key',
  'Dispatch a key press (Enter, Tab, Escape, ArrowDown…) to an element or the focused element.',
  {
    tabId,
    key: z.string().describe('Key name, e.g. Enter, Tab, Escape, ArrowDown, a.'),
    ref,
    selector,
    snapshot,
    ctrl: z.boolean().optional(),
    alt: z.boolean().optional(),
    shift: z.boolean().optional(),
    meta: z.boolean().optional(),
  },
  (args) =>
    bridge.call('press_key', {
      tabId: args.tabId,
      key: args.key,
      ref: args.ref,
      selector: args.selector,
      snapshot: args.snapshot,
      ctrl: args.ctrl,
      alt: args.alt,
      shift: args.shift,
      meta: args.meta,
    })
);

tool('select', 'Choose an option in a <select> by value or visible text.', { tabId, ref, selector, snapshot, option: z.string() }, (args) =>
  bridge.call('select', {
    tabId: args.tabId,
    ref: args.ref,
    selector: args.selector,
    snapshot: args.snapshot,
    option: args.option,
  })
);

tool('hover', 'Hover an element to open menus and tooltips.', { tabId, ref, selector, snapshot }, (args) =>
  bridge.call('hover', { tabId: args.tabId, ref: args.ref, selector: args.selector, snapshot: args.snapshot })
);

tool(
  'scroll',
  'Scroll an element into view, or scroll the window by dx/dy.',
  {
    tabId,
    ref,
    selector,
    snapshot,
    dx: z.number().optional(),
    dy: z.number().optional(),
    block: z.enum(['start', 'center', 'end', 'nearest']).optional(),
  },
  (args) =>
    bridge.call('scroll', {
      tabId: args.tabId,
      ref: args.ref,
      selector: args.selector,
      snapshot: args.snapshot,
      dx: args.dx,
      dy: args.dy,
      block: args.block,
    })
);

tool(
  'navigate',
  'Navigate the attached tab (url, back, forward or reload) and wait for the page to settle.',
  {
    tabId,
    url: z.string().optional(),
    back: z.boolean().optional(),
    forward: z.boolean().optional(),
    reload: z.boolean().optional(),
  },
  (args) =>
    bridge.call(
      'navigate',
      { tabId: args.tabId, url: args.url, back: args.back, forward: args.forward, reload: args.reload },
      60000
    )
);

tool(
  'wait_for',
  'Wait for text, a selector, a ref, a URL fragment, or for a value to disappear. Polls every 100 ms.',
  {
    tabId,
    text: z.string().optional().describe('Body text that must appear.'),
    selector: z.string().optional().describe('CSS selector that must match.'),
    ref: z.string().optional().describe('Ref that must still exist.'),
    gone: z.string().optional().describe('Text or selector that must disappear.'),
    urlIncludes: z.string().optional(),
    quiet: z.boolean().optional().describe('Only wait for 250 ms of DOM quiet.'),
    timeoutMs: z.number().int().positive().optional().describe('Default 5000.'),
  },
  (args) => bridge.call('wait_for', args, (args.timeoutMs || 5000) + 10000)
);

// ---- evidence ------------------------------------------------------------

tool(
  'screenshot',
  'Capture the attached tab as a PNG and return its path. fullPage stitches scroll tiles (max 20 viewports).',
  { tabId, fullPage: z.boolean().optional() },
  async (args) => {
    const result: any = await bridge.call('screenshot', { tabId: args.tabId, fullPage: args.fullPage }, 120000);
    const base64 = String(result.dataUrl).split(',')[1] || '';
    const bytes = Buffer.from(base64, 'base64');
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
    const path = join(SCREENSHOT_DIR, `ffbridge-${Date.now()}-${args.tabId}.png`);
    writeFileSync(path, bytes);
    return {
      path,
      bytes: bytes.length,
      fullPage: !!result.fullPage,
      tiles: result.tiles,
      width: result.width,
      height: result.height,
      truncated: result.truncated,
    };
  }
);

tool(
  'console',
  'Read console entries captured in the page world (log, info, warn, error, debug).',
  { tabId, since: z.number().int().nonnegative().optional(), limit: z.number().int().positive().optional() },
  async (args) => {
    const result: any = await bridge.call('console', { tabId: args.tabId, since: args.since, limit: args.limit });
    const lines = result.items.map(
      (entry: any) => `[${entry.t}] ${entry.level}: ${String(entry.text).slice(0, 500)}`
    );
    return `${lines.join('\n')}\n\n(${result.items.length} of ${result.total} entries)`;
  }
);

tool(
  'network',
  'Read fetch/XHR metadata captured in the page world: method, url, status, duration, failures.',
  {
    tabId,
    since: z.number().int().nonnegative().optional(),
    limit: z.number().int().positive().optional(),
    failedOnly: z.boolean().optional(),
  },
  async (args) => {
    const result: any = await bridge.call('network', {
      tabId: args.tabId,
      since: args.since,
      limit: args.limit,
      failedOnly: args.failedOnly,
    });
    const lines = result.items.map((entry: any) => {
      const outcome = entry.error ? `ERROR ${entry.error}` : `${entry.method} ${entry.status} ${entry.ok ? 'ok' : 'fail'} ${entry.ms}ms`;
      return `${outcome} ${entry.url}`;
    });
    return `${lines.join('\n')}\n\n(${result.items.length} of ${result.total} entries)`;
  }
);

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  zip: 'application/zip',
};

tool(
  'upload',
  'Set a file input to a file from this machine. Refuses ~/.ssh, ~/.gnupg, ~/.aws, the token file, and files over 25 MB.',
  { tabId, ref, selector, snapshot, path: z.string().describe('Absolute path, or a path starting with ~/.') },
  async (args) => {
    const file = readUpload(args.path);
    const extension = file.name.split('.').pop()?.toLowerCase() || '';
    const result = await bridge.call('upload', {
      tabId: args.tabId,
      ref: args.ref,
      selector: args.selector,
      snapshot: args.snapshot,
      name: file.name,
      type: MIME[extension] || 'application/octet-stream',
      b64: file.b64,
    });
    return { ...(result as object), uploaded: file.path, bytes: file.size };
  },
  120000
);

// ---- boot ----------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(
  `ffbridge: MCP ready · ws://127.0.0.1:${port} · token file ${TOKEN_PATH} · origin locked to moz-extension://\n`
);

function shutdown() {
  bridge.stop();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
