import * as pth from "node:path";

export interface Artifact {
  locks: Promise<unknown>[];
  node: GraphNode;
}

export interface GraphNode {
  segment: string;
  parent: GraphNode | null;
  children: Map<string, GraphNode>;
  writeTail: Promise<unknown> | null;
  readTail: Promise<unknown> | null;
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
    this.root = { segment: "", parent: null, children: new Map(), writeTail: null, readTail: null };
  }

  public acquireAll = async (paths: string[]): Promise<number> => {
    if (paths.length === 0) {
      throw new Error("Paths must not be empty.");
    }
    const acquireId = this.id++;
    const nodes: GraphNode[] = [];
    let locks: Promise<unknown>[] = [];
    try {
      for (const path of paths) {
        const artifact = this.collectArtifact(path, "write");
        nodes.push(artifact.node);
        locks = locks.concat(artifact.locks);
      }

      const currentWrite = new Promise<unknown>((r) => {
        this.idToRelease.set(acquireId, r);
      });

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

  public acquire = async (path: string, type: "read" | "write" | "collect" | "delete"): Promise<number> => {
    const acquireId = this.id++;
    try {
      const artifact: Artifact = this.collectArtifact(path, type);
      switch (type) {
        case "read":
        case "collect": {
          const currentRead = new Promise<unknown>((r) => {
            this.idToRelease.set(acquireId, r);
          });

          const currentNode = artifact.node;
          // A subsequent write may not write until all prior reads have completed.
          const currentReadTail = (currentNode.readTail = currentNode.readTail === null ? currentRead : currentNode.readTail.then(() => currentRead));

          // Prune the graph if a new read has not been acquired for this GraphNode.
          currentReadTail
            .finally(() => {
              if (currentNode.readTail === currentReadTail) {
                currentNode.readTail = null;
                this.prune(currentNode);
              }
            })
            .catch(this.errorHandler);

          await Promise.all(artifact.locks);

          return acquireId;
        }
        case "write":
        case "delete": {
          const currentWrite = new Promise<unknown>((r) => {
            this.idToRelease.set(acquireId, r);
          });

          // A subsequent write may not write until all prior reads and writes have completed.
          const currentNode = artifact.node;
          const currentWriteTail = (currentNode.writeTail = currentNode.writeTail === null ? currentWrite : currentNode.writeTail.then(() => currentWrite));

          // Prune the graph if a new write has not been acquired for this GraphNode.
          currentWriteTail
            .finally(() => {
              if (currentNode.writeTail === currentWriteTail) {
                currentNode.writeTail = null;
                this.prune(currentNode);
              }
            })
            .catch(this.errorHandler);

          await Promise.all(artifact.locks);

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

  protected collectArtifact = (path: string, type: "read" | "write" | "collect" | "delete"): Artifact => {
    const locks: Promise<unknown>[] = [];
    path = pth.resolve(path);
    const root = pth.parse(path).root;
    if (path == root && (type == "read" || type == "write" || type == "delete")) {
      throw new Error("Read, write, and delete operations on root are not supported.");
    }
    let node: GraphNode = this.root;
    if (node.writeTail) {
      locks.push(node.writeTail);
    }
    if (node.readTail && (type == "write" || type == "delete")) {
      locks.push(node.readTail);
    }
    const segments = path == root ? [path.split(pth.sep)[0]] : path.split(pth.sep);
    for (const segment of segments) {
      let child = node.children.get(segment);
      if (!child) {
        child = { segment, parent: node, children: new Map(), writeTail: null, readTail: null };
        node.children.set(segment, child);
        node = child;
      } else {
        if (child.writeTail) {
          locks.push(child.writeTail);
        }
        if (child.readTail && (type == "write" || type == "delete")) {
          locks.push(child.readTail);
        }
        node = child;
      }
    }

    let children = [...node.children.values()];
    while (children.length) {
      const child = children.pop();
      if (child) {
        children = children.concat([...child.children.values()]);
        if (child.writeTail) {
          locks.push(child.writeTail);
        }
        if (child.readTail && (type == "write" || type == "delete")) {
          locks.push(child.readTail);
        }
      }
    }
    return { locks, node };
  };
}
