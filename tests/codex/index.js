"use strict";

const assert = require("node:assert/strict");
const { performance } = require("node:perf_hooks");
const { RWDependencyGraph } = require("../../dist/index.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const flush = async () => {
  await Promise.resolve();
  await new Promise((r) => setImmediate(r));
};

const main = async () => {
  const graph = new RWDependencyGraph();
  const path = "file://alpha";
  const timeline = [];

  const mark = (name, phase) => {
    timeline.push({ name, phase, t: performance.now() });
  };

  const r1 = (async () => {
    const release = await graph.acquire(path, "read");
    mark("r1", "acquired");
    await sleep(60);
    graph.release(release);
    mark("r1", "released");
  })();

  await sleep(10);

  const r2 = (async () => {
    const release = await graph.acquire(path, "read");
    mark("r2", "acquired");
    await sleep(60);
    graph.release(release);
    mark("r2", "released");
  })();

  await sleep(10);

  const w1 = (async () => {
    const release = await graph.acquire(path, "write");
    mark("w1", "acquired");
    await sleep(30);
    graph.release(release);
    mark("w1", "released");
  })();

  await sleep(10);

  const r3 = (async () => {
    const release = await graph.acquire(path, "read");
    mark("r3", "acquired");
    await sleep(10);
    graph.release(release);
    mark("r3", "released");
  })();

  await Promise.all([r1, r2, w1, r3]);

  const timeOf = (name, phase) => {
    const hit = timeline.find((e) => e.name === name && e.phase === phase);
    assert.ok(hit, `Missing timeline entry ${name}:${phase}`);
    return hit.t;
  };

  assert.ok(
    timeOf("r2", "acquired") < timeOf("r1", "released"),
    "reads should overlap; r2 must acquire before r1 releases"
  );

  assert.ok(
    timeOf("w1", "acquired") >= timeOf("r1", "released") &&
      timeOf("w1", "acquired") >= timeOf("r2", "released"),
    "write must wait for prior reads to release"
  );

  assert.ok(
    timeOf("r3", "acquired") >= timeOf("w1", "released"),
    "read after queued write must wait for the write"
  );

  // If the cleanup logic works, both maps should be empty after all releases.
  await flush();
  assert.equal(graph.pathToRead.size, 0, "read map should be empty");
  assert.equal(graph.pathToWrite.size, 0, "write map should be empty");

  // Stress test: randomized mixed reads/writes across multiple paths.
  const lcg = (() => {
    let state = 0xdeadbeef;
    return () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 0xffffffff;
    };
  })();

  const paths = ["file://a", "file://b", "file://c"];
  const activeReads = new Map(paths.map((p) => [p, 0]));
  const activeWrites = new Map(paths.map((p) => [p, 0]));

  const ops = [];
  const rounds = 5;
  const opCount = 600;
  for (let round = 0; round < rounds; round++) {
    for (let i = 0; i < opCount; i++) {
      const p = paths[Math.floor(lcg() * paths.length)];
      const type = lcg() < 0.7 ? "read" : "write";
      const startDelay = Math.floor(lcg() * 12);
      const holdDelay = 3 + Math.floor(lcg() * 20);

      ops.push(
        (async () => {
          await sleep(startDelay);
          const release = await graph.acquire(p, type);

          if (type === "read") {
            assert.equal(activeWrites.get(p), 0, "read acquired while write active");
            activeReads.set(p, activeReads.get(p) + 1);
          } else {
            assert.equal(activeWrites.get(p), 0, "write acquired while write active");
            assert.equal(activeReads.get(p), 0, "write acquired while reads active");
            activeWrites.set(p, 1);
          }

          await sleep(holdDelay);

          if (type === "read") {
            activeReads.set(p, activeReads.get(p) - 1);
          } else {
            activeWrites.set(p, 0);
          }

          graph.release(release);
        })()
      );
    }

    await Promise.all(ops.splice(0, ops.length));
  }

  await flush();
  for (const p of paths) {
    assert.equal(activeReads.get(p), 0, "reads should be drained");
    assert.equal(activeWrites.get(p), 0, "writes should be drained");
  }
  assert.equal(graph.pathToRead.size, 0, "read map should be empty after stress");
  assert.equal(graph.pathToWrite.size, 0, "write map should be empty after stress");

  // Isolation test: different paths should not block each other.
  const iso = [];
  const markIso = (label) => iso.push({ label, t: performance.now() });
  const pathA = "file://iso-a";
  const pathB = "file://iso-b";

  const wA = (async () => {
    const release = await graph.acquire(pathA, "write");
    markIso("wA-acq");
    await sleep(40);
    graph.release(release);
    markIso("wA-rel");
  })();

  await sleep(5);

  const rB = (async () => {
    const release = await graph.acquire(pathB, "read");
    markIso("rB-acq");
    await sleep(10);
    graph.release(release);
    markIso("rB-rel");
  })();

  await Promise.all([wA, rB]);
  const t = (label) => {
    const hit = iso.find((e) => e.label === label);
    assert.ok(hit, `Missing iso entry ${label}`);
    return hit.t;
  };
  assert.ok(
    t("rB-acq") < t("wA-rel"),
    "operations on different paths should overlap"
  );

  // Soak test: repeat mixed workloads and verify maps drain every round.
  const soakRounds = 8;
  const soakOps = 400;
  for (let round = 0; round < soakRounds; round++) {
    const soak = [];
    for (let i = 0; i < soakOps; i++) {
      const p = paths[Math.floor(lcg() * paths.length)];
      const type = lcg() < 0.65 ? "read" : "write";
      const startDelay = Math.floor(lcg() * 8);
      const holdDelay = 2 + Math.floor(lcg() * 12);

      soak.push(
        (async () => {
          await sleep(startDelay);
          const release = await graph.acquire(p, type);

          if (type === "read") {
            assert.equal(activeWrites.get(p), 0, "read acquired while write active");
            activeReads.set(p, activeReads.get(p) + 1);
          } else {
            assert.equal(activeWrites.get(p), 0, "write acquired while write active");
            assert.equal(activeReads.get(p), 0, "write acquired while reads active");
            activeWrites.set(p, 1);
          }

          await sleep(holdDelay);

          if (type === "read") {
            activeReads.set(p, activeReads.get(p) - 1);
          } else {
            activeWrites.set(p, 0);
          }

          graph.release(release);
        })()
      );
    }

    await Promise.all(soak);
  await flush();
  assert.equal(graph.pathToRead.size, 0, "read map should be empty after soak");
  assert.equal(graph.pathToWrite.size, 0, "write map should be empty after soak");
  }

  // Chaos test: time-bounded random workload with occasional long holds.
  const chaosMs = Number.parseInt(process.env.CHAOS_MS || "20000", 10);
  const chaosUntil = performance.now() + chaosMs;
  const chaosWorkers = 10;
  const chaosOps = [];

  for (let w = 0; w < chaosWorkers; w++) {
    chaosOps.push(
      (async () => {
        while (performance.now() < chaosUntil) {
          const p = paths[Math.floor(lcg() * paths.length)];
          const type = lcg() < 0.68 ? "read" : "write";
          const startDelay = Math.floor(lcg() * 6);
          const holdDelay =
            lcg() < 0.08 ? 200 + Math.floor(lcg() * 200) : 2 + Math.floor(lcg() * 16);

          await sleep(startDelay);
          const release = await graph.acquire(p, type);

          if (type === "read") {
            assert.equal(activeWrites.get(p), 0, "read acquired while write active");
            activeReads.set(p, activeReads.get(p) + 1);
          } else {
            assert.equal(activeWrites.get(p), 0, "write acquired while write active");
            assert.equal(activeReads.get(p), 0, "write acquired while reads active");
            activeWrites.set(p, 1);
          }

          await sleep(holdDelay);

          if (type === "read") {
            activeReads.set(p, activeReads.get(p) - 1);
          } else {
            activeWrites.set(p, 0);
          }

          graph.release(release);
        }
      })()
    );
  }

  await Promise.all(chaosOps);
  await flush();
  for (const p of paths) {
    assert.equal(activeReads.get(p), 0, "reads should be drained after chaos");
    assert.equal(activeWrites.get(p), 0, "writes should be drained after chaos");
  }
  assert.equal(graph.pathToRead.size, 0, "read map should be empty after chaos");
  assert.equal(graph.pathToWrite.size, 0, "write map should be empty after chaos");

  // Burst test: many reads, then many writes, then many reads.
  const burstPath = "file://burst";
  const burstOrder = [];
  const markBurst = (label) => burstOrder.push(label);

  const earlyBurstReads = Array.from({ length: 40 }, (_, i) =>
    (async () => {
      const release = await graph.acquire(burstPath, "read");
      markBurst(`rE${i}-acq`);
      await sleep(15);
      graph.release(release);
      markBurst(`rE${i}-rel`);
    })()
  );

  await sleep(5);

  const burstWrites = Array.from({ length: 12 }, (_, i) =>
    (async () => {
      const release = await graph.acquire(burstPath, "write");
      markBurst(`w${i}-acq`);
      await sleep(10);
      graph.release(release);
      markBurst(`w${i}-rel`);
    })()
  );

  await sleep(5);

  const lateBurstReads = Array.from({ length: 40 }, (_, i) =>
    (async () => {
      const release = await graph.acquire(burstPath, "read");
      markBurst(`rL${i}-acq`);
      await sleep(5);
      graph.release(release);
      markBurst(`rL${i}-rel`);
    })()
  );

  await Promise.all([...earlyBurstReads, ...burstWrites, ...lateBurstReads]);
  await flush();

  const lastWriteRelIdx = burstOrder
    .map((v, idx) => (v.startsWith("w") && v.endsWith("-rel") ? idx : -1))
    .filter((v) => v !== -1)
    .pop();
  assert.ok(lastWriteRelIdx !== undefined, "burst writes should complete");

  for (const entry of burstOrder) {
    if (entry.startsWith("rL") && entry.endsWith("-acq")) {
      assert.ok(
        burstOrder.indexOf(entry) > lastWriteRelIdx,
        "late burst reads must acquire after last burst write"
      );
    }
  }

  // Writers should acquire in FIFO order.
  const writeAcquireOrder = burstOrder
    .filter((v) => v.startsWith("w") && v.endsWith("-acq"))
    .map((v) => Number.parseInt(v.slice(1), 10));
  for (let i = 1; i < writeAcquireOrder.length; i++) {
    assert.ok(
      writeAcquireOrder[i] > writeAcquireOrder[i - 1],
      "writers should acquire in FIFO order"
    );
  }

  // FIFO boundary test (reads and writes should respect arrival order).
  // Scenario: W0 holds, R1 queues, W1 queues. FIFO means R1 should acquire
  // before W1 once W0 releases.
  const prefPath = "file://writer-pref";
  const prefOrder = [];
  const markPref = (label) => prefOrder.push(label);

  const w0 = (async () => {
    const release = await graph.acquire(prefPath, "write");
    markPref("w0-acq");
    await sleep(30);
    graph.release(release);
    markPref("w0-rel");
  })();

  await sleep(5);

  const prefR1 = (async () => {
    const release = await graph.acquire(prefPath, "read");
    markPref("r1-acq");
    await sleep(10);
    graph.release(release);
    markPref("r1-rel");
  })();

  await sleep(5);

  const prefW1 = (async () => {
    const release = await graph.acquire(prefPath, "write");
    markPref("w1-acq");
    await sleep(10);
    graph.release(release);
    markPref("w1-rel");
  })();

  await Promise.all([w0, prefR1, prefW1]);
  await flush();

  const w1Acq = prefOrder.indexOf("w1-acq");
  const r1Acq = prefOrder.indexOf("r1-acq");
  assert.ok(w1Acq !== -1 && r1Acq !== -1, "fifo: missing acquire");
  assert.ok(
    r1Acq < w1Acq,
    "fifo: read queued before write should acquire first"
  );

  // Adversarial ordering: many reads, then a write, then reads.
  const order = [];
  const markOrder = (label) => order.push(label);
  const path2 = "file://order";

  const earlyReads = Array.from({ length: 10 }, (_, i) =>
    (async () => {
      const release = await graph.acquire(path2, "read");
      markOrder(`r${i}-acq`);
      await sleep(20);
      graph.release(release);
      markOrder(`r${i}-rel`);
    })()
  );

  await sleep(5);

  const w = (async () => {
    const release = await graph.acquire(path2, "write");
    markOrder("w-acq");
    await sleep(10);
    graph.release(release);
    markOrder("w-rel");
  })();

  await sleep(5);

  const lateReads = Array.from({ length: 5 }, (_, i) =>
    (async () => {
      const release = await graph.acquire(path2, "read");
      markOrder(`rL${i}-acq`);
      await sleep(5);
      graph.release(release);
      markOrder(`rL${i}-rel`);
    })()
  );

  await Promise.all([...earlyReads, w, ...lateReads]);

  const wAcq = order.indexOf("w-acq");
  const wRel = order.indexOf("w-rel");
  assert.ok(wAcq !== -1 && wRel !== -1, "writer should have acquired and released");
  for (const entry of order) {
    if (entry.startsWith("rL") && entry.endsWith("-acq")) {
      assert.ok(order.indexOf(entry) > wRel, "late reads must acquire after writer");
    }
  }

  // Single-path hammer: extreme contention on one path.
  const hammerPath = "file://hammer";
  const hammerReads = new Map([[hammerPath, 0]]);
  const hammerWrites = new Map([[hammerPath, 0]]);
  const hammerOps = [];
  const hammerCount = 2000;

  for (let i = 0; i < hammerCount; i++) {
    const type = lcg() < 0.7 ? "read" : "write";
    const startDelay = Math.floor(lcg() * 5);
    const holdDelay = 1 + Math.floor(lcg() * 8);

    hammerOps.push(
      (async () => {
        await sleep(startDelay);
        const release = await graph.acquire(hammerPath, type);

        if (type === "read") {
          assert.equal(hammerWrites.get(hammerPath), 0, "hammer read while write active");
          hammerReads.set(hammerPath, hammerReads.get(hammerPath) + 1);
        } else {
          assert.equal(hammerWrites.get(hammerPath), 0, "hammer write while write active");
          assert.equal(hammerReads.get(hammerPath), 0, "hammer write while reads active");
          hammerWrites.set(hammerPath, 1);
        }

        await sleep(holdDelay);

        if (type === "read") {
          hammerReads.set(hammerPath, hammerReads.get(hammerPath) - 1);
        } else {
          hammerWrites.set(hammerPath, 0);
        }

        graph.release(release);
      })()
    );
  }

  await Promise.all(hammerOps);
  await flush();
  assert.equal(hammerReads.get(hammerPath), 0, "hammer reads should be drained");
  assert.equal(hammerWrites.get(hammerPath), 0, "hammer writes should be drained");
  assert.equal(graph.pathToRead.size, 0, "read map should be empty after hammer");
  assert.equal(graph.pathToWrite.size, 0, "write map should be empty after hammer");

  // Reentrancy deadlock test: read->write on same path should block.
  const deadlockPath = "file://deadlock";
  const readRelease = await graph.acquire(deadlockPath, "read");
  let writeAcquired = false;
  const writeAttempt = (async () => {
    const release = await graph.acquire(deadlockPath, "write");
    writeAcquired = true;
    graph.release(release);
  })();
  const timeout = new Promise((r) => setTimeout(r, 50, "timeout"));
  const result = await Promise.race([writeAttempt.then(() => "acquired"), timeout]);
  assert.equal(result, "timeout", "write should not acquire while read is held");
  graph.release(readRelease);
  await writeAttempt;
  assert.ok(writeAcquired, "write should acquire after read releases");

  // Multi-path fairness: heavy contention on one path shouldn't block another.
  const busyPath = "file://busy";
  const freePath = "file://free";
  const busyWrite = (async () => {
    const release = await graph.acquire(busyPath, "write");
    await sleep(80);
    graph.release(release);
  })();
  await sleep(5);
  const freeReadStart = performance.now();
  const freeRead = (async () => {
    const release = await graph.acquire(freePath, "read");
    const acquiredAt = performance.now();
    graph.release(release);
    return acquiredAt;
  })();
  const acquiredAt = await freeRead;
  await busyWrite;
  assert.ok(
    acquiredAt - freeReadStart < 40,
    "free path read should not be blocked by busy path write"
  );

  console.log("RWDependencyGraph semantics verified.");
};

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
