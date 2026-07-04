FROM node:22-slim AS base
RUN corepack enable && corepack prepare pnpm@10.10.0 --activate
WORKDIR /app

COPY pnpm-lock.yaml package.json pnpm-workspace.yaml ./
COPY core/package.json core/
COPY apps/backend/package.json apps/backend/
COPY apps/frontend/package.json apps/frontend/

# Flat hoist avoids broken .bin symlinks in pnpm's virtual store
RUN echo "shamefully-hoist=true" > .npmrc && pnpm install --no-frozen-lockfile --prod=false

COPY core/ core/
COPY apps/frontend/ apps/frontend/

# Prepend root node_modules/.bin to PATH so all hoisted binaries resolve correctly
ENV PATH="/app/node_modules/.bin:$PATH"

RUN tsc --project core/tsconfig.json

ENV NEXT_PUBLIC_API_URL=http://localhost:8090
ENV NEXT_PUBLIC_WS_URL=ws://localhost:8090/ws

RUN cd apps/frontend && next build

# --- Production stage ---
FROM node:22-slim AS production
WORKDIR /app

COPY --from=base /app/apps/frontend/.next/standalone ./
COPY --from=base /app/apps/frontend/.next/static apps/frontend/.next/static
COPY --from=base /app/apps/frontend/public apps/frontend/public

ENV PORT=3100
EXPOSE 3100

CMD ["node", "apps/frontend/server.js"]
