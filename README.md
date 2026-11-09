# ff-tab-bridge

A local bridge that lets an AI agent drive the Firefox tabs you explicitly attach,
from opencode through an MCP server.

Status: **scaffold**. The add-on loads and does nothing yet. See [PLAN.md](PLAN.md)
for the intended behaviour and [docs/ai-daridev](docs/ai-daridev) for the build memory.

## Security model

- No cookies, history, bookmarks or profile files are read. Ever.
- Host access is opt-in: the `<all_urls>` permission is granted per install, and
  a tab is only reachable after you attach it.
- The server listens on `127.0.0.1` only and accepts a single client whose
  `Origin` is this extension.
- No attempt is made to fake trusted input. A site that refuses synthetic events
  gets reported, not worked around.

## Load it (temporary add-on)

1. `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** →
   `extension/manifest.json`.
2. The add-on is removed when Firefox closes; reload it after a restart.

## Development

```bash
bun install
```

The manifest gate is the browser itself: if `about:debugging` loads
`extension/manifest.json` without complaint, it is valid. `web-ext lint` is
**not** used — `addons-linter` hangs on import on this machine, reproduced with a
bare `require()`, so it is not a signal about this add-on.
