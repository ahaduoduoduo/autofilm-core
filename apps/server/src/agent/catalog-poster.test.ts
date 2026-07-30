import { describe, expect, it } from "vitest";
import type { CatalogItem } from "../integrations/tmdb.js";
import {
  rememberCatalogResults,
  selectedCatalogItem,
} from "./catalog-poster.js";

const colony: CatalogItem = {
  id: 1375646,
  mediaType: "movie",
  title: "群体",
  originalTitle: "군체",
  overview: "",
  releaseDate: "2026-05-21",
  posterPath: "/colony.jpg",
};

describe("catalog poster selection", () => {
  it("selects the poster by the TMDB ID stated in the final response", () => {
    const items = new Map<number, CatalogItem>([
      [colony.id, colony],
      [
        2,
        {
          ...colony,
          id: 2,
          title: "其他电影",
          originalTitle: "Other",
          posterPath: "/other.jpg",
        },
      ],
    ]);

    expect(
      selectedCatalogItem("找到《群体》，TMDB ID：1375646", items),
    ).toEqual(colony);
  });

  it("uses a unique title and year match when the response omits the ID", () => {
    const items = new Map<number, CatalogItem>([[colony.id, colony]]);

    expect(selectedCatalogItem("《群体》是 2026 年韩国电影。", items)).toEqual(
      colony,
    );
  });

  it("records only valid search_catalog results", () => {
    const items = new Map<number, CatalogItem>();
    rememberCatalogResults(
      "search_catalog",
      JSON.stringify([colony, { id: "invalid" }]),
      items,
    );

    expect([...items.values()]).toEqual([colony]);
  });
});
