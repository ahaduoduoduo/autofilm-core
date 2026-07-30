import * as cheerio from "cheerio";
import { randomUUID } from "node:crypto";
import type { AnyNode } from "domhandler";
import type { ConfigStore } from "../db/config-store.js";
import { CookieJar } from "./cookie-jar.js";
import type {
  CaptchaChallenge,
  SubtitleComment,
  SubtitleDetail,
  SubtitleDownload,
  SubtitleSearchResponse,
  SubtitleSearchResult,
} from "../subtitles/types.js";

const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export class SubHDClient {
  private requestStartQueue: Promise<unknown> = Promise.resolve();
  private lastRequestAt = 0;

  constructor(private readonly configs: ConfigStore) {}

  async search(keyword: string): Promise<SubtitleSearchResponse> {
    const response = await this.request(
      `/search/${encodeURIComponent(keyword)}`,
    );
    if (!response.ok) throw new Error(`SubHD 搜索返回 HTTP ${response.status}`);
    const searchResults = parseSearchPage(await response.text());
    const moviePageId = mostCommonMoviePageId(searchResults);
    if (moviePageId) {
      try {
        const moviePage = await this.request(
          `/d/${encodeURIComponent(moviePageId)}`,
        );
        if (moviePage.ok) {
          const movieResults = parseMoviePage(
            await moviePage.text(),
            moviePageId,
          );
          if (movieResults.length > 0) {
            return {
              source: "movie",
              moviePageId,
              total: movieResults.length,
              results: movieResults,
            };
          }
        }
      } catch {
        // The search page is still useful when the associated movie page is
        // temporarily unavailable or its markup has changed.
      }
    }
    return {
      source: "search",
      moviePageId,
      total: searchResults.length,
      results: searchResults,
    };
  }

  async detail(id: string): Promise<SubtitleDetail> {
    const response = await this.request(`/a/${encodeURIComponent(id)}`);
    if (!response.ok) throw new Error(`SubHD 详情返回 HTTP ${response.status}`);
    return parseDetail(await response.text(), id);
  }

  async download(id: string): Promise<SubtitleDownload> {
    const session: SubHDDownloadSession = {
      id: randomUUID(),
      sid: id,
      cookies: new CookieJar(),
      downloadPageUrl: "",
    };
    await this.establishSession(session);
    return this.callDownload(session, "");
  }

  async submitCaptcha(
    challenge: CaptchaChallenge,
    text: string,
  ): Promise<SubtitleDownload> {
    return this.callDownload(
      {
        id: challenge.sessionId,
        sid: challenge.sid,
        cookies: new CookieJar(challenge.cookies),
        downloadPageUrl: challenge.downloadPageUrl,
      },
      text,
    );
  }

  async test(): Promise<{ ok: true; resultCount: number }> {
    const results = await this.search("test");
    return { ok: true, resultCount: results.total };
  }

  private async establishSession(
    session: SubHDDownloadSession,
  ): Promise<void> {
    const detailPath = `/a/${encodeURIComponent(session.sid)}`;
    const detail = await this.sessionRequest(session, detailPath);
    if (!detail.ok) throw new Error(`SubHD 详情返回 HTTP ${detail.status}`);
    await detail.text();
    const prepare = await this.sessionRequest(
      session,
      "/api/sub/prepare-download",
      {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8",
          origin: this.baseUrl(),
          referer: `${this.baseUrl()}${detailPath}`,
          "x-requested-with": "XMLHttpRequest",
        },
        body: JSON.stringify({ sid: session.sid }),
      },
    );
    const result = (await prepare.json()) as {
      success?: boolean;
      url?: string;
      msg?: string;
    };
    if (!prepare.ok || result.success !== true || !result.url) {
      throw new Error(result.msg || `SubHD 下载准备返回 HTTP ${prepare.status}`);
    }
    const pageUrl = new URL(result.url, this.baseUrl());
    if (
      pageUrl.origin !== new URL(this.baseUrl()).origin ||
      !pageUrl.pathname.startsWith("/down/")
    ) {
      throw new Error("SubHD 返回了无效的临时下载地址");
    }
    const page = await this.sessionRequest(session, pageUrl.toString(), {
      headers: { referer: `${this.baseUrl()}${detailPath}` },
    });
    if (!page.ok) throw new Error(`SubHD 下载页返回 HTTP ${page.status}`);
    await page.text();
    session.downloadPageUrl = pageUrl.toString();
  }

  private async callDownload(
    session: SubHDDownloadSession,
    captcha: string,
  ): Promise<SubtitleDownload> {
    const response = await this.sessionRequest(session, "/api/sub/down", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        referer: session.downloadPageUrl,
      },
      body: JSON.stringify(
        captcha
          ? { sid: session.sid, cap: captcha }
          : { sid: session.sid },
      ),
    });
    const result = (await response.json()) as {
      success?: boolean;
      pass?: boolean;
      url?: string;
      msg?: string;
    };
    if (!response.ok) throw new Error(`SubHD 下载接口返回 HTTP ${response.status}`);
    if (result.pass && result.url) {
      const file = await fetch(result.url, {
        headers: { "user-agent": USER_AGENT },
        signal: AbortSignal.timeout(60_000),
      });
      if (!file.ok) throw new Error(`字幕文件下载返回 HTTP ${file.status}`);
      const urlName = new URL(result.url).pathname.split("/").pop();
      return {
        data: Buffer.from(await file.arrayBuffer()),
        filename: urlName || "subtitle.zip",
      };
    }
    if (result.msg) {
      return {
        captcha: {
          sessionId: session.id,
          svgContent: result.msg,
          sid: session.sid,
          cookies: session.cookies.header(),
          downloadPageUrl: session.downloadPageUrl,
        },
      };
    }
    throw new Error(result.msg || "SubHD 返回了无法识别的下载结果");
  }

  private async sessionRequest(
    session: SubHDDownloadSession,
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    let url = path.startsWith("http") ? path : `${this.baseUrl()}${path}`;
    let currentInit = init;
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      const response = await this.request(url, {
        ...currentInit,
        redirect: "manual",
        headers: {
          ...currentInit.headers,
          ...(session.cookies.header()
            ? { cookie: session.cookies.header() }
            : {}),
        },
      });
      session.cookies.absorb(response.headers);
      if (![301, 302, 303, 307, 308].includes(response.status)) {
        return response;
      }
      const location = response.headers.get("location");
      if (!location) return response;
      const nextUrl = new URL(location, url);
      if (nextUrl.origin !== new URL(this.baseUrl()).origin) {
        throw new Error("SubHD session 请求拒绝跨域重定向");
      }
      url = nextUrl.toString();
      if (
        response.status === 303 ||
        ((response.status === 301 || response.status === 302) &&
          currentInit.method?.toUpperCase() === "POST")
      ) {
        currentInit = { method: "GET" };
      }
    }
    throw new Error("SubHD session 请求重定向次数过多");
  }

  private async request(
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    await this.reserveRequestStart();
    const url = path.startsWith("http") ? path : `${this.baseUrl()}${path}`;
    return fetch(url, {
      ...init,
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,application/xhtml+xml,application/json",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
        ...init.headers,
      },
      signal: init.signal ?? AbortSignal.timeout(60_000),
    });
  }

  private reserveRequestStart(): Promise<void> {
    const turn = this.requestStartQueue.then(async () => {
      const delay = Number(this.config()?.options.requestDelayMs ?? 800);
      const remaining = delay - (Date.now() - this.lastRequestAt);
      if (remaining > 0) {
        await new Promise((resolve) => setTimeout(resolve, remaining));
      }
      this.lastRequestAt = Date.now();
    });
    this.requestStartQueue = turn.then(
      () => undefined,
      () => undefined,
    );
    return turn;
  }

  private config() {
    return this.configs.service("subhd");
  }

  private baseUrl(): string {
    return this.config()?.baseUrl || "https://subhd.tv";
  }
}

