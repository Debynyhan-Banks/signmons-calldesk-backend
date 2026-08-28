FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY prisma.config.ts tsconfig.json tsconfig.build.json nest-cli.json ./
COPY scripts ./scripts
RUN npm ci
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/prisma.config.ts ./prisma.config.ts
USER node
CMD ["node", "dist/main"]
