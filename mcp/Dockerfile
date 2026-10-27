# The MCP server as its own container, for a host where each person's Claude reaches it through
# a Unix socket instead of running it: src/socket.js listens on $MCP_SOCKET and starts one stdio
# server per connection, which ends when the connection closes. Build from the repository root, since
# the tools run the app's own frontend/src/lib code:
#   docker build -f mcp/Dockerfile -t opengym-mcp .
# docs: mcp/README.md, "Running it as a container".
FROM node:22-alpine
WORKDIR /app
COPY frontend/package.json frontend/
COPY frontend/src/lib frontend/src/lib
COPY mcp/package.json mcp/package-lock.json mcp/
RUN cd mcp && npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY mcp/src mcp/src
ENV NODE_ENV=production MCP_SOCKET=/run/mcp/mcp.sock
USER node
CMD ["node", "/app/mcp/src/socket.js"]
