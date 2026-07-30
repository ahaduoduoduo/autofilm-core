export interface AssStyle {
  name: string;
  fontName: string;
  fontSize: number;
  primaryColour: string;
  outlineColour: string;
  alignment: number;
  marginV: number;
  usageCount: number;
  samples: string[];
}

export interface AssAnalysis {
  playResX: number;
  playResY: number;
  aspectRatio: string;
  styles: AssStyle[];
  dialogueCount: number;
}

export interface AssModifyOptions {
  styleNames: string[];
  changes?: {
    fontSize?: number;
    primaryColour?: string;
    outlineColour?: string;
    alignment?: number;
    marginV?: number;
  };
  moveToBottom?: boolean;
  moveToBlackBar?: boolean;
  inlineMode?: "keep" | "scale" | "remove";
  blackBarMarginV?: number;
}

interface StyleSection {
  formatIndex: number;
  format: string[];
  start: number;
  end: number;
}

export function analyzeAss(content: string): AssAnalysis {
  const lines = splitLines(content);
  const playResX = scriptNumber(lines, "PlayResX");
  const playResY = scriptNumber(lines, "PlayResY");
  const section = findStyleSection(lines);
  const styles = new Map<string, AssStyle>();
  if (section) {
    for (let index = section.formatIndex + 1; index < section.end; index += 1) {
      const line = lines[index] ?? "";
      if (!/^Style:/i.test(line)) continue;
      const values = splitCsv(line.replace(/^Style:\s*/i, ""));
      const value = (name: string) => values[fieldIndex(section.format, name)] ?? "";
      const style: AssStyle = {
        name: value("Name"),
        fontName: value("Fontname"),
        fontSize: numberValue(value("Fontsize")),
        primaryColour: value("PrimaryColour"),
        outlineColour: value("OutlineColour"),
        alignment: numberValue(value("Alignment")),
        marginV: numberValue(value("MarginV")),
        usageCount: 0,
        samples: [],
      };
      if (style.name) styles.set(style.name, style);
    }
  }
  let dialogueCount = 0;
  for (const line of lines) {
    if (!/^Dialogue:/i.test(line)) continue;
    dialogueCount += 1;
    const values = splitCsvLimited(line.replace(/^Dialogue:\s*/i, ""), 10);
    const style = styles.get(values[3] ?? "");
    if (!style) continue;
    style.usageCount += 1;
    const sample = stripAssTags(values[9] ?? "").trim();
    if (sample && style.samples.length < 3) style.samples.push(sample.slice(0, 100));
  }
  return {
    playResX,
    playResY,
    aspectRatio: describeAspectRatio(playResX, playResY),
    styles: [...styles.values()],
    dialogueCount,
  };
}

