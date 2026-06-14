# syntax=docker/dockerfile:1

# ---- shared base ----
FROM node:20-alpine AS base
WORKDIR /app
COPY package.json package-lock.json ./

# ---- dev stage (hot-reload via nodemon) ----
FROM base AS dev
ENV NODE_ENV=development
RUN npm install
COPY src ./src
USER node
EXPOSE 8080
CMD ["npm", "run", "dev"]

# ---- build stage (production deps only) ----
FROM base AS build
RUN npm ci --omit=dev

# ---- minimal runtime ----
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
USER node
EXPOSE 8080
CMD ["node", "src/server.js"]