# Memoria Hub — Phase 7 production image.
#
# Build context is `server/multi/`. The image is intentionally minimal:
# only the multi-server code and its deps (pg, jose, hono, …). Local
# server modules at `../*.js` are never imported.
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json ./
# `npm install` instead of `npm ci` — lockfile lives one level up in the
# monorepo install layout. Phase 7 follow-up will add a dedicated
# `multi/package-lock.json` once the dep set settles.
RUN npm install --omit=dev

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV MEMORIA_HUB_PORT=5280
COPY --from=deps /app/node_modules ./node_modules
COPY . .

EXPOSE 5280

# Tiny health check via /healthz so docker-compose's healthcheck has
# something cheap to hit.
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- http://localhost:${MEMORIA_HUB_PORT}/healthz || exit 1

# `npm start` runs migrations on container start, then boots Hono.
CMD ["sh", "-c", "node migrate.js && node index.js"]
