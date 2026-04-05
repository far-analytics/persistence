/* eslint-disable @typescript-eslint/no-deprecated */
import * as fsp from "node:fs/promises";
import * as fs from "node:fs";
import * as pth from "node:path";
import * as crypto from "node:crypto";
import { once } from "node:events";
import { LockManager } from "./lock_manager.js";
import { Abortable } from "node:events";

export interface ClientOptions {
  manager: LockManager;
  tempSuffix?: string;
  durable?: boolean;
}

type SafeReadStreamOptions = Omit<fs.ReadStreamOptions, "fd" | "autoClose">;
type SafeWriteStreamOptions = Omit<fs.WriteStreamOptions, "fd" | "autoClose">;

export class Client {
  protected manager: LockManager;
  protected tempSuffix: string;
  public durable: boolean;
  constructor({ manager, tempSuffix, durable }: ClientOptions) {
    this.manager = manager;
    this.tempSuffix = tempSuffix ?? "tmp";
    this.durable = durable ?? false;
  }

  public collect(
    path: string,
    options: {
      encoding: "buffer";
      withFileTypes: true;
      recursive?: boolean;
    }
  ): Promise<fs.Dirent<NonSharedBuffer>[]>;
  public collect(
    path: string,
    options?:
      | {
          encoding: Exclude<BufferEncoding, "buffer">;
          withFileTypes?: false;
          recursive?: boolean;
        }
      | Exclude<BufferEncoding, "buffer">
      | null
  ): Promise<string[]>;
  public collect(
    path: string,
    options: {
      encoding: "buffer";
      withFileTypes?: false;
      recursive?: boolean;
    }
  ): Promise<NonSharedBuffer[]>;
  public async collect(
    path: string,
    options?:
      | {
          encoding: "buffer";
          withFileTypes: true;
          recursive?: boolean;
        }
      | {
          encoding: Exclude<BufferEncoding, "buffer">;
          withFileTypes?: false;
          recursive?: boolean;
        }
      | {
          encoding: "buffer";
          withFileTypes?: false;
          recursive?: boolean;
        }
      | Exclude<BufferEncoding, "buffer">
      | null
  ): Promise<string[] | fs.Dirent<NonSharedBuffer>[] | NonSharedBuffer[]> {
    if (!pth.isAbsolute(path)) {
      throw new Error("`path` must be absolute");
    }
    path = pth.resolve(path);
    const id = await this.manager.acquire(path, "collect");
    try {
      if (options && typeof options === "object" && "withFileTypes" in options && options.withFileTypes) {
        return await fsp.readdir(path, options);
      } else if (options && typeof options === "object" && options.encoding == "buffer") {
        return await fsp.readdir(path, options);
      } else {
        return await fsp.readdir(path, options);
      }
    } finally {
      this.manager.release(id);
    }
  }

  public async delete(path: string, options?: Parameters<typeof fsp.rm>[1]): ReturnType<typeof fsp.rm> {
    if (!pth.isAbsolute(path)) {
      throw new Error("`path` must be absolute");
    }
    path = pth.resolve(path);
    const id = await this.manager.acquire(path, "delete");
    try {
      if (this.durable) {
        const parsed = pth.parse(path);
        const parent = parsed.dir;
        await fsp.rm(path, options);
        const fh = await fsp.open(parent, "r");
        try {
          await fh.sync();
        } finally {
          await fh.close();
        }
      } else {
        await fsp.rm(path, options);
      }
    } finally {
      this.manager.release(id);
    }
  }

  public read(
    path: string,
    options:
      | ({
          encoding: BufferEncoding;
          flag?: fs.OpenMode | undefined;
        } & Abortable)
      | BufferEncoding
  ): Promise<string>;
  public read(
    path: string,
    options?:
      | ({
          encoding?: null | undefined;
          flag?: fs.OpenMode | undefined;
        } & Abortable)
      | null
  ): Promise<NonSharedBuffer>;
  public async read(
    path: string,
    options?:
      | ({
          encoding: BufferEncoding;
          flag?: fs.OpenMode | undefined;
        } & Abortable)
      | ({
          encoding?: null | undefined;
          flag?: fs.OpenMode | undefined;
        } & Abortable)
      | null
      | BufferEncoding
  ): Promise<string | NonSharedBuffer> {
    if (!pth.isAbsolute(path)) {
      throw new Error("`path` must be absolute");
    }
    path = pth.resolve(path);
    const id = await this.manager.acquire(path, "read");
    try {
      return await fsp.readFile(path, options);
    } finally {
      this.manager.release(id);
    }
  }

  public createReadStream(path: string, options?: SafeReadStreamOptions | BufferEncoding): Promise<fs.ReadStream>;
  public async createReadStream(path: string, options?: Parameters<typeof fs.createReadStream>[1]): Promise<fs.ReadStream> {
    if (!pth.isAbsolute(path)) {
      throw new Error("`path` must be absolute");
    }
    if (options && typeof options === "object" && options.fd != null) {
      throw new Error("`options.fd` is not supported");
    }
    if (options && typeof options === "object" && options.autoClose === false) {
      throw new Error("`options.autoClose` must not be false");
    }
    path = pth.resolve(path);
    const id = await this.manager.acquire(path, "read");
    const stream = fs.createReadStream(path, options);
    const releaseOnce = () => {
      this.manager.release(id);
    };
    stream.once("close", releaseOnce);
    stream.once("error", releaseOnce);
    return stream;
  }

