#!/bin/sh
set -eu

data_root="${XDG_DATA_HOME:-${HOME:-/tmp}/.local/share}"
auth_dir="$data_root/opencode"
workdir="${OPENCODE_WORKDIR:-/var/lib/opencode/workspace}"
internal_port="${OPENCODE_INTERNAL_PORT:-4096}"
public_port="${PORT:-3000}"
api_port="${API_PORT:-4097}"
custom_proxy_ports="${PROXY_ALLOWED_PORTS:-}"
litestream_enabled="${OPENCODE_LITESTREAM_ENABLED:-0}"

case "$internal_port" in
  ''|*[!0-9]*) echo "OPENCODE_INTERNAL_PORT must be numeric" >&2; exit 1 ;;
esac
case "$public_port" in
  ''|*[!0-9]*) echo "PORT must be numeric" >&2; exit 1 ;;
esac
case "$api_port" in
  ''|*[!0-9]*) echo "API_PORT must be numeric" >&2; exit 1 ;;
esac
for value in "$internal_port" "$public_port" "$api_port"; do
  if [ "$value" -lt 1 ] || [ "$value" -gt 65535 ]; then
    echo "Ports must be between 1 and 65535" >&2
    exit 1
  fi
done
if [ "$internal_port" = "$public_port" ] || [ "$internal_port" = "$api_port" ]; then
  echo "OPENCODE_INTERNAL_PORT must differ from PORT and API_PORT" >&2
  exit 1
fi

case "$custom_proxy_ports" in
  *[!0-9,]*)
    echo "PROXY_ALLOWED_PORTS must be a comma-separated list of numeric ports" >&2
    exit 1
    ;;
esac

case "$litestream_enabled" in
  0|1) ;;
  *) echo "OPENCODE_LITESTREAM_ENABLED must be 0 or 1" >&2; exit 1 ;;
esac

mkdir -p "$auth_dir" "$workdir"

proxy_dir="$data_root/proxy"
mkdir -p "$proxy_dir/client_body_temp" "$proxy_dir/proxy_temp"
allowed_ports_file="$proxy_dir/allowed-ports.map"
proxy_config="$proxy_dir/nginx.conf"
: > "$allowed_ports_file"

if [ -n "$custom_proxy_ports" ]; then
  case ",$custom_proxy_ports," in
    *,,*)
      echo "PROXY_ALLOWED_PORTS cannot contain empty entries" >&2
      exit 1
      ;;
  esac

  saved_ifs=$IFS
  IFS=','
  set -- $custom_proxy_ports
  IFS=$saved_ifs
  seen_ports=","
  for allowed_port do
    case "$allowed_port" in
      ''|0*|*[!0-9]*)
        echo "Each PROXY_ALLOWED_PORTS entry must be a decimal port without leading zeroes" >&2
        exit 1
        ;;
    esac
    if [ "${#allowed_port}" -gt 5 ] || [ "$allowed_port" -lt 1024 ] || [ "$allowed_port" -gt 65535 ]; then
      echo "Custom proxy ports must be between 1024 and 65535" >&2
      exit 1
    fi
    case "$allowed_port" in
      18012|18013|19099)
        echo "Port $allowed_port is reserved by Render" >&2
        exit 1
        ;;
    esac
    if [ "$allowed_port" = "$internal_port" ] || [ "$allowed_port" = "$public_port" ] || [ "$allowed_port" = "$api_port" ]; then
      echo "Port $allowed_port is already used by OpenCode or the service proxy" >&2
      exit 1
    fi
    case "$seen_ports" in
      *,"$allowed_port",*)
        echo "PROXY_ALLOWED_PORTS contains duplicate port $allowed_port" >&2
        exit 1
        ;;
    esac
    seen_ports="$seen_ports$allowed_port,"
    printf '    %s %s;\n' "$allowed_port" "$allowed_port" >> "$allowed_ports_file"
  done
fi

cat > "$proxy_config" <<EOF
worker_processes 1;
pid $proxy_dir/nginx.pid;
error_log /dev/stderr notice;

events {
  worker_connections 1024;
}

http {
  access_log /dev/stdout;
  client_body_temp_path $proxy_dir/client_body_temp;
  proxy_temp_path $proxy_dir/proxy_temp;
  client_max_body_size 1g;

  map $custom_port $custom_upstream_port {
    default "";
    include $allowed_ports_file;
  }

  map $http_upgrade $connection_upgrade {
    default upgrade;
    "" close;
  }

  server {
    listen 0.0.0.0:$public_port default_server;
    server_tokens off;

    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_connect_timeout 10s;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    proxy_buffering off;
    proxy_request_buffering off;
    proxy_redirect off;

    location ~ ^/port/(?<custom_port>[0-9]{1,5})(?<custom_uri>/.*)?$ {
      if ($custom_upstream_port = "") { return 404; }
      set $proxy_uri $custom_uri;
      if ($proxy_uri = "") { set $proxy_uri /; }
      proxy_set_header X-Forwarded-Prefix /port/$custom_port;
      proxy_pass http://127.0.0.1:$custom_upstream_port$proxy_uri$is_args$args;
    }

    location / {
      proxy_pass http://127.0.0.1:$internal_port;
    }
  }
}
EOF

nginx -t -c "$proxy_config"


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

