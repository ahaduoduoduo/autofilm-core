import type { CatalogItem } from "../integrations/tmdb.js";

export function rememberCatalogResults(
  toolName: string,
  content: string,
  items: Map<number, CatalogItem>,
): void {
  if (toolName !== "search_catalog") return;
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!Array.isArray(parsed)) return;
    for (const candidate of parsed) {
      if (isCatalogItem(candidate)) items.set(candidate.id, candidate);
    }
  } catch {
    // The model still receives the original tool result. Poster delivery is optional.
  }
}

export function selectedCatalogItem(
  content: string,
  items: Map<number, CatalogItem>,
): CatalogItem | undefined {
  for (const match of content.matchAll(/\bTMDB(?:\s*ID)?\s*[:：#]?\s*(\d+)/gi)) {
    const candidate = items.get(Number(match[1]));
    if (candidate) return candidate;
  }

  const normalized = content.toLocaleLowerCase();
  const matches = [...items.values()].filter((item) => {
    const year = item.releaseDate.slice(0, 4);
    if (year && !normalized.includes(year)) return false;
    return [item.title, item.originalTitle]
      .filter(Boolean)
      .some((title) => normalized.includes(title.toLocaleLowerCase()));
  });
  return matches.length === 1 ? matches[0] : undefined;
}

function isCatalogItem(value: unknown): value is CatalogItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<CatalogItem>;
  return (
    typeof item.id === "number" &&
    Number.isInteger(item.id) &&
    typeof item.title === "string" &&
    typeof item.originalTitle === "string" &&
    typeof item.releaseDate === "string" &&
    typeof item.posterPath === "string" &&
    (item.mediaType === "movie" || item.mediaType === "tv")
  );
}
