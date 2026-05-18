import * as fsp from "node:fs/promises";
import * as pth from "node:path";
import { finished } from "node:stream/promises";
import { Client, LockManager } from "@far-analytics/persistence";
import { test, suite } from "node:test";
import * as assert from "node:assert";
import { WEB_ROOT } from "./helpers.js";

await suite("Client (concurrent)", async () => {
  await test("Mixed concurrent operations remain consistent under load.", async () => {
    const streamClient = new Client({ manager: new LockManager({ errorHandler: () => {} }) });
    const dir = pth.join(WEB_ROOT, "streams", "concurrent");
    const file = pth.join(dir, "data.json");
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.mkdir(dir, { recursive: true });

    const payloads = Array.from({ length: 13 }, (_, i) => JSON.stringify({ v: i }));
    const validPayloads = new Set(payloads);
    await streamClient.write(file, payloads[0]);

    const operations = payloads.slice(1).flatMap((payload, i) => {
      const writeOp =
        i % 2 === 0
          ? (async () => {
              await streamClient.write(file, payload);
            })()
          : (async () => {
              const ws = await streamClient.createWriteStream(file, "utf8");
              ws.end(payload);
              await finished(ws);
            })();

      const readOp =
        i % 2 === 0
          ? (async () => {
              const data = await streamClient.read(file, "utf8");
              assert.strictEqual(validPayloads.has(data), true);
            })()
          : (async () => {
              const rs = await streamClient.createReadStream(file, "utf8");
              const chunks: string[] = [];
              rs.on("data", (chunk) => {
                chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
              });
              await finished(rs);
              const data = chunks.join("");
              assert.strictEqual(validPayloads.has(data), true);
            })();

      return [writeOp, readOp];
    });

    await Promise.all(operations);

    const entries = await fsp.readdir(dir);
    assert.deepStrictEqual(entries, ["data.json"]);

    await streamClient.write(file, JSON.stringify({ v: "final" }));
    const finalData = await streamClient.read(file, "utf8");
    assert.strictEqual(finalData, JSON.stringify({ v: "final" }));
  });

  await test("Durable mixed concurrent operations remain consistent under load.", async () => {
    const streamClient = new Client({ manager: new LockManager({ errorHandler: () => {} }), durable: true });
    const dir = pth.join(WEB_ROOT, "streams", "durable-concurrent");
    const file = pth.join(dir, "data.json");
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.mkdir(dir, { recursive: true });

    const payloads = Array.from({ length: 9 }, (_, i) => JSON.stringify({ v: i }));
    const validPayloads = new Set(payloads);
    await streamClient.write(file, payloads[0]);

    const operations = payloads.slice(1).flatMap((payload, i) => {
      const writeOp =
        i % 2 === 0
          ? (async () => {
              await streamClient.write(file, payload);
            })()
          : (async () => {
              const ws = await streamClient.createWriteStream(file, "utf8");
              ws.end(payload);
              await finished(ws);
            })();

      const readOp =
        i % 2 === 0
          ? (async () => {
              const data = await streamClient.read(file, "utf8");
              assert.strictEqual(validPayloads.has(data), true);
            })()
          : (async () => {
              const rs = await streamClient.createReadStream(file, "utf8");
              const chunks: string[] = [];
              rs.on("data", (chunk) => {
                chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
              });
              await finished(rs);
              const data = chunks.join("");
              assert.strictEqual(validPayloads.has(data), true);
            })();

      return [writeOp, readOp];
    });

    await Promise.all(operations);

    const entries = await fsp.readdir(dir);
    assert.deepStrictEqual(entries, ["data.json"]);

    await streamClient.write(file, JSON.stringify({ v: "final" }));
    const finalData = await streamClient.read(file, "utf8");
    assert.strictEqual(finalData, JSON.stringify({ v: "final" }));
  });
});