interface SubHDDownloadSession {
  id: string;
  sid: string;
  cookies: CookieJar;
  downloadPageUrl: string;
}

export function parseSearchPage(html: string): SubtitleSearchResult[] {
  const $ = cheerio.load(html);
  const results: SubtitleSearchResult[] = [];
  $("div.bg-white.shadow-sm.rounded-3.mb-4").each((_, element) => {
    const card = $(element);
    const link = card
      .find('div.float-start.f16.fw-bold a[href^="/a/"]')
      .first();
    const id = (link.attr("href") || "").replace("/a/", "");
    if (!id) return;
    const badges = card.find("div.text-truncate.py-2.f11");
    const languages: string[] = [];
    let bilingual = false;
    let format = "";
    badges.find("span.p-1").each((__, span) => {
      const text = $(span).text().trim();
      if ($(span).hasClass("fw-bold")) {
        if (text === "双语") bilingual = true;
        else if (text) languages.push(text);
      } else if (
        $(span).hasClass("text-secondary") &&
        /^(SRT|ASS|SSA|SUP)$/i.test(text)
      ) {
        format = text.toUpperCase();
      }
    });
    const stats = card.find("span.align-text-top.me-3");
    const ratingSpans = badges.find("span.p-1").filter((__, span) => {
      const text = $(span).text().trim();
      return (
        /^\d+$/.test(text) &&
        !$(span).hasClass("fw-bold") &&
        !$(span).hasClass("text-secondary")
      );
    });
    const moviePageId = card
      .find('a[href^="/d/"]')
      .first()
      .attr("href")
      ?.replace("/d/", "");
    results.push({
      id,
      title: link.text().trim(),
      releaseName: card.find("div.view-text a").text().trim(),
      subtitleType:
        badges.find("span.rounded.p-1.me-1.text-white").first().text().trim() ||
        "未知",
      languages,
      format: format || "SRT",
      isBilingual: bilingual,
      fileSize: stats.eq(0).text().trim(),
      downloads: numberText(stats.eq(1).text()),
      date: stats.eq(2).text().trim(),
      uploader: card.find('a[href^="/u/"]').first().text().trim(),
      ratingUp:
        ratingSpans.length >= 1
          ? Number.parseInt(ratingSpans.eq(0).text().trim(), 10)
          : undefined,
      ratingDown:
        ratingSpans.length >= 2
          ? Number.parseInt(ratingSpans.eq(1).text().trim(), 10)
          : undefined,
      moviePageId,
    });
  });
  return results;
}

