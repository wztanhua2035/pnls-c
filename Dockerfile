FROM node:22-alpine
WORKDIR /app
COPY . .
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data
RUN apk add --no-cache su-exec && mkdir -p /data && chown -R node:node /app
EXPOSE 3000
CMD ["sh", "-c", "chown -R node:node /data && exec su-exec node node server.js"]
