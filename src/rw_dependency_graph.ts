export class RWDependencyGraph {
  public pathToWrite: Map<string, Promise<unknown>>;
  public pathToRead: Map<string, Promise<unknown>>;

  constructor() {
    this.pathToWrite = new Map();
    this.pathToRead = new Map();
  }

  public acquire = async (path: string, type: "read" | "write"): Promise<() => void> => {
    switch (type) {
      case "read": {
        const lastRead = this.pathToRead.get(path) ?? Promise.resolve();
        const lastWrite = this.pathToWrite.get(path) ?? Promise.resolve();

        let release!: () => void;
        const currentRead = new Promise<void>((r) => {
          release = () => {
            r();
          };
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

        return release;
      }
      case "write": {
        // write
        const lastRead = this.pathToRead.get(path) ?? Promise.resolve();
        const lastWrite = this.pathToWrite.get(path) ?? Promise.resolve();

        let release!: () => void;
        const currentWrite = new Promise<void>((r) => {
          release = () => {
            r();
          };
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

        return release;
      }
      default: {
        throw new Error(`Unexpected lock type: ${String(type)}`);
      }
    }
  };
}