export function modifyAss(content: string, options: AssModifyOptions): string {
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = splitLines(content);
  const selected = new Set(options.styleNames);
  const section = findStyleSection(lines);
  const originalX = scriptNumber(lines, "PlayResX");
  const originalY = scriptNumber(lines, "PlayResY");
  const canExpand = originalX > 0 && originalY > 0;
  const targetY = options.moveToBlackBar && canExpand
    ? Math.max(originalY, Math.round((originalX * 9) / 16))
    : originalY;
  const verticalOffset = Math.round((targetY - originalY) / 2);

  if (options.moveToBlackBar && targetY !== originalY) {
    setScriptNumber(lines, "PlayResY", targetY);
  }
  if (section) {
    for (let index = section.formatIndex + 1; index < section.end; index += 1) {
      const line = lines[index] ?? "";
      if (!/^Style:/i.test(line)) continue;
      const prefix = line.match(/^Style:\s*/i)?.[0] ?? "Style: ";
      const values = splitCsv(line.slice(prefix.length));
      const nameIndex = fieldIndex(section.format, "Name");
      const isSelected = selected.has(values[nameIndex] ?? "");
      if (isSelected) {
        applyStyleChanges(values, section.format, options);
      }
      if (isSelected && (options.moveToBottom || options.moveToBlackBar)) {
        setField(values, section.format, "Alignment", "2");
      }
      if (isSelected && options.moveToBlackBar) {
        setField(
          values,
          section.format,
          "MarginV",
          String(options.blackBarMarginV ?? 30),
        );
      } else if (!isSelected && options.moveToBlackBar && verticalOffset > 0) {
        const marginIndex = fieldIndex(section.format, "MarginV");
        if (marginIndex >= 0) {
          values[marginIndex] = String(
            numberValue(values[marginIndex]) + verticalOffset,
          );
        }
      }
      lines[index] = `${prefix}${values.join(",")}`;
    }
  }
  const eventFormat = findEventFormat(lines);
  if (eventFormat) {
    for (
      let index = eventFormat.formatIndex + 1;
      index < eventFormat.end;
      index += 1
    ) {
      const line = lines[index] ?? "";
      if (!/^Dialogue:/i.test(line)) continue;
      const prefix = line.match(/^Dialogue:\s*/i)?.[0] ?? "Dialogue: ";
      const values = splitCsvLimited(
        line.slice(prefix.length),
        eventFormat.format.length,
      );
      const styleName = values[fieldIndex(eventFormat.format, "Style")] ?? "";
      const textIndex = fieldIndex(eventFormat.format, "Text");
      let text = values[textIndex] ?? "";
      if (selected.has(styleName)) {
        if (options.moveToBottom || options.moveToBlackBar) {
          text = removePositionTags(text);
        }
        if (options.inlineMode === "remove") {
          text = removeSelectedInlineOverrides(text, options);
        } else if (
          options.inlineMode === "scale" &&
          options.changes?.fontSize
        ) {
          text = text.replace(
            /\\fs(\d+(?:\.\d+)?)/gi,
            (_, size: string) =>
              `\\fs${Math.round(
                Number(size) *
                  (options.changes!.fontSize! /
                    currentStyleSize(lines, section, styleName)),
              )}`,
          );
        }
      } else if (options.moveToBlackBar && verticalOffset !== 0) {
        text = shiftCoordinates(text, verticalOffset);
      }
      values[textIndex] = text;
      lines[index] = `${prefix}${values.join(",")}`;
    }
  }
  return lines.join(newline);
}

function applyStyleChanges(
  values: string[],
  format: string[],
  options: AssModifyOptions,
): void {
  const changes = options.changes;
  if (!changes) return;
  if (changes.fontSize !== undefined)
    setField(values, format, "Fontsize", String(changes.fontSize));
  if (changes.primaryColour !== undefined)
    setField(values, format, "PrimaryColour", changes.primaryColour);
  if (changes.outlineColour !== undefined)
    setField(values, format, "OutlineColour", changes.outlineColour);
  if (changes.alignment !== undefined)
    setField(values, format, "Alignment", String(changes.alignment));
  if (changes.marginV !== undefined)
    setField(values, format, "MarginV", String(changes.marginV));
}

function findStyleSection(lines: string[]): StyleSection | undefined {
  return findSection(lines, ["V4+ Styles", "V4 Styles"]);
}

function findEventFormat(lines: string[]): StyleSection | undefined {
  return findSection(lines, ["Events"]);
}

function findSection(
  lines: string[],
  names: string[],
): StyleSection | undefined {
  let start = -1;
  let end = lines.length;
  for (let index = 0; index < lines.length; index += 1) {
    const match = (lines[index] ?? "").match(/^\[([^\]]+)]/);
    if (match) {
      if (start >= 0) {
        end = index;
        break;
      }
      if (
        names.some(
          (name) => (match[1] ?? "").toLowerCase() === name.toLowerCase(),
        )
      ) {
        start = index;
      }
    }
  }
  if (start < 0) return undefined;
  const formatIndex = lines.findIndex(
    (line, index) => index > start && index < end && /^Format:/i.test(line),
  );
  if (formatIndex < 0) return undefined;
  return {
    formatIndex,
    format: splitCsv((lines[formatIndex] ?? "").replace(/^Format:\s*/i, "")),
    start,
    end,
  };
}

function currentStyleSize(
  lines: string[],
  section: StyleSection | undefined,
  styleName: string,
): number {
  if (!section) return 1;
  for (let index = section.formatIndex + 1; index < section.end; index += 1) {
    const line = lines[index] ?? "";
    if (!/^Style:/i.test(line)) continue;
    const values = splitCsv(line.replace(/^Style:\s*/i, ""));
    if (values[fieldIndex(section.format, "Name")] === styleName) {
      return numberValue(values[fieldIndex(section.format, "Fontsize")]) || 1;
    }
  }
  return 1;
}

