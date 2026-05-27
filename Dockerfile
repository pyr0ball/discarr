# Discarr: disc scanning and encoding queue
# ffmpeg/ffprobe: VIDEO_TS/BDMV metadata scanning and HEVC encode dispatch
# openssh-client: remote encode dispatch to SSH transcode workers
#
# Base: node:22-bookworm-slim (Debian bookworm)
# Debian's security team backports ffmpeg CVE patches to 5.1.x; Alpine's
# community ffmpeg package has had several high CVEs open for 12+ months.
#
# HandBrake is NOT included — ffmpeg handles encoding by default.
# For HandBrake presets or forced-subtitle burn-in, use:
#   pyr0ball/discarr:handbrake  (or build from Dockerfile.handbrake)
#   Or install natively: sudo bash install.sh

FROM node:22-bookworm-slim

# Install ffmpeg and openssh-client, then clean apt lists
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        ffmpeg \
        openssh-client && \
    rm -rf /var/lib/apt/lists/*

# Update npm to patch bundled tar/minimatch CVEs
RUN npm install -g npm@latest && npm cache clean --force

WORKDIR /app
COPY server.js scanner.js ./
COPY public/ ./public/

EXPOSE 8603
CMD ["node", "server.js"]
