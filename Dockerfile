# Discarr: disc scanning and encoding queue
# ffmpeg/ffprobe: VIDEO_TS/BDMV metadata scanning and local encode dispatch
# HandBrake: optional HEVC encoder (ffmpeg is the fallback)
# openssh-client: remote encode dispatch to SSH transcode workers

# Node 22 is the current LTS (Node 20 reached EOL 2026-04-30)
FROM node:22-alpine

# Upgrade all base packages to pick up security patches from Alpine before
# adding our own deps. Combining upgrade + add in one RUN avoids an extra
# layer and ensures the package index stays consistent.
RUN apk upgrade --no-cache && \
    apk add --no-cache \
        ffmpeg \
        handbrake \
        openssh-client

# npm's bundled deps (tar, minimatch) carry their own CVE surface.
# Updating to latest npm gets the patched versions.
RUN npm install -g npm@latest && npm cache clean --force

WORKDIR /app
COPY server.js scanner.js ./
COPY public/ ./public/

EXPOSE 8603
CMD ["node", "server.js"]