function shiftCoordinates(text: string, yOffset: number): string {
  return text
    .replace(
      /\\pos\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)/gi,
      (_, x: string, y: string) => `\\pos(${x},${Number(y) + yOffset})`,
    )
    .replace(
      /\\move\(([^,]+),([^,]+),([^,]+),([^,\)]+)(,[^)]*)?\)/gi,
      (
        _,
        x1: string,
        y1: string,
        x2: string,
        y2: string,
        timing = "",
      ) =>
        `\\move(${x1},${Number(y1) + yOffset},${x2},${Number(y2) + yOffset}${timing})`,
    )
    .replace(
      /\\(i?clip)\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)/gi,
      (_, type: string, x1: string, y1: string, x2: string, y2: string) =>
        `\\${type}(${x1},${Number(y1) + yOffset},${x2},${Number(y2) + yOffset})`,
    )
    .replace(
      /\\org\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)/gi,
      (_, x: string, y: string) => `\\org(${x},${Number(y) + yOffset})`,
    );
}

function removePositionTags(text: string): string {
  return text
    .replace(/\\pos\([^)]*\)/gi, "")
    .replace(/\\move\([^)]*\)/gi, "")
    .replace(/\\an\d+/gi, "")
    .replace(/\\org\([^)]*\)/gi, "")
    .replace(/\{\s*}/g, "");
}

function removeSelectedInlineOverrides(
  text: string,
  options: AssModifyOptions,
): string {
  let result = text;
  if (options.changes?.fontSize !== undefined) {
    result = result.replace(/\\fs\d+(?:\.\d+)?/gi, "");
  }
  if (options.changes?.primaryColour !== undefined) {
    result = result.replace(/\\[1]?c&H[0-9A-F]+&/gi, "");
  }
  if (options.changes?.outlineColour !== undefined) {
    result = result.replace(/\\3c&H[0-9A-F]+&/gi, "");
  }
  return result.replace(/\{\s*}/g, "");
}

function scriptNumber(lines: string[], key: string): number {
  const line = lines.find((candidate) =>
    new RegExp(`^${key}\\s*:`, "i").test(candidate),
  );
  return numberValue(line?.split(":").slice(1).join(":") ?? "");
}

function setScriptNumber(lines: string[], key: string, value: number): void {
  const index = lines.findIndex((line) =>
    new RegExp(`^${key}\\s*:`, "i").test(line),
  );
  if (index >= 0) lines[index] = `${key}: ${value}`;
}

function fieldIndex(format: string[], name: string): number {
  return format.findIndex(
    (field) => field.trim().toLowerCase() === name.toLowerCase(),
  );
}

function setField(
  values: string[],
  format: string[],
  name: string,
  value: string,
): void {
  const index = fieldIndex(format, name);
  if (index >= 0) values[index] = value;
}

function splitLines(content: string): string[] {
  return content.replace(/^\uFEFF/, "").split(/\r?\n/);
}

function splitCsv(value: string): string[] {
  return value.split(",").map((part) => part.trim());
}

function splitCsvLimited(value: string, fields: number): string[] {
  const result: string[] = [];
  let start = 0;
  for (let count = 1; count < fields; count += 1) {
    const index = value.indexOf(",", start);
    if (index < 0) break;
    result.push(value.slice(start, index).trim());
    start = index + 1;
  }
  result.push(value.slice(start));
  return result;
}

function numberValue(value: string | undefined): number {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}

function stripAssTags(value: string): string {
  return value.replace(/\{[^}]*\}/g, "").replace(/\\[Nn]/g, " ");
}

function reduce(x: number, y: number): [number, number] {
  let a = x;
  let b = y;
  while (b) [a, b] = [b, a % b];
  return [Math.round(x / a), Math.round(y / a)];
}

function describeAspectRatio(x: number, y: number): string {
  if (x <= 0 || y <= 0) return "?";
  const ratio = x / y;
  if (Math.abs(ratio - 16 / 9) < 0.05) return "16:9";
  if (Math.abs(ratio - 2.35) < 0.1) return "~2.35:1";
  if (Math.abs(ratio - 2.39) < 0.1) return "~2.39:1";
  if (Math.abs(ratio - 2.4) < 0.15) return "~2.40:1";
  if (Math.abs(ratio - 4 / 3) < 0.05) return "4:3";
  const exact = reduce(x, y).join(":");
  return Number(exact.split(":")[0]) < 100 ? exact : `${ratio.toFixed(2)}:1`;
}
