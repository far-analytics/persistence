import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as pth from "node:path";
import { once } from "node:events";
import { finished } from "node:stream/promises";
import { Client, LockManager } from "@far-analytics/persistence";
import { test, suite } from "node:test";
import * as assert from "node:assert";
import { WEB_ROOT, mutableFsp, withFailingSyncOnOpen, withTimeout } from "./helpers.js";

await suite("Client (write streams)", async () => {
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

  await test("createWriteStream abort signal settles a backpressured write callback.", async () => {
    const streamClient = new Client({ manager: new LockManager({ errorHandler: () => {} }) });
    const dir = pth.join(WEB_ROOT, "streams", "backpressure-abort");
    const file = pth.join(dir, "data.txt");
    await fsp.mkdir(dir, { recursive: true });
    await streamClient.write(file, "original", "utf8");

    const controller = new AbortController();
    const ws = await streamClient.createWriteStream(file, { highWaterMark: 1, signal: controller.signal });
    const finishedPromise = withTimeout(finished(ws), "Timed out waiting for aborted write stream.");
    const writeCallback = new Promise<Error | null | undefined>((resolve) => {
      ws.write(Buffer.alloc(8 * 1024 * 1024), resolve);
    });

    controller.abort();

    await assert.rejects(finishedPromise, { name: "AbortError" });
    const writeError = await withTimeout(writeCallback, "Timed out waiting for aborted write callback.");
    assert.ok(writeError instanceof Error);
    assert.strictEqual(writeError.name, "AbortError");

    const readData = await streamClient.read(file, "utf8");
    assert.strictEqual(readData, "original");
    await streamClient.write(file, "next", "utf8");
    const nextData = await streamClient.read(file, "utf8");
    assert.strictEqual(nextData, "next");
  });

  await test("createWriteStream settles a backpressured write callback when the inner stream closes.", async () => {
    const streamClient = new Client({ manager: new LockManager({ errorHandler: () => {} }) });
    const dir = pth.join(WEB_ROOT, "streams", "backpressure-close");
    const file = pth.join(dir, "data.txt");
    await fsp.mkdir(dir, { recursive: true });
    await streamClient.write(file, "original", "utf8");

    const ws = await streamClient.createWriteStream(file, { highWaterMark: 1 });
    const finishedPromise = withTimeout(finished(ws), "Timed out waiting for closed write stream.");
    const writeCallback = new Promise<Error | null | undefined>((resolve) => {
      ws.write(Buffer.alloc(8 * 1024 * 1024), resolve);
    });

    ws.fsWriteStream.close();

    await assert.rejects(finishedPromise, /fsWriteStream closed\./);
    const writeError = await withTimeout(writeCallback, "Timed out waiting for closed write callback.");
    assert.ok(writeError instanceof Error);
    assert.match(writeError.message, /fsWriteStream closed\./);

    const readData = await streamClient.read(file, "utf8");
    assert.strictEqual(readData, "original");
    await streamClient.write(file, "next", "utf8");
    const nextData = await streamClient.read(file, "utf8");
    assert.strictEqual(nextData, "next");
  });

  await test("createWriteStream abort signal settles corked backpressured write callbacks.", async () => {
    const streamClient = new Client({ manager: new LockManager({ errorHandler: () => {} }) });
    const dir = pth.join(WEB_ROOT, "streams", "backpressure-writev-abort");
    const file = pth.join(dir, "data.txt");
    await fsp.mkdir(dir, { recursive: true });
    await streamClient.write(file, "original", "utf8");

    const controller = new AbortController();
    const ws = await streamClient.createWriteStream(file, { highWaterMark: 1, signal: controller.signal });
    const finishedPromise = withTimeout(finished(ws), "Timed out waiting for aborted writev stream.");
    const callbacks: Promise<Error | null | undefined>[] = [];
    ws.cork();
    for (let i = 0; i < 4; i++) {
      callbacks.push(
        new Promise<Error | null | undefined>((resolve) => {
          ws.write(Buffer.alloc(2 * 1024 * 1024), resolve);
        }),
      );
    }
    ws.uncork();

    controller.abort();

    await assert.rejects(finishedPromise, { name: "AbortError" });
    const writeErrors = await withTimeout(Promise.all(callbacks), "Timed out waiting for aborted writev callbacks.");
    for (const writeError of writeErrors) {
      assert.ok(writeError instanceof Error);
      assert.strictEqual(writeError.name, "AbortError");
    }

    const readData = await streamClient.read(file, "utf8");
    assert.strictEqual(readData, "original");
    await streamClient.write(file, "next", "utf8");
    const nextData = await streamClient.read(file, "utf8");
    assert.strictEqual(nextData, "next");
  });

  await test("createWriteStream settles corked backpressured write callbacks when the inner stream closes.", async () => {
    const streamClient = new Client({ manager: new LockManager({ errorHandler: () => {} }) });
    const dir = pth.join(WEB_ROOT, "streams", "backpressure-writev-close");
    const file = pth.join(dir, "data.txt");
    await fsp.mkdir(dir, { recursive: true });
    await streamClient.write(file, "original", "utf8");

    const ws = await streamClient.createWriteStream(file, { highWaterMark: 1 });
    const finishedPromise = withTimeout(finished(ws), "Timed out waiting for closed writev stream.");
    const callbacks: Promise<Error | null | undefined>[] = [];
    ws.cork();
    for (let i = 0; i < 4; i++) {
      callbacks.push(
        new Promise<Error | null | undefined>((resolve) => {
          ws.write(Buffer.alloc(2 * 1024 * 1024), resolve);
        }),
      );
    }
    ws.uncork();

    ws.fsWriteStream.close();

    await assert.rejects(finishedPromise, /fsWriteStream closed\./);
    const writeErrors = await withTimeout(Promise.all(callbacks), "Timed out waiting for closed writev callbacks.");
    for (const writeError of writeErrors) {
      assert.ok(writeError instanceof Error);
      assert.match(writeError.message, /fsWriteStream closed\./);
    }

    const readData = await streamClient.read(file, "utf8");
    assert.strictEqual(readData, "original");
    await streamClient.write(file, "next", "utf8");
    const nextData = await streamClient.read(file, "utf8");
    assert.strictEqual(nextData, "next");
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

  await test("createWriteStream preserves the original commit error when temp cleanup fails.", async () => {
    const streamClient = new Client({ manager: new LockManager({ errorHandler: () => {} }) });
    const dir = pth.join(WEB_ROOT, "streams", "cleanup-error");
    const file = pth.join(dir, "data.json");
    await fsp.mkdir(dir, { recursive: true });
    await streamClient.write(file, JSON.stringify({ v: 1 }));

    const ws = await streamClient.createWriteStream(file);
    const originalRename = mutableFsp.rename;
    const originalRm = mutableFsp.rm;
    mutableFsp.rename = () => Promise.reject(new Error("Injected rename failure"));
    mutableFsp.rm = () => Promise.reject(new Error("Injected cleanup failure"));
    try {
      ws.end(JSON.stringify({ v: 2 }));
      await assert.rejects(withTimeout(finished(ws), "Timed out waiting for commit failure."), /Injected rename failure/);
    } finally {
      mutableFsp.rename = originalRename;
      mutableFsp.rm = originalRm;
    }

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
