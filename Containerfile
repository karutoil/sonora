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
COPY scripts ./scripts
RUN chmod +x scripts/container-entrypoint.sh

# The data dir is a bind mount in compose; creating it here means the app can
# also run without one. Rootless podman maps container root to the host user,
# so files written here stay owned by whoever runs the container.
RUN mkdir -p /app/data/audio

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD ["node", "scripts/healthcheck.js"]

EXPOSE 8130

ENTRYPOINT ["/usr/bin/tini", "--", "/app/scripts/container-entrypoint.sh"]
CMD ["node", "--no-warnings", "src/server.js"]
