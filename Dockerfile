FROM node:20-slim

RUN apt-get update && apt-get install -y python3 make g++ libopus-dev && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

CMD ["node", "index.js"]
