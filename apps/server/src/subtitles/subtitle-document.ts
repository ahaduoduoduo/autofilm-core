import path from "node:path";

export const TEXT_SUBTITLE_EXTENSIONS = [".ass", ".ssa", ".srt", ".vtt"] as const;

export type TextSubtitleFormat = "ass" | "ssa" | "srt" | "vtt";

export interface ChineseTextSegment {
  index: number;
  text: string;
}

export interface SubtitleDocumentEvent {
  id: number;
  kind: "dialogue" | "comment" | "cue";
  plainText: string;
  chineseSegments: ChineseTextSegment[];
  cleanerPromptLine: string;
}

interface EditableSegment extends ChineseTextSegment {
  start: number;
  end: number;
}

interface ParsedEvent extends SubtitleDocumentEvent {
  unitIndex: number;
  textStart: number;
  textEnd: number;
  editableSegments: EditableSegment[];
}

export class SubtitleDocument {
  readonly events: SubtitleDocumentEvent[];

  private constructor(
    readonly format: TextSubtitleFormat,
    private readonly prefix: string,
    private readonly units: string[],
    private readonly separator: string,
    private readonly parsedEvents: ParsedEvent[],
  ) {
    this.events = parsedEvents.map(({ editableSegments: _segments, ...event }) =>
      Object.freeze({
        ...event,
        chineseSegments: event.chineseSegments.map((segment) => ({ ...segment })),
      }),
    );
  }

  static parse(filename: string, content: string): SubtitleDocument | undefined {
    const extension = path.extname(filename).toLowerCase();
    if (!TEXT_SUBTITLE_EXTENSIONS.includes(
      extension as (typeof TEXT_SUBTITLE_EXTENSIONS)[number],
    )) {
      return undefined;
    }
    const format = extension.slice(1) as TextSubtitleFormat;
    return format === "ass" || format === "ssa"
      ? parseAss(format, content)
      : parseTimedText(format, content);
  }

  removeEvents(eventIds: ReadonlySet<number>): string {
    if (eventIds.size === 0) return this.original();
    const removedUnits = new Set(
      this.parsedEvents
        .filter((event) => eventIds.has(event.id))
        .map((event) => event.unitIndex),
    );
    let sequence = 0;
    const kept = this.units
      .filter((_, index) => !removedUnits.has(index))
      .map((unit) => {
        if (this.format !== "srt") return unit;
        const lines = unit.split(/\r?\n/);
        if (/^\d+$/.test(lines[0]?.trim() ?? "") && lines[1]?.includes("-->")) {
          sequence += 1;
          lines[0] = String(sequence);
          return lines.join(newlineFor(unit));
        }
        return unit;
      });
    return this.prefix + kept.join(this.separator);
  }

  replaceChineseSegments(
    changes: ReadonlyMap<number, ReadonlyMap<number, string>>,
  ): string {
    if (changes.size === 0) return this.original();
    const units = [...this.units];
    for (const [eventId, eventChanges] of changes) {
      const event = this.parsedEvents.find((candidate) => candidate.id === eventId);
      if (!event) throw new Error(`AI 返回了未知字幕事件 ID ${eventId}`);
      let text = units[event.unitIndex]!.slice(event.textStart, event.textEnd);
      const replacements = [...eventChanges.entries()]
        .map(([segmentIndex, replacement]) => {
          const segment = event.editableSegments.find(
            (candidate) => candidate.index === segmentIndex,
          );
          if (!segment) {
            throw new Error(
              `AI 返回了事件 ${eventId} 的未知中文片段 ${segmentIndex}`,
            );
          }
          return { segment, replacement };
        })
        .sort((left, right) => right.segment.start - left.segment.start);
      for (const { segment, replacement } of replacements) {
        text =
          text.slice(0, segment.start) + replacement + text.slice(segment.end);
      }
      const unit = units[event.unitIndex]!;
      units[event.unitIndex] =
        unit.slice(0, event.textStart) + text + unit.slice(event.textEnd);
    }
    return this.prefix + units.join(this.separator);
  }

