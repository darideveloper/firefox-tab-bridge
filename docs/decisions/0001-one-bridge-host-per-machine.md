# One bridge host per machine

Decided: 2026-11-25

Because: every opencode session spawns its own MCP server and one port can only have one listener.
All sessions but the first died on `EADDRINUSE` and silently offered no tools.

Alternatives: a port per session (the add-on holds one socket); an HTTP MCP endpoint with a shared
daemon (changes the install, gambles on transport support); one session at a time (the actual bug).

Consequence: the process that wins the port is the host and accepts `role: "client"` peers, which
relay their calls; a survivor takes the port when the host exits and the add-on reconnects. A port
conflict became a normal path instead of a crash.
