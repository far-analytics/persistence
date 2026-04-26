import { Abortable } from "node:events";
import * as fs from "node:fs";

export type ReadStreamOptions = Omit<fs.ReadStreamOptions, "fd" | "autoClose" | "fs" | "flush" | "emitClose">;
export type WriteStreamOptions = Omit<fs.WriteStreamOptions, "fd" | "autoClose" | "fs" | "flush" | "emitClose">;
export type WriteFileOptions = fs.ObjectEncodingOptions &
  Abortable & {
    mode?: fs.Mode | undefined;
    flag?: string | undefined;
  };
