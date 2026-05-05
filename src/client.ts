import * as fsp from "node:fs/promises";
import * as fs from "node:fs";
import * as pth from "node:path";
import * as crypto from "node:crypto";
import { once } from "node:events";
import { LockManager } from "./lock_manager.js";
import { Abortable } from "node:events";
import { WriteStream } from "./write_stream.js";
import { makePathDurable, makeDurablePath } from "./common.js";

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
      encoding?: Exclude<BufferEncoding, "buffer"> | undefined;
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
    const id = await this.manager.acquire(path, "read");
    try {
      // These branches exist to narrow `options` into the correct `fs.promises.readdir`
      // overloads without a type assertion. Runtime behavior is the same in each case.
      if (typeof options === "string" || options === null || options === undefined) {
        return await fsp.readdir(path, options);
      }
      if (options.withFileTypes === true) {
        return await fsp.readdir(path, options);
      }
      if (options.encoding === "buffer") {
        return await fsp.readdir(path, options);
      }
      return await fsp.readdir(path, options);
    } finally {
      this.manager.release(id);
    }
  }

  public async rename(oldPath: string, newPath: string): Promise<void> {
    if (!pth.isAbsolute(oldPath)) {
      throw new Error("oldPath must be absolute.");
    }
    if (!pth.isAbsolute(newPath)) {
      throw new Error("newPath must be absolute.");
    }
    oldPath = pth.resolve(oldPath);
    newPath = pth.resolve(newPath);
    const oldPathDir = pth.dirname(oldPath);
    const newPathDir = pth.dirname(newPath);
    if (oldPathDir == oldPath || newPathDir == newPath) {
      throw new Error("Operations on root are not supported.");
    }
    const paths = [oldPath, newPath];
    const id = await this.manager.acquireAll(paths);
    try {
      await fsp.access(oldPath, fs.constants.F_OK);
      if (this.durable) {
        await makeDurablePath(newPath);
      } else {
        await fsp.mkdir(newPathDir, { recursive: true });
      }
      await fsp.rename(oldPath, newPath);
      if (this.durable) {
        for (const path of [oldPathDir, newPathDir]) {
          await makePathDurable(path);
        }
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
    const dir = pth.dirname(path);
    if (dir == path) {
      throw new Error("Operations on root are not supported.");
    }
    const id = await this.manager.acquire(path, "write");
    try {
      await fsp.rm(path, options);
      if (this.durable) {
        await makePathDurable(dir, { force: options?.force ?? false });
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
    const dir = pth.dirname(path);
    if (dir == path) {
      throw new Error("Operations on root are not supported.");
    }
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
    const dir = pth.dirname(path);
    if (dir == path) {
      throw new Error("Operations on root are not supported.");
    }
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
      const readStream = fs.createReadStream(path, options);
      const release = () => {
        readStream.off("close", release);
        readStream.off("error", release);
        this.manager.release(id);
      };
      readStream.once("close", release);
      readStream.once("error", release);
      return readStream;
    } catch (err) {
      this.manager.release(id);
      throw err;
    }
  }

  public async write(path: string, data: Parameters<typeof fsp.writeFile>[1], options?: ClientWriteOptions | BufferEncoding): Promise<void> {
    if (!pth.isAbsolute(path)) {
      throw new Error("Path must be absolute.");
    }
    path = pth.resolve(path);
    const dir = pth.dirname(path);
    if (dir == path) {
      throw new Error("Operations on root are not supported.");
    }
    const writeFileOptions =
      typeof options == "string"
        ? { encoding: options, flush: this.durable }
        : { ...{ encoding: options?.encoding, mode: options?.mode, signal: options?.signal }, ...{ flush: this.durable } };
    const id = await this.manager.acquire(path, "write");
    try {
      const tempFile = `.${crypto.randomUUID()}`;
      const tempPath = pth.join(dir, tempFile);
      if (this.durable) {
        await makeDurablePath(path);
        try {
          await fsp.writeFile(tempPath, data, writeFileOptions);
          await fsp.rename(tempPath, path);
        } catch (err) {
          await fsp.rm(tempPath, { force: true });
          throw err;
        }
        await makePathDurable(dir);
      } else {
        await fsp.mkdir(dir, {
          recursive: true,
        });
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
    if (dir == path) {
      throw new Error("Operations on root are not supported.");
    }
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
        await makeDurablePath(path);
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
