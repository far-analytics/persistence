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
