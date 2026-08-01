FROM node:22-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p /data

CMD ["node", "--experimental-sqlite", "--require", "tsx/cjs", "src/index.ts"]