  private original(): string {
    return this.prefix + this.units.join(this.separator);
  }

  static create(input: {
    format: TextSubtitleFormat;
    prefix: string;
    units: string[];
    separator: string;
    events: ParsedEvent[];
  }): SubtitleDocument {
    return new SubtitleDocument(
      input.format,
      input.prefix,
      input.units,
      input.separator,
      input.events,
    );
  }
}

function parseAss(format: "ass" | "ssa", content: string): SubtitleDocument {
  const { prefix, body } = splitBom(content);
  const newline = newlineFor(body);
  const lines = body.split(/\r?\n/);
  let eventFormat: string[] = [];
  let inEvents = false;
  const events: ParsedEvent[] = [];

  for (const [unitIndex, line] of lines.entries()) {
    const trimmed = line.trim();
    if (/^\[Events]/i.test(trimmed)) {
      inEvents = true;
      continue;
    }
    if (/^\[[^\]]+]/.test(trimmed)) {
      inEvents = false;
      continue;
    }
    if (!inEvents) continue;
    if (/^Format:/i.test(trimmed)) {
      eventFormat = trimmed
        .slice(trimmed.indexOf(":") + 1)
        .split(",")
        .map((field) => field.trim());
      continue;
    }
    if (!/^(Dialogue|Comment):/i.test(trimmed)) continue;

    const colon = line.indexOf(":");
    const valuesStart = colon + 1;
    const fields = splitLimited(line.slice(valuesStart).trimStart(), eventFormat.length || 10);
    const fieldIndex = (name: string, fallback: number) => {
      const index = eventFormat.findIndex(
        (candidate) => candidate.toLowerCase() === name.toLowerCase(),
      );
      return index >= 0 ? index : fallback;
    };
    const textIndex = fieldIndex("Text", 9);
    const textStart = assFieldStart(line, valuesStart, textIndex);
    const rawText = line.slice(textStart);
    const id = events.length;
    const kind = /^Comment:/i.test(trimmed) ? "comment" : "dialogue";
    const editableSegments =
      kind === "dialogue" ? chineseSegments(rawText, "ass") : [];
    const plainText = visibleText(rawText, "ass");
    events.push({
      id,
      unitIndex,
      textStart,
      textEnd: line.length,
      kind,
      plainText,
      editableSegments,
      chineseSegments: publicSegments(editableSegments),
      cleanerPromptLine:
        `[${id}] type="${kind === "comment" ? "Comment" : "Dialogue"}" ` +
        `style="${fields[fieldIndex("Style", 3)] ?? ""}" ` +
        `time="${fields[fieldIndex("Start", 1)] ?? ""}→` +
        `${fields[fieldIndex("End", 2)] ?? ""}" ` +
        `effect="${fields[fieldIndex("Effect", 8)] ?? ""}" ` +
        `raw="${rawText}" plain="${plainText.replaceAll("\n", " ")}"`,
    });
  }

  return SubtitleDocument.create({
    format,
    prefix,
    units: lines,
    separator: newline,
    events,
  });
}

function parseTimedText(
  format: "srt" | "vtt",
  content: string,
): SubtitleDocument {
  const { prefix, body } = splitBom(content);
  const separator = body.includes("\r\n\r\n") ? "\r\n\r\n" : "\n\n";
  const blocks = body.split(/\r?\n\r?\n/);
  const events: ParsedEvent[] = [];
  for (const [unitIndex, block] of blocks.entries()) {
    const newline = newlineFor(block);
    const lines = block.split(/\r?\n/);
    const timestampIndex = lines.findIndex((line) => line.includes("-->"));
    if (timestampIndex < 0) continue;
    const textStart = lines
      .slice(0, timestampIndex + 1)
      .reduce((total, line) => total + line.length + newline.length, 0);
    const rawText = block.slice(textStart);
    const editableSegments = chineseSegments(rawText, "timed");
    const id = events.length;
    events.push({
      id,
      unitIndex,
      textStart,
      textEnd: block.length,
      kind: "cue",
      plainText: visibleText(rawText, "timed"),
      editableSegments,
      chineseSegments: publicSegments(editableSegments),
      cleanerPromptLine:
        `[${id}] time="${lines[timestampIndex]?.trim()}" ` +
        `text="${rawText.replace(/\r?\n/g, " | ")}"`,
    });
  }
  return SubtitleDocument.create({
    format,
    prefix,
    units: blocks,
    separator,
    events,
  });
}

