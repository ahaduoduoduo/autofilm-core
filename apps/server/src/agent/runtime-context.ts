export function runtimeSystemPrompt(
  base: string,
  userMemory = "",
  now = new Date(),
): string {
  const local = now.toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour12: false,
  });
  return [
    base,
    "## 当前运行时间",
    `服务器时间：${local}（Asia/Shanghai）`,
    `ISO 时间：${now.toISOString()}`,
    userMemory,
  ]
    .filter(Boolean)
    .join("\n\n");
}
