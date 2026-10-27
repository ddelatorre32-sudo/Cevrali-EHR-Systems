FROM node:24-bookworm-slim AS build

WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json package-lock.json ./
# Optional trust material for builders behind an authenticated TLS proxy.
# The secret is available only during this build step and never enters the image.
RUN --mount=type=secret,id=cevrali_build_ca \
    if [ -f /run/secrets/cevrali_build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/cevrali_build_ca; fi; \
    npm ci --include=dev --no-fund

COPY . .
RUN --mount=type=secret,id=cevrali_build_ca \
    if [ -f /run/secrets/cevrali_build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/cevrali_build_ca; fi; \
    npm run build \
    && npm prune --omit=dev --no-fund

FROM node:24-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production \
    CEVRALI_MODE=demo \
    PORT=8080 \
    DATABASE_PATH=/var/lib/cevrali/cevrali.sqlite \
    ACCOUNTS_PATH=/var/lib/cevrali/accounts

# Scanned fax recognition stays local to this service.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates gosu tesseract-ocr tesseract-ocr-eng poppler-utils \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /var/lib/cevrali \
    && chown node:node /var/lib/cevrali

COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/dist-server ./dist-server
COPY --from=build --chown=node:node /app/scripts ./scripts
COPY deploy/docker-entrypoint.sh /usr/local/bin/cevrali-entrypoint
RUN chmod 755 /usr/local/bin/cevrali-entrypoint

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || '8080') + '/api/health', {signal: AbortSignal.timeout(4000)}).then(response => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"

# Prepare a newly mounted disk, then run Node as the unprivileged node user.
ENTRYPOINT ["/usr/local/bin/cevrali-entrypoint"]
CMD ["node", "dist-server/index.js"]
