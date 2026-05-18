import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as pth from "node:path";
import { finished } from "node:stream/promises";
import { Client, LockManager } from "@far-analytics/persistence";
import { test, suite } from "node:test";
import * as assert from "node:assert";
import { WEB_ROOT } from "./helpers.js";

await suite("Client (read streams)", async () => {
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
});
