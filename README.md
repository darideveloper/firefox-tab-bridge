# ff-tab-bridge

Drive Firefox tabs you explicitly attach, from opencode, through an MCP server.
No cookies, no history, no bookmarks, no profile files.

```
opencode ──stdio──> server/server.ts ──ws://127.0.0.1:8788──> extension/background.js
                                                                     │
                                                        content scripts in attached tabs
```

- `extension/` — MV2 WebExtension: background page, isolated agent, page-world patches, options page.
- `server/` — one Bun process: MCP over stdio plus the WebSocket the add-on connects to.
- `test/` — `bun test` for the server and the pure DOM helpers, plus a fixture page.

## Requirements

- Firefox 128 or newer (verified on 152.0.4), installed from a **signed XPI** — Firefox 152 refuses
  unsigned builds.
- [Bun](https://bun.sh) 1.2 or newer.
- opencode with the `ffbridge` MCP server registered (see below).

## Install

1. Dependencies:

   ```bash
   cd /mnt/work/develop/automation/ff-tab-bridge
   bun install
   ```

2. Start the bridge server once. It creates the token file and prints the paths:

   ```bash
   bun run server
   ```

   ```
   ffbridge: MCP ready · ws://127.0.0.1:8788 · token file ~/.config/ff-tab-bridge/token
   ```

   The token file is written with mode `0600`. opencode starts the same command itself, so after
   this first run you normally let the MCP client own it.

3. Pack the add-on. `manifest.json` must sit at the archive root, so zip from inside `extension/`:

   ```bash
   mkdir -p dist && cd extension && zip -r -X ../dist/ff-tab-bridge-1.0.0.xpi . -x '.*' && cd ..
   ```

   `dist/` is ignored by git; the archive is a build output, never committed.

4. Sign it at the [AMO Developer Hub](https://addons.mozilla.org/developers/) → **Submit a New
   Add-on** → **On your own** (unlisted, self-distribution) → upload
   `dist/ff-tab-bridge-1.0.0.xpi` → download the signed copy. The signature covers the version, so
   every manifest change needs a new upload.

5. Install the signed XPI: open the downloaded file in Firefox and confirm the prompt, or use
   `about:addons` → gear → **Install Add-on From File…**. ff-tab-bridge must show as enabled and
   *not* as a temporary add-on.

6. Copy the token and open the add-on's options page (about:addons → ff-tab-bridge → Preferences,
   or the *Options* button in `about:debugging`). Paste the token, keep the port at `8788`, then
   **Save and reconnect**. Status should read `socket: connected`.

7. Attach a tab: click the ff-tab-bridge toolbar icon while a normal `http(s)` page is active. Site
   access is declared in the manifest, so the add-on already holds it — there is no prompt.
   The badge turns **ON** for that tab; click again to detach. The badge reads **OFF** while the
   socket is down and **ERR** if injection failed, and the options page then prints
   `last error (toolbar click): …`.

8. Register the MCP server in `~/.config/opencode/opencode.json` (already added by the install):

   ```json
   {
     "mcp": {
       "servers": {
         "ffbridge": {
           "type": "local",
           "command": ["bun", "run", "/mnt/work/develop/automation/ff-tab-bridge/server/server.ts"],
           "disabled": false
         }
       }
     }
   }
   ```

   Restart opencode. The tools appear as `tools.ffbridge.<name>` in Code Mode.

A signed install survives Firefox restarts: the add-on stays enabled, with its stored token and the
declared site access, so there is no reload step after a reboot. Just attach the tab again after a
restart of Firefox — the lease is per session, not per install.

Temporary loading remains the MV2 iteration path: `about:debugging#/runtime/this-firefox` → **Load
Temporary Add-on…** → `extension/manifest.json`. That copy is dropped when Firefox closes, so repeat
it after every restart; it keeps the stored token for the same extension id. The MCP config and the
token file survive either way.

The port belongs to one process. opencode starts one MCP server per session, so the first session
owns `ws://127.0.0.1:8788` and every other session relays its tool calls through it — no tools fail
with `EADDRINUSE`, and no session needs to be closed. If the owning session exits, a surviving
session takes the port over and the add-on reconnects to it automatically.

## Tools

| Tool | What it does |
|---|---|
| `tabs` | List open tabs with `tabId`, title, URL, `attached` flag. This is also how a popup is found and attached. |
| `attach` | Attach a tab. After the one-time `<all_urls>` grant the agent may attach on its own. |
| `detach` | Detach a tab; every later command for it fails with `TAB_NOT_ATTACHED`. |
| `snapshot` | Visible interactive elements and headings with refs (`e1…eN`), capped at 1500 lines. Start here. |
| `click` | Click by `ref` or `selector`; returns focus, value and any dialog raised. |
| `type` | Type into input/textarea/contenteditable. Native value setter, `execCommand("insertText")` fallback for React. `submit` submits the form. |
| `press_key` | Enter, Tab, Escape, arrows, with Ctrl/Alt/Shift/Meta. |
| `select` | Choose a `<select>` option by value or visible text. |
| `hover` | Mouse over an element to open menus and tooltips. |
| `scroll` | Scroll an element into view, or scroll the window by `dx`/`dy`. |
| `navigate` | `url`, `back`, `forward` or `reload`, then waits for load plus 250 ms of DOM quiet. |
| `wait_for` | Wait for text, selector, ref, URL fragment, or for a value to disappear. Polls at 100 ms. |
| `screenshot` | PNG into `/tmp/opencode`, returns the path. `fullPage` stitches up to 20 viewports. |
| `console` | Console entries captured in the page world (log/info/warn/error/debug), with timestamps. |
| `network` | fetch/XHR metadata: method, URL, status, duration, failures. Bodies are never read. |
| `upload` | Put a local file into a file input. Refuses `~/.ssh`, `~/.gnupg`, `~/.aws`, the token file and anything over 25 MB. |

Refs are valid for one snapshot. Pass the `snapshot` number back with a command to get
`STALE_SNAPSHOT` instead of clicking the wrong element after the page changed.

## Security model

- The extension only reads a tab after you attach it, and only through the agent's commands.
- It never reads cookies, history, bookmarks, form autofill or profile files. There is no
  `cookies`, `history` or `downloads` permission in the manifest.
- The server binds `127.0.0.1` only, refuses any WebSocket whose `Origin` is not
  `moz-extension://`, and then requires the 0600 token. A web page cannot attach: it has no token
  and no extension origin.
- Page content (snapshot text, screenshots, console, network metadata) leaves the page only when a
  tool asks for it, and goes only to the local MCP server.
- Synthetic events are `isTrusted: false`. No site is tricked into believing otherwise; a site that
  checks gets reported, not worked around.
- Site access is a **required** permission, so `about:addons` offers no per-site toggle: to withdraw
  it you disable or remove the add-on, which also closes the socket. The alternative — an optional
  grant requested on first click — never worked here, because Firefox ignores
  `permissions.request()` after an `await` in the click handler.
- Upload is deliberately narrow: explicit deny list, regular files only, 25 MB cap.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Badge **OFF** | The socket is down: server not running, wrong port, or the token does not match. Start `bun run server`, re-paste the token on the options page. |
| `NOT_CONNECTED` | opencode started the server but the add-on has not authenticated yet. Load the add-on and save the token. |
| Tools missing in one opencode window | Fixed: that window relays through the session that owns port 8788. Check the server line in `~/.local/share/opencode/log/opencode.log`: it reads `sharing the bridge at ws://127.0.0.1:8788` when relaying. |
| `PERMISSION_NEEDED` | Site access was not granted; reload the add-on from `about:debugging` (it is a declared permission, so a fresh load always has it). |
| `TAB_NOT_ATTACHED` | Attach the tab (toolbar click, or the `attach` tool). |
| `NO_RESPONSE` / `INJECT_FAILED` | The tab is privileged (`about:`, `view-source:`, add-on pages) or was closed mid-command. |
| `TIMEOUT` | A page left a dialog open or blocked the event loop. `screenshot` and `navigate` allow longer. |
| `console`/`network` empty | The page-world patch was blocked by the site's CSP, or the document loaded before registration — reload the tab once and retry. |
| A link does not open its popup | Expected: a synthetic click carries no user activation, so Firefox blocks `target="_blank"`. A popup the site opens for other reasons still shows up in `tabs` and can be attached by id. |
| Snapshot missing a shadow-DOM control | Closed shadow roots are covered only when the patch loaded before the shadow root was created. |

MV2 in Firefox 152 is deprecated but still loaded. If Firefox ever refuses it, the port is
`scripting.registerContentScripts` with `world: "MAIN"`, an event page, and `host_permissions`.

## Development

```bash
bun test                 # 20 tests: DOM helpers, token, origin gate, upload guard, WS auth/round-trip
bun run fixture          # serves test/fixture on http://127.0.0.1:8787/
```

Serve the fixture, attach that tab, then press **Run self-test on an attached tab** on the options
page. It exercises snapshot, typing, console, network, dialogs, select, wait_for and reports
pass/fail in place.

`web-ext lint` is not a gate here: `addons-linter` hangs on import on this machine (reproduced with a
bare `require()`), so the browser loading the manifest is the real gate.
