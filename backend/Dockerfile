FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
RUN mkdir -p /app/dist && chown -R node:node /app
USER node
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM dependencies AS development
USER root
RUN mkdir -p /data/experiments && chown -R node:node /data
USER node
COPY --chown=node:node . .
EXPOSE 3000
CMD ["node", "node_modules/nodemon/bin/nodemon.js"]

FROM development AS build
RUN npm run build
