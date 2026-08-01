import { randomUUID } from "node:crypto";

export interface CompletionContinuation {
  workflowId: string;
  state: "pending" | "running" | "completed" | "failed";
  attempts: number;
  nextAttemptAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

export function createCompletionContinuation(
  workflowId: string = randomUUID(),
): CompletionContinuation {
  return {
    workflowId,
    state: "pending",
    attempts: 0,
    nextAttemptAt: new Date().toISOString(),
  };
}

export function parseCompletionContinuation(
  value: unknown,
): CompletionContinuation | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const continuation = value as Partial<CompletionContinuation>;
  if (
    typeof continuation.workflowId !== "string" ||
    !["pending", "running", "completed", "failed"].includes(
      String(continuation.state),
    ) ||
    typeof continuation.attempts !== "number" ||
    typeof continuation.nextAttemptAt !== "string"
  ) {
    return undefined;
  }
  return continuation as CompletionContinuation;
}
