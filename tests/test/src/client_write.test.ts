import * as fsp from "node:fs/promises";
import * as pth from "node:path";
import { Client, LockManager } from "@far-analytics/persistence";
import { test, suite } from "node:test";
import * as assert from "node:assert";
import { WEB_ROOT, withFailingSyncOnOpen } from "./helpers.js";

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
