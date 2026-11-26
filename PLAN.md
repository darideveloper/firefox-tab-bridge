# Plan: ff-tab-bridge

_standalone · `main` · loaded in Firefox 152 and verified against real sites (2026-11-25)_

**Goal.** Give opencode control of Firefox tabs you explicitly attach, via a custom
WebExtension and a local MCP server. No cookie, history, bookmark or profile access.

Repo: `/mnt/work/develop/automation/ff-tab-bridge` → `github.com/darideveloper/firefox-tab-bridge`
(Odoo project `firefox-tab-bridge`, done column `Sprint Complete`, default tag `script`).

## Where it stands

| Thing | State |
|---|---|
| Repo | `main` level with `origin/main` at `c89a61f`; scaffold + implementation committed |
| `extension/manifest.json` | real MV2, loads in Firefox 152; `<all_urls>` is a declared permission (no prompt) |
| `extension/background.js`, `extension/options/*` | implemented and exercised: socket, lease, router, screenshots, options page status + self-test |
| `extension/agent.js`, `extension/core.js`, `extension/patches.js` | implemented and verified on real sites: snapshot, primitives, wait_for, upload, page-world capture |
| `server/` | implemented: MCP stdio + `Bun.serve` WebSocket, token auth, 16 tools, one host shared by every session |
| `test/` | `bun test` (21 tests, green); fixture page with popup/delegated/keydown/input cases; in-browser self-test 13/13 |
| `AGENTS.md` | ai-daridev block + the four non-negotiable constraints |
| `package.json` | scripts `server`, `fixture`, `test`; version `0.1.0` |
| `docs/ai-daridev/` | only `.gitkeep`; the flow writes `spec.md`/`decisions.md`/`log.md` on first write |
| `~/.config/opencode/opencode.json` | `mcp.servers.ffbridge` enabled at `/mnt/work/...` |
| Odoo | project and stages exist, **zero cards created** (backlog not run) |

## Decisions (locked)

| # | Question | Answer |
|---|---|---|
| 1 | Target | Your own Firefox and your real sessions → extension path, MV2 |
| 2 | Day-one jobs | All six: snapshot, forms, async/SPA, screenshot, console, hover/scroll |
| 3 | Hard limits | iframes ✗, privileged pages ✗; **upload ✓, popups ✓, full-page ✓, network errors ✓** |
| 4 | Uploads | Any readable path, plus a hardcoded refuse for `~/.ssh`, `~/.gnupg`, `~/.aws`, the token file; ~25 MB cap |
| 5 | Tabs | Several at once → `tabId` on every tool, refs scoped per tab + snapshot generation |
| 6 | Install | Temporary add-on in `about:debugging` only. No AMO account, no signing, no 2FA |
| 7 | Tests | `bun test` for socket/auth/routing, fixture page, plus an in-browser harness in real Firefox |
| 8 | Attach | Toolbar button only → no `menus` permission, no context menu |

## What I need from you

Remaining, in one line each:

1. **Open one throwaway tab** (e.g. `http://127.0.0.1:8787/` with `bun run fixture`) so I can re-run the
   verification — the tab used during the 2026-11-25 pass was closed.
2. **Close that tab while it is attached**, and **revoke site access** from `about:addons`, one at a
   time; I watch `tabs`/`status` and record the behaviour.
3. **Approve the Odoo cards** if you want the work tracked there — write tools are yours to approve,
   and `/ai-daridev-backlog` is the normal path.

## Tools to build (16)

`tabs, attach, detach, snapshot, click, type, press_key, select, hover, scroll, navigate, wait_for,
screenshot, console, network, upload`

- `tabs` lists every open tab with an `attached` flag — that is also how the agent finds a popup the
  page opened. No `onCreated` handler, no auto-follow.
- `attach(tabId)`; `<all_urls>` is a declared permission, so a temporary add-on already has it and no
  prompt appears. Any session may attach any supported tab itself.
- `screenshot` writes a PNG to `/tmp/opencode` and returns the path.
- `upload(tabId, ref, path)` — server reads the bytes, page builds `File` + `DataTransfer`.

In Code Mode the tools show up as `tools.ffbridge.<tool>`.

## Checklist

- [x] p1 Repo at `/mnt/hd/develop/automation/ff-tab-bridge`, `origin` over SSH — [agent]
  - `git init` was already done; origin switched from HTTPS to `git@github.com:…` because `gh` is absent.
- [x] p2 Dependencies installed — [agent]
  - `@modelcontextprotocol/sdk@1.32.2`, `zod@4.6.7`, `@types/bun`. No scripts, deliberately: none of the
    targets exist yet.
- [x] p3 MV2 manifest with stable gecko id — [agent]
  - `persistent: true`, `strict_min_version 128.0`, `storage/tabs/activeTab/webNavigation`,
    `optional_permissions: ["<all_urls>"]` (MV2 name), no `menus`, **no custom CSP** (the MV2 default
    already allows `ws://127.0.0.1`), `data_collection_permissions: ["websiteContent"]`.
- [x] p4 Options page that stores token and port — [agent]
  - Stub HTML/JS only. `storage.local`, connection state and token input come with the server story.
