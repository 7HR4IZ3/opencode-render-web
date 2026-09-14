import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { bucket, prefix, safePath, s3 } from "./r2-storage";

declare const process: {
  env: Record<string, string | undefined>;
  cwd(): string;
};

const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_DEBOUNCE_MS = 750;
const DEFAULT_MAX_FILE_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_FILES = 2_000;
const DEFAULT_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const DEFAULT_IGNORE = [".r2-sync", ".opencode", ".git", "node_modules"];

export type ConflictPolicy = "skip" | "local-wins" | "remote-wins";

type LocalEntry = {
  path: string;
  hash: string;
  size: number;
  mode: number;
  mtimeMs: number;
};

type RemoteEntry = {
  path: string;
  key: string;
  etag: string;
  size: number;
};

type SyncReport = {
  uploaded: number;
  downloaded: number;
  deletedRemote: number;
  deletedLocal: number;
  conflicts: string[];
  skipped: number;
};

type SyncStatus = {
  enabled: true;
  root: string;
  remotePrefix: string;
  intervalMs: number;
  conflictPolicy: ConflictPolicy;
  localFiles: number;
  remoteFiles: number;
  lastSyncAt?: string;
  lastError?: string;
  lastReport?: SyncReport;
};

function positiveInteger(name: string, fallback: number) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function cleanPrefix(value: string, name: string) {
  const normalized = value.trim().replace(/^\/+|\/+$/g, "");
  if (
    !normalized ||
    normalized.includes("\0") ||
    normalized.includes("\\") ||
    normalized
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`${name} must be a relative object prefix`);
  }
  return normalized;
}

function remoteWorkspacePrefix() {
  const configured = cleanPrefix(
    process.env.R2_SYNC_PREFIX ?? "workspace",
    "R2_SYNC_PREFIX",
  );
  return [prefix(), configured].filter(Boolean).join("/");
}

function remoteConflictPrefix() {
  const configured = cleanPrefix(
    process.env.R2_SYNC_CONFLICT_PREFIX ?? "workspace-conflicts",
    "R2_SYNC_CONFLICT_PREFIX",
  );
  return [prefix(), configured].filter(Boolean).join("/");
}

function parseIgnore() {
  const configured = process.env.R2_SYNC_IGNORE;
  const values = configured
    ? configured
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : DEFAULT_IGNORE;
  return new Set(values);
}

function conflictPolicy(): ConflictPolicy {
  const value = process.env.R2_SYNC_CONFLICT ?? "skip";
  if (value !== "skip" && value !== "local-wins" && value !== "remote-wins") {
    throw new Error(
      "R2_SYNC_CONFLICT must be one of: skip, local-wins, remote-wins",
    );
  }
  return value;
}

function safeRelative(value: string) {
  const normalized = value.replaceAll(sep, "/");
  if (
    !normalized ||
    normalized.includes("\0") ||
    normalized.includes("\\") ||
    normalized.startsWith("/") ||
    normalized.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`unsafe workspace path: ${value}`);
  }
  return safePath(normalized);
}

function sameLocal(left: LocalEntry | undefined, right: LocalEntry | undefined) {
  if (!left || !right) return left === right;
  return (
    left.hash === right.hash &&
    left.size === right.size &&
    left.mode === right.mode
  );
}

function sameRemote(
  left: RemoteEntry | undefined,
  right: RemoteEntry | undefined,
) {
  if (!left || !right) return left === right;
  return left.etag === right.etag && left.size === right.size;
}

function report(): SyncReport {
  return {
    uploaded: 0,
    downloaded: 0,
    deletedRemote: 0,
    deletedLocal: 0,
    conflicts: [],
    skipped: 0,
  };
}

