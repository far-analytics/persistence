import * as http from "node:http";
import * as fs from "node:fs";
import * as pth from "node:path";
import * as fsp from "node:fs/promises";
import { once } from "node:events";
import { finished } from "node:stream/promises";
import { Client, LockManager } from "@far-analytics/persistence";
import { StreamBuffer } from "./stream_buffer.js";
import { test, after, before, suite } from "node:test";
import * as assert from "node:assert";

const WEB_ROOT = pth.join(process.cwd(), "web_root");

const manager = new LockManager({ errorHandler: () => {} });
const client = new Client({ manager, errorHandler: () => {} });
const server = http.createServer();

server.listen({ port: 0, host: "127.0.0.1" });
server.on("error", console.error);
await once(server, "listening");

const address = server.address();
if (!address || typeof address === "string") {
  throw new Error("Expected TCP server address");
}
const PORT = address.port.toString();

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}
const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

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

await suite("LockManager", async () => {
  const tick = () => new Promise((r) => setImmediate(r));
  await test("Read does not block read; write blocks until reads release.", async () => {
    const path = "/tmp/test-lock-read-write";
    const r1 = await manager.acquire(path, "read");
    const r2Promise = manager.acquire(path, "read");
    const r2 = await r2Promise;
    assert.ok(typeof r2 === "number");

    let writeResolved = false;
    const wPromise = manager.acquire(path, "write");
    void wPromise.then(() => {
      writeResolved = true;
    });
    await tick();
    assert.strictEqual(writeResolved, false);
    manager.release(r1);
    manager.release(r2);
    const wId = await wPromise;
    manager.release(wId);
  });

  await test("Write blocks subsequent reads until released.", async () => {
    const path = "/tmp/test-lock-write-read";
    const w1 = await manager.acquire(path, "write");

    let readResolved = false;
    const rPromise = manager.acquire(path, "read");
    void rPromise.then(() => {
      readResolved = true;
    });
    await tick();
    assert.strictEqual(readResolved, false);
    manager.release(w1);
    const rId = await rPromise;
    manager.release(rId);
  });

  await test("Writes are FIFO on the same path.", async () => {
    const path = "/tmp/test-lock-fifo";
    const w1 = await manager.acquire(path, "write");
    let w2Resolved = false;
    const w2Promise = manager.acquire(path, "write");
    void w2Promise.then(() => {
      w2Resolved = true;
    });
    await tick();
    assert.strictEqual(w2Resolved, false);
    manager.release(w1);
    const w2Id = await w2Promise;
    manager.release(w2Id);
  });

  await test("Ancestor/descendant conflicts are enforced.", async () => {
    const childPath = "/tmp/test-lock-anc-desc/a/b";
    const parentPath = "/tmp/test-lock-anc-desc/a";

    const r1 = await manager.acquire(childPath, "read");
    let writeResolved = false;
    const wPromise = manager.acquire(parentPath, "write");
    void wPromise.then(() => {
      writeResolved = true;
    });
    await tick();
    assert.strictEqual(writeResolved, false);
    manager.release(r1);
    const wId = await wPromise;
    manager.release(wId);

    const w1 = await manager.acquire(parentPath, "write");
    let readResolved = false;
    const rPromise = manager.acquire(childPath, "read");
    void rPromise.then(() => {
      readResolved = true;
    });
    await tick();
    assert.strictEqual(readResolved, false);
    manager.release(w1);
    const rId = await rPromise;
    manager.release(rId);
  });

  await test("Independent paths do not block each other.", async () => {
    const p1 = "/tmp/test-lock-independent/a";
    const p2 = "/tmp/test-lock-independent/b";
    const w1 = await manager.acquire(p1, "write");
    let w2Resolved = false;
    const w2Promise = manager.acquire(p2, "write");
    void w2Promise.then(() => {
      w2Resolved = true;
    });
    await tick();
    assert.strictEqual(w2Resolved, true);
    manager.release(w1);
    const w2Id = await w2Promise;
    manager.release(w2Id);
  });

  await test("Collect behaves like read (blocks on write).", async () => {
    const path = "/tmp/test-lock-collect";
    const w1 = await manager.acquire(path, "write");
    let collectResolved = false;
    const cPromise = manager.acquire(path, "collect");
    void cPromise.then(() => {
      collectResolved = true;
    });
    await tick();
    assert.strictEqual(collectResolved, false);
    manager.release(w1);
    const cId = await cPromise;
    manager.release(cId);
  });
});

