import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import iconv from "iconv-lite";
import type { ExtractedSubtitle } from "./types.js";

const SUBTITLE_EXTENSIONS = new Set([
  ".srt",
  ".ass",
  ".ssa",
  ".sub",
  ".idx",
  ".vtt",
  ".sup",
]);
const MAX_TEXT_SIZE = 10 * 1024 * 1024;
const MAX_BINARY_SIZE = 200 * 1024 * 1024;

type ArchiveType = "zip" | "rar" | "7z";

interface ExtractCommand {
  name: string;
  command: string;
  args(archive: string, output: string): string[];
}

export function extractSubtitles(
  buffer: Buffer,
  filename: string,
): ExtractedSubtitle[] {
  const extension = path.extname(filename).toLowerCase();
  if (SUBTITLE_EXTENSIONS.has(extension)) {
    return [toSubtitle(buffer, path.basename(filename), path.basename(filename))];
  }

  const archiveType = detectArchive(buffer, extension);
  if (!archiveType) {
    const content = decodeText(buffer);
    if (looksLikeSubtitle(content)) {
      const inferredName = inferSubtitleName(filename, content);
      return [toSubtitle(buffer, inferredName, inferredName)];
    }
    throw new Error(`无法识别字幕包格式：${filename}`);
  }

  const tempDir = mkdtempSync(path.join(os.tmpdir(), "autofilm-subtitles-"));
  const archive = path.join(tempDir, safeName(filename || `archive.${archiveType}`));
  const errors: string[] = [];
  try {
    writeFileSync(archive, buffer, { mode: 0o600 });
    for (const strategy of extractCommands(archiveType)) {
      const output = path.join(tempDir, `content-${strategy.name}`);
      mkdirSync(output, { recursive: true, mode: 0o700 });
      try {
        execFileSync(strategy.command, strategy.args(archive, output), {
          stdio: "pipe",
          timeout: 60_000,
          maxBuffer: 4 * 1024 * 1024,
        });
        const files = collect(output, output);
        if (files.length > 0) return files;
        errors.push(`${strategy.name}：压缩包中没有受支持的字幕文件`);
      } catch (error) {
        errors.push(
          `${strategy.name}：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    throw new Error(errors.join("\n"));
  } catch (error) {
    throw new Error(
      `字幕包解压失败：${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function extractCommands(type: ArchiveType): ExtractCommand[] {
  const sevenZip: ExtractCommand = {
    name: "7z",
    command: "7z",
    args: (archive, output) => ["x", `-o${output}`, archive, "-y"],
  };
  if (type === "zip") {
    return [
      sevenZip,
      {
        name: "unzip",
        command: "unzip",
        args: (archive, output) => ["-o", archive, "-d", output],
      },
    ];
  }
  if (type === "rar") {
    return [
      sevenZip,
      {
        name: "unrar",
        command: "unrar",
        args: (archive, output) => ["x", "-o+", archive, `${output}/`],
      },
    ];
  }
  return [sevenZip];
}

function collect(root: string, current: string): ExtractedSubtitle[] {
  const result: ExtractedSubtitle[] = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const fullPath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      result.push(...collect(root, fullPath));
      continue;
    }
    if (!entry.isFile()) continue;
    const extension = path.extname(entry.name).toLowerCase();
    if (!SUBTITLE_EXTENSIONS.has(extension)) continue;
    const data = readFileSync(fullPath);
    const maximum = isBinarySubtitle(extension, data)
      ? MAX_BINARY_SIZE
      : MAX_TEXT_SIZE;
    if (statSync(fullPath).size > maximum) continue;
    const relativePath = path.relative(root, fullPath).replaceAll(path.sep, "/");
    result.push(toSubtitle(data, entry.name, relativePath));
  }
  return result;
}

function toSubtitle(
  data: Buffer,
  filename: string,
  relativePath: string,
): ExtractedSubtitle {
  const extension = path.extname(filename).toLowerCase();
  const content = isBinarySubtitle(extension, data)
    ? undefined
    : decodeText(data);
  return {
    filename,
    relativePath,
    format: extension.slice(1),
    sizeBytes: data.length,
    content,
    data: content === undefined ? data : Buffer.from(content, "utf8"),
  };
}

export function decodeSubtitleText(buffer: Buffer): string {
  return decodeText(buffer);
}

function decodeText(buffer: Buffer): string {
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.toString("utf8", 3).replace(/^\uFEFF/, "");
  }
  if (buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.toString("utf16le", 2).replace(/^\uFEFF/, "");
  }
  if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    const body = Buffer.from(buffer.subarray(2, 2 + ((buffer.length - 2) & ~1)));
    body.swap16();
    return body.toString("utf16le").replace(/^\uFEFF/, "");
  }

  try {
    return new TextDecoder("utf-8", { fatal: true })
      .decode(buffer)
      .replace(/^\uFEFF/, "");
  } catch {
    // GB18030 is a strict superset of GBK and GB2312. Subtitles using any of
    // those encodings are normalized to UTF-8 before AI or ASS processing.
  }

  for (const encoding of ["gb18030", "big5", "windows-1252"]) {
    try {
      const decoded = iconv.decode(buffer, encoding);
      if (decoded && !decoded.includes("\uFFFD")) return decoded;
    } catch {
      // Continue with the next legacy encoding.
    }
  }
  return buffer.toString("utf8").replace(/^\uFEFF/, "");
}

function detectArchive(
  buffer: Buffer,
  extension: string,
): ArchiveType | undefined {
  if (buffer[0] === 0x50 && buffer[1] === 0x4b) return "zip";
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x61 &&
    buffer[2] === 0x72
  ) {
    return "rar";
  }
  if (
    buffer[0] === 0x37 &&
    buffer[1] === 0x7a &&
    buffer[2] === 0xbc
  ) {
    return "7z";
  }
  if (extension === ".zip" || extension === ".rar" || extension === ".7z") {
    return extension.slice(1) as ArchiveType;
  }
  return undefined;
}

function isBinarySubtitle(extension: string, data: Buffer): boolean {
  if (extension === ".sup") return true;
  if (extension !== ".sub") return false;
  const sample = data.subarray(0, Math.min(data.length, 1024));
  return sample.includes(0) || !looksLikeSubtitle(decodeText(sample));
}

function looksLikeSubtitle(content: string): boolean {
  const head = content.slice(0, 1000);
  return (
    /^\s*\d+\s*\r?\n\d{1,2}:\d{2}:\d{2}/m.test(head) ||
    /^\s*\{\d+\}\{\d+\}/m.test(head) ||
    head.includes("[Script Info]") ||
    /^(Dialogue|Comment):/m.test(head) ||
    /^WEBVTT/m.test(head) ||
    /^# VobSub index file/m.test(head)
  );
}

function inferSubtitleName(filename: string, content: string): string {
  const base = path.basename(filename || "subtitle").replace(/\.[^.]*$/, "");
  if (content.includes("[Script Info]") || /^(Dialogue|Comment):/m.test(content)) {
    return `${base}.ass`;
  }
  if (/^WEBVTT/m.test(content)) return `${base}.vtt`;
  if (/^\s*\{\d+\}\{\d+\}/m.test(content)) return `${base}.sub`;
  return `${base}.srt`;
}

function safeName(filename: string): string {
  return path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, "_");
}
