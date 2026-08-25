import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import http from "node:http";
import https from "node:https";

// 用 Node http/https 直连远程 Qdrant，绕过 Vite 内置代理的慢路径
function createQdrantProxy(upstreamUrl: string, apiKey: string) {
  const upstream = new URL(upstreamUrl);
  const mod = upstream.protocol === "https:" ? https : http;

  return (req: any, res: any) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "*");
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }

    const path = req.url.replace(/^\/qdrant/, "");
    const headers: Record<string, string> = {
      host: upstream.host,
      "api-key": apiKey,
    };
    if (req.headers["content-type"]) {
      headers["content-type"] = String(req.headers["content-type"]);
    }
    if (req.headers["content-length"]) {
      headers["content-length"] = String(req.headers["content-length"]);
    }

    const proxyReq = mod.request(
      {
        hostname: upstream.hostname,
        port: upstream.port || (upstream.protocol === "https:" ? 443 : 80),
        path,
        method: req.method,
        headers,
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
        proxyRes.pipe(res);
      },
    );
    proxyReq.on("error", (err) => {
      res.statusCode = 502;
      res.end(String(err));
    });
    req.pipe(proxyReq);
  };
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const qdrantTarget =
    env.QDRANT_URL ||
    (env.VITE_QDRANT_URL?.startsWith("http") ? env.VITE_QDRANT_URL : undefined);
  const qdrantKey = env.QDRANT_API_KEY || env.VITE_QDRANT_API_KEY;

  return {
    plugins: [
      react(),
      {
        name: "qdrant-proxy",
        configureServer(server) {
          if (qdrantTarget && qdrantKey) {
            server.middlewares.use(
              "/qdrant",
              createQdrantProxy(qdrantTarget, qdrantKey),
            );
          }
        },
      },
    ],
    server: {
      proxy: undefined,
    },
  };
});
