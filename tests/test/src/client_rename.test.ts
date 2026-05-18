import * as fsp from "node:fs/promises";
import * as pth from "node:path";
import { Client, LockManager } from "@far-analytics/persistence";
import { test, suite } from "node:test";
import * as assert from "node:assert";
import { WEB_ROOT, deferred, mutableFsp, withFailingSyncOnOpen } from "./helpers.js";

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
