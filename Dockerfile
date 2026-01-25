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
WORKDIR /app

ENV TRANSPORT=http \
    PORT=3000 \
    HOST=0.0.0.0 \
    NODE_ENV=production

# Ставим prod deps
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Копируем билд и сразу выставляем владельца на node
COPY --from=builder --chown=node:node /app/dist ./dist

# Если приложению нужно писать под /app (токены/кэш/конфиги) — это критично:
RUN chown -R node:node /app

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

USER node
CMD ["node", "dist/index.js"]
