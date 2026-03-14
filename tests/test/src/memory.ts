import { RWDependencyGraph } from "persistence";
import v8 from "node:v8";

if (!global.gc) {
  throw new Error();
}

const dg = new RWDependencyGraph();

const fmt = (n: number) => `${(n / (1024 * 1024)).toFixed(2)} MB`;

const snapshot = (label: string) => {
  const m = process.memoryUsage();
  console.log(`${label}: \nrss=${fmt(m.rss)} \nheapUsed=${fmt(m.heapUsed)} \nheapTotal=${fmt(m.heapTotal)} \nexternal=${fmt(m.external)}\n`);
};

global.gc();
snapshot("after-gc");

const writeSnapshot = (label: string) => {
  const file = v8.writeHeapSnapshot();
  console.log(`${label}: heap snapshot written to ${file}`);
};

if (process.env.HEAP_SNAPSHOT === "1") {
  writeSnapshot("before-loop");
}

for (let i = 0; i < 1e7; i++) {
  const uuid1 = await dg.acquire("/test", "read");
  await new Promise((r) => setImmediate(r));
  dg.release(uuid1);
  const uuid2 = await dg.acquire("/test", "write");
  await new Promise((r) => setImmediate(r));
  dg.release(uuid2);
}

if (process.env.HEAP_SNAPSHOT === "1") {
  writeSnapshot("after-loop");
}

await Promise.resolve();
await new Promise((r) => setImmediate(r));
global.gc();
snapshot("after-loop-gc");

if (process.env.HEAP_SNAPSHOT === "1") {
  writeSnapshot("after-loop-gc");
}
