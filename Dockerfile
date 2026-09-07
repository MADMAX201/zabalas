# Etapa 1: instala dependencias (better-sqlite3 necesita compilarse si no hay binario precompilado)
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --omit=dev

# Etapa 2: imagen final, sin herramientas de compilación
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production TZ=America/Bogota
COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY src ./src
COPY public ./public
RUN mkdir -p /app/data/uploads
VOLUME ["/app/data"]
EXPOSE 3000
CMD ["node", "src/server.js"]
