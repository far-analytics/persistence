# _"Hello, World!"_

## Introduction

In this example you will use Persistence in order to read, write, stream, and list files on the local filesystem.

## Implement the example

### Implement the `main.ts` module

#### Import `Client` and `LockManager`.

```ts
import { Client, LockManager } from "@far-analytics/persistence";
```

#### Create an instance of a `LockManager` and `Client`.

```ts
const manager = new LockManager();
const client = new Client({ manager, durable: true });
```

#### Write a file and read it back.

```ts
await client.write("/tmp/example.json", JSON.stringify({ message: "Hello, World!" }));

const data = await client.read("/tmp/example.json", "utf8");
console.log(JSON.parse(data)); // { message: "Hello, World!" }
```

#### Collect directory contents.

```ts
const entries = await client.collect("/tmp", { encoding: "utf8", withFileTypes: false });
console.log(entries); // ['example.json']
```

#### Stream a write and read it back.

```ts
const writeStream = await client.createWriteStream("/tmp/example.json");
writeStream.write(JSON.stringify({ message: "Streaming Hello, World!" }) + "\n");
writeStream.end();
await once(writeStream, "finish");

const readStream = await client.createReadStream("/tmp/example.json");
readStream.pipe(process.stdout); // {"message":"Streaming Hello, World!"}
await once(readStream, "close");
```

## Run the example

### How to run the example

#### Clone the Persistence repository.

```bash
git clone https://github.com/far-analytics/persistence.git
```

#### Change directory into the example.

```bash
cd persistence/examples/example-ts
```

#### Install the example dependencies.

```bash
npm install
```

#### Build the application.

```bash
npm run clean:build
```

#### Run the application.

```bash
npm start
```

##### Output

```bash
{ message: 'Hello, World!' }
[ 'example.json', ... ]
{"message":"Streaming Hello, World!"}
```
