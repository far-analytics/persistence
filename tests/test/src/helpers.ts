import * as fsp from "node:fs/promises";
import * as pth from "node:path";
import { createRequire } from "node:module";

export const WEB_ROOT = pth.join(process.cwd(), "web_root");

const require = createRequire(import.meta.url);
export const mutableFsp = require("node:fs/promises") as typeof fsp;

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

export const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

export const withFailingSyncOnOpen = async <T>(path: string, error: Error, fn: () => Promise<T>): Promise<T> => {
  const originalOpen = mutableFsp.open;
  mutableFsp.open = async (...args: Parameters<typeof fsp.open>) => {
    const handle = await originalOpen(...args);
    if (args[0] !== path || args[1] !== "r") {
      return handle;
    }
    return new Proxy(handle, {
      get(target, prop) {
        if (prop === "sync") {
          return (): Promise<void> => Promise.reject(error);
        }
        const value = Reflect.get(target, prop, target) as unknown;
        if (typeof value !== "function") {
          return value;
        }
        const fn = value as (...args: unknown[]) => unknown;
        return (...args: unknown[]): unknown => Reflect.apply(fn, target, args);
      },
    });
  };
  try {
    return await fn();
  } finally {
    mutableFsp.open = originalOpen;
  }
};

export const withTimeout = async <T>(promise: Promise<T>, message: string): Promise<T> => {
  let timeout!: NodeJS.Timeout;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(message));
    }, 2_000);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeout);
  }
};
