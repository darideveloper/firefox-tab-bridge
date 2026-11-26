# Signed XPI install

Decided: 2026-11-25

Because: Firefox 152 refuses unsigned builds, and a temporary load is dropped on every restart,
taking the stored bridge token and the sidebar panel's pairing with it. Signing is the only way to
keep the add-on installed without leaving the release channel.

Alternatives: temporary loading only — still the MV2 iteration path, but never an install; Firefox
Developer Edition with signature checks off — a second browser build to keep in step; MV3 — out of
scope, nothing here needs it.

Consequence: each version is packed, submitted to AMO as an unlisted "On your own" release and
installed from the signed file; `about:debugging` stays for iteration, and every manifest change
needs a new upload and signature before it ships.
