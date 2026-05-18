import * as fsp from "node:fs/promises";
import * as pth from "node:path";
import { Client, LockManager } from "@far-analytics/persistence";
import { test, suite } from "node:test";
import * as assert from "node:assert";
import { WEB_ROOT } from "./helpers.js";

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

await suite("Client (read)", async () => {
  await test("Read on root is rejected.", async () => {
    const client = new Client({ manager: new LockManager({ errorHandler: () => {} }) });
    const root = pth.parse(WEB_ROOT).root;
    await assert.rejects(client.read(root), /Operations on root are not supported\./);
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
