<!-- ai-daridev:start -->
- odoo_project: firefox-tab-bridge
- odoo_stage_done: Sprint Complete
- card_tag: script
<!-- ai-daridev:end -->

# ff-tab-bridge

## Constraints that are not up for debate

- The extension never reads cookies, history, bookmarks or profile files.
- Manifest V2, loaded as a temporary add-on in `about:debugging`. No AMO account,
  no signing, no MV3 migration unless Firefox stops loading it.
- The MCP server binds `127.0.0.1` and rejects any WebSocket whose `Origin` is not
  this extension.
- No trusted-input evasion. If a site refuses synthetic events, report it.

## Layout

- `extension/` — the WebExtension (`manifest.json`, background, content, options)
- `server/` — one Bun process: MCP over stdio, WebSocket for the extension
- `test/` — `bun test` for the server, fixture page for the browser
- `docs/ai-daridev/` — `spec.md`, `decisions.md`, `log.md` (written by the flow)
