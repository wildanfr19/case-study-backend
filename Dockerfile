FROM node:20-alpine AS base
WORKDIR /usr/src/app

# Install deps separately for better caching
COPY package*.json ./
RUN npm install --only=production && npm cache clean --force

COPY . .

ENV NODE_ENV=production \
    PORT=3000

EXPOSE 3000
CMD ["node", "index.js"]
