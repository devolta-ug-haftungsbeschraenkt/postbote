# syntax=docker/dockerfile:1
# postbote — multi-stage, non-root (Bauplan §5)

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Production dependencies only — keeps the runtime image small.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    POSTBOTE_HOST=0.0.0.0 \
    POSTBOTE_PORT=3000
RUN addgroup -S postbote && adduser -S -G postbote postbote
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY migrations ./migrations
COPY docker/healthcheck.mjs ./healthcheck.mjs
USER postbote
EXPOSE 3000 2525 587
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=5 \
  CMD ["node", "/app/healthcheck.mjs"]
CMD ["node", "dist/index.js"]
