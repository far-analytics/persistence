import * as pth from "node:path";

export interface Artifact {
  locks: Promise<unknown>[];
  node: GraphNode;
}

export interface GraphNodeOptions {
  segment: string;
  ascendant: GraphNode | null;
  errorHandler: typeof console.error;
}

export class GraphNode {
  public segment: string;
  public ascendant: GraphNode | null;
  public descendants: Map<string, GraphNode>;
  public writeTail: Promise<unknown> | null;
  public readTail: Promise<unknown> | null;
  // Aggregate descendant state. The counters track whether conflicting activity
  // currently exists below this node, while the tails preserve FIFO ordering for
  // those descendant acquisitions.
  public descendantWriteTail: Promise<unknown> | null;
  public descendantReadTail: Promise<unknown> | null;
  public activeDescendantReadCount: number;
  public activeDescendantWriteCount: number;
  protected errorHandler: typeof console.error;

  constructor(options: GraphNodeOptions) {
    this.segment = options.segment;
    this.ascendant = options.ascendant;
    this.descendants = new Map();
    this.writeTail = null;
    this.readTail = null;
    this.descendantReadTail = null;
    this.descendantWriteTail = null;
    this.activeDescendantReadCount = 0;
    this.activeDescendantWriteCount = 0;
    this.errorHandler = options.errorHandler;
  }

  appendWriteTail(lock: Promise<unknown>) {
    this.writeTail = this.writeTail === null ? lock : this.writeTail.then(() => lock);
  }

  appendReadTail(lock: Promise<unknown>) {
    this.readTail = this.readTail === null ? lock : this.readTail.then(() => lock);
  }

  appendDescendantWriteTail(lock: Promise<unknown>) {
    this.activeDescendantWriteCount++;
    const tail = (this.descendantWriteTail = this.descendantWriteTail === null ? lock : this.descendantWriteTail.then(() => lock));
    tail
      .finally(() => {
        this.activeDescendantWriteCount--;
        if (this.descendantWriteTail === tail) {
          this.descendantWriteTail = null;
        }
      })
      .catch(this.errorHandler);
  }

  appendDescendantReadTail(lock: Promise<unknown>) {
    this.activeDescendantReadCount++;
    const tail = (this.descendantReadTail = this.descendantReadTail === null ? lock : this.descendantReadTail.then(() => lock));
    tail
      .finally(() => {
        if (this.descendantReadTail === tail) {
          this.descendantReadTail = null;
        }
        this.activeDescendantReadCount--;
      })
      .catch(this.errorHandler);
  }
}

export interface LockManagerOptions {
  errorHandler?: typeof console.error;
}

export class LockManager {
  protected idToRelease: Map<number, (value: void | PromiseLike<void>) => void>;
  public root: GraphNode;
  protected id: number;
  protected errorHandler: typeof console.error;

  constructor({ errorHandler }: LockManagerOptions = {}) {
    this.errorHandler = errorHandler ?? console.error;
    this.id = 0;
    this.idToRelease = new Map();
    this.root = new GraphNode({ segment: "", ascendant: null, errorHandler: this.errorHandler });
  }

  public acquireAll = async (paths: string[]): Promise<number> => {
    if (paths.length === 0) {
      throw new Error("Paths must not be empty.");
    }
    const acquireId = this.id++;
    const nodes: GraphNode[] = [];
    let locks: Promise<unknown>[] = [];
    try {
      const currentWrite = new Promise<unknown>((r) => {
        this.idToRelease.set(acquireId, r);
      });
      for (const path of paths) {
        const artifact = this.createArtifact(path, currentWrite, "write");
        nodes.push(artifact.node);
        locks = locks.concat(artifact.locks);
      }
      for (const node of nodes) {
        // A subsequent write may not write until all prior reads and writes have completed.
        const tail = (node.writeTail = node.writeTail === null ? currentWrite : node.writeTail.then(() => currentWrite));
        // Prune the graph if a new write has not been acquired for this GraphNode.
        tail
          .finally(() => {
            if (node.writeTail === tail) {
              node.writeTail = null;
              this.prune(node);
            }
          })
          .catch(this.errorHandler);
      }
      await Promise.all(locks);
      return acquireId;
    } catch (err) {
      const r = this.idToRelease.get(acquireId);
      if (r) {
        r();
      }
      this.idToRelease.delete(acquireId);
      for (const node of nodes) {
        this.prune(node);
      }
      throw err;
    }
  };

