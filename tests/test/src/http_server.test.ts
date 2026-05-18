import * as http from "node:http";
import * as fsp from "node:fs/promises";
import * as pth from "node:path";
import { once } from "node:events";
import { Client, LockManager } from "@far-analytics/persistence";
import { StreamBuffer } from "./stream_buffer.js";
import { test, after, before, suite } from "node:test";
import * as assert from "node:assert";
import { WEB_ROOT, deferred } from "./helpers.js";

const manager = new LockManager({ errorHandler: () => {} });
const client = new Client({ manager });
const server = http.createServer();
let PORT = "";

interface Gate {
  arrived: Promise<undefined>;
  signalArrived: () => void;
  release: Promise<undefined>;
  releaseNow: () => void;
}

const gates = new Map<string, Gate>();
const getGate = (id: string): Gate => {
  let gate = gates.get(id);
  if (!gate) {
    const arrived = deferred<undefined>();
    const release = deferred<undefined>();
    gate = {
      arrived: arrived.promise,
      signalArrived: () => {
        arrived.resolve(undefined);
      },
      release: release.promise,
      releaseNow: () => {
        release.resolve(undefined);
      },
    };
    gates.set(id, gate);
  }
  return gate;
};

server.on("error", console.error);

server.on("request", (req: http.IncomingMessage, res: http.ServerResponse & { req: http.IncomingMessage }) => {
  void (async () => {
    try {
      req.on("error", console.error);
      res.on("error", console.error);
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = pth.resolve(WEB_ROOT, `.${url.pathname}`);
      switch (req.method) {
        case "GET": {
          try {
            const stat = await fsp.stat(path);
            if (stat.isFile()) {
              const data = await client.read(path);
              res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
              res.end(data);
            } else if (stat.isDirectory()) {
              const data = await client.collect(path, { encoding: "utf-8", withFileTypes: false });
              res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
              res.end(JSON.stringify(data));
            } else {
              res.writeHead(404);
              res.end();
            }
          } catch (err) {
            res.writeHead(404);
            res.end();
            console.error(err);
          }
          break;
        }
        case "PUT": {
          const streamBuffer = new StreamBuffer({ bufferSizeLimit: 1e8 });
          streamBuffer.on("error", console.error);
          req.pipe(streamBuffer);
          await once(req, "end");
          const gateId = req.headers["x-gate-id"];
          if (typeof gateId === "string") {
            const gate = getGate(gateId);
            gate.signalArrived();
            await gate.release;
          }
          await client.write(path, streamBuffer.buffer);
          res.writeHead(200);
          res.end();
          break;
        }
        case "DELETE": {
          await client.delete(path);
          res.writeHead(200);
          res.end();
          break;
        }
        default: {
          res.setHeader("Allow", "GET, PUT, DELETE");
          res.writeHead(405);
          res.end();
          break;
        }
      }
    } catch (err) {
      console.error(err);
      res.writeHead(500);
      res.end();
    }
  })();
});

await suite("HTTP server", async () => {
  before(async () => {
    server.listen({ port: 0, host: "127.0.0.1" });
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected TCP server address");
    }
    PORT = address.port.toString();
    await fsp.mkdir(WEB_ROOT, { recursive: true });
    try {
      await fsp.rm(pth.join(WEB_ROOT, "data.json"));
    } catch (err) {
      if (!(err instanceof Error && "code" in err && err.code === "ENOENT")) {
        throw err;
      }
    }
  });

  await test("Concurrent reads see full values during overlapping writes.", async () => {
    const data1 = "42".repeat(5e6);
    const body1 = { data: data1 };
    const data2 = "57".repeat(5e6);
    const body2 = { data: data2 };
    const url = `http://127.0.0.1:${PORT}/data.json`;
    await client.write(pth.join(WEB_ROOT, "data.json"), JSON.stringify(body1));

    const put1 = fetch(url, { method: "PUT", body: JSON.stringify(body1), headers: { "x-gate-id": "w1" } });
    const put2 = fetch(url, { method: "PUT", body: JSON.stringify(body2), headers: { "x-gate-id": "w2" } });

    await getGate("w1").arrived;
    await getGate("w2").arrived;

    const get1 = fetch(url, { method: "GET" });
    const get2 = fetch(url, { method: "GET" });

    getGate("w1").releaseNow();
    await put1;
    getGate("w2").releaseNow();
    await put2;

    const responses = await Promise.all([get1, get2, fetch(url, { method: "GET" })]);
    const results = await Promise.all(responses.map((r) => r.json() as Promise<{ data: string }>));

    for (const result of results) {
      const ok = result.data === data1 || result.data === data2;
      assert.strictEqual(ok, true);
    }
    assert.deepStrictEqual(results[2], body2);
  });

  after(async () => {
    server.close();
    await once(server, "close");
  });
});
