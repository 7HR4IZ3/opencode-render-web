import { spawnSync } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { Plugin } from "@opencode/plugin";
import { Schema } from "effect";

const portInput = Schema.Struct({ port: Schema.Number });
const emptyInput = Schema.Struct({});
const MAX_MANUAL_PORTS = 256;
const RENDER_RESERVED_PORTS = new Set([18012, 18013, 19099]);

const dataRoot =
  process.env.XDG_DATA_HOME ||
  join(process.env.HOME ?? "/tmp", ".local", "share");
const proxyDirectory = join(dataRoot, "proxy");
const nginxConfig = join(proxyDirectory, "nginx.conf");
const envPortsFile = join(proxyDirectory, "allowed-ports.map");
const manualPortsFile = join(proxyDirectory, "manual-ports.map");

let mutationQueue: Promise<void> = Promise.resolve();

function exclusive<T>(task: () => Promise<T>): Promise<T> {
  const result = mutationQueue.then(task, task);
  mutationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function validatePort(value: number) {
  if (!Number.isInteger(value) || value < 1024 || value > 65535) {
    throw new Error("port must be an integer between 1024 and 65535");
  }
  const occupied = new Set([
    Number(process.env.PORT ?? 3000),
    Number(process.env.OPENCODE_INTERNAL_PORT ?? 4096),
    Number(process.env.API_PORT ?? 4097),
  ]);
  if (occupied.has(value)) {
    throw new Error("That port is already used by Render or OpenCode");
  }
  if (RENDER_RESERVED_PORTS.has(value)) {
    throw new Error("That port is reserved by Render");
  }
}

function parsePorts(value: string) {
  const ports = new Set<number>();
  for (const line of value.split(/\r?\n/)) {
    const match = line.match(/^\s*~\^\/port\/(\d+)\(\?:\/\|\$\)\s+(\d+);\s*$/);
    if (match) ports.add(Number(match[1]));
  }
  return ports;
}

async function readMap(file: string) {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

async function assertHttpService(port: number) {
  await fetch(`http://127.0.0.1:${port}/`, {
    method: "HEAD",
    redirect: "manual",
    signal: AbortSignal.timeout(1500),
  });
}

function runNginx(args: string[]) {
  const result = spawnSync(
    "nginx",
    [...args.slice(0, args.indexOf("-c")), "-e", "/dev/stderr", ...args.slice(args.indexOf("-c"))],
    { encoding: "utf8" },
  );
  if (result.error || result.status !== 0) {
    const details = (result.stderr || result.stdout || result.error?.message || "").trim();
    throw new Error(details ? `Nginx could not apply the proxy routes: ${details}` : "Nginx could not apply the proxy routes");
  }
}

function mapLine(port: number) {
  return `    ~^/port/${port}(?:/|$) ${port};`;
}

async function writeAtomically(file: string, value: string) {
  const temporary = `${file}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(temporary, value, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, file);
}

async function applyManualPorts(ports: Set<number>) {
  const previous = await readMap(manualPortsFile);
  const next = [...ports]
    .sort((a, b) => a - b)
    .map(mapLine)
    .join("\n");
  await writeAtomically(manualPortsFile, next ? `${next}\n` : "");
  try {
    runNginx(["-t", "-c", nginxConfig]);
    runNginx(["-s", "reload", "-c", nginxConfig]);
  } catch (error) {
    await writeAtomically(manualPortsFile, previous);
    throw error;
  }
}

async function exposePort(port: number) {
  validatePort(port);
  return exclusive(async () => {
    const [envMap, manualMap] = await Promise.all([
      readMap(envPortsFile),
      readMap(manualPortsFile),
    ]);
    if (parsePorts(envMap).has(port)) {
      return `Port ${port} is already exposed by PROXY_ALLOWED_PORTS at /port/${port}/.`;
    }
    const ports = parsePorts(manualMap);
    if (ports.has(port)) return `Port ${port} is already exposed at /port/${port}/.`;
    if (ports.size >= MAX_MANUAL_PORTS) {
      throw new Error(`At most ${MAX_MANUAL_PORTS} ports can be exposed manually at once`);
    }
    try {
      await assertHttpService(port);
    } catch {
      throw new Error(`No HTTP service answered on 127.0.0.1:${port}`);
    }
    ports.add(port);
    await applyManualPorts(ports);
    return `Port ${port} is now publicly reachable at /port/${port}/. It remains exposed until you unexpose it or the container restarts.`;
  });
}

async function unexposePort(port: number) {
  validatePort(port);
  return exclusive(async () => {
    const [envMap, manualMap] = await Promise.all([
      readMap(envPortsFile),
      readMap(manualPortsFile),
    ]);
    if (parsePorts(envMap).has(port)) {
      throw new Error(`Port ${port} is configured by PROXY_ALLOWED_PORTS; remove it from that setting to unexpose it.`);
    }
    const ports = parsePorts(manualMap);
    if (!ports.delete(port)) return `Port ${port} is not manually exposed.`;
    await applyManualPorts(ports);
    return `Port ${port} is no longer exposed through the proxy.`;
  });
}

async function exposedPorts() {
  const [envMap, manualMap] = await Promise.all([
    readMap(envPortsFile),
    readMap(manualPortsFile),
  ]);
  return {
    configured_by_env: [...parsePorts(envMap)].sort((a, b) => a - b),
    exposed_manually: [...parsePorts(manualMap)].sort((a, b) => a - b),
  };
}

export default Plugin.define({
  id: "render.port-proxy",
  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "port_proxy",
        description: "Expose and manage local HTTP services through the Render front proxy.",
      });

      editor.add({
        name: "expose_port",
        description: "Expose a currently listening HTTP service on a local container port at the public /port/{port}/ route. This changes public access; call only when the user explicitly asks to expose that port.",
        input: portInput,
        options: { namespace: "port_proxy" },
        execute: async ({ port }) => ({ content: await exposePort(port) }),
      });

      editor.add({
        name: "unexpose_port",
        description: "Remove a manually created /port/{port}/ public route. Environment-configured routes must be removed from PROXY_ALLOWED_PORTS instead.",
        input: portInput,
        options: { namespace: "port_proxy" },
        execute: async ({ port }) => ({ content: await unexposePort(port) }),
      });

      editor.add({
        name: "list_exposed_ports",
        description: "List ports routed through the Render proxy, separated into environment-configured and manually exposed ports.",
        input: emptyInput,
        options: { namespace: "port_proxy" },
        execute: async () => ({ content: JSON.stringify(await exposedPorts()) }),
      });
    }).catch((error) => {
      const detail = error instanceof Error ? error.stack ?? error.message : String(error);
      console.error("[render.port-proxy] tool.transform failed:", detail);
      throw error;
    });
  },
});
