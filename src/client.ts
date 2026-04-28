import * as fsp from "node:fs/promises";
import * as fs from "node:fs";
import * as pth from "node:path";
import * as crypto from "node:crypto";
import { once } from "node:events";
import { LockManager } from "./lock_manager.js";
import { Abortable } from "node:events";
import { WriteStream } from "./write_stream.js";

export interface ClientCreateReadStreamOptions {
  end?: number | undefined;
  encoding?: BufferEncoding | undefined;
  mode?: number | undefined;
  start?: number | undefined;
  signal?: AbortSignal | null | undefined;
  highWaterMark?: number | undefined;
}

export interface ClientCreateWriteStreamOptions {
  encoding?: BufferEncoding | undefined;
  mode?: number | undefined;
  signal?: AbortSignal | null | undefined;
  highWaterMark?: number | undefined;
}

export type ClientWriteOptions = fs.ObjectEncodingOptions &
  Abortable & {
    mode?: fs.Mode | undefined;
  };

export interface ClientCollectDirentOptions {
  encoding: "buffer";
  withFileTypes: true;
  recursive?: boolean;
}

export type ClientCollectStringOptions =
  | {
      encoding: Exclude<BufferEncoding, "buffer">;
      withFileTypes?: false;
      recursive?: boolean;
    }
  | Exclude<BufferEncoding, "buffer">
  | null;

export interface ClientCollectBufferOptions {
  encoding: "buffer";
  withFileTypes?: false;
  recursive?: boolean;
}

export type ClientCollectOptions = ClientCollectDirentOptions | ClientCollectStringOptions | ClientCollectBufferOptions;

export type ClientReadStringOptions =
  | ({
      encoding: BufferEncoding;
    } & Abortable)
  | BufferEncoding;

export type ClientReadBufferOptions =
  | ({
      encoding?: null | undefined;
    } & Abortable)
  | null;

export type ClientReadOptions = ClientReadStringOptions | ClientReadBufferOptions;

export interface ClientOptions {
  manager: LockManager;
  durable?: boolean;
}

export class Client {
  protected manager: LockManager;
  public durable: boolean;
  constructor({ manager, durable }: ClientOptions) {
    this.manager = manager;
    this.durable = durable ?? false;
  }

  public collect(path: string, options: ClientCollectDirentOptions): Promise<fs.Dirent<Buffer<ArrayBuffer>>[]>;
  public collect(path: string, options?: ClientCollectStringOptions): Promise<string[]>;
  public collect(path: string, options: ClientCollectBufferOptions): Promise<Buffer<ArrayBuffer>[]>;
  public async collect(path: string, options?: ClientCollectOptions): Promise<string[] | fs.Dirent<Buffer<ArrayBuffer>>[] | Buffer<ArrayBuffer>[]> {
    if (!pth.isAbsolute(path)) {
      throw new Error("Path must be absolute.");
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

  public async delete(path: string, options?: fs.RmOptions): Promise<void> {
    if (!pth.isAbsolute(path)) {
      throw new Error("Path must be absolute.");
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

  public read(path: string, options: ClientReadStringOptions): Promise<string>;
  public read(path: string, options?: ClientReadBufferOptions): Promise<Buffer<ArrayBuffer>>;
  public async read(path: string, options?: ClientReadOptions): Promise<string | Buffer<ArrayBuffer>> {
    if (!pth.isAbsolute(path)) {
      throw new Error("Path must be absolute.");
    }
    path = pth.resolve(path);
    const id = await this.manager.acquire(path, "read");
    try {
      return await fsp.readFile(path, options);
    } finally {
      this.manager.release(id);
    }
  }

  public async createReadStream(path: string, options?: ClientCreateReadStreamOptions | BufferEncoding): Promise<fs.ReadStream> {
    if (!pth.isAbsolute(path)) {
      throw new Error("Path must be absolute.");
    }
    path = pth.resolve(path);
    const id = await this.manager.acquire(path, "read");
    try {
      options =
        typeof options == "string"
          ? { encoding: options }
          : {
              encoding: options?.encoding,
              mode: options?.mode,
              start: options?.start,
              signal: options?.signal,
              highWaterMark: options?.highWaterMark,
              end: options?.end,
            };
      const stream = fs.createReadStream(path, options);
      const releaseOnce = () => {
        this.manager.release(id);
      };
      stream.once("close", releaseOnce);
      stream.once("error", releaseOnce);
      return stream;
    } catch (err) {
      this.manager.release(id);
      throw err;
    }
  }

  public async write(path: string, data: Parameters<typeof fsp.writeFile>[1], options?: ClientWriteOptions | BufferEncoding): Promise<void> {
    if (!pth.isAbsolute(path)) {
      throw new Error("Path must be absolute.");
    }
    const writeFileOptions =
      typeof options == "string"
        ? { encoding: options, flush: this.durable }
        : { ...{ encoding: options?.encoding, mode: options?.mode, signal: options?.signal }, ...{ flush: this.durable } };
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

        const tempFile = `.${crypto.randomUUID()}`;
        const tempPath = pth.join(dir, tempFile);
        try {
          await fsp.writeFile(tempPath, data, writeFileOptions);
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
        const tempFile = `.${crypto.randomUUID()}`;
        const tempPath = pth.join(dir, tempFile);
        try {
          await fsp.writeFile(tempPath, data, writeFileOptions);
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

  public async createWriteStream(path: string, options?: ClientCreateWriteStreamOptions | BufferEncoding): Promise<WriteStream> {
    if (!pth.isAbsolute(path)) {
      throw new Error("Path must be absolute.");
    }
    path = pth.resolve(path);
    const dir = pth.dirname(path);
    const id = await this.manager.acquire(path, "write");
    const writeStreamOptions =
      typeof options == "string"
        ? { encoding: options, durable: this.durable, path, dir, id, manager: this.manager }
        : {
            ...{ highWaterMark: options?.highWaterMark, encoding: options?.encoding, mode: options?.mode, signal: options?.signal },
            ...{ durable: this.durable, path, dir, id, manager: this.manager },
          };
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
      const tempFile = `.${crypto.randomUUID()}`;
      const tempPath = pth.join(dir, tempFile);
      const writeStream = new WriteStream(tempPath, writeStreamOptions);
      await once(writeStream, "ready");
      return writeStream;
    } catch (err) {
      this.manager.release(id);
      throw err;
    }
  }
}
