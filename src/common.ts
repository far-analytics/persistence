import * as pth from "node:path";
import * as fsp from "node:fs/promises";

export const makeDurablePath = async (path: string): Promise<void> => {
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
};

export const makePathDurable = async (path: string, options?: { force: boolean }): Promise<void> => {
  let fh;
  try {
    fh = await fsp.open(path, "r");
  } catch (err) {
    if (options?.force && err instanceof Error && "code" in err && err.code === "ENOENT") {
      return;
    }
    throw err;
  }
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
};
