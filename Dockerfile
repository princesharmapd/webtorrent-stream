# Use a minimal Node.js image
FROM node:20-alpine 

# Set working directory inside the container
WORKDIR /app

# Copy package.json and package-lock.json first (for efficient caching)
COPY package.json package-lock.json ./

# Install only production dependencies
RUN npm install --only=production

# Copy the entire API folder
COPY api ./api

# Expose the necessary port
EXPOSE 3000

# Start the Express server
CMD ["node", "api/index.js"]
