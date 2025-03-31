# Use a minimal Node.js image
FROM node:20-alpine 

# Set working directory inside the container
WORKDIR /app

# Copy package.json and package-lock.json first for caching
COPY package.json package-lock.json ./

# Install only production dependencies
RUN npm install --only=production

# Copy the rest of the code
COPY . .

# Expose the dynamic port Render assigns
EXPOSE 3000 

# Start the server
CMD ["node", "api/index.js"]
