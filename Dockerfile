FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/tsconfig.json ./packages/contracts/
COPY apps/server/package.json apps/server/tsconfig.json ./apps/server/
COPY apps/web/package.json apps/web/tsconfig.json apps/web/tsconfig.node.json ./apps/web/
COPY apps/telegram-adapter/package.json apps/telegram-adapter/tsconfig.json ./apps/telegram-adapter/
RUN npm install

COPY packages/contracts ./packages/contracts
COPY apps/server ./apps/server
COPY apps/web ./apps/web
COPY apps/telegram-adapter ./apps/telegram-adapter
RUN npm run build -w @autofilm/contracts \
    && npm run test -w @autofilm/server -- --run
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    AUTOFILM_HOST=0.0.0.0 \
    AUTOFILM_PORT=3100 \
    AUTOFILM_DATA_DIR=/data
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      fontconfig fonts-dejavu-core p7zip-full unzip unrar-free \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --create-home autofilm \
    && mkdir -p /data \
    && chown autofilm:autofilm /data

COPY --from=build --chown=autofilm:autofilm /app/package.json /app/package-lock.json ./
COPY --from=build --chown=autofilm:autofilm /app/node_modules ./node_modules
COPY --from=build --chown=autofilm:autofilm /app/apps/server/dist ./apps/server/dist
COPY --from=build --chown=autofilm:autofilm /app/apps/server/package.json ./apps/server/package.json
COPY --from=build --chown=autofilm:autofilm /app/apps/web/dist ./apps/web/dist
COPY --from=build --chown=autofilm:autofilm /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build --chown=autofilm:autofilm /app/packages/contracts/package.json ./packages/contracts/package.json

USER autofilm
EXPOSE 3100
CMD ["node", "apps/server/dist/index.js"]
