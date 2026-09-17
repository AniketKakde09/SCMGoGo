# Build stage
FROM node:20-alpine AS builder
WORKDIR /app

# Install dependencies and build
COPY package*.json ./
RUN npm ci --quiet
COPY . .
RUN npm run build

# Production stage: serve static files with nginx
FROM nginx:stable-alpine
# Remove default nginx html and copy built assets
RUN rm -rf /usr/share/nginx/html/*
COPY --from=builder /app/dist /usr/share/nginx/html

# Expose port 80
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
