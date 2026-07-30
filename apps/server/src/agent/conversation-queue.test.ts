import { describe, expect, it } from "vitest";
import { ConversationQueue } from "./conversation-queue.js";

describe("ConversationQueue", () => {
  it("runs operations for the same conversation in submission order", async () => {
    const queue = new ConversationQueue();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = queue.run("wechat:friend", async () => {
      events.push("first:start");
      await firstGate;
      events.push("first:end");
      return "first";
    });
    const second = queue.run("wechat:friend", async () => {
      events.push("second:start");
      return "second";
    });

    await nextTurn();
    expect(events).toEqual(["first:start"]);
    releaseFirst();

    await expect(Promise.all([first, second])).resolves.toEqual([
      "first",
      "second",
    ]);
    expect(events).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("allows different conversations to run concurrently", async () => {
    const queue = new ConversationQueue();
    const active = new Set<string>();
    let overlapped = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const operation = (key: string) =>
      queue.run(key, async () => {
        active.add(key);
        overlapped ||= active.size === 2;
        await gate;
        active.delete(key);
      });

    const first = operation("wechat:first");
    const second = operation("wechat:second");
    await nextTurn();
    expect(overlapped).toBe(true);
    release();
    await Promise.all([first, second]);
  });

  it("continues after a prior operation fails", async () => {
    const queue = new ConversationQueue();
    const failed = queue.run("wechat:friend", async () => {
      throw new Error("failed");
    });
    const next = queue.run("wechat:friend", async () => "continued");

    await expect(failed).rejects.toThrow("failed");
    await expect(next).resolves.toBe("continued");
  });
});

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
