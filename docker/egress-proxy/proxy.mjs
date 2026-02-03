import http from "node:http";
import https from "node:https";
import net from "node:net";
import { URL } from "node:url";

const port = Number(process.env.EGRESS_PROXY_PORT || 3128);
const allowlist = (process.env.EGRESS_ALLOWED_DOMAINS || "")
  .split(",")
  .map((entry) => entry.trim().toLowerCase())
  .filter(Boolean);
const allowAll = allowlist.length === 0 || allowlist.includes("*");

const log = (level, message, extra = {}) => {
  const payload = { level, message, time: new Date().toISOString(), ...extra };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
};

const isAllowedHost = (host) => {
  if (allowAll) return true;
  const normalized = host.toLowerCase();
  return allowlist.some((domain) => normalized === domain || normalized.endsWith(`.${domain}`));
};

const reject = (res, status, message) => {
  res.writeHead(status, { "content-type": "text/plain" });
  res.end(message);
};

const server = http.createServer((req, res) => {
  const rawUrl = req.url || "";
  let target;
  try {
    target = new URL(rawUrl);
  } catch {
    const hostHeader = req.headers.host;
    if (!hostHeader) {
      reject(res, 400, "Missing host header");
      return;
    }
    try {
      target = new URL(`http://${hostHeader}${rawUrl}`);
    } catch {
      reject(res, 400, "Invalid request URL");
      return;
    }
  }

  const hostname = target.hostname;
  if (!hostname || !isAllowedHost(hostname)) {
    log("warn", "Blocked request", { host: hostname, url: target.toString() });
    reject(res, 403, "Domain blocked by egress policy");
    return;
  }

  const headers = { ...req.headers };
  delete headers["proxy-connection"];
  delete headers["proxy-authorization"];
  headers.host = target.host;

  const client = target.protocol === "https:" ? https : http;
  const proxyReq = client.request(target, {
    method: req.method,
    headers,
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on("error", (error) => {
    log("error", "Proxy request failed", { error: error.message, url: target.toString() });
    reject(res, 502, "Proxy request failed");
  });

  req.pipe(proxyReq);
});

server.on("connect", (req, clientSocket, head) => {
  const target = req.url || "";
  const [host, portValue] = target.split(":");
  const portNumber = Number(portValue || 443);
  if (!host || Number.isNaN(portNumber)) {
    clientSocket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    clientSocket.end();
    return;
  }

  if (!isAllowedHost(host)) {
    log("warn", "Blocked connect", { host });
    clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    clientSocket.end();
    return;
  }

  const upstream = net.connect(portNumber, host, () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head && head.length > 0) {
      upstream.write(head);
    }
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });

  upstream.on("error", (error) => {
    log("error", "Upstream connect failed", { host, error: error.message });
    clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    clientSocket.end();
  });
});

server.on("clientError", (err, socket) => {
  log("error", "Client error", { error: err.message });
  socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});

server.listen(port, () => {
  log("info", "Egress proxy listening", { port, allowlist: allowAll ? "*" : allowlist });
});