  public acquire = async (path: string, type: "read" | "write"): Promise<number> => {
    const acquireId = this.id++;
    try {
      const lock = new Promise<unknown>((r) => {
        this.idToRelease.set(acquireId, r);
      });
      const { node, locks } = this.createArtifact(path, lock, type);
      switch (type) {
        case "read": {
          // A subsequent write may not write until all prior reads have completed.
          const tail = (node.readTail = node.readTail === null ? lock : node.readTail.then(() => lock));
          // Prune the graph if a new read has not been acquired for this GraphNode.
          tail
            .finally(() => {
              if (node.readTail === tail) {
                node.readTail = null;
                this.prune(node);
              }
            })
            .catch(this.errorHandler);
          await Promise.all(locks);
          return acquireId;
        }
        case "write": {
          // A subsequent write may not write until all prior reads and writes have completed.
          const tail = (node.writeTail = node.writeTail === null ? lock : node.writeTail.then(() => lock));
          // Prune the graph if a new write has not been acquired for this GraphNode.
          tail
            .finally(() => {
              if (node.writeTail === tail) {
                node.writeTail = null;
                this.prune(node);
              }
            })
            .catch(this.errorHandler);
          await Promise.all(locks);
          return acquireId;
        }
        default: {
          throw new Error(`Unexpected lock type: ${String(type)}`);
        }
      }
    } catch (err) {
      const r = this.idToRelease.get(acquireId);
      if (r) {
        r();
      }
      this.idToRelease.delete(acquireId);
      throw err;
    }
  };

  public release = (id: number): void => {
    const r = this.idToRelease.get(id);
    if (r) {
      r();
    }
    this.idToRelease.delete(id);
  };

  protected prune = (node: GraphNode | null): void => {
    while (node !== null) {
      // Pruning depends only on structural children and the node's own lock
      // tails. Aggregate descendant tails self-clear, and the counters track
      // whether descendant activity still exists.
      if (node.descendants.size === 0 && node.readTail === null && node.writeTail === null) {
        if (node.ascendant !== null) {
          node.ascendant.descendants.delete(node.segment);
        }
        node = node.ascendant;
      } else {
        break;
      }
    }
  };

  protected createArtifact = (path: string, lock: Promise<unknown>, type: "read" | "write"): Artifact => {
    const locks: Promise<unknown>[] = [];
    path = pth.resolve(path);
    const root = pth.parse(path).root;
    // This is a defensive check.
    if (path == root && type != "read") {
      throw new Error("Operation is not supported.");
    }
    let node: GraphNode = this.root;
    const segments = path == root ? [path.split(pth.sep)[0]] : path.split(pth.sep);
    const name = segments[segments.length - 1];
    for (const segment of segments) {
      let descendant = node.descendants.get(segment);
      if (!descendant) {
        descendant = new GraphNode({ segment, ascendant: node, errorHandler: this.errorHandler });
        node.descendants.set(segment, descendant);
      } else {
        if (descendant.writeTail) {
          locks.push(descendant.writeTail);
        }
        if (descendant.readTail && type == "write") {
          locks.push(descendant.readTail);
        }
      }
      if (segment != name) {
        // Cache descendant activity on each ancestor along the path so the
        // target node can detect conflicting locks below it without a subtree
        // traversal.
        if (type == "write") {
          descendant.appendDescendantWriteTail(lock);
        }
        if (type == "read") {
          descendant.appendDescendantReadTail(lock);
        }
      }
      node = descendant;
    }
    // Use the counters to avoid awaiting a stale settled tail. The tail is only
    // relevant while conflicting descendant activity is still active or queued.
    if (node.activeDescendantReadCount != 0 && node.descendantReadTail && type == "write") {
      locks.push(node.descendantReadTail);
    }
    if (node.activeDescendantWriteCount != 0 && node.descendantWriteTail) {
      locks.push(node.descendantWriteTail);
    }
    return { locks, node };
  };
}
