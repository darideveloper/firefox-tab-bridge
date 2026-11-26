# Build synthetic events in the content compartment

Decided: 2026-11-25

Because: events built with the page's constructors (`new page.KeyboardEvent` on `wrappedJSObject`) are
dropped when a content script dispatches them, so no page listener ran. Clicks only looked fine
because they use the native `el.click()`. React and root-delegated handlers stayed deaf: typing
landed in the DOM while state never changed.

Alternatives: keep page-world constructors and declare React unsupported; dispatch on a page-node
twin found by a marker attribute (fragile); rely on `execCommand` alone (needs focus, cannot send
keys).

Consequence: `pageEvent`, `mouse` and `pressKey` construct with `view: window` in the content
compartment. Two self-test checks guard the boundary, since unit tests cannot see it.
