FROM node:24-bookworm-slim
WORKDIR /storage
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY src ./src
COPY scripts ./scripts
USER node
ENTRYPOINT ["node", "src/cli.mjs"]
CMD ["help"]
