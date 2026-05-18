import * as pth from "node:path";
import { GraphNode } from "./graph_node.js";
import { Artifact } from "./artifact.js";

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
    let ancestors: GraphNode[] = [];
    try {
      const lock = new Promise<unknown>((r) => {
        this.idToRelease.set(acquireId, r);
      });

      for (const path of paths) {
        const artifact = this.createArtifact(path, lock, "write");
        nodes.push(artifact.node);
        locks = locks.concat(artifact.locks);
        ancestors = ancestors.concat(artifact.ancestors);
      }

      // Append ancestor descendant tails only after every path has collected
      // its blockers. Otherwise acquireAll(["/a/b", "/a"]) would make "/a"
      // wait on its own "/a/b" lock and deadlock.
      ancestors = [...new Set(ancestors)];
      for (const ancestor of ancestors) {
        const tail = ancestor.appendDescendantWriteTail(lock);
        tail
          .finally(() => {
            if (ancestor.descendantWriteTail === tail) {
              ancestor.descendantWriteTail = null;
            }
          })
          .catch(this.errorHandler);
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
      switch (type) {
        case "read": {
          const { node, locks, ancestors } = this.createArtifact(path, lock, type);
          for (const ancestor of ancestors) {
            // Cache descendant activity on each ancestor along the path so the
            // target node can detect conflicting locks below it without walking the
            // descendant subtree.
            const tail = ancestor.appendDescendantReadTail(lock);
            tail
              .finally(() => {
                if (ancestor.descendantReadTail === tail) {
                  ancestor.descendantReadTail = null;
                }
              })
              .catch(this.errorHandler);
          }
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
          const { node, locks, ancestors } = this.createArtifact(path, lock, type);
          for (const ancestor of ancestors) {
            const tail = ancestor.appendDescendantWriteTail(lock);
            tail
              .finally(() => {
                if (ancestor.descendantWriteTail === tail) {
                  ancestor.descendantWriteTail = null;
                }
              })
              .catch(this.errorHandler);
          }
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
    const ancestors: GraphNode[] = [];
    path = pth.resolve(path);
    const root = pth.parse(path).root;
    // This is a defensive check.
    if (path == root && type != "read") {
      throw new Error("Operation is not supported.");
    }
    let node: GraphNode = this.root;
    // Keep the parsed root as the first segment. On Windows this preserves
    // drive roots and UNC share roots as distinct lock scopes.
    const segments = path == root ? [root] : [root, ...path.slice(root.length).split(pth.sep)];
    const last = segments.length - 1;
    for (const [index, segment] of segments.entries()) {
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
      if (index != last) {
        ancestors.push(descendant);
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
    return { locks, node, ancestors };
  };
}