export class R2WorkspaceSync {
  private readonly root: string;
  private readonly intervalMs: number;
  private readonly debounceMs: number;
  private readonly maxFileBytes: number;
  private readonly maxFiles: number;
  private readonly maxTotalBytes: number;
  private readonly ignore: Set<string>;
  private readonly policy: ConflictPolicy;
  private readonly workspacePrefix: string;
  private readonly conflictsPrefix: string;
  private local = new Map<string, LocalEntry>();
  private remote = new Map<string, RemoteEntry>();
  private timer?: ReturnType<typeof setTimeout>;
  private eventTimer?: ReturnType<typeof setTimeout>;
  private watcher?: FSWatcher;
  private running = false;
  private stopped = false;
  private lastSyncAt?: string;
  private lastError?: string;
  private lastReport?: SyncReport;

  constructor(root = process.cwd()) {
    this.root = resolve(root);
    if (this.root === sep) {
      throw new Error("R2_SYNC_DIR must not be the filesystem root");
    }
    this.intervalMs = positiveInteger("R2_SYNC_INTERVAL_MS", DEFAULT_INTERVAL_MS);
    this.debounceMs = positiveInteger(
      "R2_SYNC_DEBOUNCE_MS",
      DEFAULT_DEBOUNCE_MS,
    );
    this.maxFileBytes = positiveInteger(
      "R2_SYNC_MAX_FILE_BYTES",
      DEFAULT_MAX_FILE_BYTES,
    );
    this.maxFiles = positiveInteger("R2_SYNC_MAX_FILES", DEFAULT_MAX_FILES);
    this.maxTotalBytes = positiveInteger(
      "R2_SYNC_MAX_TOTAL_BYTES",
      DEFAULT_MAX_TOTAL_BYTES,
    );
    this.ignore = parseIgnore();
    this.policy = conflictPolicy();
    this.workspacePrefix = remoteWorkspacePrefix();
    this.conflictsPrefix = remoteConflictPrefix();
    if (this.workspacePrefix === this.conflictsPrefix) {
      throw new Error(
        "R2_SYNC_CONFLICT_PREFIX must be different from R2_SYNC_PREFIX",
      );
    }
  }

