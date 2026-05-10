import * as pth from "node:path";

export interface Artifact {
  locks: Promise<unknown>[];
  node: GraphNode;
}

export interface GraphNodeOptions {
  segment: string;
  ancestor: GraphNode | null;
  errorHandler: typeof console.error;
}

export class GraphNode {
  public segment: string;
  public ancestor: GraphNode | null;
  public descendants: Map<string, GraphNode>;
  public writeTail: Promise<unknown> | null;
  public readTail: Promise<unknown> | null;
  // Aggregate descendant tails let a node wait on conflicting activity anywhere
  // below it without traversing the whole active subtree.
  public descendantWriteTail: Promise<unknown> | null;
  public descendantReadTail: Promise<unknown> | null;
  protected errorHandler: typeof console.error;

  constructor(options: GraphNodeOptions) {
    this.segment = options.segment;
    this.ancestor = options.ancestor;
    this.descendants = new Map();
    this.writeTail = null;
    this.readTail = null;
    this.descendantReadTail = null;
    this.descendantWriteTail = null;
    this.errorHandler = options.errorHandler;
  }

  public appendWriteTail(lock: Promise<unknown>): Promise<unknown> {
    this.writeTail = this.writeTail === null ? lock : this.writeTail.then(() => lock);
    return this.writeTail;
  }

  public appendReadTail(lock: Promise<unknown>): Promise<unknown> {
    this.readTail = this.readTail === null ? lock : this.readTail.then(() => lock);
    return this.readTail;
  }

  public appendDescendantWriteTail(lock: Promise<unknown>): Promise<unknown> {
    this.descendantWriteTail = this.descendantWriteTail === null ? lock : this.descendantWriteTail.then(() => lock);
    return this.descendantWriteTail;
  }

  public appendDescendantReadTail(lock: Promise<unknown>): Promise<unknown> {
    this.descendantReadTail = this.descendantReadTail === null ? lock : this.descendantReadTail.then(() => lock);
    return this.descendantReadTail;
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
    this.root = new GraphNode({ segment: "", ancestor: null, errorHandler: this.errorHandler });
  }

  public acquireAll = async (paths: string[]): Promise<number> => {
    if (paths.length === 0) {
      throw new Error("Paths must not be empty.");
    }
    const acquireId = this.id++;
    const nodes: GraphNode[] = [];
    let locks: Promise<unknown>[] = [];
    try {
      const lock = new Promise<unknown>((r) => {
        this.idToRelease.set(acquireId, r);
      });
      for (const path of paths) {
        const artifact = this.createArtifact(path, lock, "write");
        nodes.push(artifact.node);
        locks = locks.concat(artifact.locks);
      }
      for (const node of nodes) {
        // A subsequent write may not write until all prior reads and writes have completed.
        const tail = node.appendWriteTail(lock);
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
          const tail = node.appendReadTail(lock);
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
          const tail = node.appendWriteTail(lock);
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
      // Pruning only depends on structural descendants and the node's own lock
      // tails. Aggregate descendant tails clear themselves when the last
      // descendant acquisition in their chain drains.
      if (node.descendants.size === 0 && node.readTail === null && node.writeTail === null) {
        if (node.ancestor !== null) {
          node.ancestor.descendants.delete(node.segment);
        }
        node = node.ancestor;
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
        descendant = new GraphNode({ segment, ancestor: node, errorHandler: this.errorHandler });
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
        // target node can detect conflicting locks below it without walking the
        // descendant subtree.
        if (type == "write") {
          const tail = descendant.appendDescendantWriteTail(lock);
          tail
            .finally(() => {
              if (descendant.descendantWriteTail === tail) {
                descendant.descendantWriteTail = null;
              }
            })
            .catch(this.errorHandler);
        }
        if (type == "read") {
          const tail = descendant.appendDescendantReadTail(lock);
          tail
            .finally(() => {
              if (descendant.descendantReadTail === tail) {
                descendant.descendantReadTail = null;
              }
            })
            .catch(this.errorHandler);
        }
      }
      node = descendant;
    }
    // A cached descendant tail is only present while conflicting descendant
    // activity is still active or queued.
    if (node.descendantReadTail && type == "write") {
      locks.push(node.descendantReadTail);
    }
    if (node.descendantWriteTail) {
      locks.push(node.descendantWriteTail);
    }
    return { locks, node };
  };
}
