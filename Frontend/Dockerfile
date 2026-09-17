# Build stage
FROM node:20-alpine AS builder
WORKDIR /app

# Install dependencies and build
COPY . .
RUN npm install

# Expose port 5173
EXPOSE 5173
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]