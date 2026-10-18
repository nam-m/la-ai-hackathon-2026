# Family app: built with Vite, served by nginx, which also proxies the API to the server container (nginx.conf),
# so the browser talks to one origin and VITE_API_URL stays empty.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Baked in at build time: rebuild after changing it.
ARG VITE_WEARER_NAME=Rose
ENV VITE_WEARER_NAME=$VITE_WEARER_NAME
RUN npm run build

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
# 127.0.0.1, not localhost: nginx.conf listens on IPv4 only, and wget would try ::1 first.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
