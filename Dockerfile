# Discarr: disc scanning and encoding queue
# ffmpeg/ffprobe: VIDEO_TS/BDMV metadata scanning and HEVC encode dispatch
# openssh-client: remote encode dispatch to SSH transcode workers
#
# Base: node:22-alpine (Alpine 3.23)
# Alpine's rolling package model ships significantly newer versions than
# Debian stable (bookworm, frozen at June 2023). Key examples:
#   mbedtls: Alpine 3.6.6 (patched) vs Debian bookworm 2.28.3 (unpatched)
#   ffmpeg:  Alpine 8.0.1 vs Debian bookworm 5.1.x
#
# HandBrake is NOT included — ffmpeg handles encoding by default.
# For HandBrake presets or forced-subtitle burn-in:
#   pyr0ball/discarr:handbrake  (or build from Dockerfile.handbrake)

FROM node:22-alpine

# Upgrade all packages to pick up any in-branch security patches,
# then add runtime deps in the same layer.
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
