import type { NativeOutboundMessage } from "@autofilm/contracts";

export function agentMessages(
  content: string,
  mediaBaseUrl: string,
): NativeOutboundMessage[] {
  const baseUrl = mediaBaseUrl.replace(/\/+$/, "");
  const mediaPattern = new RegExp(
    `${escapeRegExp(baseUrl)}/v1/media/[A-Za-z0-9_-]+`,
    "g",
  );
  const mediaUrls = [...new Set(content.match(mediaPattern) ?? [])];
  if (mediaUrls.length === 0) {
    return [{ type: "text", text: content }];
  }

  const text = content
    .replace(mediaPattern, "")
    .replace(/\[[^\]]*]\(\s*\)/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const messages: NativeOutboundMessage[] = [];
  for (const mediaUrl of mediaUrls) {
    messages.push({ type: "image", media_url: mediaUrl });
  }
  if (text) messages.push({ type: "text", text });
  return messages;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
