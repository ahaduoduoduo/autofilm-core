export function openListPathFromUri(value: unknown): string {
  const uri = String(value ?? "");
  if (!uri.startsWith("openlist:///")) {
    throw new Error("缺少有效的 OpenList 路径");
  }
  return `/${uri.slice("openlist:///".length)}`;
}

export function toOpenListUri(value: string): string {
  return `openlist:///${value.replace(/^\/+/, "")}`;
}
