# Discarr: disc scanning and encoding queue
# ffmpeg/ffprobe: VIDEO_TS/BDMV metadata scanning and HEVC encode dispatch
# openssh-client: remote encode dispatch to SSH transcode workers
#
# HandBrake is NOT included in this image — ffmpeg handles encoding by default.
# If you need HandBrake (preset system, forced-subtitle burn-in), use the
# handbrake variant: pyr0ball/discarr:handbrake
# Or install HandBrake natively via: sudo bash install.sh

# Node 22 is the current LTS (Node 20 reached EOL 2026-04-30)
FROM node:22-alpine

# Upgrade all base packages first to pick up Alpine security patches,
# then add runtime dependencies in the same layer.
RUN apk upgrade --no-cache && \
    apk add --no-cache \
        ffmpeg \
        openssh-client

# Update npm to patch bundled tar/minimatch CVEs
RUN npm install -g npm@latest && npm cache clean --force

WORKDIR /app
COPY server.js scanner.js ./
COPY public/ ./public/

EXPOSE 8603
CMD ["node", "server.js"]
