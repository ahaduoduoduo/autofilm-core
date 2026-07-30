import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { timingSafeEqual } from "node:crypto";
import type {
  NativeEventResponse,
  NativeInboundEvent,
  NativeOutboundMessage,
} from "@autofilm/contracts";
import {
  TelegramConfigStore,
  type TelegramProcessConfig,
  type TelegramRuntimeConfig,
  validateRuntime,
} from "./config.js";
import {
  decodeTarget,
  encodeTarget,
  messageAttachments,
  messageText,
  messageType,
  TelegramClient,
  type TelegramMessage,
  type TelegramUpdate,
} from "./telegram.js";

interface OutboundRequest {
  provider_instance_id: string;
  to: string;
  messages: NativeOutboundMessage[];
}

export class TelegramAdapter {
  private readonly configStore: TelegramConfigStore;
  private telegram: TelegramClient | undefined;
  private runtime: TelegramRuntimeConfig | undefined;
  private pollingController: AbortController | undefined;
  private server: Server | undefined;

  constructor(private readonly processConfig: TelegramProcessConfig) {
    this.configStore = new TelegramConfigStore(processConfig);
  }

  async start(): Promise<void> {
    await this.startHttpServer();
    const saved = this.configStore.load();
    if (saved) this.activate(saved);
  }

