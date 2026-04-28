# Persistence

Persistence - a filesystem-backed persistence layer with hierarchical RW locking, atomic-style writes, and optional durability.

## Introduction

Persistence is a filesystem-backed persistence layer. It provides hierarchical read/write locking, optional durability, and atomic‑style writes. You can use Persistence as a drop-in library to safely coordinate reads and writes to the filesystem. Reads on the same file are concurrent; however, reads are partitioned by writes and conflicting writes are processed in order of arrival (FIFO).

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
const writeStream = await client.createWriteStream("/tmp/example.json");
writeStream.write(JSON.stringify({ message: "Streaming Hello, World!" }) + `\n`);
writeStream.end();
await once(writeStream, "finish");
```

**Create a read stream and read from a file**

```ts
const readStream = await client.createReadStream("/tmp/example.json");
readStream.pipe(process.stdout); // {"message":"Streaming Hello, World!"}
await once(readStream, "close");
```

## Examples

### _"Hello, World!"_ (TypeScript)

Please see the TypeScript [example](https://github.com/far-analytics/persistence/tree/main/examples/example-ts) for a working implementation.

### _"Hello, World!"_ (Node.js)

Please see the Node.js [example](https://github.com/far-analytics/persistence/tree/main/examples/example-nodejs) for a working implementation.

## Locking model

- Per-operation hierarchical locking within a single `LockManager` instance.
- Write partitioned FIFO: for any two conflicting operations where at least one is a write, acquisition respects arrival order.
- Read/collect operations can overlap other reads on the same path or within the same ancestor/descendant subtree.
- Write/delete operations are exclusive: a write on a path excludes all reads and writes on that path and any ancestor/descendant paths until the write is complete.

## Horizontal scaling

Persistence supports horizontal scaling across multiple clients, as long as all operations route through a single authoritative `LockManager` (for example, a shared in-process instance or a single lock service accessed over RPC).

## Durability

When a client instance is instantiated with `{ durable: true }`, `client.write` and `client.createWriteStream` flush temp file data before rename and then `fsync`s the parent directory. `client.delete` operations `fsync` the parent directory. Durability guarantees are best‑effort and depend on filesystem and OS behavior.

Important semantic note:

In durable mode, some operations perform a filesystem mutation first and then execute a final durability step such as `fsync` on the parent directory. If that final durability step fails, the operation rejects even though the mutation may already be visible on disk. In particular, a durable `client.write` or `client.createWriteStream` may have already renamed the new file into place before rejecting, and a durable `client.delete` may already have removed the target before rejecting. Callers must not interpret every durable-mode rejection as "no change was applied". A rejection can also mean "the mutation was applied, but final durability confirmation failed".

## Atomicity

Persistence supports atomic-style file replacement via temp file + rename for `write` and `createWriteStream`.

## Limitations

- The directory structure that Persistence operates on is assumed to be hierarchical.
- Hence, symlinks/aliases are not supported.
- Filesystem root-path operations are restricted: `collect(root)` is supported, but `read(root)`, `write(root)`, and `delete(root)` are not.
- When durability is enabled, `fsync` on directories is considered best‑effort and behaves differently on different filesystems.
- Distributed locking or coordination across multiple independent `LockManager` instances is not supported.
- Protection against external processes that bypass the client and write directly to disk.
- Testing to date has been limited to Linux on ext4.

## Planned

- Optional lock timeout.

## API

The _Persistence_ API provides a path-aware lock manager and a filesystem client that uses it for safe reads and writes.

### The Client class

#### new persistence.Client(options)

- options `<ClientOptions>` Options passed to the `Client`.
  - manager `<LockManager>` The lock manager instance used to coordinate access.
  - durable `<boolean>` If `true`, use stronger durability behavior for filesystem mutations: `client.write` and `client.createWriteStream` flush the temp file before rename and then `fsync` the parent directory. `client.delete` operations `fsync` the parent directory. **Default: `false`**

Use a `Client` instance to read, write, list, and delete files with hierarchical locking.

_public_ **client.durable**

- `<boolean>`

Whether durability mode is enabled for the client.

_public_ **client.collect(path, options)**

- path `<string>` An absolute path to a directory.
- options `<ClientCollectDirentOptions>`
  - encoding `<"buffer">`
  - withFileTypes `<true>` Enables `Dirent` output with `NonSharedBuffer` names.
  - recursive `<boolean>` Optional.

Returns: `<Promise<Array<fs.Dirent<NonSharedBuffer>>>>`

_public_ **client.collect(path, options?)**

- path `<string>` An absolute path to a directory.
- options `<ClientCollectStringOptions>`
  - encoding `<BufferEncoding>` Optional. Defaults to UTF-8 string output when omitted.
  - withFileTypes `<false>` Optional.
  - recursive `<boolean>` Optional.

Returns: `<Promise<Array<string>>>`

_public_ **client.collect(path, options)**

- path `<string>` An absolute path to a directory.
- options `<ClientCollectBufferOptions>`
  - encoding `<"buffer">`
  - withFileTypes `<false>` Optional.
  - recursive `<boolean>` Optional.

Returns: `<Promise<Array<NonSharedBuffer>>>`

Lists the entries in a directory. All paths must be absolute.

`client.collect` supports filesystem root paths such as `/` on POSIX systems or a volume root such as `C:\` on Windows.

_public_ **client.read(path, options)**

- path `<string>` An absolute path to a file.
- options `<ClientReadStringOptions>`
  - encoding `<BufferEncoding>` Read as text with the specified encoding.
  - flag `<fs.OpenMode>` Optional.
  - signal `<AbortSignal>` Abort an in-progress read.

Returns: `<Promise<string>>`

_public_ **client.read(path, options?)**

- path `<string>` An absolute path to a file.
- options `<ClientReadBufferOptions>`
  - encoding `<null>` Optional. Reads raw bytes when omitted or `null`.
  - flag `<fs.OpenMode>` Optional.
  - signal `<AbortSignal>` Abort an in-progress read.

Returns: `<Promise<NonSharedBuffer>>`

Reads a file. All paths must be absolute.

_public_ **client.createReadStream(path, options?)**

- path `<string>` An absolute path to a file.
- options `<ClientCreateReadStreamOptions | BufferEncoding>`
  - flags `<string>` File system flags. **Default:** `"r"`
  - encoding `<string | null>` **Default:** `null`
  - mode `<integer>` **Default:** `0o666`
  - start `<number>` Start offset.
  - end `<number>` End offset (inclusive).
  - signal `<AbortSignal>` Abort an in‑progress read.
  - highWaterMark `<number>` Read buffer size.

Returns: `<Promise<fs.ReadStream>>`

Creates a read stream and holds a read lock for the stream lifetime. Persistence supports the subset of `fs.createReadStream` options listed above.

_public_ **client.write(path, data, options?)**

- path `<string>` An absolute path to a file.
- data `<string | Buffer | TypedArray | DataView | Iterable | AsyncIterable | Stream>` Data to write.
- options `<ClientWriteOptions | BufferEncoding>`
  - encoding `<string | null>` **Default:** `"utf8"`
  - mode `<integer>` **Default:** `0o666`
  - signal `<AbortSignal>` Abort an in‑progress write.

Returns: `<Promise<void>>`

Writes a file using a temp file + rename. In durable mode, `client.write` flushes the temp file before rename and `fsync`s the parent directory after rename.

In durable mode, a rejection does not always mean the old file is still in place. If the post-rename directory `fsync` fails, the promise rejects even though the rename may already have committed the new file at the target path.

_public_ **client.createWriteStream(path, options?)**

- path `<string>` An absolute path to a file.
- options `<ClientCreateWriteStreamOptions | BufferEncoding>`
  - encoding `<string>` **Default:** `"utf8"`
  - mode `<integer>` **Default:** `0o666`
  - signal `<AbortSignal>` Abort an in‑progress write.
  - highWaterMark `<number>` Write buffer size.

Returns: `<Promise<persistence.WriteStream>>`

Creates an atomic write stream abstraction backed by a temp file + rename and holds a write lock for the stream lifetime. Persistence supports the subset of write-stream options listed above.

Notes:

- The stream writes to a temp file in the target directory and renames it into place before `finish` is emitted.
- On success, `finish` means the write has been committed.
- In durable mode, the parent directory is `fsync`'d after rename.
- If that post-rename `fsync` fails in durable mode, the stream rejects even though the target path may already contain the new data.
- The lock is held for the entire stream lifetime, so long-running writes will block **conflicting** operations.

_public_ **client.delete(path, options?)**

- path `<string>` An absolute path to a file or directory.
- options `<fs.RmOptions>`
  - recursive `<boolean>` **Default:** `false`
  - force `<boolean>` **Default:** `false`
  - maxRetries `<number>` **Default:** `0`
  - retryDelay `<number>` **Default:** `100`
  - signal `<AbortSignal>` Abort an in‑progress remove.

Returns: `<Promise<void>>`

Deletes a file or directory. In durable mode, the parent directory is `fsync`'d. For the full option list, see the Node.js `fs.promises.rm` documentation.

In durable mode, a rejection does not always mean the target still exists. If removal succeeds but the subsequent parent-directory `fsync` fails, the promise rejects even though the file or directory may already be gone.

### The LockManager class

#### new persistence.LockManager(options?)

- options `<LockManagerOptions>` Optional options passed to the `LockManager`.
  - errorHandler `<typeof console.error>` **Default:** `console.error`.

Creates a hierarchical lock manager. The lock manager enforces per-operation locking for reads, writes, collects, and deletes.

_public_ **lockManager.acquire(path, type)**

- path `<string>` An absolute path.
- type `<"read" | "write" | "collect" | "delete">` The type of lock to acquire.

Returns: `<Promise<number>>`

Acquires a lock for a path and returns a lock id. Reads may overlap other reads; writes are exclusive across ancestors and descendants.

Filesystem root paths are supported for `type === "collect"`. Filesystem root paths are not supported for `type === "read"`, `type === "write"`, or `type === "delete"`.

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

## Versioning

Until `2.0.0`, Persistence does not promise strict semantic versioning. Minor releases may include API adjustments, behavioral changes, or other breaking changes.

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
