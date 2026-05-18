import * as pth from "node:path";
import { LockManager } from "@far-analytics/persistence";
import { test, suite } from "node:test";
import * as assert from "node:assert";
import { WEB_ROOT } from "./helpers.js";

await suite("LockManager", async () => {
  const tick = () => new Promise((r) => setImmediate(r));
  await test("Read does not block read; write blocks until reads release.", async () => {
    const manager = new LockManager({ errorHandler: () => {} });
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
    const manager = new LockManager({ errorHandler: () => {} });
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
    const manager = new LockManager({ errorHandler: () => {} });
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
    const manager = new LockManager({ errorHandler: () => {} });
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

  await test("Ancestor/descendant conflicts are enforced when path segments repeat.", async () => {
    const repeatManager = new LockManager({ errorHandler: () => {} });
    const childPath = "/tmp/test-lock-repeat/a/x/a";
    const parentPath = "/tmp/test-lock-repeat/a";

    const w1 = await repeatManager.acquire(childPath, "write");
    let readResolved = false;
    const rPromise = repeatManager.acquire(parentPath, "read");
    void rPromise.then(() => {
      readResolved = true;
    });
    await tick();
    assert.strictEqual(readResolved, false);
    repeatManager.release(w1);
    const rId = await rPromise;
    repeatManager.release(rId);

    const r1 = await repeatManager.acquire(childPath, "read");
    let writeResolved = false;
    const wPromise = repeatManager.acquire(parentPath, "write");
    void wPromise.then(() => {
      writeResolved = true;
    });
    await tick();
    assert.strictEqual(writeResolved, false);
    repeatManager.release(r1);
    const wId = await wPromise;
    repeatManager.release(wId);
  });

  await test("Independent paths do not block each other.", async () => {
    const manager = new LockManager({ errorHandler: () => {} });
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

  await test("Root read blocks descendant writes until released.", async () => {
    const rootManager = new LockManager({ errorHandler: () => {} });
    const root = pth.parse(WEB_ROOT).root;
    const childPath = pth.join(root, "tmp", "test-lock-root-collect");
    const c1 = await rootManager.acquire(root, "read");

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

    await test("Windows UNC shares do not conflict with each other.", async () => {
      const rootManager = new LockManager({ errorHandler: () => {} });
      const shareAPath = "\\\\server-a\\share-a\\tmp\\test-lock-unc";
      const shareBPath = "\\\\server-b\\share-b\\tmp\\test-lock-unc";
      const shareAWrite = await rootManager.acquire(shareAPath, "write");

      let shareBWriteResolved = false;
      const shareBWritePromise = rootManager.acquire(shareBPath, "write");
      void shareBWritePromise.then(() => {
        shareBWriteResolved = true;
      });
      await tick();
      assert.strictEqual(shareBWriteResolved, true);
      rootManager.release(shareAWrite);
      const shareBWrite = await shareBWritePromise;
      rootManager.release(shareBWrite);
    });

    await test("Windows UNC root reads only block descendants on the same share.", async () => {
      const rootManager = new LockManager({ errorHandler: () => {} });
      const shareARoot = "\\\\server-a\\share-a\\";
      const shareAChild = "\\\\server-a\\share-a\\tmp\\test-lock-unc-root";
      const shareBChild = "\\\\server-b\\share-b\\tmp\\test-lock-unc-root";
      const shareARead = await rootManager.acquire(shareARoot, "read");

      let shareAWriteResolved = false;
      const shareAWritePromise = rootManager.acquire(shareAChild, "write");
      void shareAWritePromise.then(() => {
        shareAWriteResolved = true;
      });

      let shareBWriteResolved = false;
      const shareBWritePromise = rootManager.acquire(shareBChild, "write");
      void shareBWritePromise.then(() => {
        shareBWriteResolved = true;
      });

      await tick();
      assert.strictEqual(shareAWriteResolved, false);
      assert.strictEqual(shareBWriteResolved, true);

      rootManager.release(shareARead);
      const shareAWrite = await shareAWritePromise;
      rootManager.release(shareAWrite);
      const shareBWrite = await shareBWritePromise;
      rootManager.release(shareBWrite);
    });
  }
  await test("Write on root is rejected.", async () => {
    const rootManager = new LockManager({ errorHandler: () => {} });
    const root = pth.parse(WEB_ROOT).root;
    await assert.rejects(rootManager.acquire(root, "write"), /Operation is not supported\./);
  });
});
