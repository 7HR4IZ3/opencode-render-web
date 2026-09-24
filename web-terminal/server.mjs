import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pty from "node-pty";
import { WebSocketServer, WebSocket } from "ws";

const port = Number(process.env.TERMINAL_PORT || 4098);
const username = process.env.TERMINAL_USERNAME || "";
const password = process.env.TERMINAL_PASSWORD || "";
const workdir = process.env.TERMINAL_WORKDIR
  || process.env.OPENCODE_WORKDIR
  || process.env.HOME
  || "/var/lib/opencode/workspace";
const here = path.dirname(fileURLToPath(import.meta.url));
const nodeModules = path.join(here, "node_modules");

const assets = new Map([
  ["/terminal/assets/xterm.js", {
    file: path.join(nodeModules, "@xterm/xterm/lib/xterm.js"),
    type: "text/javascript; charset=utf-8",
  }],
  ["/terminal/assets/xterm.css", {
    file: path.join(nodeModules, "@xterm/xterm/lib/xterm.css"),
    type: "text/css; charset=utf-8",
  }],
  ["/terminal/assets/addon-fit.js", {
    file: path.join(nodeModules, "@xterm/addon-fit/lib/addon-fit.js"),
    type: "text/javascript; charset=utf-8",
  }],
]);

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="color-scheme" content="dark">
  <title>OpenCode Terminal</title>
  <link rel="stylesheet" href="/terminal/assets/xterm.css">
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0b0d10; color: #e8edf2; }
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; }
    body { display: flex; flex-direction: column; min-height: 0; }
    header { height: 48px; flex: 0 0 48px; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 0 16px; border-bottom: 1px solid #252a31; background: #111419; }
    .brand { display: flex; align-items: center; gap: 10px; min-width: 0; font-size: 13px; font-weight: 600; letter-spacing: .01em; }
    .mark { width: 9px; height: 9px; border-radius: 50%; background: #64748b; }
    .mark.connected { background: #4ade80; box-shadow: 0 0 10px #4ade8070; }
    .mark.error { background: #fb7185; }
    #status { color: #9aa4b2; font-size: 12px; font-weight: 500; }
    button { border: 1px solid #303742; border-radius: 6px; background: #181c22; color: #dce3eb; padding: 6px 10px; font: inherit; font-size: 12px; cursor: pointer; }
    button:hover { background: #232933; }
    main { position: relative; flex: 1 1 auto; min-height: 0; padding: 8px 10px 10px; }
    #terminal { position: absolute; inset: 8px 10px 10px; }
    .xterm { height: 100%; }
    @media (max-width: 600px) {
      header { height: 42px; flex-basis: 42px; padding: 0 10px; }
      main { padding: 4px 3px 5px; }
      #terminal { inset: 4px 3px 5px; }
      .brand { gap: 7px; }
    }
  </style>
</head>
<body>
  <header>
    <div class="brand"><span id="mark" class="mark"></span><span>OpenCode Terminal</span><span aria-hidden="true">·</span><span id="status">Connecting…</span></div>
    <button id="reconnect" type="button">Reconnect</button>
  </header>
  <main><div id="terminal"></div></main>
  <script src="/terminal/assets/xterm.js"></script>
  <script src="/terminal/assets/addon-fit.js"></script>
  <script>
    (() => {
      const status = document.getElementById("status");
      const mark = document.getElementById("mark");
      const terminal = new Terminal({
        cursorBlink: true,
        convertEol: false,
        scrollback: 10000,
        fontSize: 14,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
        theme: { background: "#0b0d10", foreground: "#e8edf2", cursor: "#80cbc4", selectionBackground: "#334155" }
      });
      const fit = new FitAddon.FitAddon();
      terminal.loadAddon(fit);
      terminal.open(document.getElementById("terminal"));

      let socket;
      let retryTimer;
      const setStatus = (text, state) => {
        status.textContent = text;
        mark.className = "mark" + (state ? " " + state : "");
      };
      const send = (message) => {
        if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
      };
      const fitAndResize = () => {
        try {
          fit.fit();
          send({ type: "resize", cols: terminal.cols, rows: terminal.rows });
        } catch {}
      };
      const connect = () => {
        clearTimeout(retryTimer);
        setStatus("Connecting…", "");
        const target = new URL("/terminal/ws", window.location.href);
        target.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        socket = new WebSocket(target);
        socket.onopen = () => {
          setStatus("Connected · tmux", "connected");
          fitAndResize();
          terminal.focus();
        };
        socket.onmessage = (event) => {
          try {
            const message = JSON.parse(event.data);
            if (message.type === "output") terminal.write(message.data);
            if (message.type === "notice") terminal.write("\\r\\n\\x1b[90m" + message.text + "\\x1b[0m\\r\\n");
          } catch {}
        };
        socket.onerror = () => setStatus("Connection error", "error");
        socket.onclose = () => {
          setStatus("Disconnected · reconnecting…", "error");
          retryTimer = setTimeout(connect, 1500);
        };
      };
      terminal.onData((data) => send({ type: "input", data }));
      terminal.onResize(({ cols, rows }) => send({ type: "resize", cols, rows }));
      new ResizeObserver(fitAndResize).observe(document.getElementById("terminal"));
      document.getElementById("reconnect").addEventListener("click", () => window.location.reload());
      window.addEventListener("beforeunload", () => {
        clearTimeout(retryTimer);
        if (socket) socket.close();
      });
      connect();
    })();
  </script>
</body>
</html>`;

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest();
}

function authorized(request) {
  const header = request.headers.authorization || "";
  const match = /^Basic\s+([A-Za-z0-9+/]+={0,2})$/i.exec(header);
  let suppliedUser = "";
  let suppliedPassword = "";
  if (match) {
    try {
      const decoded = Buffer.from(match[1], "base64").toString("utf8");
      const separator = decoded.indexOf(":");
      if (separator >= 0) {
        suppliedUser = decoded.slice(0, separator);
        suppliedPassword = decoded.slice(separator + 1);
      }
    } catch {}
  }
  const userOk = timingSafeEqual(digest(suppliedUser), digest(username));
  const passwordOk = timingSafeEqual(digest(suppliedPassword), digest(password));
  return Boolean(username && password && password.length >= 20 && userOk && passwordOk);
}

function unauthorized(response) {
  const body = "Authentication required.";
  response.writeHead(401, {
    "WWW-Authenticate": 'Basic realm="OpenCode Terminal", charset="UTF-8"',
    "Cache-Control": "no-store",
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

const server = createServer((request, response) => {
  const url = new URL(request.url || "/", "http://localhost");
  if (!url.pathname.startsWith("/terminal")) {
    response.writeHead(404).end();
    return;
  }
  if (!authorized(request)) {
    if (!username || !password || password.length < 20) {
      response.writeHead(503, { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" });
      response.end("Terminal authentication is not configured. Set TERMINAL_USERNAME and a TERMINAL_PASSWORD of at least 20 characters.");
      return;
    }
    unauthorized(response);
    return;
  }

  if (request.method !== "GET") {
    response.writeHead(405, { Allow: "GET", "Cache-Control": "no-store" }).end();
    return;
  }
  if (url.pathname === "/terminal" || url.pathname === "/terminal/") {
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data:; font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    });
    response.end(html);
    return;
  }

  const asset = assets.get(url.pathname);
  if (!asset) {
    response.writeHead(404, { "Cache-Control": "no-store" }).end();
    return;
  }
  response.writeHead(200, {
    "Cache-Control": "public, max-age=3600",
    "Content-Type": asset.type,
    "X-Content-Type-Options": "nosniff",
  });
  createReadStream(asset.file).on("error", () => {
    if (!response.headersSent) response.writeHead(404);
    response.end();
  }).pipe(response);
});

const sockets = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024, perMessageDeflate: false });

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url || "/", "http://localhost");
  if (url.pathname !== "/terminal/ws") {
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  if (!authorized(request)) {
    if (!username || !password || password.length < 20) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
    } else {
      socket.write('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="OpenCode Terminal", charset="UTF-8"\r\nConnection: close\r\n\r\n');
    }
    socket.destroy();
    return;
  }
  const host = request.headers.host || "";
  let origin;
  try {
    origin = new URL(request.headers.origin || "");
  } catch {
    socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  if (!host || origin.host !== host || !["http:", "https:"].includes(origin.protocol)) {
    socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }

  sockets.handleUpgrade(request, socket, head, (websocket) => {
    sockets.emit("connection", websocket, request);
  });
});

sockets.on("connection", (websocket) => {
  const cols = 120;
  const rows = 36;
  let terminal;
  try {
    terminal = pty.spawn("tmux", [
      "new-session",
      "-A",
      "-s",
      "opencode-terminal",
      "-c",
      workdir,
    ], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: workdir,
      env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
    });
  } catch (error) {
    websocket.send(JSON.stringify({ type: "notice", text: `Could not start tmux: ${error.message}` }));
    websocket.close(1011, "tmux failed");
    return;
  }

  const output = terminal.onData((data) => {
    if (websocket.readyState === WebSocket.OPEN) {
      websocket.send(JSON.stringify({ type: "output", data }));
    }
  });
  const exited = terminal.onExit(({ exitCode }) => {
    if (websocket.readyState === WebSocket.OPEN) {
      websocket.send(JSON.stringify({ type: "notice", text: `tmux exited with code ${exitCode}` }));
      websocket.close(1000, "tmux exited");
    }
  });

  websocket.on("message", (raw, isBinary) => {
    if (isBinary || raw.length > 128 * 1024) return websocket.close(1009, "message too large");
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return websocket.close(1003, "invalid message");
    }
    if (message?.type === "input" && typeof message.data === "string" && message.data.length <= 64 * 1024) {
      terminal.write(message.data);
      return;
    }
    if (message?.type === "resize") {
      const cols = Number(message.cols);
      const rows = Number(message.rows);
      if (Number.isInteger(cols) && Number.isInteger(rows) && cols >= 2 && cols <= 500 && rows >= 2 && rows <= 300) {
        terminal.resize(cols, rows);
      }
    }
  });

  websocket.on("close", () => {
    output.dispose();
    exited.dispose();
    try { terminal.kill(); } catch {}
  });
  websocket.on("error", () => {
    output.dispose();
    exited.dispose();
    try { terminal.kill(); } catch {}
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Authenticated terminal backend listening on 127.0.0.1:${port}`);
});