function chineseSegments(
  rawText: string,
  syntax: "ass" | "timed",
): EditableSegment[] {
  if (syntax === "ass" && /\\(?:k(?:f|o)?\d*|K\d*|p[1-9]\d*)/i.test(rawText)) {
    return [];
  }
  const lineRanges = displayLineRanges(rawText, syntax);
  const result: EditableSegment[] = [];
  for (const range of lineRanges) {
    const line = rawText.slice(range.start, range.end);
    const plain = visibleText(line, syntax);
    if (/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(plain)) {
      continue;
    }
    const protectedRanges = syntaxRanges(line, syntax);
    let cursor = 0;
    for (const protectedRange of protectedRanges) {
      appendHanSegments(
        result,
        line.slice(cursor, protectedRange.start),
        range.start + cursor,
      );
      cursor = protectedRange.end;
    }
    appendHanSegments(result, line.slice(cursor), range.start + cursor);
  }
  return result.map((segment, index) => ({ ...segment, index }));
}

function appendHanSegments(
  target: EditableSegment[],
  text: string,
  offset: number,
): void {
  for (const match of text.matchAll(/\p{Script=Han}+/gu)) {
    const start = offset + (match.index ?? 0);
    target.push({
      index: 0,
      start,
      end: start + match[0].length,
      text: match[0],
    });
  }
}

function displayLineRanges(
  value: string,
  syntax: "ass" | "timed",
): Array<{ start: number; end: number }> {
  const delimiter = syntax === "ass" ? /\\[Nn]|\r?\n/g : /\r?\n/g;
  const result: Array<{ start: number; end: number }> = [];
  let start = 0;
  for (const match of value.matchAll(delimiter)) {
    const index = match.index ?? start;
    result.push({ start, end: index });
    start = index + match[0].length;
  }
  result.push({ start, end: value.length });
  return result;
}

function syntaxRanges(
  value: string,
  syntax: "ass" | "timed",
): Array<{ start: number; end: number }> {
  const expression = syntax === "ass" ? /\{[^}]*}/g : /<[^>]*>|\{[^}]*}/g;
  return [...value.matchAll(expression)].map((match) => ({
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));
}

function visibleText(value: string, syntax: "ass" | "timed"): string {
  const withoutTags =
    syntax === "ass"
      ? value.replace(/\{[^}]*}/g, "")
      : value.replace(/<[^>]*>|\{[^}]*}/g, "");
  return withoutTags
    .replace(/\\[Nn]/g, "\n")
    .replace(/\\h/g, " ")
    .trim();
}

function publicSegments(segments: EditableSegment[]): ChineseTextSegment[] {
  return segments.map(({ index, text }) => ({ index, text }));
}

function splitLimited(value: string, fields: number): string[] {
  const result: string[] = [];
  let start = 0;
  for (let count = 1; count < fields; count += 1) {
    const index = value.indexOf(",", start);
    if (index < 0) break;
    result.push(value.slice(start, index));
    start = index + 1;
  }
  result.push(value.slice(start));
  return result;
}

function assFieldStart(line: string, valuesStart: number, fieldIndex: number): number {
  let cursor = valuesStart;
  let fieldsSeen = 0;
  while (fieldsSeen < fieldIndex) {
    const comma = line.indexOf(",", cursor);
    if (comma < 0) return line.length;
    cursor = comma + 1;
    fieldsSeen += 1;
  }
  return cursor;
}

function splitBom(content: string): { prefix: string; body: string } {
  return content.startsWith("\uFEFF")
    ? { prefix: "\uFEFF", body: content.slice(1) }
    : { prefix: "", body: content };
}

function newlineFor(value: string): string {
  return value.includes("\r\n") ? "\r\n" : "\n";
}
