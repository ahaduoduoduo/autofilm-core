export function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

export function stringProperty(description: string): Record<string, unknown> {
  return { type: "string", description };
}

export function requireString(
  args: Record<string, unknown>,
  key: string,
): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value.trim();
}

export function optionalString(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function requireNumber(
  args: Record<string, unknown>,
  key: string,
): number {
  const value = args[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${key} must be a number`);
  }
  return value;
}

export function requireAbsolutePath(
  args: Record<string, unknown>,
  key: string,
): string {
  const value = requireString(args, key);
  if (!value.startsWith("/") || value.includes("..")) {
    throw new Error(`${key} must be a safe absolute OpenList path`);
  }
  return value.replace(/\/+/g, "/");
}

export function requireArray(
  args: Record<string, unknown>,
  key: string,
): unknown[] {
  const value = args[key];
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${key} must be a non-empty array`);
  }
  return value;
}

export function optionalStringArray(
  args: Record<string, unknown>,
  key: string,
  maxItems: number,
): string[] {
  const value = args[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new Error(`${key} must be an array with at most ${maxItems} items`);
  }
  return value.map((item, index) => {
    if (typeof item !== "string" || !item.trim()) {
      throw new Error(`${key}[${index}] must be a non-empty string`);
    }
    return item.trim();
  });
}

export function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
