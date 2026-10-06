FROM node:24.13.1-bookworm-slim AS dependencies
WORKDIR /app
RUN npm install --global pnpm@11.10.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY patches ./patches
COPY packages ./packages
COPY infra/relay/package.json ./infra/relay/package.json
# Preserve workspace symlinks: Node can execute their TypeScript sources directly.
RUN pnpm install --frozen-lockfile --ignore-scripts --filter t3code-relay...
COPY infra/relay ./infra/relay

FROM node:24.13.1-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=dependencies --chown=node:node /app /app
USER node
EXPOSE 8080
ENTRYPOINT ["node", "infra/relay/src/cluster/main.ts"]
CMD ["serve"]
