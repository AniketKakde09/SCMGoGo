# ---------- Build stage ----------
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci

COPY . .

RUN npm run build


# ---------- Runtime stage ----------
FROM nginx:1.27-alpine AS runtime

# Remove default configuration
RUN rm -f /etc/nginx/conf.d/default.conf

# Copy our complete nginx configuration
COPY nginx.conf /etc/nginx/nginx.conf

# Copy only production files
COPY --from=builder /app/dist /usr/share/nginx/html

# Make application files readable by nginx
RUN chown -R nginx:nginx /usr/share/nginx/html

# Non-root container
USER nginx

EXPOSE 5173

CMD ["nginx", "-g", "daemon off;"]