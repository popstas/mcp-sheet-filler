# Stage 1: Build
FROM node:20-alpine AS builder

# Install build dependencies for better-sqlite3
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including devDependencies for build)
RUN npm ci

# Copy source code
COPY tsconfig.json ./
COPY src ./src

# Build TypeScript
RUN npm run build

# Stage 2: Production
FROM node:20-alpine AS production

# Install runtime dependencies for better-sqlite3
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev && \
    # Clean up build tools after native module compilation
    apk del python3 make g++ && \
    rm -rf /root/.npm /tmp/*

# Copy built application
COPY --from=builder /app/dist ./dist

# Create directory for SQLite data
RUN mkdir -p /data

# Environment defaults
ENV TRANSPORT=http \
    PORT=3000 \
    HOST=0.0.0.0 \
    STORAGE_BACKEND=sqlite \
    SQLITE_PATH=/data/filler.db

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

# Run the server
CMD ["node", "dist/index.js"]
