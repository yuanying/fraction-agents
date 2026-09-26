# syntax=docker/dockerfile:1
FROM node:24.12.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# The generic host: the A2A adapter as PID 1, and pi, which it starts once per context.
FROM node:24.12.0-bookworm-slim AS host
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

# The web researcher (ADR 0013): the generic host with a headless browser, the Pi packages that fetch pages and drive
# the browser, and the browser CLI. Built with --target web-researcher; the Wiki keeper's image stays without them.
FROM host AS web-researcher
USER root
# Debian's Chromium, and CJK fonts so that Japanese pages read and screenshot properly.
RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium fonts-noto-cjk \
  && rm -rf /var/lib/apt/lists/*
# The versions are pinned by the lock. Pi provides the packages' peer dependencies (.npmrc: legacy-peer-deps).
WORKDIR /opt/fraction-agents/web-researcher
COPY images/web-researcher/package.json images/web-researcher/package-lock.json images/web-researcher/.npmrc ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
# agent-browser's install script only picks its native binary; pick the one for this machine ourselves, make it
# executable (the package ships it without the bit), and drop the other platforms' binaries.
RUN case "$(uname -m)" in \
      x86_64) binary=agent-browser-linux-x64 ;; \
      aarch64) binary=agent-browser-linux-arm64 ;; \
      *) echo "no agent-browser binary for $(uname -m)" >&2; exit 1 ;; \
    esac \
  && cd node_modules/agent-browser/bin \
  && find . -name 'agent-browser-*' ! -name "$binary" -delete \
  && chmod 755 "$binary" \
  && ln -s "$PWD/$binary" /usr/local/bin/agent-browser
# Chromium's managed policy: no local files (the agent directory holds the login), and no obvious in-cluster names.
COPY images/web-researcher/chromium-policy.json /etc/chromium/policies/managed/web-researcher.json
# The browser CLI's and its Pi package's settings, in the node user's home (pi gets HOME from the host).
COPY --chown=node:node images/web-researcher/agent-browser.json /home/node/.agent-browser/config.json
COPY --chown=node:node images/web-researcher/pi-agent-browser-native.json /home/node/.pi/config/pi-agent-browser-native/config.json
WORKDIR /app
USER node

# The generic host is the default target.
FROM host
