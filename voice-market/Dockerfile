FROM node:24-alpine
WORKDIR /app/voice-market
COPY --chown=node:node voice-market/package.json voice-market/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --chown=node:node voice-market/src ./src
COPY --chown=node:node src/moderation.mjs /app/src/moderation.mjs
RUN mkdir -p /data && chown node:node /data
USER node
ENV VOICE_MARKET_PORT=8793 VOICE_MARKET_DATA_DIR=/data
EXPOSE 8793
VOLUME ["/data"]
CMD ["node", "src/server.mjs"]
