# Persistence

Persistence - a performant, durable filesystem storage layer.

## Introduction

Persistence is a filesystem persistent storage layer. It provides hierarchical read/write locking, durability, and atomic‑style writes. You can use Persistence as a drop‑in library to safely coordinate reads and writes to the filesystem. Reads on the same file are concurrent; however, reads are partitioned by writes and writes are processed in order of arrival (FIFO).

### Features

- **A _zero-dependency_ filesystem storage layer.**
- Coordinates reads and writes with hierarchical path locks.
- Provides atomic-style file replacement (temp file + rename).
- Flushes directory metadata for stronger durability on write/delete when durability is enabled.
- FIFO: for any two conflicting operations where at least one is a write, acquisition respects arrival order.

It is intentionally minimal: one lock manager, one client, one clear set of semantics.

## Usage

**Setup**

```ts
import { once } from "node:events";
import { Client, LockManager } from "@far-analytics/persistence";

const manager = new LockManager();
const client = new Client({ manager, durable: true });
```

**Write to a file**

```ts
await client.write("/tmp/example.json", JSON.stringify({ message: "Hello, World!" }));
```

**Read from a file**

```ts
const data = await client.read("/tmp/example.json", "utf8");
console.log(JSON.parse(data)); // { message: "Hello, World!" }
```

**Collect directory contents**

```ts
const entries = await client.collect("/tmp", { encoding: "utf8", withFileTypes: false });
console.log(entries); // ['example.json']
```

**Delete a file or directory**

```ts
await client.delete("/tmp/example.json");
```

**Create a write stream and write to a file**

```ts
const ws = await client.createWriteStream("/tmp/example.json");
ws.write(JSON.stringify({ message: "Streaming Hello, World!" }) + `\n`);
ws.end();
await once(ws, "finish");
```

**Create a read stream and read from a file**

```ts
const rs = await client.createReadStream("/tmp/example.json");
rs.pipe(process.stdout); // {"message":"Streaming Hello, World!"}
await once(rs, "close");
```

## Examples

### _"Hello, World!"_

