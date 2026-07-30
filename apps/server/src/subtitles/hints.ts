export function episodeHint(value: string): number | undefined {
  const seasonEpisode = value.match(/[Ss]\d{1,3}[Ee](\d{1,4})/);
  if (seasonEpisode) return positiveInteger(seasonEpisode[1]!);

  const episode = value.match(/\bE[Pp]?(\d{2,4})\b/);
  if (episode) return positiveInteger(episode[1]!);

  const chinese = value.match(/第\s*(\d{1,4})\s*[集话話]/);
  if (chinese) return positiveInteger(chinese[1]!);

  const separated = value.match(/[.\-_\s](\d{2,3})[.\-_\s]/);
  const number = separated ? positiveInteger(separated[1]!) : undefined;
  return number && number < 1000 ? number : undefined;
}

export function languageHint(filename: string, relativePath = ""): string {
  const value = `${relativePath}/${filename}`.toLowerCase();
  const includes = (candidates: string[]) =>
    candidates.some((candidate) => value.includes(candidate));
  const simplified =
    includes(["chs", "简体", "简中", "sc.", "gb.", "zh-cn"]) ||
    /简[.\-_]/.test(value);
  const traditional =
    includes(["cht", "繁体", "繁中", "tc.", "tw.", "hk.", "big5", "zh-tw"]) ||
    /繁[.\-_]/.test(value);
  const english = includes(["eng", "english", "英文", "英语", ".en."]);
  const bilingual = includes([
    "双语",
    "chs&eng",
    "chs.eng",
    "eng&chs",
    "bilingual",
    "中英",
  ]);

  if (bilingual || (simplified && english)) return "chs+eng";
  if (simplified && traditional) return "chs+cht";
  if (simplified) return "chs";
  if (traditional) return "cht";
  if (english) return "eng";
  if (/中文|chinese/.test(value)) return "chs";
  return "unknown";
}

export function jellyfinLanguage(hint: string): string {
  if (hint === "eng") return "en";
  if (hint === "cht") return "zh-tw";
  return "zh";
}

function positiveInteger(value: string): number | undefined {
  const result = Number.parseInt(value, 10);
  return Number.isInteger(result) && result > 0 ? result : undefined;
}
