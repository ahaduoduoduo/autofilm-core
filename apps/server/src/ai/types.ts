export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface CanonicalMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  images?: Array<{
    mediaType: string;
    dataBase64: string;
  }>;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

export interface GenerateRequest {
  model: string;
  messages: CanonicalMessage[];
  tools?: ToolDefinition[];
  temperature?: number | null;
  maxOutputTokens?: number | null;
}

export interface GenerateResponse {
  content: string;
  toolCalls: ToolCall[];
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
  rawStopReason?: string;
}

export interface AiTransportConfig {
  baseUrl: string;
  apiKey: string;
  headers?: Record<string, string>;
}

export interface AiClient {
  generate(request: GenerateRequest): Promise<GenerateResponse>;
}
