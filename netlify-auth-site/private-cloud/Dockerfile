FROM node:22-alpine
ENV NODE_ENV=production \
    ARVIO_PRIVATE_CLOUD=true \
    HOST=0.0.0.0 \
    PORT=3000
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY netlify/functions ./netlify/functions
COPY private-cloud ./private-cloud
EXPOSE 3000
USER node
CMD ["node", "private-cloud/server.js"]
