# syntax=docker/dockerfile:1
FROM node:24.12.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# The generic host: the A2A adapter as PID 1, and pi, which it starts once per context.
FROM node:24.12.0-bookworm-slim
ENV NODE_ENV=production
# What pi's own container recipe installs: a shell and git for its tools, ripgrep for search, CA certificates.
RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates git ripgrep \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.87.1 \
  && npm cache clean --force
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist/src ./dist/src
# The fraction-agents Pi package (ADR 0008). Agents load it by this path from their settings, so its version is
# the image's. Its TypeScript runs as is: pi loads the extensions, and node runs the workspace command.
COPY pi-package/package.json /opt/fraction-agents/pi-package/package.json
COPY pi-package/extensions /opt/fraction-agents/pi-package/extensions
COPY pi-package/lib /opt/fraction-agents/pi-package/lib
COPY pi-package/bin /opt/fraction-agents/pi-package/bin
# Mount points for the host's data (tasks, sessions, pi's working directory) and pi's agent directory.
# A new volume inherits this ownership and mode, so the unprivileged user can write without running as root.
RUN mkdir -p /data /agent \
  && chown node:node /data /agent \
  && chmod 700 /data /agent
USER node
EXPOSE 8080
ENTRYPOINT ["node", "/app/dist/src/main.js"]
CMD ["--config", "/etc/fraction-agents/config.json"]
