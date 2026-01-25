# Stage 1: Build
FROM node:24-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Stage 2: Production
FROM node:24-alpine AS production
ENV TRANSPORT=http \
    PORT=3000 \
    HOST=0.0.0.0 \
    NODE_ENV=production

# Prep app dir with node ownership to avoid a full tree chown later.
RUN mkdir -p /app && chown node:node /app
WORKDIR /app
USER node

# Ставим prod deps
COPY --chown=node:node package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# Копируем билд и сразу выставляем владельца на node
COPY --from=builder --chown=node:node /app/dist ./dist

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

CMD ["node", "dist/index.js"]
