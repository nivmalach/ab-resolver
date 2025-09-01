FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production || npm i --production
COPY . .
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["npm","start"]
