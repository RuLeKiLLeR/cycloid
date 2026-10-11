// Simple HTTPS reverse proxy for local Slack OAuth testing.
// Slack requires HTTPS callback URLs -- this proxies https://localhost:3443 → http://localhost:3000.

import { createServer } from "node:https";
import { request as httpRequest } from "node:http";
import { readFileSync } from "node:fs";

const PORT = parseInt(process.env.SSL_PROXY_PORT || "3443");
const TARGET = parseInt(process.env.SSL_PROXY_TARGET || "3000");
const TIMEOUT_MS = parseInt(process.env.SSL_PROXY_TIMEOUT_MS || "30000");

let key, cert;
try {
  key = readFileSync("certs/localhost-key.pem");
  cert = readFileSync("certs/localhost.pem");
} catch {
  console.error("SSL certs not found. Run: bash scripts/setup-ssl-certs.sh");
  process.exit(1);
}

function sendError(clientRes, status, message) {
  if (clientRes.headersSent || clientRes.writableEnded) return;
  clientRes.writeHead(status);
  clientRes.end(message);
}

const server = createServer({ key, cert }, (clientReq, clientRes) => {
  const proxyReq = httpRequest(
    {
      hostname: "localhost",
      port: TARGET,
      path: clientReq.url,
      method: clientReq.method,
      headers: clientReq.headers,
    },
    (proxyRes) => {
      proxyRes.on("error", (err) => {
        console.error("Upstream response error:", err.message);
        sendError(clientRes, 502, "Bad Gateway");
      });
      clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(clientRes);
    },
  );
  proxyReq.setTimeout(TIMEOUT_MS, () => {
    proxyReq.destroy(new Error(`Upstream timeout after ${TIMEOUT_MS}ms`));
    sendError(clientRes, 504, "Gateway Timeout");
  });
  proxyReq.on("error", (err) => {
    console.error("Proxy error:", err.message);
    sendError(clientRes, 502, "Bad Gateway");
  });
  clientReq.on("error", (err) => {
    console.error("Client request error:", err.message);
    proxyReq.destroy(err);
  });
  clientReq.on("aborted", () => {
    proxyReq.destroy(new Error("Client aborted request"));
  });
  clientReq.pipe(proxyReq);
});

server.listen(PORT, () => {
  console.log(`SSL proxy: https://localhost:${PORT} → http://localhost:${TARGET}`);
});
