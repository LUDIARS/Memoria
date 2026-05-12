# Memoria Hub — Phase 7 production image.
#
# `@ludiars/cernere-service-adapter` is declared as a file: dep pointing at
#   ../../../Cernere/packages/service-adapter
# which is outside the docker build context (server/multi/). The previous
# Dockerfile silently produced an image without the adapter installed, so the
# container crashed with:
#   ERR_MODULE_NOT_FOUND '@ludiars/cernere-service-adapter'
#
# Fix: sparse-clone LUDIARS/Cernere in a build stage and materialize the
# adapter at the relative path the package.json points to.

FROM node:20-alpine AS adapter-fetch
RUN apk add --no-cache git
WORKDIR /tmp
RUN git clone --depth 1 --filter=blob:none --sparse https://github.com/LUDIARS/Cernere.git
WORKDIR /tmp/Cernere
# Both file: deps used by Memoria Hub:
#   @ludiars/cernere-service-adapter  -> packages/service-adapter
#   @ludiars/cernere-id-cache         -> packages/id-cache
RUN git sparse-checkout set packages/service-adapter packages/id-cache

FROM node:20-alpine AS deps
WORKDIR /app
# package.json references `file:../../../Cernere/packages/*`.
# Resolved from /app, that points to /Cernere/packages/*.
COPY --from=adapter-fetch /tmp/Cernere/packages/service-adapter /Cernere/packages/service-adapter
COPY --from=adapter-fetch /tmp/Cernere/packages/id-cache /Cernere/packages/id-cache
COPY package.json ./
RUN npm install --omit=dev

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV MEMORIA_HUB_PORT=5280
# npm install made symlinks `@ludiars/* -> ../../../Cernere/packages/*` in
# node_modules. The link targets must also exist in the production image.
COPY --from=adapter-fetch /tmp/Cernere/packages/service-adapter /Cernere/packages/service-adapter
COPY --from=adapter-fetch /tmp/Cernere/packages/id-cache /Cernere/packages/id-cache
COPY --from=deps /app/node_modules ./node_modules
COPY . .

EXPOSE 5280

# Tiny health check via /healthz so docker-compose's healthcheck has
# something cheap to hit.
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- http://localhost:${MEMORIA_HUB_PORT}/healthz || exit 1

# `npm start` runs migrations on container start, then boots Hono.
CMD ["sh", "-c", "node migrate.js && node index.js"]
