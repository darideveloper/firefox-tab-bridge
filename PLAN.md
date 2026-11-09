# Plan: ff-tab-bridge

_standalone · scaffold committed as `bfc9c80` on `main` · nothing runs yet_

**Goal.** Give opencode control of Firefox tabs you explicitly attach, via a custom
WebExtension and a local MCP server. No cookie, history, bookmark or profile access.

Repo: `/mnt/hd/develop/automation/ff-tab-bridge` → `github.com/darideveloper/firefox-tab-bridge`
(Odoo project `firefox-tab-bridge`, done column `Sprint Complete`, default tag `script`).

## Where it stands

| Thing | State |
|---|---|
| Repo | initialized, `origin` = SSH, one commit pushed, tree clean |
| `extension/manifest.json` | real MV2, loadable, **not yet loaded in a browser** |
| `extension/background.js`, `extension/options/*` | stubs, zero logic |
| `AGENTS.md` | ai-daridev block + the four non-negotiable constraints |
| `package.json` | `@modelcontextprotocol/sdk`, `zod`, `@types/bun`; no scripts yet |
| `docs/ai-daridev/` | only `.gitkeep`; the flow writes `spec.md`/`decisions.md`/`log.md` on first write |
| `~/.config/opencode/opencode.json` | `mcp.servers.ffbridge` added, `"disabled": true`, backup at `opencode.json.bak.20261108185144` |
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

1. **Load the add-on** — `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on* →
   `extension/manifest.json`, then tell me exactly what Firefox 152 says. This decides MV2 vs a
   forced MV3 migration and it is the only step I cannot perform.
2. **Restart opencode once** — the config change only applies on restart. Expected result: no
   `ffbridge` tools appear, because the entry is disabled until `server/server.ts` exists.
3. **When you want the build sliced** — run `/ai-daridev-backlog` with the tool list below. I will not
   create or move cards on my own.

## Tools to build (16)

`tabs, attach, detach, snapshot, click, type, press_key, select, hover, scroll, navigate, wait_for,
screenshot, console, network, upload`

- `tabs` lists every open tab with an `attached` flag — that is also how the agent finds a popup the
  page opened. No `onCreated` handler, no auto-follow.
- `attach(tabId)`; the first `<all_urls>` grant needs your toolbar click, after that the agent can
  attach any tab itself.
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
- [ ] p4 Options page that stores token and port — [agent]
  - Stub HTML/JS only. `storage.local`, connection state and token input come with the server story.
- [ ] p5 WebSocket client with auth, backoff, heartbeat
- [ ] p6 Attach/detach from the toolbar, optional host permission on first click, badge `ON`/`OFF`
- [ ] p7 Command router over an attached-set, `TAB_NOT_ATTACHED`, `tab_gone` per tab
- [ ] p8 Snapshot with roles, names, stable refs, 1500-line cap, state keyed per tab
- [ ] p9 DOM primitives: click, type, press_key, select, scroll, hover
- [ ] p10 MAIN-world patches: inputs, dialogs, console, **fetch/XHR**, shadow roots
  - Read back through `window.wrappedJSObject`; no message plumbing.
- [ ] p11 Inject patches per origin and the agent per load
  - Real MV2 call is `browser.contentScripts.register()`, `run_at: document_start`, registered for all
    URLs once permission is granted — per-origin registration at `onCommitted` is too late to catch a
    page's early fetches. Patches buffer always, transmit only while their tab is attached.
- [ ] p12 Navigation settle and `wait_for`: `onCompleted` raced with timeout + 250 ms mutation quiet
- [ ] p13 MCP server with all 16 tools — [agent]
  - stdio + `Bun.serve({ hostname: "127.0.0.1" })` (the default `0.0.0.0` would publish tab control to
    the LAN), reject any `Origin` that is not `moz-extension://<id>`, then the token; token file `0600`.
- [ ] p14 Fixture page, `bun test`, in-browser harness that posts pass/fail back to the server
- [x] p15 **Dropped.** `web-ext lint` is not a gate here — [agent]
  - `addons-linter` hangs on a bare `require()` in this environment, with no manifest involved; npm and
    AMO both answer 200. The manifest gate is `about:debugging` loading it, which is p16.
- [ ] p16 Load the temporary add-on and paste the token — [you, blocking]
- [ ] p17 Flip `mcp.servers.ffbridge` to enabled, restart, confirm `tools.ffbridge.*` appear — [agent]
- [ ] p18 Attach a tab and run the smoke prompt — [you]
- [ ] p19 Real-site matrix: GitHub search, React form, shadow-DOM site, full-page screenshot, upload,
  popup follow, network capture, detach mid-command, tab close, permission revoke — [agent]
- [ ] p20 README tool reference + tag `v0.1.0` — [agent]
  - Install, token, tool reference, security model, troubleshooting, "reload after a Firefox restart".
- ~~p20/p21 AMO credentials and signing~~ — **removed** with decision 6.

## Environment facts (verified, do not re-litigate)

- Firefox **152.0.4**; bun 1.3.14; node 22; no `gh` CLI; no `web-ext`.
- Your live config uses `mcp.servers.<name>` with `"disabled": false` and it works — the plan's earlier
  snippet was right and the public docs (`mcp.<name>`) are not what this install reads.
- Bun projects here install slowly (~160 s for 395 packages); the first interrupted install left
  `node_modules` corrupt (`pino` missing) and only `rm -rf node_modules && bun install` fixed it.
- Odoo project 155 has its own five stages; `project.type_ids` was empty until you created them.

## Risks

- **MV2 in Firefox 152 is unverified.** You are 38 versions past the manifest floor. If it refuses,
  every later step becomes MV3: `scripting.registerContentScripts`, event page, `host_permissions`.
  p16 answers this before any real code is written.
- **Snapshot/ref work overruns.** Timebox p8, default `interactiveOnly`, cap lines.
- **React-controlled inputs** resist synthetic typing; MAIN-world `execCommand` is the fallback, and
  some sites will still refuse.
- **`isTrusted` is false on everything we dispatch.** No workaround exists in WebExtensions. A site that
  gates on it gets reported, never evaded.
- **Full-page screenshots** are scroll-stitched canvas output: fixed headers repeat, lazy content may
  not load. Documented ceiling, not a bug to chase.
