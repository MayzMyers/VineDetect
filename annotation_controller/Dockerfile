FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src

EXPOSE 9000
CMD ["node", "src/server.js"]
