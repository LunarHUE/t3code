FROM node:26.12.1-bookworm-slim AS dependencies
WORKDIR /app
RUN npm install --global pnpm@12.14.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .pnpmfile.cjs tsconfig.base.json ./
COPY patches ./patches
COPY packages ./packages
COPY infra/relay/package.json ./infra/relay/package.json
# Preserve workspace symlinks: Node can execute their TypeScript sources directly.
RUN pnpm install --frozen-lockfile --ignore-scripts --filter t3code-relay...
COPY infra/relay ./infra/relay

FROM node:26.12.1-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=dependencies --chown=node:node /app /app
USER node
EXPOSE 8080
ENTRYPOINT ["node", "infra/relay/src/cluster/main.ts"]
CMD ["serve"]
