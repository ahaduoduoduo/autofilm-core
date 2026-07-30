import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseDetail,
  parseMoviePage,
  parseSearchPage,
  SubHDClient,
} from "./subhd.js";

const searchHtml = `
<div class="bg-white shadow-sm rounded-3 mb-4">
  <div class="float-start f16 fw-bold"><a href="/a/search-one">搜索字幕</a></div>
  <a href="/d/movie-42">影片</a>
  <div class="view-text"><a>Movie.2026.WEB-DL</a></div>
  <div class="text-truncate py-2 f11">
    <span class="rounded p-1 me-1 text-white">转载精修</span>
    <span class="p-1 fw-bold">简体</span>
    <span class="p-1 fw-bold">双语</span>
    <span class="p-1 text-secondary">ASS</span>
    <span class="p-1">12</span><span class="p-1">1</span>
  </div>
  <span class="align-text-top me-3">120KB</span>
  <span class="align-text-top me-3">123</span>
  <span class="align-text-top me-3">今天</span>
  <a href="/u/author">author</a>
</div>`;

const movieHtml = `
<div class="row pt-2 mb-2">
  <div class="view-text"><a class="link-dark" href="/a/movie-sub">Movie.2026.2160p.WEB-DL</a></div>
  <div class="pt-1 f11">
    <span class="rounded p-1 me-1 text-white">官方字幕</span>
    <span class="p-1 fw-bold">简体</span>
    <span class="p-1 fw-bold">双语</span>
    <span class="p-1 text-secondary">SUP</span>
    <span class="p-1 text-primary">7</span>
    <span class="p-1 text-danger"><span class="align-baseline">25</span></span>
  </div>
  <div class="col-2 d-none d-lg-block"><div class="text-end text-secondary">2,345</div></div>
  <div class="col-2 d-none d-lg-block"><a class="link-dark" href="/u/a">a</a><div class="text-black-50">昨天</div></div>
</div>`;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SubHD full movie search", () => {
  it("recognizes the movie page and replaces search-page candidates", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(searchHtml, { status: 200 }))
      .mockResolvedValueOnce(new Response(movieHtml, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new SubHDClient({
      service: () => ({
        baseUrl: "https://subhd.tv",
        options: { requestDelayMs: 0 },
      }),
    } as never);

    const result = await client.search("Movie");

    expect(result.source).toBe("movie");
    expect(result.moviePageId).toBe("movie-42");
    expect(result.results[0]).toMatchObject({
      id: "movie-sub",
      downloads: 2345,
      ratingUp: 25,
      commentCount: 7,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("parses search ratings and nested detail replies", () => {
    expect(parseSearchPage(searchHtml)[0]).toMatchObject({
      id: "search-one",
      ratingUp: 12,
      ratingDown: 1,
      moviePageId: "movie-42",
    });
    expect(parseMoviePage(movieHtml, "movie-42")).toHaveLength(1);

    const detail = parseDetail(
      `
      <h1>字幕</h1>
      <div class="p-3 my-2 bg-light clearfix"></div>
      <a href="/u/author">author</a>
      <div class="pt-3 f14">
        <div class="d-flex px-3"><div class="flex-grow-1">
          <a href="/u/user-a">user-a</a>
          <div class="pt-2">时间轴正确</div>
          <div class="pt-2"><div class="float-start">今天</div></div>
          <div class="d-flex p-2 my-2 bg-light shadow-sm rounded-3">
            <div class="flex-grow-1">
              <a href="/u/author">author</a>
              <div class="pt-2">谢谢反馈</div>
              <div class="pt-2"><div class="float-start">今天</div></div>
            </div>
          </div>
        </div></div>
      </div>`,
      "detail-one",
    );
    expect(detail.comments[0]?.content).toBe("时间轴正确");
    expect(detail.comments[0]?.replies[0]?.content).toBe("谢谢反馈");
  });

  it("keeps concurrent download cookies and captcha sessions isolated", async () => {
    let activeRequests = 0;
    let maximumActiveRequests = 0;
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init: RequestInit = {}) => {
        activeRequests += 1;
        maximumActiveRequests = Math.max(
          maximumActiveRequests,
          activeRequests,
        );
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
        try {
          const url = new URL(
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input
                : input.url,
          );
          const headers = new Headers(init.headers);
          const cookie = headers.get("cookie") ?? "";
          if (url.pathname.startsWith("/a/")) {
            const sid = url.pathname.split("/").pop()!;
            return response("detail", {
              "set-cookie": `session=${sid}; Path=/; HttpOnly`,
            });
          }
          if (url.pathname === "/api/sub/prepare-download") {
            const sid = JSON.parse(String(init.body)).sid as string;
            expect(cookie).toContain(`session=${sid}`);
            return jsonResponse(
              { success: true, url: `/down/token-${sid}` },
              { "set-cookie": `prepared=${sid}; Path=/` },
            );
          }
          if (url.pathname.startsWith("/down/token-")) {
            const sid = url.pathname.replace("/down/token-", "");
            expect(cookie).toContain(`session=${sid}`);
            return response("download page", {
              "set-cookie": `download=${sid}; Path=/`,
            });
          }
          if (url.pathname === "/api/sub/down") {
            const body = JSON.parse(String(init.body)) as {
              sid: string;
              cap?: string;
            };
            expect(cookie).toContain(`session=${body.sid}`);
            expect(cookie).toContain(`download=${body.sid}`);
            if (!body.cap) {
              return jsonResponse(
                { success: true, pass: false, msg: `<svg>${body.sid}</svg>` },
                { "set-cookie": `captcha=${body.sid}; Path=/` },
              );
            }
            expect(cookie).toContain(`captcha=${body.sid}`);
            expect(body.cap).toBe(`answer-${body.sid}`);
            return jsonResponse({
              success: true,
              pass: true,
              url: `https://cdn.example/${body.sid}.ass`,
            });
          }
          if (url.origin === "https://cdn.example") {
            return response(url.pathname.slice(1));
          }
          throw new Error(`Unexpected URL: ${url}`);
        } finally {
          activeRequests -= 1;
        }
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new SubHDClient({
      service: () => ({
        baseUrl: "https://subhd.tv",
        options: { requestDelayMs: 0 },
      }),
    } as never);

    const [first, second] = await Promise.all([
      client.download("subtitle-a"),
      client.download("subtitle-b"),
    ]);
    expect(first.captcha?.sessionId).not.toBe(second.captcha?.sessionId);
    expect(first.captcha?.cookies).toContain("session=subtitle-a");
    expect(first.captcha?.cookies).not.toContain("session=subtitle-b");
    expect(second.captcha?.cookies).toContain("session=subtitle-b");
    expect(second.captcha?.cookies).not.toContain("session=subtitle-a");

    const [firstResult, secondResult] = await Promise.all([
      client.submitCaptcha(first.captcha!, "answer-subtitle-a"),
      client.submitCaptcha(second.captcha!, "answer-subtitle-b"),
    ]);
    expect(firstResult.filename).toBe("subtitle-a.ass");
    expect(secondResult.filename).toBe("subtitle-b.ass");
    expect(maximumActiveRequests).toBeGreaterThan(1);
  });
});

function response(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status: 200, headers });
}

function jsonResponse(
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Response {
  return response(JSON.stringify(body), {
    "content-type": "application/json",
    ...headers,
  });
}
