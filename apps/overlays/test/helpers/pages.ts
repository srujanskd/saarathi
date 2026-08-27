import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = fileURLToPath(new URL("../../dist/", import.meta.url));

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

export interface PageServer {
  readonly origin: string;
  stop(): Promise<void>;
}

/**
 * Serves the built pages from an origin that is deliberately not the Saarathi
 * server: no socket.io, no API, nothing but files. A page that reached for its
 * own origin instead of the `?server=` parameter finds nothing here, which is
 * exactly the failure IRL mode would hit and the reason this exists.
 */
export async function startPages(): Promise<PageServer> {
  const server: Server = createServer((request, response) => {
    void (async () => {
      const path = new URL(request.url ?? "/", "http://pages").pathname;
      const relative = normalize(path === "/" ? "index.html" : path.slice(1));
      // A built page never reaches outside dist, so anything that tries is a
      // request we did not write.
      if (relative.startsWith("..")) {
        response.writeHead(403).end();
        return;
      }
      try {
        const body = await readFile(join(DIST, relative));
        response.writeHead(200, {
          "content-type": TYPES[extname(relative)] ?? "application/octet-stream",
        });
        response.end(body);
      } catch {
        response.writeHead(404).end(`not built: ${relative}`);
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || !address) throw new Error("pages server got no port");

  return {
    origin: `http://127.0.0.1:${address.port}`,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