await suite("HTTP server", async () => {
  before(async () => {
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

await suite("Client (durable)", async () => {
  await test("Write/read/delete with durable client.", async () => {
    const durableClient = new Client({ manager: new LockManager({ errorHandler: () => {} }), durable: true, errorHandler: () => {} });
    const dir = pth.join(WEB_ROOT, "durable");
    const file = pth.join(dir, "data.json");
    await fsp.mkdir(dir, { recursive: true });
    await durableClient.write(file, JSON.stringify({ ok: true }));
    const data = await durableClient.read(file, "utf8");
    assert.strictEqual(data, JSON.stringify({ ok: true }));
    await durableClient.delete(file);
    const exists = await fsp
      .stat(file)
      .then(() => true)
      .catch((err: unknown) => {
        if (err instanceof Error && "code" in err && err.code === "ENOENT") {
          return false;
        }
        throw err;
      });
    assert.strictEqual(exists, false);
  });
});

await suite("Client (streams)", async () => {
  await test("createWriteStream is atomic and holds the lock.", async () => {
    const streamClient = new Client({ manager: new LockManager({ errorHandler: () => {} }), errorHandler: () => {} });
    const dir = pth.join(WEB_ROOT, "streams");
    const file = pth.join(dir, "data.json");
    await fsp.mkdir(dir, { recursive: true });
    await streamClient.write(file, JSON.stringify({ v: 1 }));

    const ws = await streamClient.createWriteStream(file);
    ws.write(JSON.stringify({ v: 2 }));

    let readResolved = false;
    const readPromise = streamClient.read(file, "utf8").then(() => {
      readResolved = true;
    });
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(readResolved, false);

    ws.end();
    await finished(ws);

    const readData = await streamClient.read(file, "utf8");
    assert.strictEqual(readData, JSON.stringify({ v: 2 }));
    await readPromise;
  });

  await test("createReadStream reads full content.", async () => {
    const streamClient = new Client({ manager: new LockManager({ errorHandler: () => {} }), errorHandler: () => {} });
    const dir = pth.join(WEB_ROOT, "streams");
    const file = pth.join(dir, "read.json");
    await fsp.mkdir(dir, { recursive: true });
    await streamClient.write(file, JSON.stringify({ ok: true }));

    const rs = await streamClient.createReadStream(file);
    const chunks: Buffer[] = [];
    rs.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
    });
    await finished(rs);
    const data = Buffer.concat(chunks).toString("utf8");
    assert.strictEqual(data, JSON.stringify({ ok: true }));
  });

  await test("createReadStream rejects unsupported stream options.", async () => {
    const streamClient = new Client({ manager: new LockManager({ errorHandler: () => {} }), errorHandler: () => {} });
    await assert.rejects(streamClient.createReadStream("/tmp/read.json", { autoClose: false } as Parameters<typeof fs.createReadStream>[1]), /autoClose/);
    await assert.rejects(streamClient.createReadStream("/tmp/read.json", { fd: 1 } as Parameters<typeof fs.createReadStream>[1]), /options\.fd/);
  });

  await test("createWriteStream early close preserves existing data and releases the lock.", async () => {
    const streamClient = new Client({ manager: new LockManager({ errorHandler: () => {} }), errorHandler: () => {} });
    const dir = pth.join(WEB_ROOT, "streams");
    const file = pth.join(dir, "error.json");
    await fsp.mkdir(dir, { recursive: true });
    await streamClient.write(file, JSON.stringify({ v: 1 }));

    const ws = await streamClient.createWriteStream(file);
    ws.write('{"v":');
    ws.destroy();
    await finished(ws).catch(() => {});

    const readData = await streamClient.read(file, "utf8");
    assert.strictEqual(readData, JSON.stringify({ v: 1 }));

    await streamClient.write(file, JSON.stringify({ v: 2 }));
    const nextData = await streamClient.read(file, "utf8");
    assert.strictEqual(nextData, JSON.stringify({ v: 2 }));
  });

  await test("durable createWriteStream accepts string options.", async () => {
    const streamClient = new Client({ manager: new LockManager({ errorHandler: () => {} }), durable: true, errorHandler: () => {} });
    const dir = pth.join(WEB_ROOT, "streams", "durable");
    const file = pth.join(dir, "data.txt");
    await fsp.mkdir(dir, { recursive: true });

    const ws = await streamClient.createWriteStream(file, "utf8");
    ws.write("hello");
    ws.end(" world");
    await finished(ws);

    const data = await streamClient.read(file, "utf8");
    assert.strictEqual(data, "hello world");
  });

  await test("createWriteStream rejects unsupported stream options.", async () => {
    const streamClient = new Client({ manager: new LockManager({ errorHandler: () => {} }), errorHandler: () => {} });
    await assert.rejects(streamClient.createWriteStream("/tmp/write.json", { autoClose: false } as Parameters<typeof fs.createWriteStream>[1]), /autoClose/);
    await assert.rejects(streamClient.createWriteStream("/tmp/write.json", { fd: 1 } as Parameters<typeof fs.createWriteStream>[1]), /options\.fd/);
  });
});
