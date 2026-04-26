import * as fs from "node:fs";

export type ReadStreamOptions = Omit<fs.ReadStreamOptions, "fd" | "autoClose" | "fs" | "flush">;
export type WriteStreamOptions = Omit<fs.WriteStreamOptions, "fd" | "autoClose" | "fs" | "flush">;
