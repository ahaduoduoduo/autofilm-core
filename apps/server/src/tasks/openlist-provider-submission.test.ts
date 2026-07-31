import { describe, expect, it } from "vitest";
import type { OpenListTask } from "../integrations/openlist.js";
import {
  providerSubmissionMetadata,
  providerSubmissionReceipt,
  waitForProviderSubmission,
} from "./openlist-provider-submission.js";

function task(input: Partial<OpenListTask> = {}): OpenListTask {
  return {
    id: "openlist-task",
    name: "Example",
    state: 1,
    status: "running",
    progress: 0,
    total_bytes: 0,
    error: "",
    ...input,
  };
}

describe("OpenList provider submission wait", () => {
  it("returns only after the provider accepts the task", async () => {
    let reads = 0;
    const accepted = task({
      provider_task_id: "provider-info-hash",
      provider_submitted_at: new Date().toISOString(),
    });
    const result = await waitForProviderSubmission(
      {
        async listOfflineTasks() {
          reads += 1;
          return [accepted];
        },
        async deleteOfflineTask() {},
      },
      task(),
      { timeoutMs: 100, pollIntervalMs: 1 },
    );

    expect(reads).toBe(1);
    expect(result.provider_task_id).toBe("provider-info-hash");
  });

  it("returns a submission failure and removes the OpenList task", async () => {
    const deleted: string[] = [];
    await expect(
      waitForProviderSubmission(
        {
          async listOfflineTasks() {
            return [task({
              state: 7,
              status: "failed",
              error: "provider rejected magnet",
            })];
          },
          async deleteOfflineTask(taskId) {
            deleted.push(taskId);
          },
        },
        task(),
        { timeoutMs: 100, pollIntervalMs: 1 },
      ),
    ).rejects.toThrow("provider rejected magnet");
    expect(deleted).toEqual(["openlist-task"]);
  });

  it("cancels a submission that never reaches the provider", async () => {
    const deleted: string[] = [];
    await expect(
      waitForProviderSubmission(
        {
          async listOfflineTasks() {
            return [task()];
          },
          async deleteOfflineTask(taskId) {
            deleted.push(taskId);
          },
        },
        task(),
        { timeoutMs: 5, pollIntervalMs: 1 },
      ),
    ).rejects.toThrow("未能将任务提交给 115");
    expect(deleted).toEqual(["openlist-task"]);
  });

  it("builds an explicit success receipt without exposing running state", () => {
    const accepted = task({
      provider_task_id: "provider-info-hash",
      provider_submitted_at: new Date().toISOString(),
    }) as OpenListTask & {
      provider_task_id: string;
      provider_submitted_at: string;
    };
    const metadata = providerSubmissionMetadata(
      { destination: "/115/nvideo/movie/2026-08" },
      accepted,
    );
    const receipt = providerSubmissionReceipt({
      taskId: "local-task",
      title: "Example",
      destination: metadata.destination,
      providerSubmittedAt: accepted.provider_submitted_at,
    });

    expect(receipt).toEqual({
      submissionStatus: "succeeded",
      message: "离线下载提交成功",
      taskId: "local-task",
      title: "Example",
      destination: "/115/nvideo/movie/2026-08",
      providerSubmittedAt: accepted.provider_submitted_at,
    });
    expect(receipt).not.toHaveProperty("state");
  });
});
