# Persistence

Persistence - a filesystem coordination layer.

## Introduction

Persistence is an in-process filesystem coordination layer for code that routes operations through one shared lock manager. It provides hierarchical read/write locking, optional durability (see durability notes below), and atomic-style writes. Reads on the same file are concurrent; however, reads are partitioned by writes and conflicting writes are processed in order of arrival (FIFO). Persistence does not provide OS-level locks or cross-process coordination by itself.

### Features

- **A _zero-dependency_ filesystem coordination layer.**
- Coordinates reads and writes that use the same `LockManager` with hierarchical path locks.
- Provides atomic-style file replacement (temp file + rename).
- Optionally attempts to flush file and directory metadata for stronger durability on write/delete.
- Within one `LockManager`, FIFO: for any two conflicting operations where at least one is a write, acquisition respects arrival order.

### Table of contents

- [Installation](#installation)
- [Usage](#usage)
- [Examples](#examples)
- [Locking model](#locking-model)
- [Horizontal scaling](#horizontal-scaling)
- [Durability](#durability)
- [Atomicity](#atomicity)
- [Limitations](#limitations)
- [API](#api)
- [Versioning](#versioning)
- [Tests](#tests)
- [Support](#support)
- [Colophon](#colophon)

## Installation

```bash
npm install @far-analytics/persistence
```

### Requirements

Node.js `20.10.0` or newer is required.

## Usage

**Setup**

```ts
import { Client, LockManager } from "@far-analytics/persistence";
import { once } from "node:events"; // for awaiting ReadStream and WriteStream events

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

**Rename or move a file**

```ts
await client.rename("/tmp/example.json", "/tmp/archive/example.json");
```

**Delete a file or directory**

```ts
await client.delete("/tmp/archive/example.json");
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

### _"Hello, World!"_ <sup><sup>\<TypeScript\></sup></sup>

Please see the TypeScript [example](https://github.com/far-analytics/persistence/tree/main/examples/example-ts) for a working implementation.

### _"Hello, World!"_ <sup><sup>\<Node.js\></sup></sup>

Please see the Node.js [example](https://github.com/far-analytics/persistence/tree/main/examples/example-nodejs) for a working implementation.

## Locking model

- Cooperative per-operation hierarchical locking within a single `LockManager` instance; this is not OS-level locking.
- Write partitioned FIFO: for any two conflicting operations where at least one is a write, acquisition respects arrival order.
- Read operations can overlap other reads on the same path or within the same ancestor/descendant subtree.
- Write operations are exclusive: a write on a path excludes all reads and writes on that path and any ancestor/descendant paths until the write is complete.

## Horizontal scaling

Persistence does not implement distributed locking. To use it in a horizontally scaled system, all operations that need coordination must route through one authoritative process or service that owns the shared `LockManager` (for example, a single lock service accessed over RPC). Independent processes with independent `LockManager` instances are not coordinated.

## Durability

When a client instance is instantiated with `{ durable: true }`, `client.write` and `client.createWriteStream` flush temp file data before rename and then fsync the parent directory. Likewise, `client.rename` fsyncs the relevant parent directories, and `client.delete` operations fsync the parent directory. Durability behavior is best-effort and depends on filesystem and OS behavior. Durability operations have been tested on Linux on ext4; however, fsync may throw `EPERM` on Windows on NTFS.

Important semantic note:

In durable mode, some operations perform a filesystem mutation first and then execute a final durability step such as fsync on the parent directory. If that final durability step fails, the operation rejects even though the mutation may already be visible on disk. In particular, a durable `client.write`, `client.createWriteStream`, or `client.rename` may already have placed the new file at the target path before rejecting, and a durable `client.delete` may already have removed the target before rejecting. Callers must not interpret every durable-mode rejection as "no change was applied". A rejection can also mean "the mutation was applied, but final durability confirmation failed".

## Atomicity

Persistence supports atomic-style file replacement via temp file + rename for `write` and `createWriteStream`.

## Limitations

- The directory structure that Persistence operates on is assumed to be hierarchical.
- Hence, symlinks/aliases are not supported.
- Filesystem root-path operations (i.e., operations on `/`, `C:\`, or a UNC share root such as `\\server\share\`) are restricted: `client.collect(root)` is supported, but `client.read(root)`, `client.createReadStream(root)`, `client.write(root)`, `client.createWriteStream(root)`, `client.rename(root, path)`, `client.rename(path, root)`, and `client.delete(root)` are not.
- Distributed locking or coordination across multiple independent `LockManager` instances is not supported.
- No protection against external processes that bypass the client and write directly to disk.
- When durability is enabled, fsync on directories is considered best‑effort and behaves differently on different filesystems.
- Durability operations have been tested on Linux on ext4; however, fsync (durability mode) may throw `EPERM` on Windows on NTFS.

## API

The _Persistence_ API provides a client and path-aware lock manager that coordinates operations.

For advanced use cases, the package also exports low-level durability helpers and interfaces. These are primarily intended for custom `Client` subclasses or other code that needs to build coordinated filesystem mutations on top of the same primitives.

### The Client class

#### new Client(options)

- options `<ClientOptions>` Options passed to the `Client`.
  - manager `<LockManager>` The lock manager instance used to coordinate access.
  - durable `<boolean>` If `true`, attempt stronger durability behavior for filesystem mutations: `client.write` and `client.createWriteStream` flush the temp file before rename and then fsync the parent directory. Likewise, `client.rename` fsyncs the relevant parent directories, and `client.delete` operations fsync the parent directory. **Default: `false`**

Use a `Client` instance to read, write, list, rename, and delete files with hierarchical locking.

**client.durable**

- `<boolean>`

Whether durability mode is enabled for the client.

**client.collect(path, options)**

- path `<string>` An absolute path to a directory.
- options `<ClientCollectDirentOptions>`
  - encoding `<"buffer">`
  - withFileTypes `<true>` Enables `Dirent` output with `Buffer<ArrayBuffer>` names.
  - recursive `<boolean>` Optional.

Returns: `<Promise<Array<fs.Dirent<Buffer<ArrayBuffer>>>>>`

**client.collect(path, options?)**

- path `<string>` An absolute path to a directory.
- options `<ClientCollectStringOptions>`
  - encoding `<BufferEncoding>` Optional. Defaults to UTF-8 string output when omitted.
  - withFileTypes `<false>` Optional.
  - recursive `<boolean>` Optional.

Returns: `<Promise<Array<string>>>`

**client.collect(path, options)**

- path `<string>` An absolute path to a directory.
- options `<ClientCollectBufferOptions>`
  - encoding `<"buffer">`
  - withFileTypes `<false>` Optional.
  - recursive `<boolean>` Optional.

Returns: `<Promise<Array<Buffer<ArrayBuffer>>>>`

Lists the entries in a directory. All paths must be absolute.

`client.collect` supports filesystem root paths such as `/` on POSIX systems or a volume root such as `C:\` on Windows.

**client.read(path, options)**

- path `<string>` An absolute path to a file.
- options `<ClientReadStringOptions>`
  - encoding `<BufferEncoding>` Read as text with the specified encoding.
  - signal `<AbortSignal>` Abort an in-progress read.

Returns: `<Promise<string>>`

**client.read(path, options?)**

- path `<string>` An absolute path to a file.
- options `<ClientReadBufferOptions>`
  - encoding `<null>` Optional. Reads raw bytes when omitted or `null`.
  - signal `<AbortSignal>` Abort an in-progress read.

Returns: `<Promise<Buffer<ArrayBuffer>>>`

Reads a file. All paths must be absolute.

**client.createReadStream(path, options?)**

- path `<string>` An absolute path to a file.
- options `<ClientCreateReadStreamOptions | BufferEncoding>`
  - encoding `<string | null>` **Default:** `null`
  - mode `<integer>` **Default:** `0o666`
  - start `<number>` Start offset.
  - end `<number>` End offset (inclusive).
  - signal `<AbortSignal>` Abort an in‑progress read.
  - highWaterMark `<number>` Read buffer size.

Returns: `<Promise<fs.ReadStream>>`

Creates a read stream and holds a read lock for the stream lifetime. Persistence supports the subset of `fs.createReadStream` options listed above.

**client.write(path, data, options?)**

- path `<string>` An absolute path to a file.
- data `<string | Buffer | TypedArray | DataView | Iterable | AsyncIterable | Stream>` Data to write.
- options `<ClientWriteOptions | BufferEncoding>`
  - encoding `<string | null>` **Default:** `"utf8"`
  - mode `<integer>` **Default:** `0o666`
  - signal `<AbortSignal>` Abort an in‑progress write.

Returns: `<Promise<void>>`

Writes a file using a temp file + rename. In durable mode, `client.write` flushes the temp file before rename and fsyncs the parent directory after rename.

Missing parent directories for the target path are created automatically.

In durable mode, a rejection does not always mean the old file is still in place. If the post-rename directory fsync fails, the promise rejects even though the rename may already have committed the new file at the target path.

**client.createWriteStream(path, options?)**

- path `<string>` An absolute path to a file.
- options `<ClientCreateWriteStreamOptions | BufferEncoding>`
  - encoding `<string>` **Default:** `"utf8"`
  - mode `<integer>` **Default:** `0o666`
  - signal `<AbortSignal>` Abort an in‑progress write.
  - highWaterMark `<number>` Write buffer size.

Returns: `<Promise<WriteStream>>`

Creates an atomic-style write stream abstraction backed by a temp file + rename and holds a write lock for the stream lifetime. Persistence supports the subset of write-stream options listed above.

Notes:

- Missing parent directories for the target path are created automatically before the stream is opened.
- The stream writes to a temp file in the target directory and renames it into place before `finish` is emitted.
- On success, `finish` means the write has been committed.
- In durable mode, the parent directory is fsync'd after rename.
- If that post-rename fsync fails in durable mode, the stream rejects even though the target path may already contain the new data.
- The lock is held for the entire stream lifetime, so long-running writes will block **_conflicting_** operations.

**client.rename(oldPath, newPath)**

- oldPath `<string>` An absolute source path.
- newPath `<string>` An absolute destination path.

Returns: `<Promise<void>>`

Renames or moves a file by coordinating both paths through one combined lock acquisition.

Notes:

- Both paths must be absolute.
- The lock is held across both `oldPath` and `newPath` for the full operation.
- A same-path rename is treated as a no-op.
- Missing parent directories for `newPath` are created automatically.
- If `oldPath` does not exist, the operation rejects without creating the destination parent directory.
- In durable mode, `client.rename` fsyncs the source and destination parent directories after rename.
- If that post-rename durability step fails, the promise rejects even though the file may already have moved to `newPath`.

**client.delete(path, options?)**

- path `<string>` An absolute path to a file or directory.
- options `<fs.RmOptions>`
  - recursive `<boolean>` **Default:** `false`
  - force `<boolean>` **Default:** `false`
  - maxRetries `<number>` **Default:** `0`
  - retryDelay `<number>` **Default:** `100`
  - signal `<AbortSignal>` Abort an in‑progress remove.

Returns: `<Promise<void>>`

Deletes a file or directory. In durable mode, the parent directory is fsync'd. For the full option list, see the Node.js `fs.promises.rm` documentation.

In durable mode, a rejection does not always mean the target still exists. If removal succeeds but the subsequent parent-directory fsync fails, the promise rejects even though the file or directory may already be gone.

### The LockManager class

#### new LockManager(options?)

- options `<LockManagerOptions>` Optional options passed to the `LockManager`.
  - errorHandler `<typeof console.error>` **Default:** `console.error`.

Creates a hierarchical lock manager. The lock manager enforces per-operation locking for reads and writes across hierarchical paths.

**lockManager.acquire(path, type)**

- path `<string>` A path to acquire. Relative paths are normalized using `path.resolve`.
- type `<"read" | "write">` The type of lock to acquire.

Returns: `<Promise<number>>`

Acquires a lock for a path and returns a lock id. Reads may overlap other reads; writes are exclusive across ancestors and descendants.

Filesystem root paths are supported for `type === "read"`. Filesystem root paths are not supported for `type === "write"`.

**lockManager.acquireAll(paths)**

- paths `<Array<string>>` Paths to acquire as one combined write lock set. Relative paths are normalized using `path.resolve`.

Returns: `<Promise<number>>`

Acquires write-style locks for all listed paths under one shared lock id. This is primarily useful for multi-path mutations such as `rename`, where conflicting operations on either path should wait until the combined operation completes.

Notes:

- `paths` must not be empty.
- Filesystem root paths are not supported.
- Duplicate paths are treated as one combined lock target.
- Acquisition is coordinated under one shared lock id, so callers should release it once with `lockManager.release(id)`.

**lockManager.release(id)**

- id `<number>` A lock id previously returned by `acquire` or `acquireAll`.

Returns: `<void>`

Releases a lock by id.

**lockManager.root**

- `<GraphNode>`

The root node of the internal lock graph.

### Advanced Helpers

These helpers are exported for low-level consumers who want to subclass `Client` or compose custom filesystem operations with the same durability steps used internally by the package.

**makeDurablePath(path)**

- path `<string>` A target path whose parent directory chain should exist.

Returns: `<Promise<void>>`

Ensures the parent directory chain for `path` exists. When a missing directory is created, the helper fsyncs its parent directory before proceeding. This is mainly useful for durable mutation flows that need to create missing parent directories before writing or streaming to a target path.

**makePathDurable(path, options?)**

- path `<string>` A path to fsync.
- options `<{ force: boolean }>`
  - force `<boolean>` If `true`, ignore `ENOENT` when opening `path`.

Returns: `<Promise<void>>`

Opens `path`, fsyncs it, and then closes it. This is mainly useful for durable-mode cleanup or post-mutation confirmation steps such as fsyncing a parent directory after `rename`, `write`, or `delete`.

### The GraphNode class

#### GraphNode

- segment `<string>` The path segment for this node.
- ancestor `<GraphNode | null>` The immediate ancestor node.
- descendants `<Map<string, GraphNode>>` Immediate descendant nodes keyed by segment.
- writeTail `<Promise<unknown> | null>` Tail promise for write locks.
- readTail `<Promise<unknown> | null>` Tail promise for read locks.
- descendantWriteTail `<Promise<unknown> | null>` Cached aggregate tail for descendant writes.
- descendantReadTail `<Promise<unknown> | null>` Cached aggregate tail for descendant reads.

**graphNode.appendWriteTail(lock)**

- lock `<Promise<unknown>>`

Chains a write tail onto this node.

**graphNode.appendReadTail(lock)**

- lock `<Promise<unknown>>`

Chains a read tail onto this node.

**graphNode.appendDescendantWriteTail(lock)**

- lock `<Promise<unknown>>`

Chains a cached aggregate descendant-write tail onto this node.

**graphNode.appendDescendantReadTail(lock)**

- lock `<Promise<unknown>>`

Chains a cached aggregate descendant-read tail onto this node.

### The Artifact interface

#### Artifact

- locks `<Array<Promise<unknown>>>` Promises the lock acquisition must await.
- ancestors `<Array<GraphNode>>` Ancestor nodes used to cache aggregate descendant activity.
- node `<GraphNode>` The graph node for the path.

## Versioning

Until `2.0.0`, Persistence does not promise strict semantic versioning. Minor releases may include API adjustments, behavioral changes, or other breaking changes.

## Tests

### How to run the test suite

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

#### Run the optional lock-manager soak test.

The normal test suite includes a generated state-machine test. A longer lock-manager soak test is available but skipped by default.

On POSIX shells:

```bash
PERSISTENCE_SOAK=1 npm test
```

On PowerShell:

```powershell
$env:PERSISTENCE_SOAK = "1"; npm test
```

Optional controls:

- `PERSISTENCE_SOAK_SEEDS` Number of generated seeds to run. Default: `16`.
- `PERSISTENCE_SOAK_STEPS` Number of generated acquire/release steps per seed. Default: `2000`.
- `PERSISTENCE_SOAK_TIMEOUT_MS` Test timeout in milliseconds. Default: `120000`.

## Support

For feature requests or issues, please open an [issue](https://github.com/far-analytics/persistence/issues) or contact the author.

- [Adam Patterson](https://github.com/adpatter)

## Colophon

**Persistence _(noun)_**

_\\pər-ˈsi-stən(t)s\\_<br>
...<br>
**2:** Continued effort to achieve something despite difficulties, opposition, or discouragement.  
_Success achieved through sheer persistence._<br>
...<br>