  async start() {
    await mkdir(this.root, { recursive: true });
    await this.hydrate();
    await this.run();
    this.startWatcher();
    this.schedulePoll();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.eventTimer) clearTimeout(this.eventTimer);
    this.watcher?.close();
  }

  async flush() {
    return this.run();
  }

  status(): SyncStatus {
    return {
      enabled: true,
      root: this.root,
      remotePrefix: this.workspacePrefix,
      intervalMs: this.intervalMs,
      conflictPolicy: this.policy,
      localFiles: this.local.size,
      remoteFiles: this.remote.size,
      ...(this.lastSyncAt ? { lastSyncAt: this.lastSyncAt } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
      ...(this.lastReport ? { lastReport: this.lastReport } : {}),
    };
  }

  private localPath(path: string) {
    const absolute = resolve(this.root, ...path.split("/"));
    if (absolute !== this.root && !absolute.startsWith(`${this.root}${sep}`)) {
      throw new Error(`workspace path escaped sync root: ${path}`);
    }
    return absolute;
  }

  private key(path: string) {
    return `${this.workspacePrefix}/${safeRelative(path)}`;
  }

  private isIgnored(path: string) {
    const parts = path.split("/");
    return parts.some((part) => this.ignore.has(part)) || this.ignore.has(path);
  }

  private async stableLocal(path: string) {
    const absolute = this.localPath(path);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = await stat(absolute);
      if (!before.isFile()) throw new Error(`${path} is not a regular file`);
      if (before.size > this.maxFileBytes) {
        throw new Error(
          `${path} exceeds R2_SYNC_MAX_FILE_BYTES (${this.maxFileBytes})`,
        );
      }
      const bytes = await readFile(absolute);
      const after = await stat(absolute);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
        continue;
      }
      return {
        bytes,
        entry: {
          path,
          hash: createHash("sha256").update(bytes).digest("hex"),
          size: bytes.byteLength,
          mode: after.mode & 0o777,
          mtimeMs: after.mtimeMs,
        },
      };
    }
    throw new Error(`${path} changed while it was being read`);
  }

  private async stableLocalEntry(path: string): Promise<LocalEntry> {
    return (await this.stableLocal(path)).entry;
  }

  private async scan(previous: Map<string, LocalEntry>) {
    const entries = new Map<string, LocalEntry>();
    let totalBytes = 0;

    const walk = async (directory: string, relativeDirectory: string) => {
      const children = await readdir(directory, { withFileTypes: true });
      for (const child of children) {
        const path = relativeDirectory
          ? `${relativeDirectory}/${child.name}`
          : child.name;
        if (this.isIgnored(path)) continue;
        const absolute = join(directory, child.name);
        if (child.isDirectory()) {
          await walk(absolute, path);
          continue;
        }
        if (!child.isFile()) continue;
        const info = await stat(absolute);
        if (info.size > this.maxFileBytes) {
          throw new Error(
            `${path} exceeds R2_SYNC_MAX_FILE_BYTES (${this.maxFileBytes})`,
          );
        }
        totalBytes += info.size;
        if (totalBytes > this.maxTotalBytes) {
          throw new Error(
            `workspace exceeds R2_SYNC_MAX_TOTAL_BYTES (${this.maxTotalBytes})`,
          );
        }
        const old = previous.get(path);
        if (
          old &&
          old.size === info.size &&
          old.mtimeMs === info.mtimeMs &&
          old.mode === (info.mode & 0o777)
        ) {
          entries.set(path, old);
        } else {
          entries.set(path, await this.stableLocalEntry(path));
        }
        if (entries.size > this.maxFiles) {
          throw new Error(`workspace exceeds R2_SYNC_MAX_FILES (${this.maxFiles})`);
        }
      }
    };

    await walk(this.root, "");
    return entries;
  }

  private async listRemote() {
    const entries = new Map<string, RemoteEntry>();
    let continuationToken: string | undefined;
    const listPrefix = `${this.workspacePrefix}/`;
    let totalBytes = 0;

    do {
      const response = await s3().send(
        new ListObjectsV2Command({
          Bucket: bucket(),
          Prefix: listPrefix,
          MaxKeys: 1_000,
          ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
        }),
      );
      for (const object of response.Contents ?? []) {
        if (!object.Key || object.Key.endsWith("/")) continue;
        const path = safeRelative(object.Key.slice(listPrefix.length));
        const size = object.Size ?? 0;
        totalBytes += size;
        if (totalBytes > this.maxTotalBytes) {
          throw new Error(
            `remote workspace exceeds R2_SYNC_MAX_TOTAL_BYTES (${this.maxTotalBytes})`,
          );
        }
        if (size > this.maxFileBytes) {
          throw new Error(
            `${path} exceeds R2_SYNC_MAX_FILE_BYTES (${this.maxFileBytes}) in R2`,
          );
        }
        entries.set(path, {
          path,
          key: object.Key,
          etag:
            object.ETag ??
            `${size}:${object.LastModified?.getTime() ?? "unknown"}`,
          size,
        });
        if (entries.size > this.maxFiles) {
          throw new Error(`remote workspace exceeds R2_SYNC_MAX_FILES (${this.maxFiles})`);
        }
      }
      continuationToken = response.IsTruncated
        ? response.NextContinuationToken
        : undefined;
    } while (continuationToken);

    return entries;
  }

  private async download(entry: RemoteEntry) {
    const response = await s3().send(
      new GetObjectCommand({ Bucket: bucket(), Key: entry.key }),
    );
    if (!response.Body) throw new Error(`R2 object '${entry.path}' had no body`);
    if (
      response.ContentLength !== undefined &&
      response.ContentLength > this.maxFileBytes
    ) {
      throw new Error(
        `${entry.path} exceeds R2_SYNC_MAX_FILE_BYTES (${this.maxFileBytes})`,
      );
    }
    const bytes = await response.Body.transformToByteArray();
    if (bytes.byteLength > this.maxFileBytes) {
      throw new Error(
        `${entry.path} exceeds R2_SYNC_MAX_FILE_BYTES (${this.maxFileBytes})`,
      );
    }
    const absolute = this.localPath(entry.path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, bytes, { mode: 0o644 });
    const mode = response.Metadata?.mode;
    if (mode && /^[0-7]{3,4}$/.test(mode)) {
      await chmod(absolute, Number.parseInt(mode, 8));
    }
    return this.stableLocalEntry(entry.path);
  }

  private async upload(path: string) {
    const { entry, bytes } = await this.stableLocal(path);
    const response = await s3().send(
      new PutObjectCommand({
        Bucket: bucket(),
        Key: this.key(path),
        Body: bytes,
        ContentType: "application/octet-stream",
        Metadata: {
          sha256: entry.hash,
          mode: entry.mode.toString(8),
        },
      }),
    );
    return {
      local: entry,
      remote: {
        path,
        key: this.key(path),
        etag: response.ETag ?? `sha256:${entry.hash}`,
        size: entry.size,
      },
    };
  }

  private async archiveLocal(path: string, suffix: string) {
    const { entry, bytes } = await this.stableLocal(path);
    const key = `${this.conflictsPrefix}/${Date.now()}-${entry.hash.slice(0, 12)}-${path}.${suffix}`;
    await s3().send(
      new PutObjectCommand({
        Bucket: bucket(),
        Key: key,
        Body: bytes,
        ContentType: "application/octet-stream",
        Metadata: { sha256: entry.hash, originalPath: path },
      }),
    );
  }

  private async archiveRemote(entry: RemoteEntry, suffix: string) {
    const response = await s3().send(
      new GetObjectCommand({ Bucket: bucket(), Key: entry.key }),
    );
    if (!response.Body) throw new Error(`R2 object '${entry.path}' had no body`);
    if (
      response.ContentLength !== undefined &&
      response.ContentLength > this.maxFileBytes
    ) {
      throw new Error(
        `${entry.path} exceeds R2_SYNC_MAX_FILE_BYTES (${this.maxFileBytes})`,
      );
    }
    const bytes = await response.Body.transformToByteArray();
    if (bytes.byteLength > this.maxFileBytes) {
      throw new Error(
        `${entry.path} exceeds R2_SYNC_MAX_FILE_BYTES (${this.maxFileBytes})`,
      );
    }
    const key = `${this.conflictsPrefix}/${Date.now()}-${entry.etag.replaceAll(/[^A-Za-z0-9_-]/g, "").slice(-12)}-${entry.path}.${suffix}`;
    await s3().send(
      new PutObjectCommand({
        Bucket: bucket(),
        Key: key,
        Body: bytes,
        ContentType: "application/octet-stream",
        Metadata: { originalPath: entry.path, originalEtag: entry.etag },
      }),
    );
  }

  private async deleteRemote(entry: RemoteEntry) {
    await s3().send(
      new DeleteObjectCommand({ Bucket: bucket(), Key: entry.key }),
    );
  }

  private async deleteLocal(path: string) {
    await rm(this.localPath(path), { force: true });
  }

  private async hydrate() {
    const remote = await this.listRemote();
    const local = await this.scan(new Map());
    const baseline = new Map<string, LocalEntry>();
    for (const entry of remote.values()) {
      if (local.has(entry.path)) {
        baseline.set(entry.path, local.get(entry.path)!);
      } else {
        baseline.set(entry.path, await this.download(entry));
      }
    }
    // Do not baseline local-only files. The first sync pass must upload them
    // into the empty remote workspace instead of treating them as already
    // synchronized.
    this.local = baseline;
    this.remote = remote;
  }

  private startWatcher() {
    try {
      this.watcher = watch(
        this.root,
        { recursive: true },
        () => this.scheduleEventRun(),
      );
      this.watcher.on("error", (error) => {
        console.warn(`[r2-sync] filesystem watcher stopped: ${error}`);
        this.watcher?.close();
        this.watcher = undefined;
      });
    } catch (error) {
      console.warn(`[r2-sync] recursive watcher unavailable; polling only: ${error}`);
    }
  }

  private scheduleEventRun() {
    if (this.stopped || this.eventTimer) return;
    this.eventTimer = setTimeout(() => {
      this.eventTimer = undefined;
      void this.run().catch(() => undefined);
    }, this.debounceMs);
  }

  private schedulePoll() {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.run()
        .catch(() => undefined)
        .finally(() => this.schedulePoll());
    }, this.intervalMs);
  }

  private async run(): Promise<SyncReport> {
    if (this.running) return this.lastReport ?? report();
    this.running = true;
    const result = report();
    try {
      const currentLocal = await this.scan(this.local);
      const currentRemote = await this.listRemote();
      const nextLocal = new Map(currentLocal);
      const nextRemote = new Map(currentRemote);
      const paths = new Set([
        ...this.local.keys(),
        ...this.remote.keys(),
        ...currentLocal.keys(),
        ...currentRemote.keys(),
      ]);

      for (const path of paths) {
        const previousLocal = this.local.get(path);
        const previousRemote = this.remote.get(path);
        const local = currentLocal.get(path);
        const remote = currentRemote.get(path);
        const localChanged = !sameLocal(local, previousLocal);
        const remoteChanged = !sameRemote(remote, previousRemote);
        if (!localChanged && !remoteChanged) continue;

        if (localChanged && remoteChanged) {
          result.conflicts.push(path);
          if (this.policy === "skip") {
            result.skipped += 1;
            if (previousLocal) nextLocal.set(path, previousLocal);
            else nextLocal.delete(path);
            if (previousRemote) nextRemote.set(path, previousRemote);
            else nextRemote.delete(path);
            continue;
          }
          if (this.policy === "local-wins") {
            if (remote) await this.archiveRemote(remote, "remote");
            if (local) {
              const uploaded = await this.upload(path);
              nextLocal.set(path, uploaded.local);
              nextRemote.set(path, uploaded.remote);
              result.uploaded += 1;
            } else if (remote) {
              await this.deleteRemote(remote);
              nextRemote.delete(path);
              result.deletedRemote += 1;
            }
            continue;
          }
          if (local) await this.archiveLocal(path, "local");
          if (remote) {
            nextLocal.set(path, await this.download(remote));
            nextRemote.set(path, remote);
            result.downloaded += 1;
          } else if (local) {
            await this.deleteLocal(path);
            nextLocal.delete(path);
            result.deletedLocal += 1;
          }
          continue;
        }

        if (localChanged) {
          if (local) {
            const uploaded = await this.upload(path);
            nextLocal.set(path, uploaded.local);
            nextRemote.set(path, uploaded.remote);
            result.uploaded += 1;
          } else if (remote) {
            await this.deleteRemote(remote);
            nextRemote.delete(path);
            result.deletedRemote += 1;
          }
          continue;
        }

        if (remoteChanged) {
          if (remote) {
            nextLocal.set(path, await this.download(remote));
            nextRemote.set(path, remote);
            result.downloaded += 1;
          } else if (local) {
            await this.deleteLocal(path);
            nextLocal.delete(path);
            result.deletedLocal += 1;
          }
        }
      }

      this.local = nextLocal;
      this.remote = nextRemote;
      this.lastReport = result;
      this.lastSyncAt = new Date().toISOString();
      this.lastError = undefined;
      if (
        result.uploaded ||
        result.downloaded ||
        result.deletedLocal ||
        result.deletedRemote ||
        result.conflicts.length
      ) {
        console.info(`[r2-sync] ${JSON.stringify(result)}`);
      }
      return result;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      console.error(`[r2-sync] sync failed: ${this.lastError}`);
      throw error;
    } finally {
      this.running = false;
    }
  }
}
