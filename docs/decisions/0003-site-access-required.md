# Site access is a declared permission

Decided: 2026-11-25

Because: with `<all_urls>` optional, the grant depended on `permissions.request()` inside the toolbar
click, and Firefox drops the user gesture across the `await` before it. The call threw instead of
prompting, `site access` stayed `not granted`, and no tab could ever be attached.

Alternatives: keep it optional and request synchronously as the first statement of the listener (one
prompt, revocable per site, but a prompt path that can regress); leave it broken.

Consequence: a temporary add-on has host access at load with no prompt. `about:addons` lists it as
Required, so withdrawing access means disabling or removing the add-on; a missing grant now fails as
`PERMISSION_NEEDED` and is printed on the options page.
