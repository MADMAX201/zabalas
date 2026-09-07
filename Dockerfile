FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production TZ=America/Bogota
COPY package*.json ./
RUN apk add --no-cache tzdata && npm ci --omit=dev
COPY src ./src
COPY public ./public
RUN mkdir -p /app/data/uploads
VOLUME ["/app/data"]
EXPOSE 3000
CMD ["node", "src/server.js"]
