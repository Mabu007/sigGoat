# Cloud Run runtime for SIRGOAT scheduled execution.
# Build the same tested Node application that owns the GOAT wake pipeline.
FROM node:22-slim

ENV NODE_ENV=production \
    SIRGOAT_SCHEDULER_ONLY=true
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --include=dev

COPY . .
RUN npm run build

ENV PORT=8080
EXPOSE 8080

# server.ts mounts the existing API router, including the authenticated
# /api/internal/cron endpoint. Cloud Run IAM restricts invocation to Scheduler.
CMD ["npm", "run", "start:scheduler"]
