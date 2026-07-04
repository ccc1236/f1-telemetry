FROM node:22-slim AS base
RUN corepack enable && corepack prepare pnpm@10 --activate
WORKDIR /app

COPY pnpm-lock.yaml package.json pnpm-workspace.yaml ./
COPY core/package.json core/
COPY apps/backend/package.json apps/backend/
COPY apps/frontend/package.json apps/frontend/

# Flat hoist avoids broken .bin symlinks in pnpm's virtual store
RUN echo "shamefully-hoist=true" > .npmrc && pnpm install --no-frozen-lockfile --prod=false

COPY core/ core/
COPY apps/backend/ apps/backend/

# Prepend root node_modules/.bin to PATH so all hoisted binaries resolve correctly
ENV PATH="/app/node_modules/.bin:$PATH"

RUN tsc --project core/tsconfig.json && \
    tsc --project apps/backend/tsconfig.json && \
    tsc-alias --project apps/backend/tsconfig.json

# --- Production stage ---
FROM node:22-slim AS production
WORKDIR /app

COPY --from=base /app/node_modules node_modules
COPY --from=base /app/core/dist core/dist
COPY --from=base /app/core/package.json core/
COPY --from=base /app/apps/backend/dist apps/backend/dist
COPY --from=base /app/apps/backend/package.json apps/backend/
COPY --from=base /app/package.json .

ENV PORT=8080
EXPOSE 8080

CMD ["node", "apps/backend/dist/src/index.js"]
