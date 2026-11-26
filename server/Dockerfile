# Build context is the REPOSITORY ROOT (Railway: RAILWAY_DOCKERFILE_PATH=server/Dockerfile).
# Copies only shared/, server/ and dashboard/; the extension sources never enter the image.
FROM node:24-alpine AS build
WORKDIR /repo
COPY shared ./shared
COPY server/package.json server/package-lock.json ./server/
COPY dashboard/package.json dashboard/package-lock.json ./dashboard/
RUN npm ci --prefix server && npm ci --prefix dashboard
COPY server ./server
COPY dashboard ./dashboard
RUN npm run build --prefix dashboard && npm run build --prefix server

# The server is a single esbuild bundle: no node_modules at runtime.
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /repo/server/dist ./dist
COPY --from=build /repo/server/migrations ./migrations
COPY --from=build /repo/dashboard/dist ./public
USER node
EXPOSE 8787
# Railway sets PORT; pre-deploy runs `node dist/migrate.js`, start is `node dist/index.js`.
CMD ["node", "dist/index.js"]
