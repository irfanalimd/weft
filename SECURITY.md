# Security

## Reporting a vulnerability

Please don't open a public issue. Contact the maintainer privately through GitHub with details and steps to reproduce.

## Built-in protections

The server limits abuse out of the box:

- **Size and rate limits:** 1 MiB frames, per-IP and global connection caps, and a per-connection message rate limit.
- **Connection checks:** a WebSocket must identify itself (Hello) within a deadline, and its Origin must match the site.
- **Document limits:** per-doc size quotas, a cap on open documents, and bounded CRDT buffers.

Each limit is tunable via `WEFT_LIMIT_*` environment variables (see `docs/ARCHITECTURE.md`). The web client sanitizes
peer names and colors and works under a strict Content-Security-Policy.

If you self-host, put a TLS reverse proxy in front of `weft-server` and keep it bound to localhost.

## Known limitations

Anyone with a document link can read and edit it, the same model as a pastebin. Don't put secrets in Weft documents. End-to-end
encryption is planned (`docs/roadmap/02-security.md`).
