FROM node:22-alpine

WORKDIR /app
COPY docker/egress-proxy/proxy.mjs ./proxy.mjs

ENV EGRESS_PROXY_PORT=3128
EXPOSE 3128

CMD ["node", "proxy.mjs"]
