#!/bin/sh
set -eu

# Vercel can start several containers for the same deployment. Litestream's
# SQLite replica and the workspace sync need one writer, so fail explicitly
# instead of silently corrupting data if Render env values are copied here.
if [ "${OPENCODE_LITESTREAM_ENABLED:-0}" != 0 ] || [ "${R2_SYNC_ENABLED:-0}" != 0 ]; then
  echo "Vercel preview does not support Litestream or automatic R2 workspace sync; use isolated temporary state" >&2
  exit 1
fi

if [ -z "${OPENCODE_SERVER_PASSWORD:-}" ]; then
  echo "Set OPENCODE_SERVER_PASSWORD in the Vercel project before opening the preview" >&2
  exit 1
fi

mkdir -p /tmp/opencode
chown opencode:opencode /tmp/opencode

# Port 80 is Vercel's container-image default. Keep nginx and OpenCode on
# their unprivileged ports using the existing tested entrypoint.
export PORT=3000
socat TCP-LISTEN:80,bind=0.0.0.0,reuseaddr,fork TCP:127.0.0.1:3000 &
gateway_pid=$!
su-exec opencode /usr/local/bin/opencode-render-entrypoint &
app_pid=$!

cleanup() {
  kill "$gateway_pid" "$app_pid" 2>/dev/null || true
  wait "$gateway_pid" "$app_pid" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

while kill -0 "$gateway_pid" 2>/dev/null && kill -0 "$app_pid" 2>/dev/null; do
  sleep 1
done

status=1
if ! kill -0 "$app_pid" 2>/dev/null; then
  set +e
  wait "$app_pid"
  status=$?
  set -e
fi
exit "$status"
