# Discarr — disc scanning and encoding queue
# ffmpeg/ffprobe included for VIDEO_TS/BDMV metadata scanning
# Encoding is dispatched via SSH to a remote host (e.g. Strahl)
FROM node:20-alpine

RUN apk add --no-cache ffmpeg openssh-client handbrake

WORKDIR /app
COPY server.js scanner.js ./
COPY public/ ./public/

EXPOSE 8603
CMD ["node", "server.js"]
