FROM node:20-alpine

# psql + pg_dump for the IT page's backup restore (it runs the dump through
# psql, and takes a safety dump first). Must match the Postgres major version
# in pod.yaml — postgres:16-alpine.
RUN apk add --no-cache postgresql16-client

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3000

CMD ["node", "src/server.js"]
