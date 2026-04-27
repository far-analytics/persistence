import * as stream from "node:stream";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { LockManager } from "./lock_manager";
import { finished } from "node:stream/promises";
import { ClientCreateWriteStreamOptions } from "./client";

export interface WriteStreamOptions {
  durable: boolean;
  path: string;
  dir: string;
  id: number;
  manager: LockManager;
}
export class WriteStream extends stream.Writable {
  protected tempPath: string;
  protected path: string;
  protected dir: string;
  protected durable: boolean;
  protected manager: LockManager;
  protected id: number;
  public fsWriteStream: fs.WriteStream;

  constructor(tempPath: string, options: ClientCreateWriteStreamOptions & WriteStreamOptions) {
    super({ highWaterMark: options.highWaterMark, defaultEncoding: options.encoding });
    this.tempPath = tempPath;
    this.path = options.path;
    this.dir = options.dir;
    this.durable = options.durable;
    this.manager = options.manager;
    this.id = options.id;
    this.fsWriteStream = fs.createWriteStream(tempPath, {
      flags: options.flags,
      encoding: options.encoding,
      mode: options.mode,
      start: options.start,
      signal: options.signal,
      highWaterMark: options.highWaterMark,
      flush: options.durable,
    });
    this.fsWriteStream.on("ready", () => this.emit("ready"));
    this.fsWriteStream.on("open", () => this.emit("open"));
    this.fsWriteStream.on("error", (err) => this.destroy(err));
  }

  _write(chunk: string | Buffer, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (!this.fsWriteStream.write(chunk, encoding)) {
      this.fsWriteStream.once("drain", () => {
        callback();
      });
      return;
    }
    callback();
  }

  _writev(chunks: { chunk: string | Buffer; encoding: BufferEncoding }[], callback: (error?: Error | null) => void): void {
    const buffer = Buffer.concat(chunks.map(({ chunk, encoding }) => (Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding))));
    if (!this.fsWriteStream.write(buffer)) {
      this.fsWriteStream.once("drain", () => {
        callback();
      });
      return;
    }
    callback();
  }

  _final(callback: (error?: Error | null) => void): void {
    void (async () => {
      try {
        this.fsWriteStream.end();
        await finished(this.fsWriteStream);
        await fsp.rename(this.tempPath, this.path);
        if (this.durable) {
          const fh = await fsp.open(this.dir, "r");
          try {
            await fh.sync();
          } finally {
            await fh.close();
          }
        }
        callback();
      } catch (err) {
        await fsp.rm(this.tempPath, { force: true });
        callback(err instanceof Error ? err : new Error(String(err)));
      } finally {
        this.manager.release(this.id);
      }
    })();
  }

  _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    void (async () => {
      try {
        this.fsWriteStream.destroy(error ?? undefined);
        await finished(this.fsWriteStream).catch(() => {});
        await fsp.rm(this.tempPath, { force: true });
        callback(error);
      } catch (err) {
        callback(err instanceof Error ? err : new Error(String(err)));
      } finally {
        this.manager.release(this.id);
      }
    })();
  }
}
