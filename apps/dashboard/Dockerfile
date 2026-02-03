FROM node:22-alpine AS build

WORKDIR /app
COPY . .

ENV CI=true
RUN corepack enable && corepack prepare pnpm@latest --activate
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @agent-os/dashboard build

FROM nginx:alpine

COPY --from=build /app/apps/dashboard/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
