FROM node:20-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

# Copy dependency manifests first to maximize layer cache reuse.
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

# Copy the application source after dependencies are installed.
COPY app.js ./
COPY server.js ./
COPY public ./public

EXPOSE 3000

CMD ["npm", "start"]
