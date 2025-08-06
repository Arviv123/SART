# Use official Node.js runtime as base image
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application code
COPY . .

# Create servers directory
RUN mkdir -p servers

# Expose port
EXPOSE 10000

# Set environment variables
ENV NODE_ENV=production
ENV PORT=10000
ENV API_KEY=your-super-secret-api-key-123

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:10000/health || exit 1

# Start the application
CMD ["node", "server.js"]