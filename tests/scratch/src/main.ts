import { once } from "node:events";
import { Client, LockManager } from "@far-analytics/persistence";

const manager = new LockManager({ errorHandler: () => {} });
const client = new Client({ manager });
await client.write("/home/null/workspace/repos/far-analytics/persistence/tests/scratch/scratch.json", "Hello, World!");
const writeStream = await client.createWriteStream("/home/null/workspace/repos/far-analytics/persistence/tests/scratch/scratch.json");
writeStream.write(JSON.stringify({ message: "Streaming Hello, World!" }) + `\n`);
writeStream.end();
await once(writeStream, "finish");
const collection = await client.collect("/home/null/workspace/repos/far-analytics/persistence/tests/scratch/");
console.log(collection);
