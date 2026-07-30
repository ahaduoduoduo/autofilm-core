import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "./database.js";
import { OutboxStore } from "./outbox-store.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("outbox store", () => {
  it("defers a context-dependent message without consuming an attempt", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "autofilm-outbox-"));
    directories.push(directory);
    const database = openDatabase(path.join(directory, "test.sqlite"));
    const outbox = new OutboxStore(database);
    outbox.enqueue({
      text: "completed",
    });
    const [message] = outbox.claimDue();

    outbox.defer(message!.id, "no current context token", 30_000);

    const row = database
      .prepare(
        "SELECT state, attempts, last_error FROM outbox_messages WHERE id = ?",
      )
      .get(message!.id) as {
      state: string;
      attempts: number;
      last_error: string;
    };
    expect(row).toEqual({
      state: "pending",
      attempts: 0,
      last_error: "no current context token",
    });
    database.close();
  });
});
