FROM node:24-bookworm-slim
WORKDIR /contracts
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --omit=optional --no-audit --no-fund && npm cache clean --force
COPY src ./src
COPY scripts ./scripts
RUN node scripts/compile.mjs && chown -R node:node /contracts
USER node
ENV CHAIN_LISTEN=0.0.0.0
EXPOSE 8545
CMD ["npm", "run", "chain"]
