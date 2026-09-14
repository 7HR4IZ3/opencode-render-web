import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Plugin } from "@opencode/plugin";
import { Schema } from "effect";

declare const process: { env: Record<string, string | undefined> };

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_KEYS = 100;

const readInput = Schema.Struct({
  path: Schema.String,
});

const writeInput = Schema.Struct({
  path: Schema.String,
  content: Schema.String,
});

const listInput = Schema.Struct({
  prefix: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Number),
});

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the R2 storage tools`);
  return value;
}

let client: S3Client | undefined;

function s3() {
  if (client) return client;
  client = new S3Client({
    region: process.env.R2_REGION ?? "auto",
    endpoint: required("R2_ENDPOINT"),
    credentials: {
      accessKeyId: required("R2_ACCESS_KEY_ID"),
      secretAccessKey: required("R2_SECRET_ACCESS_KEY"),
      ...(process.env.R2_SESSION_TOKEN
        ? { sessionToken: process.env.R2_SESSION_TOKEN }
        : {}),
    },
  });
  return client;
}

function bucket() {
  return required("R2_BUCKET");
}

function prefix() {
  return (process.env.R2_PREFIX ?? "opencode").trim().replace(/^\/+|\/+$/g, "");
}

function safePath(value: string) {
  const path = value.trim().replace(/^\/+/, "");
  if (
    !path ||
    path.includes("\0") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(
      "path must be a non-empty relative object path without '.', '..', or empty segments",
    );
  }
  if (path.length > 1024) throw new Error("path is too long");
  return path;
}

function key(path: string) {
  return [prefix(), safePath(path)].filter(Boolean).join("/");
}

function maxBytes() {
  const value = Number.parseInt(
    process.env.R2_MAX_BYTES ?? String(DEFAULT_MAX_BYTES),
    10,
  );
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_BYTES;
}

function maxKeys(input: number | undefined) {
  const requested = Number.isFinite(input)
    ? Math.floor(input as number)
    : DEFAULT_MAX_KEYS;
  return Math.max(1, Math.min(requested, 200));
}

async function readObject(path: string) {
  const response = await s3().send(
    new GetObjectCommand({ Bucket: bucket(), Key: key(path) }),
  );
  if (!response.Body) throw new Error(`R2 object '${path}' had no body`);
  if (
    response.ContentLength !== undefined &&
    response.ContentLength > maxBytes()
  ) {
    throw new Error(
      `R2 object '${path}' exceeds the ${maxBytes()} byte read limit`,
    );
  }
  const content = await response.Body.transformToString();
  if (new TextEncoder().encode(content).byteLength > maxBytes()) {
    throw new Error(
      `R2 object '${path}' exceeds the ${maxBytes()} byte read limit`,
    );
  }
  return content;
}

export default Plugin.define({
  id: "render.r2-storage",
  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "r2",
        description:
          "Durable UTF-8 object storage backed by an S3-compatible R2 bucket",
      });

      editor.add({
        name: "read_file",
        description: "Read a UTF-8 text file from durable R2 storage.",
        input: readInput,
        options: { namespace: "r2" },
        execute: async ({ path }) => ({ content: await readObject(path) }),
      });

      editor.add({
        name: "write_file",
        description:
          "Write or replace a UTF-8 text file in durable R2 storage.",
        input: writeInput,
        options: { namespace: "r2" },
        execute: async ({ path, content }) => {
          const bytes = new TextEncoder().encode(content).byteLength;
          if (bytes > maxBytes())
            throw new Error(
              `content exceeds the ${maxBytes()} byte write limit`,
            );
          await s3().send(
            new PutObjectCommand({
              Bucket: bucket(),
              Key: key(path),
              Body: content,
              ContentType: "text/plain; charset=utf-8",
            }),
          );
          return { content: `Stored ${path} (${bytes} bytes)` };
        },
      });

      editor.add({
        name: "list_files",
        description: "List durable UTF-8 files below an R2 prefix.",
        input: listInput,
        options: { namespace: "r2" },
        execute: async ({ prefix: requestedPrefix, limit }) => {
          const base = prefix();
          const relativePrefix = requestedPrefix
            ? safePath(requestedPrefix)
            : "";
          const objectPrefix = [base, relativePrefix].filter(Boolean).join("/");
          const result = await s3().send(
            new ListObjectsV2Command({
              Bucket: bucket(),
              Prefix: objectPrefix ? `${objectPrefix}/` : undefined,
              MaxKeys: maxKeys(limit),
            }),
          );
          const basePrefix = base ? `${base}/` : "";
          const files = (result.Contents ?? [])
            .map((item) => item.Key)
            .filter((item): item is string => Boolean(item))
            .map((item) => item.slice(basePrefix.length));
          return { content: JSON.stringify(files) };
        },
      });

      editor.add({
        name: "delete_file",
        description: "Delete a file from durable R2 storage.",
        input: readInput,
        options: { namespace: "r2" },
        execute: async ({ path }) => {
          await s3().send(
            new DeleteObjectCommand({ Bucket: bucket(), Key: key(path) }),
          );
          return { content: `Deleted ${path}` };
        },
      });
    });
  },
});
