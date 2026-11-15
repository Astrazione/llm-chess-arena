FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
RUN mkdir -p /app/dist && chown -R node:node /app
USER node
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM dependencies AS development
COPY --chown=node:node . .
EXPOSE 5173
CMD ["node", "node_modules/vite/bin/vite.js"]

FROM development AS build
RUN npm run build

FROM development AS browser-tests
USER root
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
RUN npx playwright install --with-deps chromium && chmod -R a+rX /opt/playwright
USER node
