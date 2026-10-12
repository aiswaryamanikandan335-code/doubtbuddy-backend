FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY start.js ./

USER node
# start.js unlocks the keys with DOUBTBUDDY_SECRET, then starts src/server.js
CMD ["node", "start.js"]
