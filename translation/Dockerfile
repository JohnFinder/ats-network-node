FROM node:24-alpine
ENV NODE_ENV=production TRANSLATION_PORT=8792
WORKDIR /app
COPY --chown=node:node src ./src
USER node
EXPOSE 8792
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:8792/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.mjs"]