  async stop(): Promise<void> {
    this.pollingController?.abort();
    if (this.server) {
      await new Promise<void>((resolve, reject) =>
        this.server!.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }

  async processUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    const telegram = this.telegram;
    const runtime = this.runtime;
    if (!message?.from || !telegram || !runtime) return;
    const target = decodeTarget(encodeTarget(message));
    await telegram.sendTyping(target).catch(() => undefined);
    const event = buildInboundEvent(
      update,
      message,
      runtime.providerInstanceId,
    );
    try {
      const response = await this.sendToCore(runtime, event);
      for (const outbound of response.messages) {
        await telegram.send(target, outbound);
      }
    } catch (error) {
      await telegram.send(target, {
        type: "text",
        text: `AutoFilm 请求失败：${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  private async poll(
    telegram: TelegramClient,
    runtime: TelegramRuntimeConfig,
    initialOffset: number,
    controller: AbortController,
  ): Promise<void> {
    let offset = initialOffset;
    while (!controller.signal.aborted) {
      try {
        const updates = await telegram.getUpdates(
          offset,
          30,
          controller.signal,
        );
        const conversations = new Map<string, TelegramUpdate[]>();
        for (const update of updates) {
          const key = update.message
            ? encodeTarget(update.message)
            : `update:${update.update_id}`;
          const queued = conversations.get(key) ?? [];
          queued.push(update);
          conversations.set(key, queued);
        }
        await Promise.all(
          [...conversations.values()].map(async (queued) => {
            for (const update of queued) {
              await this.processUpdate(update);
            }
          }),
        );
        if (updates.length > 0) {
          for (const update of updates) {
            offset = Math.max(offset, update.update_id + 1);
          }
          this.configStore.saveOffset(runtime, offset);
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        console.error(
          `Telegram polling failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        await delay(2_000);
      }
    }
  }

  private async sendToCore(
    runtime: TelegramRuntimeConfig,
    event: NativeInboundEvent,
  ): Promise<NativeEventResponse> {
    const response = await fetch(
      `${runtime.coreUrl}/v1/conversation/events`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${runtime.coreToken}`,
        },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(180_000),
      },
    );
    const data = (await response.json()) as NativeEventResponse & {
      error?: string;
    };
    if (!response.ok) {
      throw new Error(data.error || `Core returned HTTP ${response.status}`);
    }
    return data;
  }

  private async startHttpServer(): Promise<void> {
    this.server = createServer((request, response) => {
      void this.handleHttp(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(
        this.processConfig.port,
        this.processConfig.host,
        resolve,
      );
    });
  }

  private async handleHttp(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      if (request.method === "GET" && request.url === "/health") {
        return json(response, 200, {
          status: "ok",
          configured: Boolean(this.runtime),
        });
      }
      if (request.method === "POST" && request.url === "/v1/setup") {
        return await this.setup(request, response);
      }
      if (request.method !== "POST" || request.url !== "/v1/messages") {
        return json(response, 404, { error: "Not found" });
      }
      const runtime = this.runtime;
      const telegram = this.telegram;
      if (!runtime || !telegram) {
        return json(response, 503, { error: "Telegram is not configured" });
      }
      if (!authorized(request, runtime.outboundToken)) {
        return json(response, 401, { error: "Invalid service token" });
      }
      const input = validateOutbound(await readJson(request));
      if (input.provider_instance_id !== runtime.providerInstanceId) {
        return json(response, 404, { error: "Provider instance not found" });
      }
      const target = decodeTarget(input.to);
      for (const message of input.messages) {
        await telegram.send(target, message);
      }
      return json(response, 200, { accepted: input.messages.length });
    } catch (error) {
      return json(response, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async setup(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (
      this.runtime &&
      !authorized(request, this.runtime.outboundToken)
    ) {
      return json(response, 401, { error: "Invalid service token" });
    }
    const input = await readJson(request);
    const runtime = validateRuntime(
      input,
      this.processConfig.defaultCoreUrl,
    );
    const telegram = new TelegramClient(runtime.botToken);
    const identity = await telegram.identity();
    if (!identity.is_bot) throw new Error("Telegram token does not belong to a bot");
    await telegram.prepareLongPolling();
    this.configStore.save(runtime);
    this.activate(runtime, telegram);
    return json(response, 200, {
      configured: true,
      bot_id: identity.id,
      bot_username: identity.username ?? "",
      bot_name: identity.first_name,
    });
  }

  private activate(
    runtime: TelegramRuntimeConfig,
    telegram = new TelegramClient(runtime.botToken),
  ): void {
    this.pollingController?.abort();
    this.runtime = runtime;
    this.telegram = telegram;
    const offset = this.configStore.loadOffset(runtime);
    const controller = new AbortController();
    this.pollingController = controller;
    void this.poll(telegram, runtime, offset, controller);
  }
}

export function buildInboundEvent(
  update: TelegramUpdate,
  message: TelegramMessage,
  providerInstanceId: string,
): NativeInboundEvent {
  const text = messageText(message);
  const attachments = messageAttachments(message);
  const reset = /^\/(?:new|clear|reset)(?:@\w+)?(?:\s|$)/i.test(text);
  return {
    version: "2026-07-01",
    event_id: `telegram:${providerInstanceId}:${update.update_id}`,
    event_type: reset ? "conversation.reset" : "message.created",
    provider: "telegram",
    provider_instance_id: providerInstanceId,
    conversation_id: encodeTarget(message),
    sender_id: String(message.from!.id),
    message_id: String(message.message_id),
    message_type: messageType(message),
    text: reset ? undefined : text || undefined,
    attachments: attachments.length ? attachments : undefined,
    timestamp: new Date(message.date * 1000).toISOString(),
    capabilities: [
      "text",
      "image",
      "video",
      "audio",
      "file",
      "conversation.reset",
    ],
  };
}

function authorized(request: IncomingMessage, expected: string): boolean {
  const header = request.headers.authorization ?? "";
  const actual = header.toLowerCase().startsWith("bearer ")
    ? header.slice(7).trim()
    : header.trim();
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 1024 * 1024) throw new Error("Request body is too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function validateOutbound(value: unknown): OutboundRequest {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid outbound request");
  }
  const input = value as Record<string, unknown>;
  if (
    typeof input.provider_instance_id !== "string" ||
    typeof input.to !== "string" ||
    !Array.isArray(input.messages)
  ) {
    throw new Error("Invalid outbound request");
  }
  return input as unknown as OutboundRequest;
}

function json(
  response: ServerResponse,
  status: number,
  value: Record<string, unknown>,
): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
