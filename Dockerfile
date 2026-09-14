# syntax=docker/dockerfile:1.7

# Install the plugin's runtime dependencies separately because the official
# OpenCode image contains the compiled CLI, not a Bun package manager.
# bun.lock uses the v2 lockfile format emitted by Bun 1.4.x.
FROM oven/bun:1.4.0-alpine AS plugin-deps
WORKDIR /opt/opencode-config/.opencode
COPY .opencode/package.json .opencode/bun.lock ./
RUN bun install --frozen-lockfile --production

# Litestream is copied from the official static image so it can supervise
# OpenCode and replicate the SQLite WAL without adding a second runtime stack.
FROM litestream/litestream:0.5.16-scratch AS litestream

# OpenCode publishes versioned v2 images. Pin the multi-architecture manifest
# so a rebuild cannot silently move to a different release.
FROM ghcr.io/anomalyco/opencode:2.0.3@sha256:aaf8c5420e10652c520e068532384f6e20cece2922c404db7f89e36720b9f212

USER root

# socat keeps one OpenCode process (and therefore one database/event bus) while
# making the same HTTP/WebSocket server available on two container ports.
RUN apk add --no-cache ca-certificates git socat \
  && addgroup -S opencode \
  && adduser -S -G opencode -h /var/lib/opencode opencode \
  && mkdir -p /var/lib/opencode /opt/opencode-config \
  && chown -R opencode:opencode /var/lib/opencode /opt/opencode-config

COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/opencode-render-entrypoint
COPY --from=litestream /usr/local/bin/litestream /usr/local/bin/litestream
COPY opencode.jsonc /opt/opencode-config/opencode.jsonc
COPY --from=plugin-deps --chown=opencode:opencode /opt/opencode-config/.opencode/node_modules /opt/opencode-config/.opencode/node_modules
COPY --chown=opencode:opencode .opencode/package.json .opencode/bun.lock /opt/opencode-config/.opencode/
COPY --chown=opencode:opencode .opencode/plugins /opt/opencode-config/.opencode/plugins

ENV HOME=/var/lib/opencode \
  XDG_DATA_HOME=/var/lib/opencode \
  XDG_CONFIG_HOME=/var/lib/opencode/config \
  XDG_STATE_HOME=/var/lib/opencode/state \
  OPENCODE_DB=/var/lib/opencode/opencode.db \
  OPENCODE_INTERNAL_PORT=4096 \
  OPENCODE_WORKDIR=/var/lib/opencode/workspace \
  PORT=3000 \
  API_PORT=4097

EXPOSE 3000 4097

USER opencode
ENTRYPOINT ["/usr/local/bin/opencode-render-entrypoint"]
