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
  const hasToken = (candidates: string[]) =>
    candidates.some((candidate) => tokenPattern(candidate).test(value));
  const simplified =
    includes(["简体", "简中"]) ||
    hasToken(["chs", "sc", "gb", "zh-cn", "zh_cn", "zh-hans", "zh_hans"]) ||
    /简[.\-_]/.test(value);
  const traditional =
    includes(["繁体", "繁中"]) ||
    hasToken([
      "cht",
      "tc",
      "tw",
      "hk",
      "big5",
      "zh-tw",
      "zh_tw",
      "zh-hant",
      "zh_hant",
    ]) ||
    /繁[.\-_]/.test(value);
  const english =
    includes(["英文", "英语"]) || hasToken(["eng", "english", "en"]);
  const chinese = includes(["中文"]) || hasToken(["chinese"]);
  const bilingual =
    includes(["双语", "中英"]) ||
    hasToken(["bilingual"]) ||
    (chinese && english);

  if (bilingual || (simplified && english)) return "chs+eng";
  if (simplified && traditional) return "chs+cht";
  if (simplified) return "chs";
  if (traditional) return "cht";
  if (chinese) return "chs";
  if (english) return "eng";
  return "unknown";
}

function tokenPattern(value: string): RegExp {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, "i");
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
