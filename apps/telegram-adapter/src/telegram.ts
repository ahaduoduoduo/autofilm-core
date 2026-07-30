import type {
  NativeAttachment,
  NativeOutboundMessage,
} from "@autofilm/contracts";

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export interface TelegramMessage {
  message_id: number;
  message_thread_id?: number;
  date: number;
  chat: { id: number; type: string };
  from?: {
    id: number;
    username?: string;
    first_name?: string;
    last_name?: string;
  };
  text?: string;
  caption?: string;
  photo?: Array<{ file_id: string; width: number; height: number }>;
  video?: { file_id: string; file_name?: string; mime_type?: string };
  audio?: { file_id: string; file_name?: string; mime_type?: string };
  voice?: { file_id: string; mime_type?: string };
  document?: { file_id: string; file_name?: string; mime_type?: string };
}

interface TelegramEnvelope<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

export interface TelegramBotIdentity {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

export class TelegramClient {
  private readonly baseUrl: string;

  constructor(botToken: string) {
    this.baseUrl = `https://api.telegram.org/bot${botToken}`;
  }

  async identity(): Promise<TelegramBotIdentity> {
    return this.call<TelegramBotIdentity>("getMe", {});
  }

  async prepareLongPolling(): Promise<void> {
    await this.call("deleteWebhook", { drop_pending_updates: false });
  }

  async getUpdates(
    offset: number,
    timeoutSeconds: number,
    signal: AbortSignal,
  ): Promise<TelegramUpdate[]> {
    return this.call<TelegramUpdate[]>(
      "getUpdates",
      {
        offset,
        timeout: timeoutSeconds,
        allowed_updates: ["message"],
      },
      signal,
    );
  }

  async send(
    target: TelegramTarget,
    message: NativeOutboundMessage,
  ): Promise<void> {
    const common = {
      chat_id: target.chatId,
      ...(target.messageThreadId
        ? { message_thread_id: target.messageThreadId }
        : {}),
    };
    if (message.type === "text") {
      for (const text of splitTelegramText(message.text ?? "")) {
        await this.call("sendMessage", {
          ...common,
          text,
          ...(message.reply_to_id
            ? {
                reply_parameters: {
                  message_id: Number(message.reply_to_id),
                  allow_sending_without_reply: true,
                },
              }
            : {}),
        });
      }
      return;
    }
    if (!message.media_url) {
      throw new Error(`${message.type} message has no media_url`);
    }
    const method = {
      image: "sendPhoto",
      video: "sendVideo",
      audio: "sendAudio",
      file: "sendDocument",
    }[message.type];
    const field = {
      image: "photo",
      video: "video",
      audio: "audio",
      file: "document",
    }[message.type];
    await this.call(method, {
      ...common,
      [field]: message.media_url,
      ...(message.file_name ? { caption: message.file_name } : {}),
    });
  }

  async sendTyping(target: TelegramTarget): Promise<void> {
    await this.call("sendChatAction", {
      chat_id: target.chatId,
      action: "typing",
      ...(target.messageThreadId
        ? { message_thread_id: target.messageThreadId }
        : {}),
    });
  }

  private async call<T = unknown>(
    method: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await fetch(`${this.baseUrl}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: signal ?? AbortSignal.timeout(60_000),
    });
    const envelope = (await response.json()) as TelegramEnvelope<T>;
    if (!response.ok || !envelope.ok) {
      throw new Error(
        `Telegram ${method} failed: ${envelope.description ?? `HTTP ${response.status}`}`,
      );
    }
    return envelope.result as T;
  }
}

export interface TelegramTarget {
  chatId: string;
  messageThreadId?: number;
}

export function encodeTarget(message: TelegramMessage): string {
  return message.message_thread_id
    ? `${message.chat.id}:topic:${message.message_thread_id}`
    : String(message.chat.id);
}

export function decodeTarget(value: string): TelegramTarget {
  const match = /^(-?\d+)(?::topic:(\d+))?$/.exec(value);
  if (!match?.[1]) throw new Error("Invalid Telegram target");
  return {
    chatId: match[1],
    messageThreadId: match[2] ? Number(match[2]) : undefined,
  };
}

export function messageText(message: TelegramMessage): string {
  return (message.text ?? message.caption ?? "").trim();
}

export function messageType(message: TelegramMessage): string {
  if (message.text) return "text";
  if (message.photo) return "image";
  if (message.video) return "video";
  if (message.audio || message.voice) return "audio";
  if (message.document) return "file";
  return "unknown";
}

export function messageAttachments(
  message: TelegramMessage,
): NativeAttachment[] {
  if (message.photo?.length) {
    return [{ type: "image", file_name: "telegram-photo.jpg" }];
  }
  if (message.video) {
    return [
      {
        type: "video",
        file_name: message.video.file_name,
        content_type: message.video.mime_type,
      },
    ];
  }
  const audio = message.audio ?? message.voice;
  if (audio) {
    return [
      {
        type: "audio",
        file_name: message.audio?.file_name,
        content_type: audio.mime_type,
      },
    ];
  }
  if (message.document) {
    return [
      {
        type: "file",
        file_name: message.document.file_name,
        content_type: message.document.mime_type,
      },
    ];
  }
  return [];
}

export function splitTelegramText(text: string, limit = 4096): string[] {
  if (!text) return [];
  const characters = Array.from(text);
  const chunks: string[] = [];
  for (let offset = 0; offset < characters.length; offset += limit) {
    chunks.push(characters.slice(offset, offset + limit).join(""));
  }
  return chunks;
}
