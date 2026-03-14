export interface Data {
  data: number;
}

export const isData = (value: unknown): value is Data => {
  if (!(value instanceof Buffer)) {
    return false;
  }

  try {
    const parsed = JSON.parse(value.toString("utf8")) as unknown;

    if (typeof parsed === "object" && parsed !== null && typeof (parsed as Record<string, unknown>).data === "number") {
      return true;
    }
  } catch {
    return false;
  }

  return false;
};
