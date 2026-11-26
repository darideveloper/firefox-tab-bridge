# ff-tab-bridge — spec

Drive Firefox tabs you explicitly attach, from opencode, through a custom MV2 add-on and a
local MCP server. Nothing is read until a tab is attached.

## Scope

In: snapshot with stable refs, click, type, press_key, select, hover, scroll, navigate, wait_for,
screenshot (viewport and stitched full page), console capture, network metadata, upload, and the
attach/detach lease — 16 tools over `tools.ffbridge.*`.

Out, by decision: iframes, privileged pages (`about:`, `view-source:`, add-on pages), cookies,
history, bookmarks, form autofill, profile files, trusted-input evasion.

## Architecture

```
opencode ──stdio──> server/server.ts ──ws://127.0.0.1:8788──> extension/background.js
                                                                    │
                                                       content scripts in attached tabs
```

- `extension/` — MV2 add-on: background page (socket, lease, router, screenshots, options), isolated
  agent (`agent.js` on top of `core.js`), page-world patches, options page.
- `server/` — one Bun process per opencode session: MCP over stdio plus the WebSocket the add-on
  connects to. Exactly one process owns port 8788; the others relay (ADR 0001).
- `test/` — `bun test` for the server and the DOM helpers, a fixture page and a fixture server.

## Behaviour worth knowing

- **Lease** — a tab is driven only after `attach`; every later command for a detached or closed tab
  fails with `TAB_NOT_ATTACHED`. Closing an attached tab drops it from the lease via `tab_gone`.
- **Refs** — `snapshot` returns `e1…eN` with the generation number. Sending an old generation back
  yields `STALE_SNAPSHOT` instead of clicking whatever moved into that spot.
- **Events** — dispatched from the content compartment so page listeners and delegated handlers
  (React included) receive them; `isTrusted` is false and never faked (ADR 0002).
- **Typing** — native value setter plus `input`/`change`, `execCommand('insertText')` first when the
  document has focus; `submit` submits the owning form when there is one.
- **Screenshot** — PNG into `/tmp/opencode`, returned as a path by the MCP tool. `fullPage` stitches
  up to 20 viewports; fixed headers repeat (ceiling, not a bug).
- **Upload** — the server reads the bytes, the page builds `File` + `DataTransfer`. Refuses `~/.ssh`,
  `~/.gnupg`, `~/.aws`, the token file, and anything over 25 MB.
- **wait_for** — text, selector, ref, URL fragment, or disappearance; polls at 100 ms.
- **Attach marker** — an attached tab draws a fixed `#0060df` frame and a bottom-right pill in a closed
  shadow root (inline `!important` on the host, so page CSS cannot hide it): the pill names each
  command while it runs, returns to `attached` after success or error, is re-pushed on attach, detach,
  page load and re-injection, and is hidden around both capture paths so `snapshot` never lists it and
  `screenshot` never shows it.

## Security model

- Bind `127.0.0.1` only; reject any WebSocket whose `Origin` is not `moz-extension://`, then require
  the 0600 token from `~/.config/ff-tab-bridge/token`.
- No `cookies`, `history` or `downloads` permission exists in the manifest.
- Site access is a **required** `<all_urls>` grant, not revocable per site; withdrawing it means
  disabling the add-on (ADR 0003).
- Page content leaves the tab only when a tool asks for it, and only to the local server.

## Install and operations

1. `bun install`; `bun run server` once to create the token.
2. Install the AMO-signed XPI — `dist/ff-tab-bridge-1.1.0.xpi`, unlisted self-distribution — and
   confirm ff-tab-bridge is enabled; it survives a full Firefox restart with its token. Loading
   `extension/manifest.json` as a temporary add-on from `about:debugging` stays the MV2 iteration
   path and is dropped when Firefox closes.
3. Options page: port `8788`, paste the token, Save and reconnect → `socket: connected`.
4. Click the toolbar icon **on an http(s) tab** to attach (badge ON). The icon refuses `about:` and
   add-on pages, and says so on the options page as `last error (toolbar click)`.
5. After every Firefox start, click the icon again: the signed install keeps the add-on, the token
   and the permission, but the lease does not survive.

Port sharing: the first opencode session to start owns 8788, the rest relay; if the owner exits, a
survivor takes the port and the add-on reconnects within about five seconds.

The toolbar mark is `extension/icons/bridge.svg` — a deck over one arch, on a 16px grid, one
`#0060df` accent, 1px safe padding — with `icon-16/32/48/96.png` exported beside it and wired as
`icons` plus `browser_action.default_icon`, so Firefox shows it instead of the puzzle piece.

## Known limits

- `isTrusted` is false on everything dispatched; a site gating on it is reported, never worked around.
- A `target="_blank"` popup is blocked by Firefox because a synthetic click carries no user gesture.
  A popup the site opens anyway appears in `tabs` and can be attached by id.
- Closed shadow roots are only traversed when the page-world patch loaded before the root was created.
- Console and network capture are empty when the site's CSP blocks the patch.
- MV2 is deprecated. If Firefox ever refuses it, the port is `scripting.registerContentScripts`,
  an event page and `host_permissions`.

## Verification

- `bun test` — 21 checks: DOM helpers, token handling, origin gate, upload guard, WS auth,
  round-trip, relay and takeover.
- In-browser self-test (options page, or the `selftest` command) — 15 checks on the fixture:
  snapshot, input/keyboard event delivery, console, network, dialog, select, wait_for, upload,
  screenshot, closed shadow root, overlay mounted and absent from the snapshot.
- Runtime matrix proven on 2026-11-25: GitHub search, TodoMVC React, Hacker News, full-page capture,
  detach mid-command, tab closed while attached, host death, and a full Firefox restart drill.

## Decisions

- `docs/decisions/0001-one-bridge-host-per-machine.md`
- `docs/decisions/0002-content-compartment-events.md`
- `docs/decisions/0003-site-access-required.md`

Odoo project `firefox-tab-bridge` carries the cards; `PLAN.md` holds the original scope, the locked
decisions and the per-phase checklist.
