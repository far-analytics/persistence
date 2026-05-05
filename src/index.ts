/**
 * Public API for in-process filesystem coordination through one shared
 * `LockManager`.
 *
 * Guarantees are scoped to operations that use this package and share that
 * manager; this is not OS-level or cross-process locking.
 */
import { WriteStream, WriteStreamOptions } from "./write_stream.js";
import { LockManager, LockManagerOptions, LocksAndNodesArtifact, GraphNode } from "./lock_manager.js";
import { makePathDurable, makeDurablePath } from "./common.js";
import {
  Client,
  ClientCollectBufferOptions,
  ClientCollectDirentOptions,
  ClientCollectOptions,
  ClientCollectStringOptions,
  ClientOptions,
  ClientReadBufferOptions,
  ClientReadOptions,
  ClientCreateReadStreamOptions,
  ClientReadStringOptions,
  ClientWriteOptions,
  ClientCreateWriteStreamOptions,
} from "./client.js";

export {
  Client,
  ClientCollectBufferOptions,
  ClientCollectDirentOptions,
  ClientCollectOptions,
  ClientCollectStringOptions,
  LockManager,
  LockManagerOptions,
  LocksAndNodesArtifact,
  GraphNode,
  WriteStream,
  WriteStreamOptions,
  ClientReadBufferOptions,
  ClientReadOptions,
  ClientCreateReadStreamOptions,
  ClientReadStringOptions,
  ClientCreateWriteStreamOptions,
  ClientWriteOptions,
  ClientOptions,
  makeDurablePath,
  makePathDurable,
};
