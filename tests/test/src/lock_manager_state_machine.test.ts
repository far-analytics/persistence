import * as pth from "node:path";
import { LockManager } from "@far-analytics/persistence";
import { test, suite } from "node:test";
import * as assert from "node:assert";
import { WEB_ROOT } from "./helpers.js";

await suite("LockManager (state-machine)", async () => {
  type RequestKind = "acquire" | "acquireAll";
  type RequestMode = "read" | "write";
  type RequestState = "pending" | "active" | "released";

  interface ModelRequest {
    id: number;
    mode: RequestMode;
    paths: string[];
    state: RequestState;
    resolved: boolean;
    lockId: number | null;
    promise: Promise<void>;
  }

  const tick = async (): Promise<void> => {
    await new Promise((r) => setImmediate(r));
    await Promise.resolve();
  };

  const makeRandom = (seed: number): (() => number) => {
    let state = seed >>> 0;
    return () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 0x100000000;
    };
  };

  const choose = <T>(random: () => number, values: T[]): T => {
    const value = values[Math.floor(random() * values.length)];
    if (value === undefined) {
      throw new Error("Cannot choose from an empty array.");
    }
    return value;
  };

  const isAncestorOrSelf = (ancestor: string, path: string): boolean => {
    const relative = pth.relative(ancestor, path);
    return relative === "" || (!relative.startsWith("..") && !pth.isAbsolute(relative));
  };

  const pathsConflict = (a: string, b: string): boolean => {
    return isAncestorOrSelf(a, b) || isAncestorOrSelf(b, a);
  };

  const requestsConflict = (a: Pick<ModelRequest, "mode" | "paths">, b: Pick<ModelRequest, "mode" | "paths">): boolean => {
    if (a.mode === "read" && b.mode === "read") {
      return false;
    }
    return a.paths.some((aPath) => b.paths.some((bPath) => pathsConflict(aPath, bPath)));
  };

  const updateExpectedState = (pending: ModelRequest[], active: ModelRequest[]): void => {
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i < pending.length; i++) {
        const request = pending[i];
        const activeConflict = active.some((activeRequest) => requestsConflict(request, activeRequest));
        const earlierPendingConflict = pending.slice(0, i).some((pendingRequest) => requestsConflict(request, pendingRequest));
        if (!activeConflict && !earlierPendingConflict) {
          pending.splice(i, 1);
          request.state = "active";
          active.push(request);
          changed = true;
          break;
        }
      }
    }
  };

  const assertModelMatchesManager = async (requests: ModelRequest[]): Promise<void> => {
    await tick();
    for (const request of requests) {
      assert.strictEqual(request.resolved, request.state !== "pending", `request ${String(request.id)} resolution state`);
      if (request.state !== "pending") {
        assert.strictEqual(typeof request.lockId, "number", `request ${String(request.id)} lock id`);
      }
    }
  };

  const readPositiveIntegerEnv = (name: string, defaultValue: number): number => {
    const raw = process.env[name];
    if (raw === undefined) {
      return defaultValue;
    }
    const value = Number.parseInt(raw, 10);
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive integer.`);
    }
    return value;
  };

  const runGeneratedSequence = async (seed: number, steps: number, baseName: string): Promise<void> => {
    const root = pth.parse(WEB_ROOT).root;
    const base = pth.join(root, "tmp", baseName, seed.toString(16));
    const acquirePaths = [
      root,
      pth.join(base, "a"),
      pth.join(base, "a", "b"),
      pth.join(base, "a", "x", "a"),
      pth.join(base, "a", "c"),
      pth.join(base, "b"),
      pth.join(base, "b", "c"),
      pth.join(base, "repeat"),
      pth.join(base, "repeat", "x", "repeat"),
    ];
    const writePaths = acquirePaths.filter((path) => path !== root);
    const acquireAllPathSets = [
      [pth.join(base, "a")],
      [pth.join(base, "a", "b"), pth.join(base, "a")],
      [pth.join(base, "a", "b", "c"), pth.join(base, "a", "b"), pth.join(base, "a")],
      [pth.join(base, "a", "b"), pth.join(base, "a", "c"), pth.join(base, "a")],
      [pth.join(base, "a", "b"), pth.join(base, "a", "b"), pth.join(base, "a")],
      [pth.join(base, "repeat", "x", "repeat"), pth.join(base, "repeat")],
      [pth.join(base, "b"), pth.join(base, "repeat")],
    ];
    const random = makeRandom(seed);
    const rootManager = new LockManager({ errorHandler: () => {} });
    const requests: ModelRequest[] = [];
    const pending: ModelRequest[] = [];
    const active: ModelRequest[] = [];
    let nextRequestId = 0;

    const addRequest = (kind: RequestKind, mode: RequestMode, paths: string[]): void => {
      const request: ModelRequest = {
        id: nextRequestId++,
        mode,
        paths,
        state: "pending",
        resolved: false,
        lockId: null,
        promise: Promise.resolve(),
      };
      const [path] = paths;
      const acquirePromise = kind === "acquireAll" ? rootManager.acquireAll(paths) : rootManager.acquire(path, mode);
      request.promise = acquirePromise.then((lockId) => {
        request.resolved = true;
        request.lockId = lockId;
      });
      requests.push(request);
      pending.push(request);
    };

    const releaseRequest = (request: ModelRequest): void => {
      if (request.lockId === null) {
        throw new Error(`request ${String(request.id)} lock id before release`);
      }
      rootManager.release(request.lockId);
      request.state = "released";
    };

    for (let step = 0; step < steps; step++) {
      if (active.length > 0 && (pending.length > 4 || random() < 0.35)) {
        const activeIndex = Math.floor(random() * active.length);
        const request = active[activeIndex];
        active.splice(activeIndex, 1);
        releaseRequest(request);
      } else if (random() < 0.25) {
        addRequest("acquireAll", "write", choose(random, acquireAllPathSets));
      } else {
        const mode: RequestMode = random() < 0.55 ? "read" : "write";
        const path = mode === "read" ? choose(random, acquirePaths) : choose(random, writePaths);
        addRequest("acquire", mode, [path]);
      }

      updateExpectedState(pending, active);
      await assertModelMatchesManager(requests);
    }

    while (active.length > 0 || pending.length > 0) {
      if (active.length > 0) {
        const request = active.shift();
        if (request === undefined) {
          throw new Error("Expected active request.");
        }
        releaseRequest(request);
      }
      updateExpectedState(pending, active);
      await assertModelMatchesManager(requests);
    }

    await Promise.all(requests.map((request) => request.promise));
    await tick();
    assert.strictEqual(rootManager.root.descendants.size, 0, `lock graph pruned for seed ${seed.toString(16)}`);
    assert.strictEqual(rootManager.root.readTail, null, `root read tail cleared for seed ${seed.toString(16)}`);
    assert.strictEqual(rootManager.root.writeTail, null, `root write tail cleared for seed ${seed.toString(16)}`);
    assert.strictEqual(rootManager.root.descendantReadTail, null, `root descendant read tail cleared for seed ${seed.toString(16)}`);
    assert.strictEqual(rootManager.root.descendantWriteTail, null, `root descendant write tail cleared for seed ${seed.toString(16)}`);
  };

  await test("generated acquire/release sequences match a reference lock model.", async () => {
    const seeds = [0x1a2b3c4d, 0x5eed1234, 0xc0ffee, 0xdecafbad, 0x12345678, 0x87654321, 0xf00d, 0xbadc0de];
    for (const seed of seeds) {
      await runGeneratedSequence(seed, 100, "test-lock-state-machine");
    }
  });

  await test(
    "optional soak stress test matches the reference lock model",
    {
      skip: process.env.PERSISTENCE_SOAK === "1" ? false : "Set PERSISTENCE_SOAK=1 to run the optional lock-manager soak test.",
      timeout: readPositiveIntegerEnv("PERSISTENCE_SOAK_TIMEOUT_MS", 120_000),
    },
    async () => {
      const seedCount = readPositiveIntegerEnv("PERSISTENCE_SOAK_SEEDS", 16);
      const steps = readPositiveIntegerEnv("PERSISTENCE_SOAK_STEPS", 2_000);
      const baseSeed = 0x51a7e000;
      for (let i = 0; i < seedCount; i++) {
        await runGeneratedSequence(baseSeed + i, steps, "test-lock-soak");
      }
    }
  );
});
