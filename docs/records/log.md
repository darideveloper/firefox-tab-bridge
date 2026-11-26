# Log

## bridge-implementation — 2026-11-25
Shipped: MV2 add-on plus MCP server with 16 tools, fixture page, self-test and 21 unit checks.
Decided: docs/decisions/0001-one-bridge-host-per-machine.md (the sharing rule it now follows).

## bridge-port-sharing — 2026-11-25
Shipped: one process owns port 8788, the rest relay, a survivor takes over when the owner exits.
Decided: docs/decisions/0001-one-bridge-host-per-machine.md.

## content-script-event-delivery — 2026-11-25
Shipped: one injection sandbox, helpers from the content global, events built in the content compartment; self-test 2/11 → 13/13 and React accepts typing plus Enter.
Decided: docs/decisions/0002-content-compartment-events.md.

## site-access-declared — 2026-11-25
Shipped: `<all_urls>` declared instead of requested, so a fresh load has access and no prompt path exists.
Decided: docs/decisions/0003-site-access-required.md.

## scroll-offsets — 2026-11-25
Shipped: scroll answers document offsets (300 after a 300px move) instead of the sandbox viewport's 0.

## runtime-verification — 2026-11-25
Shipped: every planned case passes in a real Firefox or is documented as a limit; the restart drill closes the add-on lifecycle question.

## custom-extension-icon — 2026-11-25
Shipped: hand-authored `bridge.svg` (16px grid, one `#0060df`, 1px padding) with 16/32/48/96 exports wired as `icons` and `browser_action.default_icon`, no new permission.

## in-page-attach-indicator — 2026-11-25
Shipped: every attached tab carries a closed-shadow marker — a 2px `#0060df` frame and a bottom-right capsule that names the running command and pulses — hidden around both capture paths so `snapshot` and screenshots stay clean.