  public createWriteStream(path: string, options?: SafeWriteStreamOptions | BufferEncoding): Promise<fs.WriteStream>;
  public async createWriteStream(path: string, options?: Parameters<typeof fs.createWriteStream>[1]): Promise<fs.WriteStream> {
    if (!pth.isAbsolute(path)) {
      throw new Error("`path` must be absolute");
    }
    if (typeof options == "string") {
      options = { encoding: options, flush: this.durable };
    }
    if (options && typeof options === "object" && options.fd != null) {
      throw new Error("`options.fd` is not supported");
    }
    if (options && typeof options === "object" && options.autoClose === false) {
      throw new Error("`options.autoClose` must not be false");
    }
    path = pth.resolve(path);
    const dir = pth.dirname(path);

    const id = await this.manager.acquire(path, "write");
    try {
      if (this.durable) {
        const parsed = pth.parse(path);
        const root = parsed.root;
        const segments = parsed.dir.slice(root.length).split(pth.sep).filter(Boolean);
        let current = root;
        let parent: string;
        for (const segment of segments) {
          parent = current;
          current = pth.join(current, segment);
          try {
            await fsp.mkdir(current, { recursive: false });
            const fh = await fsp.open(parent, "r");
            try {
              await fh.sync();
            } finally {
              await fh.close();
            }
          } catch (err) {
            if (!(err instanceof Error && "code" in err && err.code == "EEXIST")) {
              throw err;
            }
          }
        }
      } else {
        await fsp.mkdir(dir, { recursive: true });
      }

      const tempFile = `.${this.tempSuffix}.${crypto.randomUUID()}`;
      const tempPath = pth.join(dir, tempFile);
      const stream = fs.createWriteStream(tempPath, options && typeof options == "object" && this.durable ? { ...options, ...{ flush: true } } : options);

      once(stream, "finish")
        .then(async () => {
          try {
            await fsp.rename(tempPath, path);
            if (this.durable) {
              const fh = await fsp.open(dir, "r");
              try {
                await fh.sync();
              } finally {
                await fh.close();
              }
            }
          } catch {
            await fsp.rm(tempPath, { force: true });
          }
        })
        .catch(async () => {
          await fsp.rm(tempPath, { force: true });
        })
        .finally(() => {
          this.manager.release(id);
        });
      await once(stream, "ready");
      return stream;
    } catch (err) {
      this.manager.release(id);
      throw err;
    }
  }

  public async write(path: string, data: Parameters<typeof fsp.writeFile>[1], options?: Parameters<typeof fsp.writeFile>[2]): ReturnType<typeof fsp.writeFile> {
    if (!pth.isAbsolute(path)) {
      throw new Error("`path` must be absolute");
    }
    path = pth.resolve(path);
    const id = await this.manager.acquire(path, "write");
    try {
      if (this.durable) {
        const parsed = pth.parse(path);
        const root = parsed.root;
        const dir = parsed.dir;
        const segments = dir.slice(root.length).split(pth.sep).filter(Boolean);
        let current = root;
        let parent: string;
        for (const segment of segments) {
          parent = current;
          current = pth.join(current, segment);
          try {
            await fsp.mkdir(current, {
              recursive: false,
            });
            const fh = await fsp.open(parent, "r");
            try {
              await fh.sync();
            } finally {
              await fh.close();
            }
          } catch (err) {
            if (!(err instanceof Error && "code" in err && err.code == "EEXIST")) {
              throw err;
            }
          }
        }

        const tempFile = `.${this.tempSuffix}.${crypto.randomUUID()}`;
        const tempPath = pth.join(dir, tempFile);
        try {
          if (typeof options === "string") {
            await fsp.writeFile(tempPath, data, {
              encoding: options,
              flush: true,
            });
          } else if (options && typeof options === "object") {
            await fsp.writeFile(tempPath, data, {
              ...options,
              ...{
                flush: true,
              },
            });
          } else {
            await fsp.writeFile(tempPath, data, {
              flush: true,
            });
          }
          await fsp.rename(tempPath, path);
        } catch (err) {
          await fsp.rm(tempPath, { force: true });
          throw err;
        }
        const fh = await fsp.open(dir, "r");
        try {
          await fh.sync();
        } finally {
          await fh.close();
        }
      } else {
        const dir = pth.dirname(path);
        await fsp.mkdir(dir, {
          recursive: true,
        });
        const tempFile = `.${this.tempSuffix}.${crypto.randomUUID()}`;
        const tempPath = pth.join(dir, tempFile);
        try {
          await fsp.writeFile(tempPath, data, options);
          await fsp.rename(tempPath, path);
        } catch (err) {
          await fsp.rm(tempPath, { force: true });
          throw err;
        }
      }
    } finally {
      this.manager.release(id);
    }
  }
}
