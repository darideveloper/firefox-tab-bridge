# Plan: ff-tab-bridge

_standalone · no card_

**Goal.** Give opencode control of one attached Firefox tab via a custom WebExtension and local MCP server, with no cookie or profile access.

**Start here** → [agent]: scaffold `/develop/automation/ff-tab-bridge` and lock the manifest, so every later step has a home.

**Touched:** `extension/manifest.json`, `extension/background.js`, `extension/content/*`, `extension/options/*`, `server/*`, `test/*`, `README.md`, `~/.config/opencode/opencode.json`, `~/.config/ff-tab-bridge/*`, an AMO account — not: cookies, history, bookmarks, profile files, other tabs.

## What changed

| Was | Now |
|---|---|
| Nine phases with implicit owners | 22 flat steps, one action each, owner on every line |
| `ff_eval` implemented behind an env flag | Deferred to v2; not implemented in v1 |
| Fixture included iframe and file input | Fixture limited to v1 capabilities |
| Repo path implied | Explicitly `/develop/automation/ff-tab-bridge`, sibling of existing repos |
| Lint only implied | Explicit gate before the add-on is loaded |
| Permanent install unverified | Restart check added after signing |

## Checklist

- [ ] p1 Initialise the repo at `/develop/automation/ff-tab-bridge` — [agent]
  - `git init -b main`, `bun init -y`, MIT LICENSE, `.gitignore` for `node_modules/`, `web-ext-artifacts/`, `*.xpi`.
- [ ] p2 Add MCP dependencies and package scripts — [agent]
  - `bun add @modelcontextprotocol/sdk zod`; scripts `server`, `lint:ext`, `test`, `sign`.
- [ ] p3 Write the MV2 manifest with a stable gecko id — [agent]
  - `persistent:true`, `strict_min_version 128.0`, optional `<all_urls>`, CSP `connect-src ws://127.0.0.1:8788`.
- [ ] p4 Build the options page that stores token and port — [agent]
  - `options/options.html|js`; `storage.local`; show connection state.
- [ ] p5 Implement the WebSocket client with auth, backoff and heartbeat — [agent]
  - `hello` frame, 500 ms→5 s retry, 20 s ping, badge `OFFLINE` on drop.
- [ ] p6 Implement attach and detach from toolbar and tab strip — [agent]
  - Request optional host permission on first click; `menus` with `contexts:["tab"]`; badge `ON`/`OFF`.
- [ ] p7 Implement the command router with a hard lease guard — [agent]
  - Reject non-leased `tabId` with `NO_LEASE`; clear lease and emit `tab_gone` on close.
- [ ] p8 Implement the snapshot with roles, names and stable refs — [agent]
  - Visibility filter, role map, `e1…eN`, `byRef`/`byEl`, 1500-line cap.
- [ ] p9 Implement the DOM interaction primitives — [agent]
  - Click, type, press_key, select, scroll, hover; each returns an effect summary.
- [ ] p10 Implement MAIN-world patches for inputs, dialogs, console, shadow roots — [agent]
  - Native setter, `execCommand("insertText")`, dialog overrides, console ring buffer, `attachShadow` patch.
- [ ] p11 Inject patches per origin and the agent script per load — [agent]
  - `registerContentScripts` on `onCommitted`, agent on `onCompleted`, unregister on detach.
- [ ] p12 Implement navigation settle and `wait_for` — [agent]
  - `onCompleted` raced with timeout plus 250 ms mutation quiet; 100 ms polling.
- [ ] p13 Expose the 13 tools through the MCP server — [agent]
  - stdio, `Bun.serve` on 8788, token file 0600, screenshots to `/tmp/opencode`, errors as text.
- [ ] p14 Build the fixture page and fake-extension e2e suite — [agent]
  - Controlled input, closed shadow, alert button, delayed list, SPA route, tall page; `bun test`.
- [ ] p15 Run `web-ext lint` and fix every finding — [agent]
  - `npx web-ext lint --source-dir extension` clean before the add-on is loaded.
- [ ] p16 Load the temporary add-on and paste the token — [you]
  - `about:debugging` → Load Temporary Add-on → `extension/manifest.json`; options page → token.
- [ ] p17 Register ffbridge in the opencode config and restart — [agent]
  - Verify the loaded tool list shows `ffbridge_*` after restart.

```json
{ "mcp": { "servers": { "ffbridge": {
  "type": "local",
  "command": ["bun", "run", "/develop/automation/ff-tab-bridge/server/server.ts"],
  "enabled": true } } } }
```

- [ ] p18 Attach a tab and run the smoke prompt — [you]
  - Click the toolbar icon; ask opencode to snapshot, click the first result, summarise.
- [ ] p19 Run the real-site validation matrix — [agent]
  - GitHub search, React form, shadow-DOM site, full-page screenshot, detach mid-command, tab close, permission revoke.
- [ ] p20 Create AMO API credentials outside the repo — [you]
  - `~/.config/ff-tab-bridge/amo.env`, mode 0600.
- [ ] p21 Sign the unlisted XPI and install it permanently — [you]
  - Confirm it reconnects after a full Firefox restart.

```bash
npx web-ext sign --source-dir extension --channel=unlisted --api-key="$AMO_KEY" --api-secret="$AMO_SECRET"
```

- [ ] p22 Tag v0.1.0 and finish the README — [agent]
  - Install, token, tool reference, security model, troubleshooting, upgrade procedure.

## Open decision

**D1 — Sign permanently (needs an AMO account with 2FA) or stay on the temporary add-on for a week.** Recommended: run temporary through p19, sign in p21; the temporary add-on is wiped on every Firefox restart.

## Risks

- Snapshot/ref work overruns the estimate — timebox p8 to 8 h, default `interactiveOnly`, cap lines.
- React-controlled inputs resist synthetic typing — MAIN-world `execCommand` fallback; document unsupported sites.
- `isTrusted` or bot walls block a site — hand it back to you; never attempt evasion.
- MV2 is eventually deprecated — 12-month notice, port patches to MV3 event pages + native messaging.

_22 steps · 18 agent · 4 you · 6/6 requirements traced · 6 auto-fixes · 0 answers_
