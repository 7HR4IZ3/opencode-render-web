# OpenCode on Vercel: isolated container preview

This branch adds `Dockerfile.vercel`, which Vercel detects as a Container Image
Function. It runs the same OpenCode v2 binary, configuration, and plugins as
the Render image. Vercel serves the image on port 80; a small root-owned TCP
forwarder sends requests to the existing nginx frontend on port 3000, while
OpenCode and nginx run as the unprivileged `opencode` user.

## Deploy the branch

1. Import `7HR4IZ3/opencode-render-web` into a **new Vercel project**. Keep
   the repository root as the project root, choose `Other` if asked for a
   framework, and keep the production branch set to `main` so this branch
   only creates a Preview deployment.
2. In the project's Preview environment, set a long random
   `OPENCODE_SERVER_PASSWORD`. Optionally set `OPENCODE_SERVER_USERNAME` and
   `OPENCODE_AUTH_B64` for provider credentials. Set integration tokens only
   if the matching OpenCode tool or MCP needs them; never store them in Git.
3. Deploy `experiment/vercel-opencode`. Open the preview URL, sign in with
   `opencode` (or `OPENCODE_SERVER_USERNAME`) and the configured password,
   then check `/api/global/health` and the OpenCode UI.

Do **not** copy the Render R2 environment into this Vercel project. The
entrypoint refuses `OPENCODE_LITESTREAM_ENABLED=1` and `R2_SYNC_ENABLED=1`.
Use a different `R2_PREFIX` if you enable the explicit `r2_*` tools so that
their writes cannot overlap the Render workspace.

## Behavior and limits

- This preview stores SQLite, provider auth, and the editable workspace under
  `/tmp/opencode`. The Function filesystem is temporary. It will lose its
  session history and uncommitted files when Vercel scales an instance down,
  restarts it, or starts another instance. Commit work to a remote Git repo.
- Vercel scales container Functions down after 30 seconds without traffic in
  Preview and may start multiple instances. A browser can therefore see an
  empty database or a different workspace on its next request. Production
  scales down after 5 minutes without traffic. The OpenCode server cannot be
  treated as a durable, single-process service here.
- Long API responses and WebSocket connections obey the Vercel Function max
  duration. Commands may be interrupted when the container exits. The
  preview is for testing Vercel's container support, UI, and short requests.
- The Function scratch filesystem has limited capacity. Installing packages,
  large repositories, and the manual `/port/<port>` proxy may exceed Function
  limits or lose state between invocations.

For a durable OpenCode workspace, continue using a single-writer process host
such as the existing Render service. Vercel Sandbox can run OpenCode with a
persistent named snapshot or Drive, but a session has a hard timeout and the
Sandbox public URL stops serving when it is stopped; it is a separate project
from this auto-scaling container preview.

References: [Container Images](https://vercel.com/docs/functions/container-images),
[Function limits](https://vercel.com/docs/functions/limitations),
[Vercel Sandbox persistence](https://vercel.com/docs/sandbox/concepts/persistent-sandboxes).
