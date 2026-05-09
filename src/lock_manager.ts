import * as pth from "node:path";

export interface Artifact {
  locks: Promise<unknown>[];
  node: GraphNode;
}

export interface GraphNodeOptions {
  segment: string;
  parent: GraphNode | null;
}

export class GraphNode {
  public segment: string;
  public parent: GraphNode | null;
  public children: Map<string, GraphNode>;
  public writeTail: Promise<unknown> | null;
  public readTail: Promise<unknown> | null;
  // Cached aggregate blockers for activity somewhere below this node. These are
  // not exact sets of active descendants; resolved tails may remain until prune.
  public childWriteTail: Promise<unknown> | null;
  public childReadTail: Promise<unknown> | null;
  constructor(options: GraphNodeOptions) {
    this.segment = options.segment;
    this.parent = options.parent;
    this.children = new Map();
    this.writeTail = null;
    this.readTail = null;
    this.childReadTail = null;
    this.childWriteTail = null;
  }

  appendWriteTail(lock: Promise<unknown>) {
    this.writeTail = this.writeTail === null ? lock : this.writeTail.then(() => lock);
  }

  appendReadTail(lock: Promise<unknown>) {
    this.readTail = this.readTail === null ? lock : this.readTail.then(() => lock);
  }

  appendChildWriteTail(lock: Promise<unknown>) {
    this.childWriteTail = this.childWriteTail === null ? lock : this.childWriteTail.then(() => lock);
  }

  appendChildReadTail(lock: Promise<unknown>) {
    this.childReadTail = this.childReadTail === null ? lock : this.childReadTail.then(() => lock);
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
    this.root = new GraphNode({ segment: "", parent: null });
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
        const currentWriteTail = (node.writeTail = node.writeTail === null ? currentWrite : node.writeTail.then(() => currentWrite));
        // Prune the graph if a new write has not been acquired for this GraphNode.
        currentWriteTail
          .finally(() => {
            if (node.writeTail === currentWriteTail) {
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
          const currentReadTail = (node.readTail = node.readTail === null ? lock : node.readTail.then(() => lock));
          // Prune the graph if a new read has not been acquired for this GraphNode.
          currentReadTail
            .finally(() => {
              if (node.readTail === currentReadTail) {
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
          const currentWriteTail = (node.writeTail = node.writeTail === null ? lock : node.writeTail.then(() => lock));
          // Prune the graph if a new write has not been acquired for this GraphNode.
          currentWriteTail
            .finally(() => {
              if (node.writeTail === currentWriteTail) {
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
      // Only the node's own tails and structural children participate in
      // pruning. `childReadTail` / `childWriteTail` are aggregate descendant
      // blockers and may linger as resolved cached promises.
      if (node.children.size === 0 && node.readTail === null && node.writeTail === null) {
        if (node.parent !== null) {
          node.parent.children.delete(node.segment);
        }
        node = node.parent;
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
      let child = node.children.get(segment);
      if (!child) {
        child = new GraphNode({ segment, parent: node });
        node.children.set(segment, child);
      } else {
        if (child.writeTail) {
          locks.push(child.writeTail);
        }
        if (child.readTail && type == "write") {
          locks.push(child.readTail);
        }
      }
      if (segment != name) {
        if (type == "write") {
          child.appendChildWriteTail(lock);
        }
        if (type == "read") {
          child.appendChildReadTail(lock);
        }
      }
      node = child;
    }
    // Descendant blockers are cached on ancestors so conflicting descendant
    // activity can be discovered without walking the entire subtree.
    if (node.childReadTail && type == "write") {
      locks.push(node.childReadTail);
    }
    if (node.childWriteTail) {
      locks.push(node.childWriteTail);
    }
    return { locks, node };
  };
}
