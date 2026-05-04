import * as stream from "node:stream";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { LockManager } from "./lock_manager.js";
import { finished } from "node:stream/promises";
import { ClientCreateWriteStreamOptions } from "./client.js";
import { once } from "node:events";
import { makePathDurable } from "./common.js";

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
      encoding: options.encoding,
      mode: options.mode,
      signal: options.signal,
      highWaterMark: options.highWaterMark,
      flush: options.durable,
    });
    this.fsWriteStream.on("ready", () => this.emit("ready"));
    this.fsWriteStream.on("open", () => this.emit("open"));
    this.fsWriteStream.on("error", (err) => this.destroy(err));
  }

  _write(chunk: string | Buffer, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    try {
      if (!this.fsWriteStream.write(chunk, encoding)) {
        this.fsWriteStream.once("drain", () => {
          callback();
        });
        return;
      }
      callback();
    } catch (err) {
      callback(err instanceof Error ? err : new Error(String(err)));
    }
  }

  _writev(chunks: { chunk: string | Buffer; encoding: BufferEncoding }[], callback: (error?: Error | null) => void): void {
    void (async () => {
      try {
        let drain = false;
        for (const [, { chunk, encoding }] of chunks.entries()) {
          if (!this.fsWriteStream.write(chunk, encoding)) {
            drain = true;
          }
        }
        if (drain) {
          await once(this.fsWriteStream, "drain");
        }
        callback();
      } catch (err) {
        callback(err instanceof Error ? err : new Error(String(err)));
      }
    })();
  }

  _final(callback: (error?: Error | null) => void): void {
    void (async () => {
      try {
        this.fsWriteStream.end();
        await finished(this.fsWriteStream);
        await fsp.rename(this.tempPath, this.path);
        if (this.durable) {
          await makePathDurable(this.dir);
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
