import * as pth from "node:path";
import { LockManager } from "@far-analytics/persistence";
import { test, suite } from "node:test";
import * as assert from "node:assert";
import { WEB_ROOT } from "./helpers.js";

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

    await assert.rejects(rootManager.acquireAll([validPath, root]), /Operation is not supported\./);

    assert.strictEqual(rootManager.root.descendants.size, 0);
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

  await test("acquireAll is order-independent for nested path sets.", async () => {
    const root = pth.parse(WEB_ROOT).root;
    const basePath = pth.join(root, "tmp", "test-lock-acquire-all-order");
    const parentPath = pth.join(basePath, "a");
    const childPath = pth.join(parentPath, "b");
    const grandchildPath = pth.join(childPath, "c");
    const siblingPath = pth.join(parentPath, "d");
    const repeatedParentPath = pth.join(basePath, "repeat");
    const repeatedChildPath = pth.join(repeatedParentPath, "x", "repeat");
    const scenarios = [
      { name: "child before parent", paths: [childPath, parentPath] },
      { name: "grandchild before child before parent", paths: [grandchildPath, childPath, parentPath] },
      { name: "sibling descendants before parent", paths: [childPath, siblingPath, parentPath] },
      { name: "duplicate child before parent", paths: [childPath, childPath, parentPath] },
      { name: "repeated segment child before parent", paths: [repeatedChildPath, repeatedParentPath] },
    ];

    for (const scenario of scenarios) {
      const rootManager = new LockManager({ errorHandler: () => {} });
      let acquireAllResolved = false;
      const acquireAllPromise = rootManager.acquireAll(scenario.paths);
      void acquireAllPromise.then(() => {
        acquireAllResolved = true;
      });

      await tick();
      assert.strictEqual(acquireAllResolved, true, scenario.name);

      const acquireAllId = await acquireAllPromise;
      rootManager.release(acquireAllId);
    }
  });

  await test("acquireAll descendant-before-ancestor blocks conflicts across the combined lock.", async () => {
    const rootManager = new LockManager({ errorHandler: () => {} });
    const root = pth.parse(WEB_ROOT).root;
    const parentPath = pth.join(root, "tmp", "test-lock-acquire-all-desc-first-block", "a");
    const childPath = pth.join(parentPath, "b");
    const unrelatedPath = pth.join(root, "tmp", "test-lock-acquire-all-desc-first-block", "unrelated");

    const acquireAllId = await rootManager.acquireAll([childPath, parentPath]);

    let parentWriteResolved = false;
    const parentWritePromise = rootManager.acquire(parentPath, "write");
    void parentWritePromise.then(() => {
      parentWriteResolved = true;
    });

    let childReadResolved = false;
    const childReadPromise = rootManager.acquire(childPath, "read");
    void childReadPromise.then(() => {
      childReadResolved = true;
    });

    let unrelatedWriteResolved = false;
    const unrelatedWritePromise = rootManager.acquire(unrelatedPath, "write");
    void unrelatedWritePromise.then(() => {
      unrelatedWriteResolved = true;
    });

    await tick();
    assert.strictEqual(parentWriteResolved, false);
    assert.strictEqual(childReadResolved, false);
    assert.strictEqual(unrelatedWriteResolved, true);

    rootManager.release(acquireAllId);
    const parentWriteId = await parentWritePromise;
    rootManager.release(parentWriteId);
    const childReadId = await childReadPromise;
    rootManager.release(childReadId);
    const unrelatedWriteId = await unrelatedWritePromise;
    rootManager.release(unrelatedWriteId);
  });

  await test("acquireAll descendant-before-ancestor waits for earlier conflicting locks.", async () => {
    const rootManager = new LockManager({ errorHandler: () => {} });
    const root = pth.parse(WEB_ROOT).root;
    const parentPath = pth.join(root, "tmp", "test-lock-acquire-all-desc-first-fifo", "a");
    const childPath = pth.join(parentPath, "b");

    const readId = await rootManager.acquire(parentPath, "read");
    let acquireAllResolved = false;
    const acquireAllPromise = rootManager.acquireAll([childPath, parentPath]);
    void acquireAllPromise.then(() => {
      acquireAllResolved = true;
    });

    await tick();
    assert.strictEqual(acquireAllResolved, false);

    rootManager.release(readId);
    await tick();
    assert.strictEqual(acquireAllResolved, true);

    const acquireAllId = await acquireAllPromise;
    rootManager.release(acquireAllId);
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
