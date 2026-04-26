import { once } from "node:events";
import { Client, LockManager } from "@far-analytics/persistence";

const manager = new LockManager({ errorHandler: () => {} });
const client = new Client({ manager });
const writeStream = await client.createWriteStream("/home/null/workspace/repos/far-analytics/persistence/tests/scratch/scratch.json");
writeStream.write(JSON.stringify({ message: "Streaming Hello, World!" }) + `\n`);
writeStream.end();
await once(writeStream, "finish");
