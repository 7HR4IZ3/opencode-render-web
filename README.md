# OpenCode v2 on Render

This repo runs the official OpenCode v2 container with its built-in web UI, v2 HTTP API, runtime auth injection, and an optional R2-backed file-tool plugin.

I interpreted “blaze r2” as Cloudflare R2. If you meant Backblaze B2, the same S3-compatible plugin works with a Backblaze endpoint and region instead.

## What runs

The container starts one `opencode serve` process and forwards it to two listeners:

- `http://localhost:3000` — web UI (the public `PORT` on Render)
- `http://localhost:4097` — the same v2 server over a second local/private port

The v2 API is on the same server as the UI, so it remains one session/event bus and one SQLite database. For example, `/api/global/health`, `/api/session`, and `/doc` are available on either listener. The API is protected by OpenCode HTTP Basic Auth.

Render only exposes one public HTTP port per web service. Its additional-port support is private-network-only, and Free services cannot receive private-network traffic, so an external API client should use `https://<service>.onrender.com/api/...` on the public URL. Port `4097` remains useful for local Docker and paid/private Render deployments.

## Storage decision

The default Blueprint targets Render Free with no persistent disk. Render’s Free filesystem is writable while the instance is running, but it is ephemeral: local SQLite, logs, auth files, and workspace changes disappear on restart, redeploy, or idle spin-down. The Blueprint sets `OPENCODE_DB=:memory:` so OpenCode does not depend on a persistent SQLite file.

OpenCode v2 still uses a local SQLite-backed server store and local POSIX workspace during the process lifetime. R2 is object storage, not a safe drop-in SQLite/POSIX filesystem; mounting it as the database or replacing OpenCode’s internal storage would be an invasive fork with locking, event, snapshot, and tool-runtime risks.

The included `.opencode/plugins/r2-storage.ts` therefore adds explicit durable tools instead:

- `r2_read_file`
- `r2_write_file`
- `r2_list_files`
- `r2_delete_file`

They store UTF-8 objects below `R2_PREFIX` and never replace OpenCode’s built-in local `read`, `write`, shell, Git, or workspace tools. This is the safer v2-compatible boundary, but it does not make OpenCode session history persistent. If you need session history and the workspace to survive Free-instance restarts, that requires a real external database/workspace design or an upstream/core storage adapter—not merely an R2 tool plugin.

The adapter is S3-compatible: Cloudflare R2 works with `region=auto` and an endpoint such as `https://<account-id>.r2.cloudflarestorage.com`; a Backblaze B2 S3 endpoint can use the same plugin by changing `R2_ENDPOINT` and `R2_REGION`.

## Auth injection

Set `OPENCODE_AUTH_B64` to the base64-encoded contents of your `auth.json`. The entrypoint decodes it at runtime to `$XDG_DATA_HOME/opencode/auth.json` with mode `0600`, then removes the encoded variable from the child environment. It is intentionally not decoded during `docker build`: build arguments and image layers can be recovered, while Render runtime secrets are kept out of the image.

Generate the value locally without putting the file in Git:

```sh
base64 < auth.json | tr -d '\n'
```

The destination matches OpenCode’s normal provider credential path, `~/.local/share/opencode/auth.json`.

## Local Docker

```sh
cp .env.example .env
# Fill in OPENCODE_SERVER_PASSWORD, OPENCODE_AUTH_B64, and R2_* values.
docker compose up --build
```

Open `http://localhost:3000`. For API clients, use `http://localhost:4097/api/...` and HTTP Basic Auth (`opencode:<password>` unless `OPENCODE_SERVER_USERNAME` is set).

The Docker image is pinned to the multi-architecture manifest digest for `ghcr.io/anomalyco/opencode:2.0.3`; Render selects linux/amd64 and local Apple Silicon Docker can select arm64. The image includes `socat`, `git`, and CA certificates for the two-listener wrapper and normal coding-agent operation.

The Dockerfile installs the plugin dependencies in a Bun builder stage and copies only the runtime dependency tree into the pinned OpenCode image; the official image itself is a compiled CLI image rather than a package-manager image.

## Render

1. Push this directory to GitHub, GitLab, or Bitbucket.
2. Create a Blueprint from the repository; Render reads `render.yaml`.
3. Fill the `sync: false` values in the Dashboard, especially `OPENCODE_SERVER_PASSWORD`, `OPENCODE_AUTH_B64`, and the R2 credentials.
4. Open the service URL after the health check passes.

The Blueprint uses the Free plan and intentionally accepts ephemeral OpenCode sessions and local workspace state. R2 credentials should be scoped to one bucket and the smallest required permissions. If persistent sessions become mandatory, move to a paid service with a disk or redesign the OpenCode storage layer around a database that it actually supports.

## Verification

```sh
sh -n docker/entrypoint.sh
bun --check .opencode/plugins/r2-storage.ts
```

After startup, check the public web listener and the private/local API listener:

```sh
curl -I http://localhost:3000/site.webmanifest
curl -u 'opencode:change-me-before-sharing' http://localhost:4097/api/global/health
curl -u 'opencode:change-me-before-sharing' http://localhost:4097/doc
```

## Upstream references

- [OpenCode v2 installation and Docker image](https://opencode.ai/v2/docs)
- [OpenCode v2 CLI paths and `OPENCODE_DB`](https://opencode.ai/v2/docs/cli)
- [OpenCode v2 web command](https://opencode.ai/v2/docs/cli/web)
- [OpenCode v2 commands and API client](https://opencode.ai/v2/docs/cli/commands/)
- [OpenCode v2 plugins and custom tools](https://opencode.ai/v2/docs/build/plugins)
- [Cloudflare R2 S3-compatible API](https://developers.cloudflare.com/r2/get-started/s3/)
- [Render Free services and ephemeral filesystems](https://render.com/docs/free)
- [Render web-service ports](https://render.com/docs/web-services)
- [Render persistent disks](https://render.com/docs/disks)
