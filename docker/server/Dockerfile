FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy server source
COPY . .

EXPOSE 3001

CMD ["node", "index.js"]
