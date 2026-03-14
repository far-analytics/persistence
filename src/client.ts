import * as fsp from "node:fs/promises";
import { RWDependencyGraph } from "./rw_dependency_graph.js";
export interface ClientOptions {
  rwDependencyGraph: RWDependencyGraph;
}

export class Client {
  protected g: RWDependencyGraph;

  constructor({ rwDependencyGraph }: ClientOptions) {
    this.g = rwDependencyGraph;
  }

  public readFile = async (path: string, options?: Parameters<typeof fsp.readFile>[1]): Promise<Buffer | string> => {
    const uuid = await this.g.acquire(path, "read");
    try {
      // Check if try needs to wrap previous call.
      const data = await fsp.readFile(path, options);
      return data;
    } finally {
      this.g.release(uuid);
    }
  };
}
