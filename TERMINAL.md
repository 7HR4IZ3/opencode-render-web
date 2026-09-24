# Authenticated web terminal

The full-screen xterm.js client is served at `/terminal`. A small Node.js backend accepts its WebSocket connection, creates a PTY with `node-pty`, and attaches to the persistent `tmux` session named `opencode-terminal`. Disconnecting the browser detaches the tmux client; the shell session stays available while the container is running.

## Authentication

The route uses HTTP Basic authentication. The browser displays its native username/password prompt before returning the page. Every terminal page, asset, and WebSocket upgrade is checked on the server.

Set these Render environment variables:

- `TERMINAL_USERNAME` — browser prompt username.
- `TERMINAL_PASSWORD` — a unique random password of at least 20 characters.
- `TERMINAL_PORT` — internal backend port; defaults to `4098`. It is not exposed publicly.

Render terminates HTTPS before forwarding traffic to the container. Do not reuse the OpenCode, GitHub, Vercel, or Render credentials for terminal authentication. The terminal runs as the `opencode` OS user and can access the files and processes available to that account.

## Local Docker

Copy `.env.example` to `.env`, set `OPENCODE_SERVER_PASSWORD` and the terminal credentials, then start the service with Docker Compose. The terminal shares the main web port, so it does not need a separate public port mapping.
