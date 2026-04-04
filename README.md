# Persistence

Persistence - a persistent storage layer.

## Introduction

Persistence is a filesystem persistent storage layer. It provides hierarchical read/write locking, durability, and atomic‑style writes. You can use Persistence as a drop‑in library to safely coordinate reads and writes to the filesystem. Reads on the same file are concurrent; however, reads are partitioned by writes and writes are processed in order of arrival (FIFO).

### Features

- Coordinates reads and writes with hierarchical path locks.
- Provides atomic-style file replacement (temp file + rename).
- Flushes directory metadata for stronger durability on write/delete when durability is enabled.
- FIFO: for any two conflicting operations where at least one is a write, acquisition respects arrival order.

It is intentionally minimal: one lock manager, one client, one clear set of semantics.

## Usage

### Setup

```ts
import { Client, LockManager } from "persistence";

const manager = new LockManager();
const client = new Client({ manager, durable: true });
```

### Write to a file

```ts
await client.write("/tmp/example.json", JSON.stringify({ message: "Hello, World!" }));
```

### Read a file

```ts
const data = await client.read("/tmp/example.json", "utf8");
console.log(JSON.parse(data)); // { message: "Hello, World!" }
```

### Collect directory contents

```ts
const entries = await client.collect("/tmp", { encoding: "utf8", withFileTypes: false });
console.log(entries);
```

### Delete a file or directory

```ts
await client.delete("/tmp/example.json");
```

### Create a read stream

```ts
const rs = await client.createReadStream("/tmp/example.json");
rs.pipe(process.stdout);
```

### Create a write stream

```ts
const ws = await client.createWriteStream("/tmp/example2.json");
ws.write(JSON.stringify({ message: "Streaming write" }));
ws.end();
```

## Locking model

- Per-operation hierarchical locking within a single `LockManager` instance.
- Write partitioned FIFO: for any two conflicting operations where at least one is a write, acquisition respects arrival order.
- Read/collect operations can overlap other reads on the same path or within the same ancestor/descendant subtree.
- Write/delete operations are exclusive: a write on a path excludes all reads and writes on that path and any ancestor/descendant paths until the write is complete.

## Durability

When a client instance is instantiated with `{ durable: true }`, writes are flushed and parent directories are `fsync`’d to reduce the chance of data loss after a crash. Durability guarantees are best‑effort and depend on filesystem and OS behavior.

## Atomicity

- Atomic-style file replacement via temp file + rename for `write` and `createWriteStream`.

## Limitations

- The directory structure that Persistence operates on is assumed to be hierarchical.
- Hence, symlinks/aliases are not supported.
- When durability is enabled, `fsync` on directories is considered best‑effort and behaves differently on different filesystems.
- Distributed locking or coordination across multiple independent `LockManager` instances is not supported.
- Protection against external processes that bypass the client and write directly to disk.
- Testing to date has been limited to Linux on ext4.

## Planned

- Optional lock timeout / abort signal.
- Temp file cleanup utility (i.e. in the event of a crash or power loss).
- A couple more tests for symlink/path edge cases.

## API

The _Persistence_ API provides a path-aware lock manager and a filesystem client that uses it for safe reads and writes.

### The Client class

#### new persistence.Client(options)

- options `<ClientOptions>` Options passed to the `Client`.
- manager `<LockManager>` The lock manager instance used to coordinate access.
- tempSuffix `<string>` Optional temp filename suffix used during atomic-style writes. **Default: `"tmp"`**
- durable `<boolean>` If `true`, use directory `fsync` and flush writes for stronger durability. **Default: `false`**

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
- options `<Parameters<typeof fs.createReadStream>[1]>` Optional `createReadStream` options.

Returns: `<Promise<fs.ReadStream>>`

Creates a read stream and holds a read lock for the stream lifetime.

_public_ **client.createWriteStream(path, options?)**

- path `<string>` An absolute path to a file.
- options `<Parameters<typeof fs.createWriteStream>[1]>` Optional `createWriteStream` options.

Returns: `<Promise<fs.WriteStream>>`

Creates an atomic write stream (temp file + rename) and holds a write lock for the stream lifetime.

Notes:

- The stream writes to a temp file in the target directory and renames on `close`.
- The lock is held for the entire stream lifetime, so long-running writes will block conflicting operations.

_public_ **client.write(path, data, options?)**

- path `<string>` An absolute path to a file.
- data `<Parameters<typeof fs.promises.writeFile>[1]>` Data to write.
- options `<Parameters<typeof fs.promises.writeFile>[2]>` Optional `writeFile` options.

Returns: `<Promise<void>>`

Writes a file using a temp file + rename. In durable mode, writes are flushed and directories are `fsync`'d.

_public_ **client.delete(path, options?)**

- path `<string>` An absolute path to a file or directory.
- options `<Parameters<typeof fs.promises.rm>[1]>` Optional `rm` options.

Returns: `<Promise<void>>`

Deletes a file or directory. In durable mode, the parent directory is `fsync`'d.

### The LockManager class

#### new persistence.LockManager()

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

## Test

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
npm install && npm update
```

#### Run the tests.

```bash
npm test
```

## License

MIT

## Support

For feature requests or issues, please open an [issue](https://github.com/far-analytics/persistence/issues) or contact one of the authors.

- [Adam Patterson](https://github.com/adpatter)
