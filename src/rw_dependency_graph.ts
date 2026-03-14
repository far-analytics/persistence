export class RWDependencyGraph {
  public uuidToRelease: Map<string, (value: void | PromiseLike<void>) => void>;
  public pathToWrite: Map<string, Promise<unknown>>;
  public pathToRead: Map<string, Promise<unknown>>;

  constructor() {
    this.pathToWrite = new Map();
    this.pathToRead = new Map();
    this.uuidToRelease = new Map();
  }

  public acquire = async (path: string, type: "read" | "write"): Promise<string> => {
    switch (type) {
      case "read": {
        const lastRead = this.getLocks(path, "read"); //this.pathToRead.get(path) ?? Promise.resolve();
        const lastWrite = this.getLocks(path, "write"); //this.pathToWrite.get(path) ?? Promise.resolve();

        const uuid = crypto.randomUUID();
        const currentRead = new Promise<void>((r) => {
          this.uuidToRelease.set(uuid, r);
        });

        // A subsequent write may not write until all prior reads have completed.
        // `read` will resolve to void (currentRead) once all prior reads resolve.
        const read = lastRead.then(() => currentRead);

        this.pathToRead.set(path, read);

        // Cleanup read tail if this read is still the current path tail.
        read
          .finally(() => {
            if (this.pathToRead.get(path) === read) {
              this.pathToRead.delete(path);
            }
          })
          .catch(console.error);

        await lastWrite;

        return uuid;
      }
      case "write": {
        // write
        const lastRead = this.getLocks(path, "read"); // this.pathToRead.get(path) ?? Promise.resolve();
        const lastWrite = this.getLocks(path, "write"); // this.pathToWrite.get(path) ?? Promise.resolve();

        const uuid = crypto.randomUUID();
        const currentWrite = new Promise<void>((r) => {
          this.uuidToRelease.set(uuid, r);
        });

        // A subsequent write may not write until all prior reads and writes have completed.
        // `write` will resolve to void (currentWrite) once all prior reads and writes resolve.
        const write = Promise.all([lastRead, lastWrite]).then(() => currentWrite);

        this.pathToWrite.set(path, write);

        // Cleanup write tail if this write is still the current path tail.
        write
          .finally(() => {
            if (this.pathToWrite.get(path) === write) {
              this.pathToWrite.delete(path);
            }
          })
          .catch(console.error);

        await Promise.all([lastRead, lastWrite]);

        return uuid;
      }
      default: {
        throw new Error(`Unexpected lock type: ${String(type)}`);
      }
    }
  };

  public release = (uuid: string): void => {
    const r = this.uuidToRelease.get(uuid);
    if (r) {
      r();
    }
    this.uuidToRelease.delete(uuid);
  };

  protected getLocks = async (path: string, type: "read" | "write"): Promise<unknown[]> => {
    const toSegments = (p: string): string[] => {
      const trimmed = p.replace(/\/+$/u, "");
      return trimmed === "" ? [""] : trimmed.split("/");
    };
    const isPrefix = (a: string, b: string): boolean => {
      const aSeg = toSegments(a);
      const bSeg = toSegments(b);
      if (aSeg.length > bSeg.length) {
        return false;
      }
      for (let i = 0; i < aSeg.length; i++) {
        if (aSeg[i] !== bSeg[i]) {
          return false;
        }
      }
      return true;
    };
    const isRelated = (a: string, b: string): boolean => {
      return isPrefix(a, b) || isPrefix(b, a);
    };
    switch (type) {
      case "read": {
        const locks: Promise<unknown>[] = [];
        for (const [key, value] of this.pathToRead.entries()) {
          if (isRelated(key, path)) {
            locks.push(value);
          }
        }
        return Promise.all(locks);
      }
      case "write": {
        const locks: Promise<unknown>[] = [];
        for (const [key, value] of this.pathToWrite.entries()) {
          if (isRelated(key, path)) {
            locks.push(value);
          }
        }
        return Promise.all(locks);
      }
      default: {
        throw new Error(`Unexpected lock type: ${String(type)}`);
      }
    }
  };
}