export function parseMoviePage(
  html: string,
  moviePageId: string,
): SubtitleSearchResult[] {
  const $ = cheerio.load(html);
  const results: SubtitleSearchResult[] = [];
  $("div.row.pt-2.mb-2").each((_, element) => {
    const row = $(element);
    const link = row.find('div.view-text a[href^="/a/"]').first();
    const id = (link.attr("href") || "").replace("/a/", "");
    if (!id) return;
    const badges = row.find("div.pt-1.f11");
    const languages: string[] = [];
    const formats: string[] = [];
    let bilingual = false;
    badges.find("span.p-1").each((__, span) => {
      const text = $(span).text().trim();
      if (!text) return;
      if ($(span).hasClass("fw-bold")) {
        if (text === "双语") bilingual = true;
        else languages.push(text);
      } else if (
        $(span).hasClass("text-secondary") &&
        /^(SRT|ASS|SSA|SUP)$/i.test(text)
      ) {
        formats.push(text.toUpperCase());
      }
    });
    const columns = row.find("div.col-2.d-none.d-lg-block");
    const ratingText = badges
      .find("span.p-1.text-danger span.align-baseline")
      .first()
      .text();
    const commentText = badges.find("span.p-1.text-primary").first().text();
    results.push({
      id,
      title: link.text().trim(),
      releaseName: link.text().trim(),
      subtitleType:
        badges.find("span.rounded.p-1.me-1.text-white").first().text().trim() ||
        "未知",
      languages,
      format: formats.join("/") || "SRT",
      isBilingual: bilingual,
      fileSize: "",
      downloads: numberText(
        columns.eq(0).find("div.text-end.text-secondary").text(),
      ),
      date: columns.eq(1).find("div.text-black-50").text().trim(),
      uploader: columns
        .eq(1)
        .find('a[href^="/u/"]')
        .first()
        .text()
        .trim(),
      ratingUp: ratingText ? numberText(ratingText) : undefined,
      moviePageId,
      commentCount: commentText ? numberText(commentText) : undefined,
    });
  });
  return results.sort((left, right) => right.downloads - left.downloads);
}

