import { createHash } from "node:crypto";

interface BencodeSpan {
  start: number;
  end: number;
}

const MAX_DEPTH = 64;

export function normalizeMagnetUri(value: string, title: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("下载入口不是有效的 magnet URI");
  }
  if (url.protocol !== "magnet:") {
    throw new Error("下载入口不是 magnet URI");
  }
  const infoHash = url.searchParams
    .getAll("xt")
    .map((entry) => entry.match(/^urn:btih:([a-f\d]{40}|[a-z2-7]{32})$/i))
    .find(Boolean)?.[1];
  if (!infoHash) {
    throw new Error("magnet 缺少兼容 115 的 BitTorrent v1 infohash");
  }
  const parameters: Array<[string, string, boolean?]> = [
    ["xt", `urn:btih:${infoHash.toLowerCase()}`, true],
  ];
  if (title.trim()) parameters.push(["dn", title.trim()]);
  for (const [key, entry] of url.searchParams) {
    if (key !== "xt" && key !== "dn") parameters.push([key, entry]);
  }
  return formatMagnet(parameters);
}

export function torrentToMagnet(content: Buffer, title: string): string {
  if (content.length === 0) throw new Error("torrent 文件为空");
  const entries = dictionaryEntries(content, 0, content.length);
  const info = entries.get("info");
  if (!info) throw new Error("torrent 缺少 info 字典");
  if (!dictionaryEntries(content, info.start, info.end).has("pieces")) {
    throw new Error("torrent 只有 BitTorrent v2 元数据，115 不支持该格式");
  }
  const infoHash = createHash("sha1")
    .update(content.subarray(info.start, info.end))
    .digest("hex");
  const trackers = readTrackers(content, entries);
  const parameters: Array<[string, string, boolean?]> = [
    ["xt", `urn:btih:${infoHash}`, true],
  ];
  if (title.trim()) parameters.push(["dn", title.trim()]);
  for (const tracker of trackers) parameters.push(["tr", tracker]);
  return formatMagnet(parameters);
}

function dictionaryEntries(
  content: Buffer,
  start: number,
  limit: number,
): Map<string, BencodeSpan> {
  if (content[start] !== 0x64) throw new Error("torrent 字典格式无效");
  const entries = new Map<string, BencodeSpan>();
  let cursor = start + 1;
  while (cursor < limit && content[cursor] !== 0x65) {
    const key = readByteString(content, cursor, limit);
    cursor = key.end;
    const valueStart = cursor;
    cursor = skipValue(content, cursor, limit, 0);
    entries.set(
      content.subarray(key.start, key.end).toString("utf8"),
      { start: valueStart, end: cursor },
    );
  }
  if (cursor >= limit || content[cursor] !== 0x65) {
    throw new Error("torrent 字典没有正确结束");
  }
  return entries;
}

function readTrackers(
  content: Buffer,
  entries: Map<string, BencodeSpan>,
): string[] {
  const trackers: string[] = [];
  const announce = entries.get("announce");
  if (announce) {
    const value = stringValue(content, announce);
    if (value) trackers.push(value);
  }
  const announceList = entries.get("announce-list");
  if (announceList) collectStrings(content, announceList, trackers, 0);
  return [...new Set(trackers.filter((value) => /^https?:|^udp:/i.test(value)))];
}

function collectStrings(
  content: Buffer,
  span: BencodeSpan,
  output: string[],
  depth: number,
): void {
  if (depth > MAX_DEPTH) throw new Error("torrent 嵌套层级过深");
  if (content[span.start] !== 0x6c) {
    const value = stringValue(content, span);
    if (value) output.push(value);
    return;
  }
  let cursor = span.start + 1;
  while (cursor < span.end && content[cursor] !== 0x65) {
    const end = skipValue(content, cursor, span.end, depth + 1);
    collectStrings(content, { start: cursor, end }, output, depth + 1);
    cursor = end;
  }
}

function stringValue(content: Buffer, span: BencodeSpan): string | undefined {
  const token = content[span.start];
  if (token === undefined || token < 0x30 || token > 0x39) return undefined;
  const value = readByteString(content, span.start, span.end);
  return content.subarray(value.start, value.end).toString("utf8");
}

function skipValue(
  content: Buffer,
  start: number,
  limit: number,
  depth: number,
): number {
  if (depth > MAX_DEPTH) throw new Error("torrent 嵌套层级过深");
  const token = content[start];
  if (token === undefined) throw new Error("torrent 内容不完整");
  if (token >= 0x30 && token <= 0x39) {
    return readByteString(content, start, limit).end;
  }
  if (token === 0x69) {
    const end = content.indexOf(0x65, start + 1);
    if (end < 0 || end >= limit) throw new Error("torrent 整数格式无效");
    const value = content.subarray(start + 1, end).toString("ascii");
    if (!/^-?(0|[1-9]\d*)$/.test(value)) {
      throw new Error("torrent 整数格式无效");
    }
    return end + 1;
  }
  if (token === 0x6c || token === 0x64) {
    let cursor = start + 1;
    while (cursor < limit && content[cursor] !== 0x65) {
      if (token === 0x64) {
        cursor = readByteString(content, cursor, limit).end;
      }
      cursor = skipValue(content, cursor, limit, depth + 1);
    }
    if (cursor >= limit || content[cursor] !== 0x65) {
      throw new Error("torrent 容器格式无效");
    }
    return cursor + 1;
  }
  throw new Error("torrent 包含未知的 bencode 类型");
}

function readByteString(
  content: Buffer,
  start: number,
  limit: number,
): BencodeSpan {
  let colon = start;
  while (colon < limit && content[colon] !== 0x3a) colon += 1;
  if (colon >= limit) throw new Error("torrent 字符串长度无效");
  const rawLength = content.subarray(start, colon).toString("ascii");
  if (!/^(0|[1-9]\d*)$/.test(rawLength)) {
    throw new Error("torrent 字符串长度无效");
  }
  const length = Number(rawLength);
  if (!Number.isSafeInteger(length)) throw new Error("torrent 字符串过大");
  const valueStart = colon + 1;
  const valueEnd = valueStart + length;
  if (valueEnd > limit) throw new Error("torrent 字符串内容不完整");
  return { start: valueStart, end: valueEnd };
}

function formatMagnet(
  parameters: Array<[string, string, boolean?]>,
): string {
  return `magnet:?${parameters
    .map(([key, value, preserveColon]) =>
      `${encodeURIComponent(key)}=${
        preserveColon ? value : encodeURIComponent(value)
      }`,
    )
    .join("&")}`;
}
