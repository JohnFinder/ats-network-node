FROM node:24-bookworm-slim
WORKDIR /services
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY src ./src
COPY scripts ./scripts
RUN mkdir -p /data && chown node:node /data
USER node
ENV SERVICE_DATA_DIR=/data SERVICE_PORT=8790
EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD node -e "fetch('http://127.0.0.1:'+process.env.SERVICE_PORT+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "src/main.mjs"]
