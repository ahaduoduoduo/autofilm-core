import { createHash } from "node:crypto";
import type { TaskSummary } from "@autofilm/contracts";

export interface DownloadCandidate {
  id: string;
  title: string;
  magnetUri: string;
}

export interface StoredDownloadCandidate extends DownloadCandidate {
  legacySourceUrl?: string;
}

export function directMagnetCandidate(
  magnetUri: string,
  title: string,
): DownloadCandidate {
  return {
    id: `magnet-${hashValue(magnetUri)}`,
    title: title.trim() || "用户提供的磁力资源",
    magnetUri,
  };
}

export function uniqueDownloadCandidates(
  values: DownloadCandidate[],
): DownloadCandidate[] {
  const seen = new Set<string>();
  return values.filter((candidate) => {
    if (seen.has(candidate.magnetUri)) return false;
    seen.add(candidate.magnetUri);
    return true;
  });
}

export function taskDownloadCandidates(
  task: TaskSummary,
): StoredDownloadCandidate[] {
  const stored = task.metadata.downloadCandidates;
  if (Array.isArray(stored)) {
    return stored.flatMap((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const candidate = value as Record<string, unknown>;
      return typeof candidate.id === "string" &&
        typeof candidate.title === "string" &&
        typeof candidate.magnetUri === "string" &&
        candidate.magnetUri.startsWith("magnet:")
        ? [{
            id: candidate.id,
            title: candidate.title,
            magnetUri: candidate.magnetUri,
          }]
        : [];
    });
  }
  const legacy = Array.isArray(task.metadata.candidateUrls)
    ? task.metadata.candidateUrls.filter(
        (value): value is string =>
          typeof value === "string" && value.length > 0,
      )
    : typeof task.metadata.sourceUrl === "string"
      ? [task.metadata.sourceUrl]
      : [];
  return legacy.map((value, index) => ({
    id: `legacy-${hashValue(value)}`,
    title: `历史备用资源 ${index + 1}`,
    magnetUri: value.startsWith("magnet:") ? value : "",
    legacySourceUrl: value.startsWith("magnet:") ? undefined : value,
  }));
}

export function safeDownloadTask(task: TaskSummary): TaskSummary {
  const metadata = { ...task.metadata };
  delete metadata.sourceUrl;
  delete metadata.candidateUrls;
  const candidates = taskDownloadCandidates(task);
  metadata.downloadCandidates = candidates.map(({ id, title }) => ({
    id,
    title,
  }));
  if (Array.isArray(metadata.attempts)) {
    metadata.attempts = metadata.attempts.map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return value;
      }
      const attempt = { ...(value as Record<string, unknown>) };
      delete attempt.url;
      return attempt;
    });
  }
  return { ...task, metadata };
}

function hashValue(value: string): string {
  return createHash("sha256")
    .update(value)
    .digest("base64url")
    .slice(0, 20);
}