Please see the [Usage](#usage) section above or the [_Hello, World!_](https://github.com/far-analytics/persistence/tree/main/examples/example) example for a working implementation.

## Locking model

- Per-operation hierarchical locking within a single `LockManager` instance.
- Write partitioned FIFO: for any two conflicting operations where at least one is a write, acquisition respects arrival order.
- Read/collect operations can overlap other reads on the same path or within the same ancestor/descendant subtree.
- Write/delete operations are exclusive: a write on a path excludes all reads and writes on that path and any ancestor/descendant paths until the write is complete.

## Horizontal scaling

Persistence supports horizontal scaling across multiple clients, as long as all operations route through a single authoritative `LockManager` (for example, a shared in-process instance or a single lock service accessed over RPC).

## Durability

When a client instance is instantiated with `{ durable: true }`, `write()` flushes file data before rename and write/delete operations `fsync` parent directories to reduce the chance of data loss after a crash. Durability guarantees are best‑effort and depend on filesystem and OS behavior.

## Atomicity

Persistence supports atomic-style file replacement via temp file + rename for `write` and `createWriteStream`.

## Limitations

- The directory structure that Persistence operates on is assumed to be hierarchical.
- Hence, symlinks/aliases are not supported.
- When durability is enabled, `fsync` on directories is considered best‑effort and behaves differently on different filesystems.
- Distributed locking or coordination across multiple independent `LockManager` instances is not supported.
- Protection against external processes that bypass the client and write directly to disk.
- Testing to date has been limited to Linux on ext4.

## Planned

- Optional lock timeout.
- Temp file cleanup utility (i.e. in the event of a crash or power loss).

## API

The _Persistence_ API provides a path-aware lock manager and a filesystem client that uses it for safe reads and writes.

### The Client class

#### new persistence.Client(options)

- options `<ClientOptions>` Options passed to the `Client`.
  - manager `<LockManager>` The lock manager instance used to coordinate access.
  - durable `<boolean>` If `true`, use stronger durability behavior for filesystem mutations: `write()` flushes the temp file before rename, and write/delete operations `fsync` the parent directory. **Default: `false`**

Use a `Client` instance to read, write, list, and delete files with hierarchical locking.

_public_ **client.durable**

- `<boolean>`

Whether durability mode is enabled for the client.

_public_ **client.collect(path, options)**

- path `<string>` An absolute path to a directory.
- options `<{ encoding: "buffer"; withFileTypes: true; recursive?: boolean }>` Optional. Enables `Dirent` output with `NonSharedBuffer` names.

Returns: `<Promise<Array<fs.Dirent<NonSharedBuffer>>>>`

_public_ **client.collect(path, options?)**

- path `<string>` An absolute path to a directory.
- options `<{ encoding: Exclude<BufferEncoding, "buffer">; withFileTypes?: false; recursive?: boolean } | Exclude<BufferEncoding, "buffer"> | null>` Optional.

Returns: `<Promise<Array<string>>>`

_public_ **client.collect(path, options)**

- path `<string>` An absolute path to a directory.
- options `<{ encoding: "buffer"; withFileTypes?: false; recursive?: boolean }>` Optional.

Returns: `<Promise<Array<NonSharedBuffer>>>`

Lists the entries in a directory. All paths must be absolute.

_public_ **client.read(path, options)**

- path `<string>` An absolute path to a file.
- options `<{ encoding: BufferEncoding; flag?: fs.OpenMode } & Abortable | BufferEncoding>` Read as text with the specified encoding.

Returns: `<Promise<string>>`

_public_ **client.read(path, options?)**

- path `<string>` An absolute path to a file.
- options `<{ encoding?: null; flag?: fs.OpenMode } & Abortable | null>` Optional.

Returns: `<Promise<NonSharedBuffer>>`

Reads a file. All paths must be absolute.

_public_ **client.createReadStream(path, options?)**

- path `<string>` An absolute path to a file.
- options `<Object>` Optional `createReadStream` options.
  - flags `<string>` File system flags. **Default:** `"r"`
  - encoding `<string | null>` **Default:** `null`
  - mode `<integer>` **Default:** `0o666`
  - emitClose `<boolean>` Emit `close` after destroy. See Node.js stream documentation.
  - start `<number>` Start offset.
  - end `<number>` End offset (inclusive).
  - signal `<AbortSignal>` Abort an in‑progress read.
  - highWaterMark `<number>` Read buffer size.

Returns: `<Promise<fs.ReadStream>>`

Creates a read stream and holds a read lock for the stream lifetime. Persistence supports the subset of `fs.createReadStream` options listed above.

_public_ **client.createWriteStream(path, options?)**

- path `<string>` An absolute path to a file.
- options `<Object | string>` Optional write stream options.
  - flags `<string>` File system flags. **Default:** `"w"`
  - encoding `<string>` **Default:** `"utf8"`
  - mode `<integer>` **Default:** `0o666`
  - emitClose `<boolean>` Emit `close` after destroy. See Node.js stream documentation.
  - start `<number>` Start offset.
  - signal `<AbortSignal>` Abort an in‑progress write.
  - highWaterMark `<number>` Write buffer size.

Returns: `<Promise<persistence.WriteStream>>`

Creates an atomic write stream abstraction backed by a temp file + rename and holds a write lock for the stream lifetime. Persistence supports the subset of write-stream options listed above.

Notes:

- The stream writes to a temp file in the target directory and renames it into place before `finish` is emitted.
- On success, `finish` means the write has been committed.
- In durable mode, the parent directory is `fsync`'d after rename.
- The lock is held for the entire stream lifetime, so long-running writes will block conflicting operations.

_public_ **client.write(path, data, options?)**

- path `<string>` An absolute path to a file.
- data `<string | Buffer | TypedArray | DataView | Iterable | AsyncIterable | Stream>` Data to write.
- options `<Object | string>` Optional `writeFile` options.
  - encoding `<string | null>` **Default:** `"utf8"`
  - mode `<integer>` **Default:** `0o666`
  - flag `<string>` **Default:** `"w"`
  - flush `<boolean>` If `true`, flush data to disk after writing. **Default:** `false`
  - signal `<AbortSignal>` Abort an in‑progress write.

Returns: `<Promise<void>>`

Writes a file using a temp file + rename. In durable mode, `write()` flushes the temp file before rename and `fsync`'s the parent directory after rename. For the full option list, see the Node.js `fs.promises.writeFile` documentation. When the `Client` is instantiated with `durable: true`, `flush` is forced to `true` regardless of the per‑call option.

_public_ **client.delete(path, options?)**

- path `<string>` An absolute path to a file or directory.
- options `<Object>` Optional `rm` options.
  - recursive `<boolean>` **Default:** `false`
  - force `<boolean>` **Default:** `false`
  - maxRetries `<number>` **Default:** `0`
  - retryDelay `<number>` **Default:** `100`
  - signal `<AbortSignal>` Abort an in‑progress remove.

Returns: `<Promise<void>>`

Deletes a file or directory. In durable mode, the parent directory is `fsync`'d. For the full option list, see the Node.js `fs.promises.rm` documentation.

### The LockManager class

#### new persistence.LockManager()

- options `<LockManagerOptions>` Optional options passed to the `LockManager`.
  - errorHandler `<typeof console.error>` **Default:** `console.error`.

Creates a hierarchical lock manager. The lock manager enforces per-operation locking for reads, writes, collects, and deletes.

_public_ **lockManager.acquire(path, type)**

- path `<string>` An absolute path.
- type `<"read" | "write" | "collect" | "delete">` The type of lock to acquire.

Returns: `<Promise<number>>`

Acquires a lock for a path and returns a lock id. Reads may overlap other reads; writes are exclusive across ancestors and descendants.

_public_ **lockManager.release(id)**

- id `<number>` A lock id previously returned by `acquire`.

Returns: `<void>`

Releases a lock by id.

_public_ **lockManager.root**

- `<GraphNode>`

The root node of the internal lock graph.

### The GraphNode interface

#### persistence.GraphNode

- segment `<string>` The path segment for this node.
- parent `<GraphNode | null>` The parent node.
- children `<Map<string, GraphNode>>` Child nodes keyed by segment.
- writeTail `<Promise<unknown> | null>` Tail promise for write locks.
- readTail `<Promise<unknown> | null>` Tail promise for read locks.

### The Artifacts interface

#### persistence.Artifacts

- locks `<Array<Promise<unknown>>>` Promises the lock acquisition must await.
- node `<GraphNode>` The graph node for the path.

## Tests

### How to run the test

#### Clone the repository.

```bash
git clone https://github.com/far-analytics/persistence
```

#### Change directory into the root of the repository.

```bash
cd persistence
```

#### Install dependencies.

```bash
npm install
```

#### Run the tests.

```bash
npm test
```

## Support

For feature requests or issues, please open an [issue](https://github.com/far-analytics/persistence/issues) or contact one of the authors.

- [Adam Patterson](https://github.com/adpatter)
