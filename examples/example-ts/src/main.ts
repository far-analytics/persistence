// Setup
import { once } from "node:events";
import { Client, LockManager } from "@far-analytics/persistence";

const manager = new LockManager();
const client = new Client({ manager, durable: true });

// Write to a file
await client.write("/tmp/example.json", JSON.stringify({ message: "Hello, World!" }));

// Read from a file
const data = await client.read("/tmp/example.json", "utf8");
console.log(JSON.parse(data)); // { message: "Hello, World!" }

// Collect directory contents
const entries = await client.collect("/tmp", { encoding: "utf8", withFileTypes: false });
console.log(entries); // ['example.json']

// Delete a file or directory
await client.delete("/tmp/example.json");

// Create a write stream and write to a file
const writeStream = await client.createWriteStream("/tmp/example.json");
writeStream.write(JSON.stringify({ message: "Streaming Hello, World!" }) + "\n");
writeStream.end();
await once(writeStream, "finish");

// Create a read stream and read from a file
const readStream = await client.createReadStream("/tmp/example.json");
readStream.pipe(process.stdout); // {"message":"Streaming Hello, World!"}
await once(readStream, "close");
