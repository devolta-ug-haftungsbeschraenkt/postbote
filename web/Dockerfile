# postbote Admin-UI — static build served by nginx (Bauplan §5, M6)
# Build context is the repository root: `docker compose build` from docker/.
FROM node:22-alpine AS build
WORKDIR /app
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/tsconfig.json web/vite.config.ts web/index.html ./
COPY web/src ./src
COPY web/public ./public
RUN npm run build

FROM nginx:1.27-alpine AS runtime
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY docker/ui-entrypoint.sh /docker-entrypoint.d/40-postbote-config.sh
COPY --from=build /app/dist /usr/share/nginx/html
RUN chmod +x /docker-entrypoint.d/40-postbote-config.sh
EXPOSE 80
