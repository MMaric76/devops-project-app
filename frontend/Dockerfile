# syntax=docker/dockerfile:1

FROM node:20-alpine AS base
WORKDIR /app
COPY package.json package-lock.json ./

FROM base AS dev
ENV NODE_ENV=development
RUN npm install
COPY src ./src
USER node
EXPOSE 3000
CMD ["npm", "run", "dev"]

FROM base AS build
RUN npm ci --omit=dev

FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
USER node
EXPOSE 3000
CMD ["node", "src/server.js"]