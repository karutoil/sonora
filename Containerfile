# sonora — production image.
#
# Three things the app needs beyond Node, all measured on the dev host:
#   * yt-dlp      — the only client allowed to fetch a whole audio file
#   * ffmpeg      — yt-dlp downloads from the visionos client as m3u8
#   * a JS runtime— yt-dlp 2026.x solves YouTube's JS challenges with node
#
# yt-dlp lives in its own venv (mirroring ~/.local/share/sonora-venv on the host)
# so the system Python is never touched, and the bgutil plugin is installed
# alongside it because yt-dlp auto-loads plugins from site-packages.
FROM docker.io/library/node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      ffmpeg \
      python3 \
      python3-venv \
      tini \
 && rm -rf /var/lib/apt/lists/*

RUN python3 -m venv /opt/ytdlp \
 && /opt/ytdlp/bin/pip install --no-cache-dir --upgrade pip \
 && /opt/ytdlp/bin/pip install --no-cache-dir yt-dlp bgutil-ytdlp-pot-provider \
 && ln -sf /opt/ytdlp/bin/yt-dlp /usr/local/bin/yt-dlp \
 && yt-dlp --version

WORKDIR /app

# Dependencies first: this layer is cached until the lockfile changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public
# Only the two runtime entrypoints belong in the production image; admin,
# icon-generation and source-checking utilities stay in the source checkout.
COPY scripts/container-entrypoint.sh scripts/healthcheck.js ./scripts/
# Source directories are non-secret public/runtime code. A developer's editor or
# atomic file replacement can leave a checked-out file at 0600; COPY preserves
# that mode, after which USER node cannot import server.js or serve app.js. Make
# the contract explicit instead of allowing one local umask to break the image.
RUN chmod 0644 package.json package-lock.json \
 && chmod -R a+rX src public scripts \
 && chmod +x scripts/container-entrypoint.sh

# The data dir is a bind mount in compose; creating it here means the app can
# also run without one. It is created as and owned by the runtime user (below) so
# a fresh volume needs no chown at boot, which matters because a chown would need
# root and the entrypoint deliberately runs unprivileged.
RUN mkdir -p /app/data/audio && chown -R node:node /app/data

# ── run unprivileged ────────────────────────────────────────────────────────
#
# Everything below runs as the image's own `node` user (uid 1000, gid 1000), not
# as root. Two things happen as root otherwise, and both are silent:
#
#   * A root container writes data/sonora.db, its -wal sibling, the 0600
#     youtube-cookies.txt and every cached track as root:root on the host. The
#     developer's next `npm start` then cannot open the database for writing
#     (SQLITE_CANTOPEN / "attempt to write a readonly database") and cannot
#     delete or back up the files without sudo — which breaks the "share ./data
#     between the container and the dev server" workflow compose.yaml promises,
#     and reads like a corrupt database rather than a permissions problem.
#   * yt-dlp and ffmpeg parse remote, attacker-influenced data (m3u8 manifests,
#     fragmented MP4/WebM from a third party). Neither needs a privilege, so
#     neither gets one.
#
# 1000 is a contract with the bind mount, not an implementation detail: Docker
# needs ./data writable by uid/gid 1000. For rootless podman, compose.podman.yaml
# maps this identity to the invoking host account (the default mapping would use a
# subuid instead). README.md covers repairing data owned by an older root container.
#
# HOME is set explicitly because yt-dlp caches format info and JS-challenge
# results under it; inherited as /root it is unwritable for this user.
ENV HOME=/home/node
USER node:node

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD ["node", "scripts/healthcheck.js"]

EXPOSE 8130

ENTRYPOINT ["/usr/bin/tini", "--", "/app/scripts/container-entrypoint.sh"]
CMD ["node", "--no-warnings", "src/server.js"]
