#!/bin/sh
set -eu

data_root="${XDG_DATA_HOME:-${HOME:-/tmp}/.local/share}"
auth_dir="$data_root/opencode"
workdir="${OPENCODE_WORKDIR:-/var/lib/opencode/workspace}"
internal_port="${OPENCODE_INTERNAL_PORT:-4096}"
public_port="${PORT:-3000}"
api_port="${API_PORT:-4097}"

mkdir -p "$auth_dir" "$workdir"

# Decode at runtime, never at Docker build time. Build args and image layers
# are recoverable; Render runtime env vars are not baked into the image.
if [ -n "${OPENCODE_AUTH_B64:-}" ]; then
  auth_tmp="$auth_dir/auth.json.tmp.$$"
  if ! printf '%s' "$OPENCODE_AUTH_B64" | base64 -d >"$auth_tmp"; then
    rm -f "$auth_tmp"
    echo "OPENCODE_AUTH_B64 is not valid base64" >&2
    exit 1
  fi
  chmod 600 "$auth_tmp"
  mv -f "$auth_tmp" "$auth_dir/auth.json"
  unset OPENCODE_AUTH_B64
fi

if [ -z "${OPENCODE_SERVER_PASSWORD:-}" ]; then
  echo "OPENCODE_SERVER_PASSWORD must be set; refusing to start an exposed server" >&2
  exit 1
fi

# Keep the checked-in config/plugin bundle available even when the workdir is a
# mounted Render disk or a local Docker volume.
cp -R /opt/opencode-config/. "$workdir"/
cd "$workdir"

echo "Starting OpenCode v2 on 127.0.0.1:${internal_port}"
opencode serve --hostname 127.0.0.1 --port "$internal_port" &
server_pid=$!

proxy_pid=""
api_proxy_pid=""

start_proxy() {
  listen_port="$1"
  if [ "$listen_port" = "$internal_port" ]; then
    echo "${listen_port} cannot equal OPENCODE_INTERNAL_PORT" >&2
    exit 1
  fi
  socat "TCP-LISTEN:${listen_port},bind=0.0.0.0,reuseaddr,fork" "TCP:127.0.0.1:${internal_port}" &
  echo "$!"
}

proxy_pid=$(start_proxy "$public_port")
if [ "$api_port" != "$public_port" ]; then
  api_proxy_pid=$(start_proxy "$api_port")
fi

cleanup() {
  kill "$server_pid" "$proxy_pid" ${api_proxy_pid:-} 2>/dev/null || true
}
trap cleanup INT TERM EXIT

set +e
wait "$server_pid"
status=$?
set -e
exit "$status"
