import * as http from "node:http";
import * as fs from "node:fs";
import * as pth from "node:path";
import * as fsp from "node:fs/promises";
import { once } from "node:events";
import { finished } from "node:stream/promises";
import { createRequire } from "node:module";
import { Client, LockManager } from "@far-analytics/persistence";
import { StreamBuffer } from "./stream_buffer.js";
import { test, after, before, suite } from "node:test";
import * as assert from "node:assert";

const WEB_ROOT = pth.join(process.cwd(), "web_root");
const require = createRequire(import.meta.url);
const mutableFsp = require("node:fs/promises") as typeof fsp;

const manager = new LockManager({ errorHandler: () => {} });
const client = new Client({ manager });
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

const withFailingSyncOnOpen = async <T>(path: string, error: Error, fn: () => Promise<T>): Promise<T> => {
  const originalOpen = mutableFsp.open;
  mutableFsp.open = async (...args: Parameters<typeof fsp.open>) => {
    const handle = await originalOpen(...args);
    if (args[0] !== path || args[1] !== "r") {
      return handle;
    }
    return new Proxy(handle, {
      get(target, prop) {
        if (prop === "sync") {
          return (): Promise<void> => Promise.reject(error);
        }
        const value = Reflect.get(target, prop, target) as unknown;
        if (typeof value !== "function") {
          return value;
        }
        const fn = value as (...args: unknown[]) => unknown;
        return (...args: unknown[]): unknown => Reflect.apply(fn, target, args);
      },
    });
  };
  try {
    return await fn();
  } finally {
    mutableFsp.open = originalOpen;
  }
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

  await test("collect behaves like read (blocks on write).", async () => {
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

  await test("collect on root blocks descendant writes until released.", async () => {
    const rootManager = new LockManager({ errorHandler: () => {} });
    const root = pth.parse(WEB_ROOT).root;
    const childPath = pth.join(root, "tmp", "test-lock-root-collect");
    const c1 = await rootManager.acquire(root, "collect");

    let writeResolved = false;
    const wPromise = rootManager.acquire(childPath, "write");
    void wPromise.then(() => {
      writeResolved = true;
    });
    await tick();
    assert.strictEqual(writeResolved, false);
    rootManager.release(c1);
    const wId = await wPromise;
    rootManager.release(wId);
  });

  await test("Read, write, and delete on root are rejected.", async () => {
    const rootManager = new LockManager({ errorHandler: () => {} });
    const root = pth.parse(WEB_ROOT).root;

    await assert.rejects(rootManager.acquire(root, "read"), /Read, write, and delete operations on root are not supported\./);
    await assert.rejects(rootManager.acquire(root, "write"), /Read, write, and delete operations on root are not supported\./);
    await assert.rejects(rootManager.acquire(root, "delete"), /Read, write, and delete operations on root are not supported\./);
  });

  if (process.platform === "win32") {
    await test("Windows volumes do not conflict with each other.", async () => {
      const rootManager = new LockManager({ errorHandler: () => {} });
      const cPath = String.raw`C:\tmp\test-lock-volume`;
      const dPath = String.raw`D:\tmp\test-lock-volume`;
      const cWrite = await rootManager.acquire(cPath, "write");

      let dWriteResolved = false;
      const dWritePromise = rootManager.acquire(dPath, "write");
      void dWritePromise.then(() => {
        dWriteResolved = true;
      });
      await tick();
      assert.strictEqual(dWriteResolved, true);
      rootManager.release(cWrite);
      const dWrite = await dWritePromise;
      rootManager.release(dWrite);
    });
  }
});

await suite("LockManager (acquireAll)", async () => {
  const tick = () => new Promise((r) => setImmediate(r));

  await test("acquireAll rejects empty input.", async () => {
    const rootManager = new LockManager({ errorHandler: () => {} });
    await assert.rejects(rootManager.acquireAll([]), /Paths must not be empty\./);
  });

  await test("acquireAll prunes partial graph state when a later path is invalid.", async () => {
    const rootManager = new LockManager({ errorHandler: () => {} });
    const root = pth.parse(WEB_ROOT).root;
    const validPath = pth.join(root, "tmp", "test-lock-acquire-all-cleanup", "a");

    await assert.rejects(rootManager.acquireAll([validPath, root]), /Read, write, and delete operations on root are not supported\./);

    assert.strictEqual(rootManager.root.children.size, 0);
  });

  await test("acquireAll on ancestor and descendant paths acquires without self-deadlock and blocks conflicting writes.", async () => {
    const rootManager = new LockManager({ errorHandler: () => {} });
    const root = pth.parse(WEB_ROOT).root;
    const parentPath = pth.join(root, "tmp", "test-lock-acquire-all-ancestor", "a");
    const childPath = pth.join(parentPath, "b");

    let acquireAllResolved = false;
    const acquireAllPromise = rootManager.acquireAll([parentPath, childPath]);
    void acquireAllPromise.then(() => {
      acquireAllResolved = true;
    });

    await tick();
    assert.strictEqual(acquireAllResolved, true);

    const acquireAllId = await acquireAllPromise;
    let writeResolved = false;
    const writePromise = rootManager.acquire(parentPath, "write");
    void writePromise.then(() => {
      writeResolved = true;
    });

    await tick();
    assert.strictEqual(writeResolved, false);

    rootManager.release(acquireAllId);
    const writeId = await writePromise;
    rootManager.release(writeId);
  });

  await test("acquireAll on independent paths blocks conflicts on either path but not unrelated writes.", async () => {
    const rootManager = new LockManager({ errorHandler: () => {} });
    const root = pth.parse(WEB_ROOT).root;
    const pathA = pth.join(root, "tmp", "test-lock-acquire-all-independent", "a");
    const pathB = pth.join(root, "tmp", "test-lock-acquire-all-independent", "b");
    const pathC = pth.join(root, "tmp", "test-lock-acquire-all-independent", "c");

    const acquireAllId = await rootManager.acquireAll([pathA, pathB]);

    let writeAResolved = false;
    const writeAPromise = rootManager.acquire(pathA, "write");
    void writeAPromise.then(() => {
      writeAResolved = true;
    });

    let writeBResolved = false;
    const writeBPromise = rootManager.acquire(pathB, "write");
    void writeBPromise.then(() => {
      writeBResolved = true;
    });

    let writeCResolved = false;
    const writeCPromise = rootManager.acquire(pathC, "write");
    void writeCPromise.then(() => {
      writeCResolved = true;
    });

    await tick();
    assert.strictEqual(writeAResolved, false);
    assert.strictEqual(writeBResolved, false);
    assert.strictEqual(writeCResolved, true);

    rootManager.release(acquireAllId);
    const writeAId = await writeAPromise;
    const writeBId = await writeBPromise;
    const writeCId = await writeCPromise;
    rootManager.release(writeAId);
    rootManager.release(writeBId);
    rootManager.release(writeCId);
  });

  await test("acquireAll treats duplicate paths as a single combined lock target.", async () => {
    const rootManager = new LockManager({ errorHandler: () => {} });
    const root = pth.parse(WEB_ROOT).root;
    const path = pth.join(root, "tmp", "test-lock-acquire-all-duplicate", "a");
    const otherPath = pth.join(root, "tmp", "test-lock-acquire-all-duplicate", "b");

    let acquireAllResolved = false;
    const acquireAllPromise = rootManager.acquireAll([path, path]);
    void acquireAllPromise.then(() => {
      acquireAllResolved = true;
    });

    await tick();
    assert.strictEqual(acquireAllResolved, true);

    const acquireAllId = await acquireAllPromise;

    let conflictingWriteResolved = false;
    const conflictingWritePromise = rootManager.acquire(path, "write");
    void conflictingWritePromise.then(() => {
      conflictingWriteResolved = true;
    });

    let unrelatedWriteResolved = false;
    const unrelatedWritePromise = rootManager.acquire(otherPath, "write");
    void unrelatedWritePromise.then(() => {
      unrelatedWriteResolved = true;
    });

    await tick();
    assert.strictEqual(conflictingWriteResolved, false);
    assert.strictEqual(unrelatedWriteResolved, true);

    rootManager.release(acquireAllId);
    const conflictingWriteId = await conflictingWritePromise;
    const unrelatedWriteId = await unrelatedWritePromise;
    rootManager.release(conflictingWriteId);
    rootManager.release(unrelatedWriteId);
  });

  await test("An earlier conflicting write acquires before a later conflicting acquireAll.", async () => {
    const rootManager = new LockManager({ errorHandler: () => {} });
    const root = pth.parse(WEB_ROOT).root;
    const pathA = pth.join(root, "tmp", "test-lock-acquire-all-fifo", "a");
    const pathB = pth.join(root, "tmp", "test-lock-acquire-all-fifo", "b");
    const pathC = pth.join(root, "tmp", "test-lock-acquire-all-fifo", "c");

    const firstAcquireAllId = await rootManager.acquireAll([pathA, pathB]);

    let writeResolved = false;
    const writePromise = rootManager.acquire(pathA, "write");
    void writePromise.then(() => {
      writeResolved = true;
    });

    let secondAcquireAllResolved = false;
    const secondAcquireAllPromise = rootManager.acquireAll([pathA, pathC]);
    void secondAcquireAllPromise.then(() => {
      secondAcquireAllResolved = true;
    });

    await tick();
    assert.strictEqual(writeResolved, false);
    assert.strictEqual(secondAcquireAllResolved, false);

    rootManager.release(firstAcquireAllId);

    await tick();
    assert.strictEqual(writeResolved, true);
    assert.strictEqual(secondAcquireAllResolved, false);

    const writeId = await writePromise;
    rootManager.release(writeId);

    const secondAcquireAllId = await secondAcquireAllPromise;
    rootManager.release(secondAcquireAllId);
  });

  await test("An earlier conflicting acquireAll acquires before a later conflicting write.", async () => {
    const rootManager = new LockManager({ errorHandler: () => {} });
    const root = pth.parse(WEB_ROOT).root;
    const pathA = pth.join(root, "tmp", "test-lock-acquire-all-fifo-reverse", "a");
    const pathB = pth.join(root, "tmp", "test-lock-acquire-all-fifo-reverse", "b");
    const pathC = pth.join(root, "tmp", "test-lock-acquire-all-fifo-reverse", "c");

    const firstAcquireAllId = await rootManager.acquireAll([pathA, pathB]);

    let secondAcquireAllResolved = false;
    const secondAcquireAllPromise = rootManager.acquireAll([pathA, pathC]);
    void secondAcquireAllPromise.then(() => {
      secondAcquireAllResolved = true;
    });

    let writeResolved = false;
    const writePromise = rootManager.acquire(pathA, "write");
    void writePromise.then(() => {
      writeResolved = true;
    });

    await tick();
    assert.strictEqual(secondAcquireAllResolved, false);
    assert.strictEqual(writeResolved, false);

    rootManager.release(firstAcquireAllId);

    await tick();
    assert.strictEqual(secondAcquireAllResolved, true);
    assert.strictEqual(writeResolved, false);

    const secondAcquireAllId = await secondAcquireAllPromise;
    rootManager.release(secondAcquireAllId);

    const writeId = await writePromise;
    rootManager.release(writeId);
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
  await test("Write/read with durable client.", async () => {
    const durableClient = new Client({ manager: new LockManager({ errorHandler: () => {} }), durable: true });
    const dir = pth.join(WEB_ROOT, "durable");
    const file = pth.join(dir, "data.json");
    await fsp.mkdir(dir, { recursive: true });
    await durableClient.write(file, JSON.stringify({ ok: true }));
    const data = await durableClient.read(file, "utf8");
    assert.strictEqual(data, JSON.stringify({ ok: true }));
  });
});

await suite("Client (collect)", async () => {
  await test("collect can list the filesystem root.", async () => {
    const collectClient = new Client({ manager: new LockManager({ errorHandler: () => {} }) });
    const root = pth.parse(WEB_ROOT).root;
    const entries = await collectClient.collect(root, { encoding: "utf8", withFileTypes: false });
    assert.strictEqual(Array.isArray(entries), true);
    assert.ok(entries.length > 0);
  });

  await test("collect returns directory entries as strings.", async () => {
    const collectClient = new Client({ manager: new LockManager({ errorHandler: () => {} }) });
    const dir = pth.join(WEB_ROOT, "collect", "strings");
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(pth.join(dir, "alpha.json"), JSON.stringify({ v: 1 }));
    await fsp.writeFile(pth.join(dir, "beta.json"), JSON.stringify({ v: 2 }));

    const entries = await collectClient.collect(dir, { encoding: "utf8", withFileTypes: false });
    assert.deepStrictEqual([...entries].sort(), ["alpha.json", "beta.json"]);
  });

  await test("collect returns buffered dirents when requested.", async () => {
    const collectClient = new Client({ manager: new LockManager({ errorHandler: () => {} }) });
    const dir = pth.join(WEB_ROOT, "collect", "dirents");
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.mkdir(pth.join(dir, "nested"), { recursive: true });
    await fsp.writeFile(pth.join(dir, "nested", "child.json"), JSON.stringify({ ok: true }));
    await fsp.writeFile(pth.join(dir, "root.json"), JSON.stringify({ ok: true }));

    const entries = await collectClient.collect(dir, { encoding: "buffer", withFileTypes: true });
    const names = [...entries.map((entry) => entry.name.toString("utf8"))].sort();
    assert.deepStrictEqual(names, ["nested", "root.json"]);
    assert.strictEqual(
      entries.some((entry) => entry.isDirectory()),
      true
    );
    assert.strictEqual(
      entries.some((entry) => entry.isFile()),
      true
    );
  });
});

await suite("Client (delete)", async () => {
  await test("delete removes an existing file with durable client.", async () => {
    const deleteClient = new Client({ manager: new LockManager({ errorHandler: () => {} }), durable: true });
    const dir = pth.join(WEB_ROOT, "delete", "durable-existing");
    const file = pth.join(dir, "data.json");
    await fsp.mkdir(dir, { recursive: true });
    await deleteClient.write(file, JSON.stringify({ ok: true }));

    await deleteClient.delete(file);

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

  await test("Durable delete with force succeeds when the parent directory does not exist.", async () => {
    const deleteClient = new Client({ manager: new LockManager({ errorHandler: () => {} }), durable: true });
    const dir = pth.join(WEB_ROOT, "delete", "durable-missing-parent");
    const file = pth.join(dir, "data.json");
    await fsp.rm(dir, { recursive: true, force: true });

    await deleteClient.delete(file, { force: true });
  });
});

await suite("Client (rename)", async () => {
  await test("rename holds conflicting locks on both old and new paths until it completes.", async () => {
    const renameManager = new LockManager({ errorHandler: () => {} });
    const renameClient = new Client({ manager: renameManager });
    const dir = pth.join(WEB_ROOT, "rename", "holds-locks");
    const srcDir = pth.join(dir, "src");
    const destDir = pth.join(dir, "dest");
    const oldPath = pth.join(srcDir, "data.json");
    const newPath = pth.join(destDir, "data.json");

    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.mkdir(srcDir, { recursive: true });
    await fsp.mkdir(destDir, { recursive: true });
    await fsp.writeFile(oldPath, JSON.stringify({ v: 1 }));

    const renameEntered = deferred<unknown>();
    const releaseRename = deferred<unknown>();
    const originalRename = mutableFsp.rename;
    mutableFsp.rename = async (...args: Parameters<typeof fsp.rename>) => {
      renameEntered.resolve(null);
      await releaseRename.promise;
      return originalRename(...args);
    };

    try {
      const renamePromise = renameClient.rename(oldPath, newPath);
      await renameEntered.promise;

      let oldPathResolved = false;
      const oldPathPromise = renameManager.acquire(oldPath, "write");
      void oldPathPromise.then(() => {
        oldPathResolved = true;
      });

      let newPathResolved = false;
      const newPathPromise = renameManager.acquire(newPath, "write");
      void newPathPromise.then(() => {
        newPathResolved = true;
      });

      await new Promise((r) => setImmediate(r));
      assert.strictEqual(oldPathResolved, false);
      assert.strictEqual(newPathResolved, false);

      releaseRename.resolve(null);
      await renamePromise;

      const oldPathId = await oldPathPromise;
      const newPathId = await newPathPromise;
      renameManager.release(oldPathId);
      renameManager.release(newPathId);

      const renamedData = await renameClient.read(newPath, "utf8");
      assert.strictEqual(renamedData, JSON.stringify({ v: 1 }));
      await assert.rejects(renameClient.read(oldPath, "utf8"), /ENOENT|no such file or directory/i);
    } finally {
      mutableFsp.rename = originalRename;
    }
  });

  await test("rename releases both locks and preserves the source when rename fails.", async () => {
    const renameManager = new LockManager({ errorHandler: () => {} });
    const renameClient = new Client({ manager: renameManager });
    const dir = pth.join(WEB_ROOT, "rename", "rename-failure");
    const srcDir = pth.join(dir, "src");
    const destDir = pth.join(dir, "dest");
    const oldPath = pth.join(srcDir, "data.json");
    const newPath = pth.join(destDir, "data.json");

    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.mkdir(srcDir, { recursive: true });
    await fsp.mkdir(destDir, { recursive: true });
    await fsp.writeFile(oldPath, JSON.stringify({ v: 1 }));

    const originalRename = mutableFsp.rename;
    mutableFsp.rename = () => {
      throw new Error("Injected rename failure");
    };

    try {
      await assert.rejects(renameClient.rename(oldPath, newPath), /Injected rename failure/);

      const oldData = await renameClient.read(oldPath, "utf8");
      assert.strictEqual(oldData, JSON.stringify({ v: 1 }));
      await assert.rejects(renameClient.read(newPath, "utf8"), /ENOENT|no such file or directory/i);

      const oldLockId = await renameManager.acquire(oldPath, "write");
      const newLockId = await renameManager.acquire(newPath, "write");
      renameManager.release(oldLockId);
      renameManager.release(newLockId);
    } finally {
      mutableFsp.rename = originalRename;
    }
  });

  await test("Durable rename reports directory sync failure after rename and releases both locks.", async () => {
    const renameManager = new LockManager({ errorHandler: () => {} });
    const renameClient = new Client({ manager: renameManager, durable: true });
    const dir = pth.join(WEB_ROOT, "rename", "durable-sync-failure");
    const srcDir = pth.join(dir, "src");
    const destDir = pth.join(dir, "dest");
    const oldPath = pth.join(srcDir, "data.json");
    const newPath = pth.join(destDir, "data.json");

    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.mkdir(srcDir, { recursive: true });
    await fsp.mkdir(destDir, { recursive: true });
    await fsp.writeFile(oldPath, JSON.stringify({ v: 1 }));

    await withFailingSyncOnOpen(destDir, new Error("Injected directory sync failure"), async () => {
      await assert.rejects(renameClient.rename(oldPath, newPath), /Injected directory sync failure/);
    });

    const renamedData = await renameClient.read(newPath, "utf8");
    assert.strictEqual(renamedData, JSON.stringify({ v: 1 }));
    await assert.rejects(renameClient.read(oldPath, "utf8"), /ENOENT|no such file or directory/i);

    const oldLockId = await renameManager.acquire(oldPath, "write");
    const newLockId = await renameManager.acquire(newPath, "write");
    renameManager.release(oldLockId);
    renameManager.release(newLockId);
  });

  await test("rename on the same path is a no-op and releases the lock.", async () => {
    const renameManager = new LockManager({ errorHandler: () => {} });
    const renameClient = new Client({ manager: renameManager });
    const dir = pth.join(WEB_ROOT, "rename", "same-path");
    const path = pth.join(dir, "data.json");

    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path, JSON.stringify({ v: 1 }));

    await renameClient.rename(path, path);

    const data = await renameClient.read(path, "utf8");
    assert.strictEqual(data, JSON.stringify({ v: 1 }));

    const lockId = await renameManager.acquire(path, "write");
    renameManager.release(lockId);
  });

  await test("Durable rename syncs both source and destination directories on success.", async () => {
    const renameManager = new LockManager({ errorHandler: () => {} });
    const renameClient = new Client({ manager: renameManager, durable: true });
    const dir = pth.join(WEB_ROOT, "rename", "durable-sync-success");
    const srcDir = pth.join(dir, "src");
    const destDir = pth.join(dir, "dest");
    const oldPath = pth.join(srcDir, "data.json");
    const newPath = pth.join(destDir, "data.json");

    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.mkdir(srcDir, { recursive: true });
    await fsp.mkdir(destDir, { recursive: true });
    await fsp.writeFile(oldPath, JSON.stringify({ v: 1 }));

    const syncCounts = new Map<string, number>([
      [srcDir, 0],
      [destDir, 0],
    ]);
    const originalOpen = mutableFsp.open;
    mutableFsp.open = async (...args: Parameters<typeof fsp.open>) => {
      const handle = await originalOpen(...args);
      const path = typeof args[0] === "string" ? args[0] : null;
      if (path === null || !syncCounts.has(path) || args[1] !== "r") {
        return handle;
      }
      return new Proxy(handle, {
        get(target, prop) {
          if (prop === "sync") {
            return async (): Promise<void> => {
              syncCounts.set(path, (syncCounts.get(path) ?? 0) + 1);
              await target.sync();
            };
          }
          const value = Reflect.get(target, prop, target) as unknown;
          if (typeof value !== "function") {
            return value;
          }
          const fn = value as (...args: unknown[]) => unknown;
          return (...args: unknown[]): unknown => Reflect.apply(fn, target, args);
        },
      });
    };

    try {
      await renameClient.rename(oldPath, newPath);
    } finally {
      mutableFsp.open = originalOpen;
    }

    const renamedData = await renameClient.read(newPath, "utf8");
    assert.strictEqual(renamedData, JSON.stringify({ v: 1 }));
    await assert.rejects(renameClient.read(oldPath, "utf8"), /ENOENT|no such file or directory/i);
    assert.strictEqual(syncCounts.get(srcDir), 1);
    assert.strictEqual(syncCounts.get(destDir), 1);
  });

  await test("rename creates missing destination parent directories.", async () => {
    const durable = false;
    const renameManager = new LockManager({ errorHandler: () => {} });
    const renameClient = new Client({ manager: renameManager, durable });
    const dir = pth.join(WEB_ROOT, "rename", `create-parent-plain`);
    const srcDir = pth.join(dir, "src");
    const missingDestDir = pth.join(dir, "missing", "dest");
    const oldPath = pth.join(srcDir, "data.json");
    const newPath = pth.join(missingDestDir, "data.json");

    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.mkdir(srcDir, { recursive: true });
    await fsp.writeFile(oldPath, JSON.stringify({ v: 1 }));

    await renameClient.rename(oldPath, newPath);

    const renamedData = await renameClient.read(newPath, "utf8");
    assert.strictEqual(renamedData, JSON.stringify({ v: 1 }));
    await assert.rejects(renameClient.read(oldPath, "utf8"), /ENOENT|no such file or directory/i);
  });

  await test("Durable rename creates missing destination parent directories.", async () => {
    const durable = true;
    const renameManager = new LockManager({ errorHandler: () => {} });
    const renameClient = new Client({ manager: renameManager, durable });
    const dir = pth.join(WEB_ROOT, "rename", `create-parent-durable`);
    const srcDir = pth.join(dir, "src");
    const missingDestDir = pth.join(dir, "missing", "dest");
    const oldPath = pth.join(srcDir, "data.json");
    const newPath = pth.join(missingDestDir, "data.json");

    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.mkdir(srcDir, { recursive: true });
    await fsp.writeFile(oldPath, JSON.stringify({ v: 1 }));

    await renameClient.rename(oldPath, newPath);

    const renamedData = await renameClient.read(newPath, "utf8");
    assert.strictEqual(renamedData, JSON.stringify({ v: 1 }));
    await assert.rejects(renameClient.read(oldPath, "utf8"), /ENOENT|no such file or directory/i);
  });

  await test("rename with a missing source rejects without creating the destination parent directory.", async () => {
    for (const durable of [false, true]) {
      const renameManager = new LockManager({ errorHandler: () => {} });
      const renameClient = new Client({ manager: renameManager, durable });
      const dir = pth.join(WEB_ROOT, "rename", `missing-source-${durable ? "durable" : "plain"}`);
      const srcDir = pth.join(dir, "src");
      const missingDestDir = pth.join(dir, "missing", "dest");
      const oldPath = pth.join(srcDir, "missing.json");
      const newPath = pth.join(missingDestDir, "data.json");

      await fsp.rm(dir, { recursive: true, force: true });
      await fsp.mkdir(srcDir, { recursive: true });

      await assert.rejects(renameClient.rename(oldPath, newPath), /ENOENT|no such file or directory/i);

      const destinationParentExists = await fsp
        .stat(missingDestDir)
        .then(() => true)
        .catch((err: unknown) => {
          if (err instanceof Error && "code" in err && err.code === "ENOENT") {
            return false;
          }
          throw err;
        });
      assert.strictEqual(destinationParentExists, false);
    }
  });
});

await suite("Client (write)", async () => {
  await test("write preserves the existing target and releases the lock when commit fails.", async () => {
    const writeClient = new Client({ manager: new LockManager({ errorHandler: () => {} }) });
    const dir = pth.join(WEB_ROOT, "write");
    const path = pth.join(dir, "target");
    const child = pth.join(path, "child.txt");
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.mkdir(path, { recursive: true });
    await fsp.writeFile(child, "keep");

    await assert.rejects(writeClient.write(path, "oops", "utf8"), /EISDIR|operation not permitted|illegal operation on a directory/i);

    const childData = await fsp.readFile(child, "utf8");
    assert.strictEqual(childData, "keep");

    await writeClient.delete(path, { recursive: true });
    await writeClient.write(path, "ok", "utf8");
    const data = await writeClient.read(path, "utf8");
    assert.strictEqual(data, "ok");
  });

  await test("Durable write reports directory sync failure after rename and releases the lock.", async () => {
    const writeClient = new Client({ manager: new LockManager({ errorHandler: () => {} }), durable: true });
    const dir = pth.join(WEB_ROOT, "durable-write-sync-error");
    const path = pth.join(dir, "target.json");
    await fsp.mkdir(dir, { recursive: true });
    await writeClient.write(path, JSON.stringify({ v: 1 }));

    await withFailingSyncOnOpen(dir, new Error("Injected directory sync failure"), async () => {
      await assert.rejects(writeClient.write(path, JSON.stringify({ v: 2 }), "utf8"), /Injected directory sync failure/);
    });

    const readData = await writeClient.read(path, "utf8");
    assert.strictEqual(readData, JSON.stringify({ v: 2 }));

    await writeClient.write(path, JSON.stringify({ v: 3 }));
    const nextData = await writeClient.read(path, "utf8");
    assert.strictEqual(nextData, JSON.stringify({ v: 3 }));
  });

  await test("Durable write preserves the existing target and releases the lock when commit fails.", async () => {
    const writeClient = new Client({ manager: new LockManager({ errorHandler: () => {} }), durable: true });
    const dir = pth.join(WEB_ROOT, "durable-write");
    const path = pth.join(dir, "target");
    const child = pth.join(path, "child.txt");
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.mkdir(path, { recursive: true });
    await fsp.writeFile(child, "keep");

    await assert.rejects(writeClient.write(path, "oops", "utf8"), /EISDIR|operation not permitted|illegal operation on a directory/i);

    const childData = await fsp.readFile(child, "utf8");
    assert.strictEqual(childData, "keep");

    await writeClient.delete(path, { recursive: true });
    await writeClient.write(path, "ok", "utf8");
    const data = await writeClient.read(path, "utf8");
    assert.strictEqual(data, "ok");
  });
});

await suite("Client (streams)", async () => {
  await test("createWriteStream is atomic and holds the lock.", async () => {
    const streamClient = new Client({ manager: new LockManager({ errorHandler: () => {} }) });
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

  await test("createWriteStream finish means the file is already committed.", async () => {
    const streamClient = new Client({ manager: new LockManager({ errorHandler: () => {} }) });
    const dir = pth.join(WEB_ROOT, "streams", "finish-commit");
    const file = pth.join(dir, "data.json");
    await fsp.mkdir(dir, { recursive: true });
    await streamClient.write(file, JSON.stringify({ v: 1 }));

    const ws = await streamClient.createWriteStream(file);
    ws.end(JSON.stringify({ v: 2 }));
    await once(ws, "finish");

    const rawData = await fsp.readFile(file, "utf8");
    assert.strictEqual(rawData, JSON.stringify({ v: 2 }));

    const entries = await fsp.readdir(dir);
    assert.deepStrictEqual(entries, ["data.json"]);
  });

  await test("Durable createWriteStream finish means the file is already committed.", async () => {
    const streamClient = new Client({ manager: new LockManager({ errorHandler: () => {} }), durable: true });
    const dir = pth.join(WEB_ROOT, "streams", "durable-finish-commit");
    const file = pth.join(dir, "data.json");
    await fsp.mkdir(dir, { recursive: true });
    await streamClient.write(file, JSON.stringify({ v: 1 }));

    const ws = await streamClient.createWriteStream(file);
    ws.end(JSON.stringify({ v: 2 }));
    await once(ws, "finish");

    const rawData = await fsp.readFile(file, "utf8");
    assert.strictEqual(rawData, JSON.stringify({ v: 2 }));

    const entries = await fsp.readdir(dir);
    assert.deepStrictEqual(entries, ["data.json"]);
  });

  await test("createReadStream reads full content.", async () => {
    const streamClient = new Client({ manager: new LockManager({ errorHandler: () => {} }) });
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

  await test("createReadStream honors text encoding options.", async () => {
    const streamClient = new Client({ manager: new LockManager({ errorHandler: () => {} }) });
    const dir = pth.join(WEB_ROOT, "streams");
    const file = pth.join(dir, "read-encoding.txt");
    await fsp.mkdir(dir, { recursive: true });
    await streamClient.write(file, "hello world", "utf16le");

    const rs = await streamClient.createReadStream(file, "utf16le");
    const chunks: string[] = [];
    rs.on("data", (chunk) => {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf16le"));
    });
    await finished(rs);
    assert.strictEqual(chunks.join(""), "hello world");
  });

  await test("createReadStream honors range options.", async () => {
    const streamClient = new Client({ manager: new LockManager({ errorHandler: () => {} }) });
    const dir = pth.join(WEB_ROOT, "streams");
    const file = pth.join(dir, "read-range.txt");
    await fsp.mkdir(dir, { recursive: true });
    await streamClient.write(file, "abcdef", "utf8");

    const rs = await streamClient.createReadStream(file, { encoding: "utf8", start: 1, end: 3 });
    const chunks: string[] = [];
    rs.on("data", (chunk) => {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    });
    await finished(rs);
    assert.strictEqual(chunks.join(""), "bcd");
  });

  await test("createReadStream range reads still hold the lock until close.", async () => {
    const streamClient = new Client({ manager: new LockManager({ errorHandler: () => {} }) });
    const dir = pth.join(WEB_ROOT, "streams");
    const file = pth.join(dir, "read-range-lock.txt");
    await fsp.mkdir(dir, { recursive: true });
    await streamClient.write(file, "abcdef", "utf8");

    const rs = await streamClient.createReadStream(file, { encoding: "utf8", start: 1, end: 3 });
    const chunks: string[] = [];
    rs.on("data", (chunk) => {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    });

    let writeResolved = false;
    const writePromise = streamClient.write(file, "rewritten", "utf8").then(() => {
      writeResolved = true;
    });
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(writeResolved, false);

    await finished(rs);
    assert.strictEqual(chunks.join(""), "bcd");
    await writePromise;

    const data = await streamClient.read(file, "utf8");
    assert.strictEqual(data, "rewritten");
  });

  await test("createReadStream ignores unsupported JS-only options and releases the lock.", async () => {
    const streamClient = new Client({ manager: new LockManager({ errorHandler: () => {} }) });
    const dir = pth.join(WEB_ROOT, "streams");
    const file = pth.join(dir, "read-options.json");
    await fsp.mkdir(dir, { recursive: true });
    await streamClient.write(file, JSON.stringify({ ok: true }));

    const rs = await streamClient.createReadStream(file, { encoding: "utf8", autoClose: false, fd: 1 } as unknown as Parameters<typeof fs.createReadStream>[1]);
    const chunks: string[] = [];
    rs.on("data", (chunk) => {
      chunks.push(String(chunk));
    });
    await finished(rs);
    assert.strictEqual(chunks.join(""), JSON.stringify({ ok: true }));

    await streamClient.write(file, JSON.stringify({ ok: false }));
    const nextData = await streamClient.read(file, "utf8");
    assert.strictEqual(nextData, JSON.stringify({ ok: false }));
  });

  await test("createReadStream releases the lock when stream creation fails.", async () => {
    const streamClient = new Client({ manager: new LockManager({ errorHandler: () => {} }) });
    const dir = pth.join(WEB_ROOT, "streams");
    const file = pth.join(dir, "missing-read.json");
    await fsp.mkdir(dir, { recursive: true });
    await fsp.rm(file, { force: true });

    const rs = await streamClient.createReadStream(file);
    await finished(rs).then(
      () => {
        throw new Error("Expected createReadStream to fail");
      },
      () => {}
    );

    await streamClient.write(file, JSON.stringify({ ok: true }));
    const data = await streamClient.read(file, "utf8");
    assert.strictEqual(data, JSON.stringify({ ok: true }));
  });

  await test("createReadStream releases the lock when stream creation throws synchronously.", async () => {
    const streamClient = new Client({ manager: new LockManager({ errorHandler: () => {} }) });
    const dir = pth.join(WEB_ROOT, "streams");
    const file = pth.join(dir, "sync-read-error.json");
    await fsp.mkdir(dir, { recursive: true });
    await streamClient.write(file, JSON.stringify({ ok: true }));

    await assert.rejects(streamClient.createReadStream(file, { start: -1 }), /ERR_OUT_OF_RANGE|out of range/i);

    await streamClient.write(file, JSON.stringify({ ok: false }));
    const data = await streamClient.read(file, "utf8");
    assert.strictEqual(data, JSON.stringify({ ok: false }));
  });

  await test("createReadStream early close releases the lock.", async () => {
    const streamClient = new Client({ manager: new LockManager({ errorHandler: () => {} }) });
    const dir = pth.join(WEB_ROOT, "streams");
    const file = pth.join(dir, "read-close.json");
    await fsp.mkdir(dir, { recursive: true });
    await streamClient.write(file, "x".repeat(1e6));

    const rs = await streamClient.createReadStream(file);
    rs.once("data", () => {
      rs.destroy();
    });
    await finished(rs).catch(() => {});

    await streamClient.write(file, JSON.stringify({ ok: true }));
    const data = await streamClient.read(file, "utf8");
    assert.strictEqual(data, JSON.stringify({ ok: true }));
  });

  await test("createReadStream abort signal releases the lock.", async () => {
    const streamClient = new Client({ manager: new LockManager({ errorHandler: () => {} }) });
    const dir = pth.join(WEB_ROOT, "streams");
    const file = pth.join(dir, "read-abort.txt");
    await fsp.mkdir(dir, { recursive: true });
    await streamClient.write(file, "x".repeat(1e6), "utf8");

    const controller = new AbortController();
    const rs = await streamClient.createReadStream(file, { signal: controller.signal });
    rs.once("data", () => {
      controller.abort();
    });
    await finished(rs).catch(() => {});

    await streamClient.write(file, JSON.stringify({ ok: true }));
    const data = await streamClient.read(file, "utf8");
    assert.strictEqual(data, JSON.stringify({ ok: true }));
  });

  await test("Equivalent normalized paths share the same lock.", async () => {
    const streamClient = new Client({ manager: new LockManager({ errorHandler: () => {} }) });
    const dir = pth.join(WEB_ROOT, "streams", "normalized-paths");
    const file = pth.join(dir, "data.json");
    const oddPath = `${dir}/./subdir/../data.json`;
    await fsp.mkdir(dir, { recursive: true });
    await streamClient.write(file, JSON.stringify({ v: 1 }));

    const rs = await streamClient.createReadStream(oddPath, "utf8");
    rs.once("data", () => {});

    let writeResolved = false;
    const writePromise = streamClient.write(file, JSON.stringify({ v: 2 })).then(() => {
      writeResolved = true;
    });
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(writeResolved, false);

    await finished(rs);
    await writePromise;

    const data = await streamClient.read(file, "utf8");
    assert.strictEqual(data, JSON.stringify({ v: 2 }));
  });

  await test("createWriteStream early close preserves existing data and releases the lock.", async () => {
    const streamClient = new Client({ manager: new LockManager({ errorHandler: () => {} }) });
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

  await test("createWriteStream abort signal preserves existing data and releases the lock.", async () => {
    const streamClient = new Client({ manager: new LockManager({ errorHandler: () => {} }) });
    const dir = pth.join(WEB_ROOT, "streams");
    const file = pth.join(dir, "abort.json");
    await fsp.mkdir(dir, { recursive: true });
    await streamClient.write(file, JSON.stringify({ v: 1 }));

    const controller = new AbortController();
    const ws = await streamClient.createWriteStream(file, { signal: controller.signal });
    ws.write('{"v":');
    controller.abort();
    await finished(ws).catch(() => {});

    const readData = await streamClient.read(file, "utf8");
    assert.strictEqual(readData, JSON.stringify({ v: 1 }));

    await streamClient.write(file, JSON.stringify({ v: 2 }));
    const nextData = await streamClient.read(file, "utf8");
    assert.strictEqual(nextData, JSON.stringify({ v: 2 }));
  });

  await test("Durable createWriteStream abort signal preserves existing data and releases the lock.", async () => {
    const streamClient = new Client({ manager: new LockManager({ errorHandler: () => {} }), durable: true });
    const dir = pth.join(WEB_ROOT, "streams", "durable-abort-signal");
    const file = pth.join(dir, "abort.json");
    await fsp.mkdir(dir, { recursive: true });
    await streamClient.write(file, JSON.stringify({ v: 1 }));

    const controller = new AbortController();
    const ws = await streamClient.createWriteStream(file, { signal: controller.signal });
    ws.write('{"v":');
    controller.abort();
    await finished(ws).catch(() => {});

    const readData = await streamClient.read(file, "utf8");
    assert.strictEqual(readData, JSON.stringify({ v: 1 }));

    await streamClient.write(file, JSON.stringify({ v: 2 }));
    const nextData = await streamClient.read(file, "utf8");
    assert.strictEqual(nextData, JSON.stringify({ v: 2 }));
  });

  await test("createWriteStream ignores unsupported JS-only options and releases the lock.", async () => {
    const streamClient = new Client({ manager: new LockManager({ errorHandler: () => {} }) });
    const dir = pth.join(WEB_ROOT, "streams");
    const file = pth.join(dir, "write-options.json");
    await fsp.mkdir(dir, { recursive: true });

    const ws = await streamClient.createWriteStream(file, { encoding: "utf8", autoClose: false, fd: 1 } as unknown as Parameters<typeof fs.createWriteStream>[1]);
    ws.end(JSON.stringify({ ok: true }));
    await finished(ws);

    const readData = await streamClient.read(file, "utf8");
    assert.strictEqual(readData, JSON.stringify({ ok: true }));

    await streamClient.write(file, JSON.stringify({ ok: false }));
    const nextData = await streamClient.read(file, "utf8");
    assert.strictEqual(nextData, JSON.stringify({ ok: false }));
  });

  await test("Durable createWriteStream ignores unsupported JS-only options and releases the lock.", async () => {
    const streamClient = new Client({ manager: new LockManager({ errorHandler: () => {} }), durable: true });
    const dir = pth.join(WEB_ROOT, "streams", "durable-write-options");
    const file = pth.join(dir, "data.json");
    await fsp.mkdir(dir, { recursive: true });

    const ws = await streamClient.createWriteStream(file, { encoding: "utf8", autoClose: false, fd: 1 } as unknown as Parameters<typeof fs.createWriteStream>[1]);
    ws.end(JSON.stringify({ ok: true }));
    await finished(ws);

    const readData = await streamClient.read(file, "utf8");
    assert.strictEqual(readData, JSON.stringify({ ok: true }));

    await streamClient.write(file, JSON.stringify({ ok: false }));
    const nextData = await streamClient.read(file, "utf8");
    assert.strictEqual(nextData, JSON.stringify({ ok: false }));
  });

  await test("createWriteStream preserves existing data when commit fails after temp write.", async () => {
    const streamClient = new Client({ manager: new LockManager({ errorHandler: () => {} }) });
    const dir = pth.join(WEB_ROOT, "streams");
    const file = pth.join(dir, "commit-error.json");
    await fsp.mkdir(dir, { recursive: true });
    await streamClient.write(file, JSON.stringify({ v: 1 }));

    const ws = await streamClient.createWriteStream(file);
    ws.write(JSON.stringify({ v: 2 }));
    ws.fsWriteStream.once("finish", () => {
      fs.rmSync((ws as unknown as { tempPath: string }).tempPath, { force: true });
    });
    ws.end();

    await finished(ws).then(
      () => {
        throw new Error("Expected createWriteStream to fail");
      },
      () => {}
    );

    const readData = await streamClient.read(file, "utf8");
    assert.strictEqual(readData, JSON.stringify({ v: 1 }));

    await streamClient.write(file, JSON.stringify({ v: 3 }));
    const nextData = await streamClient.read(file, "utf8");
    assert.strictEqual(nextData, JSON.stringify({ v: 3 }));
  });

  await test("Durable createWriteStream early close preserves existing data, cleans temp files, and releases the lock.", async () => {
    const streamClient = new Client({ manager: new LockManager({ errorHandler: () => {} }), durable: true });
    const dir = pth.join(WEB_ROOT, "streams", "durable-abort");
    const file = pth.join(dir, "error.json");
    await fsp.mkdir(dir, { recursive: true });
    await streamClient.write(file, JSON.stringify({ v: 1 }));

    const ws = await streamClient.createWriteStream(file);
    ws.write('{"v":');
    ws.destroy();
    await finished(ws).catch(() => {});

    const entries = await fsp.readdir(dir);
    assert.deepStrictEqual(entries, ["error.json"]);

    const readData = await streamClient.read(file, "utf8");
    assert.strictEqual(readData, JSON.stringify({ v: 1 }));

    await streamClient.write(file, JSON.stringify({ v: 2 }));
    const nextData = await streamClient.read(file, "utf8");
    assert.strictEqual(nextData, JSON.stringify({ v: 2 }));
  });

  await test("Durable createWriteStream preserves existing data when commit fails after temp write.", async () => {
    const streamClient = new Client({ manager: new LockManager({ errorHandler: () => {} }), durable: true });
    const dir = pth.join(WEB_ROOT, "streams", "durable-commit-error");
    const file = pth.join(dir, "data.json");
    await fsp.mkdir(dir, { recursive: true });
    await streamClient.write(file, JSON.stringify({ v: 1 }));

    const ws = await streamClient.createWriteStream(file);
    ws.write(JSON.stringify({ v: 2 }));
    ws.fsWriteStream.once("finish", () => {
      fs.rmSync((ws as unknown as { tempPath: string }).tempPath, { force: true });
    });
    ws.end();

    await finished(ws).then(
      () => {
        throw new Error("Expected durable createWriteStream to fail");
      },
      () => {}
    );

    const entries = await fsp.readdir(dir);
    assert.deepStrictEqual(entries, ["data.json"]);

    const readData = await streamClient.read(file, "utf8");
    assert.strictEqual(readData, JSON.stringify({ v: 1 }));

    await streamClient.write(file, JSON.stringify({ v: 3 }));
    const nextData = await streamClient.read(file, "utf8");
    assert.strictEqual(nextData, JSON.stringify({ v: 3 }));
  });

  await test("Durable createWriteStream reports directory sync failures after rename and releases the lock.", async () => {
    const streamClient = new Client({ manager: new LockManager({ errorHandler: () => {} }), durable: true });
    const dir = pth.join(WEB_ROOT, "streams", "durable-directory-sync-error");
    const file = pth.join(dir, "data.json");
    await fsp.mkdir(dir, { recursive: true });
    await streamClient.write(file, JSON.stringify({ v: 1 }));

    await withFailingSyncOnOpen(dir, new Error("Injected directory sync failure"), async () => {
      const ws = await streamClient.createWriteStream(file);
      ws.end(JSON.stringify({ v: 2 }));

      await finished(ws).then(
        () => {
          throw new Error("Expected durable createWriteStream to fail during directory sync");
        },
        () => {}
      );
    });

    const entries = await fsp.readdir(dir);
    assert.deepStrictEqual(entries, ["data.json"]);

    const readData = await streamClient.read(file, "utf8");
    assert.strictEqual(readData, JSON.stringify({ v: 2 }));

    await streamClient.write(file, JSON.stringify({ v: 3 }));
    const nextData = await streamClient.read(file, "utf8");
    assert.strictEqual(nextData, JSON.stringify({ v: 3 }));
  });

  await test("createWriteStream writes exact content across many small writes.", async () => {
    const streamClient = new Client({ manager: new LockManager({ errorHandler: () => {} }) });
    const dir = pth.join(WEB_ROOT, "streams");
    const file = pth.join(dir, "writev.txt");
    await fsp.mkdir(dir, { recursive: true });

    const parts = Array.from({ length: 200 }, (_, i) => `${i.toString()},`);
    const expected = parts.join("") + "done";

    const ws = await streamClient.createWriteStream(file, "utf8");
    for (const part of parts) {
      ws.write(part);
    }
    ws.end("done");
    await finished(ws);

    const data = await streamClient.read(file, "utf8");
    assert.strictEqual(data, expected);
  });

  await test("createWriteStream can commit an empty file.", async () => {
    const streamClient = new Client({ manager: new LockManager({ errorHandler: () => {} }) });
    const dir = pth.join(WEB_ROOT, "streams");
    const file = pth.join(dir, "empty.txt");
    await fsp.mkdir(dir, { recursive: true });
    await streamClient.write(file, "not empty", "utf8");

    const ws = await streamClient.createWriteStream(file);
    ws.end();
    await finished(ws);

    const data = await streamClient.read(file, "utf8");
    assert.strictEqual(data, "");

    await streamClient.write(file, "rewritten", "utf8");
    const nextData = await streamClient.read(file, "utf8");
    assert.strictEqual(nextData, "rewritten");
  });

  await test("Durable createWriteStream can commit an empty file.", async () => {
    const streamClient = new Client({ manager: new LockManager({ errorHandler: () => {} }), durable: true });
    const dir = pth.join(WEB_ROOT, "streams", "durable-empty");
    const file = pth.join(dir, "empty.txt");
    await fsp.mkdir(dir, { recursive: true });
    await streamClient.write(file, "not empty", "utf8");

    const ws = await streamClient.createWriteStream(file);
    ws.end();
    await finished(ws);

    const data = await streamClient.read(file, "utf8");
    assert.strictEqual(data, "");

    await streamClient.write(file, "rewritten", "utf8");
    const nextData = await streamClient.read(file, "utf8");
    assert.strictEqual(nextData, "rewritten");
  });

  await test("createWriteStream handles mixed Buffer and string chunks.", async () => {
    const streamClient = new Client({ manager: new LockManager({ errorHandler: () => {} }) });
    const dir = pth.join(WEB_ROOT, "streams");
    const file = pth.join(dir, "mixed-chunks.txt");
    await fsp.mkdir(dir, { recursive: true });

    const ws = await streamClient.createWriteStream(file, "utf8");
    ws.write(Buffer.from("hello", "utf8"));
    ws.write(" ");
    ws.write(Buffer.from("world", "utf8"));
    ws.end("!");
    await finished(ws);

    const data = await streamClient.read(file, "utf8");
    assert.strictEqual(data, "hello world!");
  });

  await test("createWriteStream honors configured default encoding.", async () => {
    const streamClient = new Client({ manager: new LockManager({ errorHandler: () => {} }) });
    const dir = pth.join(WEB_ROOT, "streams");
    const file = pth.join(dir, "encoding.txt");
    await fsp.mkdir(dir, { recursive: true });

    const ws = await streamClient.createWriteStream(file, { encoding: "utf16le" });
    ws.write("hello");
    ws.end(" world");
    await finished(ws);

    const data = await streamClient.read(file, "utf16le");
    assert.strictEqual(data, "hello world");
  });

  await test("createWriteStream honors explicit per-write encodings.", async () => {
    const streamClient = new Client({ manager: new LockManager({ errorHandler: () => {} }) });
    const dir = pth.join(WEB_ROOT, "streams");
    const file = pth.join(dir, "per-write-encoding.txt");
    await fsp.mkdir(dir, { recursive: true });

    const ws = await streamClient.createWriteStream(file, "utf8");
    ws.write(Buffer.from("hello ", "utf8").toString("hex"), "hex");
    ws.end(Buffer.from("world", "utf8").toString("base64"), "base64");
    await finished(ws);

    const data = await streamClient.read(file, "utf8");
    assert.strictEqual(data, "hello world");
  });

  await test("createWriteStream creates missing parent directories.", async () => {
    const streamClient = new Client({ manager: new LockManager({ errorHandler: () => {} }) });
    const dir = pth.join(WEB_ROOT, "streams", "nested", "a", "b");
    const file = pth.join(dir, "data.json");
    await fsp.rm(pth.join(WEB_ROOT, "streams", "nested"), { recursive: true, force: true });

    const ws = await streamClient.createWriteStream(file);
    ws.end(JSON.stringify({ ok: true }));
    await finished(ws);

    const data = await streamClient.read(file, "utf8");
    assert.strictEqual(data, JSON.stringify({ ok: true }));
  });

  await test("Durable createWriteStream creates missing parent directories.", async () => {
    const streamClient = new Client({ manager: new LockManager({ errorHandler: () => {} }), durable: true });
    const dir = pth.join(WEB_ROOT, "streams", "durable-nested", "a", "b");
    const file = pth.join(dir, "data.json");
    await fsp.rm(pth.join(WEB_ROOT, "streams", "durable-nested"), { recursive: true, force: true });

    const ws = await streamClient.createWriteStream(file);
    ws.end(JSON.stringify({ ok: true }));
    await finished(ws);

    const data = await streamClient.read(file, "utf8");
    assert.strictEqual(data, JSON.stringify({ ok: true }));
  });

  await test("Durable createWriteStream accepts string options.", async () => {
    const streamClient = new Client({ manager: new LockManager({ errorHandler: () => {} }), durable: true });
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
});

await suite("Client (concurrent)", async () => {
  await test("Mixed concurrent operations remain consistent under load.", async () => {
    const streamClient = new Client({ manager: new LockManager({ errorHandler: () => {} }) });
    const dir = pth.join(WEB_ROOT, "streams", "soak");
    const file = pth.join(dir, "data.json");
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.mkdir(dir, { recursive: true });

    const payloads = Array.from({ length: 13 }, (_, i) => JSON.stringify({ v: i }));
    const committed = new Set(payloads);
    await streamClient.write(file, payloads[0]);

    const operations = payloads.slice(1).flatMap((payload, i) => {
      const writeOp =
        i % 2 === 0
          ? (async () => {
              await streamClient.write(file, payload);
            })()
          : (async () => {
              const ws = await streamClient.createWriteStream(file, "utf8");
              ws.end(payload);
              await finished(ws);
            })();

      const readOp =
        i % 2 === 0
          ? (async () => {
              const data = await streamClient.read(file, "utf8");
              assert.strictEqual(committed.has(data), true);
            })()
          : (async () => {
              const rs = await streamClient.createReadStream(file, "utf8");
              const chunks: string[] = [];
              rs.on("data", (chunk) => {
                chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
              });
              await finished(rs);
              const data = chunks.join("");
              assert.strictEqual(committed.has(data), true);
            })();

      return [writeOp, readOp];
    });

    await Promise.all(operations);

    const entries = await fsp.readdir(dir);
    assert.deepStrictEqual(entries, ["data.json"]);

    await streamClient.write(file, JSON.stringify({ v: "final" }));
    const finalData = await streamClient.read(file, "utf8");
    assert.strictEqual(finalData, JSON.stringify({ v: "final" }));
  });

  await test("Durable mixed concurrent operations remain consistent under load.", async () => {
    const streamClient = new Client({ manager: new LockManager({ errorHandler: () => {} }), durable: true });
    const dir = pth.join(WEB_ROOT, "streams", "durable-soak");
    const file = pth.join(dir, "data.json");
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.mkdir(dir, { recursive: true });

    const payloads = Array.from({ length: 9 }, (_, i) => JSON.stringify({ v: i }));
    const committed = new Set(payloads);
    await streamClient.write(file, payloads[0]);

    const operations = payloads.slice(1).flatMap((payload, i) => {
      const writeOp =
        i % 2 === 0
          ? (async () => {
              await streamClient.write(file, payload);
            })()
          : (async () => {
              const ws = await streamClient.createWriteStream(file, "utf8");
              ws.end(payload);
              await finished(ws);
            })();

      const readOp =
        i % 2 === 0
          ? (async () => {
              const data = await streamClient.read(file, "utf8");
              assert.strictEqual(committed.has(data), true);
            })()
          : (async () => {
              const rs = await streamClient.createReadStream(file, "utf8");
              const chunks: string[] = [];
              rs.on("data", (chunk) => {
                chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
              });
              await finished(rs);
              const data = chunks.join("");
              assert.strictEqual(committed.has(data), true);
            })();

      return [writeOp, readOp];
    });

    await Promise.all(operations);

    const entries = await fsp.readdir(dir);
    assert.deepStrictEqual(entries, ["data.json"]);

    await streamClient.write(file, JSON.stringify({ v: "final" }));
    const finalData = await streamClient.read(file, "utf8");
    assert.strictEqual(finalData, JSON.stringify({ v: "final" }));
  });
});
