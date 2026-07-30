import { describe, expect, it } from "vitest";
import { buildInboundEvent } from "./adapter.js";
import { loadConfig } from "./config.js";
import {
  decodeTarget,
  encodeTarget,
  splitTelegramText,
  type TelegramMessage,
} from "./telegram.js";

function message(overrides: Partial<TelegramMessage> = {}): TelegramMessage {
  return {
    message_id: 12,
    message_thread_id: 34,
    date: 1_785_283_200,
    chat: { id: -100123, type: "supergroup" },
    from: { id: 99, username: "member" },
    text: "下载电影",
    ...overrides,
  };
}

describe("Telegram native adapter mapping", () => {
  it("can start unconfigured for web-based setup", () => {
    const config = loadConfig({
      TELEGRAM_DATA_DIR: "/tmp/autofilm-telegram-test",
    });
    expect(config.initialRuntime).toBeUndefined();
    expect(config.defaultCoreUrl).toBe("http://autofilm-core:3100");
  });

  it("preserves group topic identity in both directions", () => {
    const target = encodeTarget(message());
    expect(target).toBe("-100123:topic:34");
    expect(decodeTarget(target)).toEqual({
      chatId: "-100123",
      messageThreadId: 34,
    });
  });

  it("maps clear command to a reset event", () => {
    const clearMessage = message({ text: "/clear@autofilm_bot" });
    const event = buildInboundEvent(
      { update_id: 7, message: clearMessage },
      clearMessage,
      "telegram-main",
    );
    expect(event.event_type).toBe("conversation.reset");
    expect(event.provider).toBe("telegram");
    expect(event.sender_id).toBe("99");
  });

  it("maps new command to a reset event", () => {
    const newMessage = message({ text: "/new" });
    const event = buildInboundEvent(
      { update_id: 8, message: newMessage },
      newMessage,
      "telegram-main",
    );
    expect(event.event_type).toBe("conversation.reset");
  });

  it("splits text without breaking Unicode code points", () => {
    expect(splitTelegramText("甲😀乙", 2)).toEqual(["甲😀", "乙"]);
  });
});
