# Production image for the Node.js GraphQL API.
FROM node:22-slim

# Prisma needs openssl at runtime to talk to its query engine.
RUN apt-get update && apt-get install -y openssl ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first (better layer caching). Includes devDeps because we run via tsx.
COPY package*.json ./
RUN npm install

# App source + Prisma schema, then generate the typed client for THIS platform (linux).
COPY . .
RUN npx prisma generate

EXPOSE 4000
# The compose file overrides this to also run `prisma db push` on start.
CMD ["npm", "run", "start"]