litestream_config=""
db_path="${OPENCODE_DB:-/var/lib/opencode/opencode.db}"
if [ "$litestream_enabled" = "1" ]; then
  if [ "$db_path" = ":memory:" ]; then
    echo "OPENCODE_DB must be a file path when OPENCODE_LITESTREAM_ENABLED=1" >&2
    exit 1
  fi

  if [ -z "${R2_ENDPOINT:-}" ]; then
    echo "R2_ENDPOINT must be set when OPENCODE_LITESTREAM_ENABLED=1" >&2
    exit 1
  fi
  if [ -z "${R2_BUCKET:-}" ]; then
    echo "R2_BUCKET must be set when OPENCODE_LITESTREAM_ENABLED=1" >&2
    exit 1
  fi
  if [ -z "${R2_ACCESS_KEY_ID:-}" ]; then
    echo "R2_ACCESS_KEY_ID must be set when OPENCODE_LITESTREAM_ENABLED=1" >&2
    exit 1
  fi
  if [ -z "${R2_SECRET_ACCESS_KEY:-}" ]; then
    echo "R2_SECRET_ACCESS_KEY must be set when OPENCODE_LITESTREAM_ENABLED=1" >&2
    exit 1
  fi

  case "$db_path" in
    /*) ;;
    *) db_path="$data_root/$db_path" ;;
  esac
  case "$db_path" in
    *[[:space:]]*|*'"'*)
      echo "OPENCODE_DB must not contain whitespace or quotes when Litestream is enabled" >&2
      exit 1
      ;;
  esac

  r2_endpoint="$R2_ENDPOINT"
  case "$r2_endpoint" in
    https://*) r2_host="${r2_endpoint#https://}" ;;
    http://*) r2_host="${r2_endpoint#http://}" ;;
    *) r2_host="$r2_endpoint" ;;
  esac
  r2_host="${r2_host%/}"
  case "$r2_host" in
    ''|*[/?#[:space:]]*)
      echo "R2_ENDPOINT must be a host URL without a path (for example https://ACCOUNT_ID.r2.cloudflarestorage.com)" >&2
      exit 1
      ;;
  esac

  r2_bucket="$R2_BUCKET"
  case "$r2_bucket" in
    ''|*[!A-Za-z0-9._-]*)
      echo "R2_BUCKET contains unsupported characters" >&2
      exit 1
      ;;
  esac

  r2_prefix="${R2_PREFIX:-opencode}"
  r2_prefix="$(printf '%s' "$r2_prefix" | sed 's#^/*##; s#/*$##')"
  case "$r2_prefix" in
    *[!A-Za-z0-9._/-]*)
      echo "R2_PREFIX contains unsupported characters" >&2
      exit 1
      ;;
  esac

  r2_region="${R2_REGION:-auto}"
  case "$r2_region" in
    ''|*[!A-Za-z0-9._-]*)
      echo "R2_REGION contains unsupported characters" >&2
      exit 1
      ;;
  esac

  replica_path="${r2_prefix:+$r2_prefix/}opencode.db"
  mkdir -p "$(dirname "$db_path")"
  litestream_config="$data_root/litestream.yml"
  cat >"$litestream_config" <<EOF
sync-interval: 1s
snapshot:
  interval: 24h
  retention: 168h
shutdown-sync-timeout: 30s
shutdown-sync-interval: 500ms
dbs:
  - path: $db_path
    replica:
      type: s3
      bucket: $r2_bucket
      path: $replica_path
      endpoint: https://$r2_host
      region: $r2_region
EOF
  chmod 600 "$litestream_config"
  export LITESTREAM_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
  export LITESTREAM_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
  echo "Litestream will restore and replicate $db_path to s3://$r2_bucket/$replica_path"
fi

# Keep the checked-in config/plugin bundle available even when the workdir is a
# mounted Render disk or a local Docker volume.
cp -R /opt/opencode-config/. "$workdir"/
cd "$workdir"

echo "Starting OpenCode v2 on 127.0.0.1:${internal_port}"
echo "Starting public proxy on 0.0.0.0:${public_port}"
if [ "$litestream_enabled" = "1" ]; then
  litestream replicate \
    -config "$litestream_config" \
    -restore-if-db-not-exists \
    -exec "opencode serve --hostname 127.0.0.1 --port $internal_port" &
  server_pid=$!
else
  opencode serve --hostname 127.0.0.1 --port "$internal_port" &
  server_pid=$!
fi

proxy_pid=""
api_proxy_pid=""

nginx -c "$proxy_config" -g "daemon off;" &
proxy_pid=$!

if [ "$api_port" != "$public_port" ]; then
  socat "TCP-LISTEN:${api_port},bind=0.0.0.0,reuseaddr,fork" "TCP:127.0.0.1:${internal_port}" &
  api_proxy_pid=$!
fi

cleanup() {
  kill "$server_pid" "$proxy_pid" ${api_proxy_pid:-} 2>/dev/null || true
}
trap cleanup INT TERM EXIT

status=0
set +e
while :; do
  if ! kill -0 "$server_pid" 2>/dev/null; then
    wait "$server_pid"
    status=$?
    break
  fi
  if ! kill -0 "$proxy_pid" 2>/dev/null; then
    wait "$proxy_pid"
    status=$?
    break
  fi
  sleep 1
done
set -e
exit "$status"