- [x] p5 WebSocket client with auth, backoff, heartbeat
- [x] p6 Attach/detach from the toolbar, optional host permission on first click, badge `ON`/`OFF`
- [x] p7 Command router over an attached-set, `TAB_NOT_ATTACHED`, `tab_gone` per tab
- [x] p8 Snapshot with roles, names, stable refs, 1500-line cap, state keyed per tab
- [x] p9 DOM primitives: click, type, press_key, select, scroll, hover
- [x] p10 MAIN-world patches: inputs, dialogs, console, **fetch/XHR**, shadow roots
  - Read back through `window.wrappedJSObject`; no message plumbing.
- [x] p11 Inject patches per origin and the agent per load
  - Real MV2 call is `browser.contentScripts.register()`, `run_at: document_start`, registered for all
    URLs once permission is granted — per-origin registration at `onCommitted` is too late to catch a
    page's early fetches. Patches buffer always, transmit only while their tab is attached.
- [x] p12 Navigation settle and `wait_for`: `onCompleted` raced with timeout + 250 ms mutation quiet
- [x] p13 MCP server with all 16 tools — [agent]
  - stdio + `Bun.serve({ hostname: "127.0.0.1" })` (the default `0.0.0.0` would publish tab control to
    the LAN), reject any `Origin` that is not `moz-extension://<id>`, then the token; token file `0600`.
- [x] p14 Fixture page, `bun test`, in-browser harness that posts pass/fail back to the server
- [x] p15 **Dropped.** `web-ext lint` is not a gate here — [agent]
  - `addons-linter` hangs on a bare `require()` in this environment, with no manifest involved; npm and
    AMO both answer 200. The manifest gate is `about:debugging` loading it, which is p16.
- [x] p16 Loaded the temporary add-on on Firefox 152 and authenticated it — [you]
  - MV2 loads fine; the plan's biggest risk is closed. The token must be pasted once; the add-on keeps
    it across reloads, and a Firefox restart drops the add-on itself.
- [x] p17 `mcp.servers.ffbridge` enabled; `tools.ffbridge.*` appear in Code Mode — [agent]
  - Enabled at `/mnt/work/...`. Fixed in the same pass: every session used to spawn its own server and
    all but the first died on `EADDRINUSE`; the port owner is now the host and the rest relay
    (`d066eb3`).
- [x] p18 Attached a tab and ran the in-browser self-test — [you + agent]
  - First run: 2 passed, 9 failed. Three real bugs followed (`c89a61f`): the two content files were
    injected into separate sandboxes; the helpers were read from `window` instead of the content
    global; synthetic events were built with page-world constructors, so page listeners (React, any
    delegated handler) never fired. Final state: 13/13 self-test checks green.
- [x] p19 Real-site matrix: GitHub search, React form, shadow-DOM site, full-page screenshot, upload,
  popup follow, network capture, detach mid-command, tab close, permission revoke — [agent]
  - Passed: GitHub search (183-element snapshot, click by ref, `wait_for` 253 ms), React controlled
    input on TodoMVC (typing + Enter adds the todo), full-page screenshot (3 tiles, 2375×3455), network
    capture on a real site, hover, back/forward/reload with agent re-injection, upload and closed
    shadow root on the fixture, detach mid-command, `TAB_NOT_ATTACHED`, `STALE_SNAPSHOT`.
  - Limited by design: a `target="_blank"` popup is blocked because a synthetic click carries no user
    activation; a popup the site opens anyway is found by `tabs` and attachable by id.
  - Not yet exercised: closing a tab while attached, and revoking site access at runtime.
- [x] p20 README tool reference + tag `v0.1.0` — [agent]
  - Install, token, tool reference, security model, troubleshooting, "reload after a Firefox restart".
  - The README step 5 and the `PERMISSION_NEEDED` row were rewritten once `<all_urls>` became a
    declared permission: there is no grant prompt any more.
- ~~p20/p21 AMO credentials and signing~~ — **removed** with decision 6.

## Environment facts (verified, do not re-litigate)

- Firefox **152.0.4**; bun 1.3.14; node 22; no `gh` CLI; no `web-ext`.
- Your live config uses `mcp.servers.<name>` with `"disabled": false` and it works — the plan's earlier
  snippet was right and the public docs (`mcp.<name>`) are not what this install reads.
- Bun projects here install slowly (~160 s for 395 packages); the first interrupted install left
  `node_modules` corrupt (`pino` missing) and only `rm -rf node_modules && bun install` fixed it.
- Odoo project 155 has its own five stages; `project.type_ids` was empty until you created them.

## Risks

- **MV2 in Firefox 152** — resolved: the add-on loads and runs. MV3 is only needed if Firefox ever
  refuses MV2 (`scripting.registerContentScripts`, event page, `host_permissions`).
- **Snapshot/ref work overruns.** Timebox p8, default `interactiveOnly`, cap lines.
- **React-controlled inputs** — resolved: the event-construction fix makes React's delegated handlers
  run (TodoMVC typing + Enter verified). A site that gates on `isTrusted` still refuses by design.
- **`isTrusted` is false on everything we dispatch.** No workaround exists in WebExtensions. A site that
  gates on it gets reported, never evaded. A `target="_blank"` popup is blocked for the same reason.
- **Full-page screenshots** are scroll-stitched canvas output: fixed headers repeat, lazy content may
  not load. Documented ceiling, not a bug to chase.