export function parseDetail(html: string, id: string): SubtitleDetail {
  const $ = cheerio.load(html);
  const meta = $("div.p-3.my-2.bg-light.clearfix");
  const formats: string[] = [];
  const languages: string[] = [];
  let bilingual = false;
  meta.find("span.p-1").each((_, span) => {
    const text = $(span).text().trim();
    if ($(span).hasClass("fw-bold")) {
      if (text === "双语") bilingual = true;
      else if (text) languages.push(text);
    } else if (
      $(span).hasClass("text-secondary") &&
      /^(SRT|ASS|SSA|SUP)$/i.test(text)
    ) {
      formats.push(text.toUpperCase());
    }
  });
  const stats = meta.find("span.align-text-top");
  const base: SubtitleSearchResult = {
    id,
    title: $("h1").first().text().trim(),
    releaseName:
      $("div.f16.fw-bold.mb-2").first().text().trim() ||
      ($("title").text().split(" 分享交流")[0] ?? "").trim(),
    subtitleType:
      meta.find("span.rounded.p-1.me-1.text-white").first().text().trim() ||
      "未知",
    languages,
    format: formats.join("/") || "SRT",
    isBilingual: bilingual,
    fileSize: stats.eq(0).text().trim(),
    downloads: numberText(stats.eq(1).text()),
    date: stats.eq(2).text().trim(),
    uploader: $('a[href^="/u/"]').first().text().trim(),
  };
  const comments: SubtitleComment[] = [];
  $("div.pt-3.f14")
    .children("div.d-flex.px-3")
    .each((_, element) => {
      const node = $(element).children("div.flex-grow-1");
      const comment = parseCommentNode($, node);
      if (comment) comments.push(comment);
  });
  return {
    ...base,
    formats,
    rating: numberText($("span.upv").first().text()),
    description: $("div.p-3.lh-lg").text().trim(),
    comments,
  };
}

function parseCommentNode(
  $: cheerio.CheerioAPI,
  node: cheerio.Cheerio<AnyNode>,
): SubtitleComment | undefined {
  const username = node.find('> a[href^="/u/"]').first().text().trim();
  const content = node.find("> div.pt-2").first().text().trim();
  if (!username && !content) return undefined;
  const replies: SubtitleComment[] = [];
  node
    .find("div.d-flex.p-2.my-2.bg-light.shadow-sm.rounded-3")
    .each((_, element) => {
      const replyNode = $(element).children("div.flex-grow-1");
      const replyUsername = replyNode
        .find('> a[href^="/u/"]')
        .first()
        .text()
        .trim();
      const replyContent = replyNode.find("> div.pt-2").first().text().trim();
      if (!replyUsername && !replyContent) return;
      replies.push({
        username: replyUsername,
        content: replyContent,
        date: replyNode
          .find("> div.pt-2")
          .eq(1)
          .find("div.float-start")
          .text()
          .trim(),
        replies: [],
      });
    });
  return {
    username,
    content,
    date: node
      .find("> div.pt-2")
      .eq(1)
      .find("div.float-start")
      .text()
      .trim(),
    replies,
  };
}

function mostCommonMoviePageId(
  results: SubtitleSearchResult[],
): string | undefined {
  const counts = new Map<string, number>();
  for (const result of results) {
    if (result.moviePageId) {
      counts.set(result.moviePageId, (counts.get(result.moviePageId) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0];
}

function numberText(value: string): number {
  return Number.parseInt(value.replaceAll(",", "").replace(/[^\d-]/g, ""), 10) || 0;
}
