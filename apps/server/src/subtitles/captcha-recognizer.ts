import sharp from "sharp";
import { createAiClient } from "../ai/client.js";
import type { ConfigStore } from "../db/config-store.js";
import type { PromptStore } from "../db/prompt-store.js";

export class CaptchaRecognizer {
  constructor(
    private readonly configs: ConfigStore,
    private readonly prompts: PromptStore,
  ) {}

  async recognize(svgContent: string): Promise<string> {
    const service = this.configs.service("subhd");
    const configuredModelId = String(service?.options.captchaModelId ?? "");
    const model =
      (configuredModelId && this.configs.model(configuredModelId)) ||
      this.configs.defaultModel();
    if (!model) throw new Error("没有可用于验证码识别的 AI 模型");
    const provider = this.configs.provider(model.providerId);
    if (!provider || !provider.enabled) {
      throw new Error("验证码识别模型的供应方不可用");
    }
    const png = await svgToPng(svgContent);
    const client = createAiClient(provider.protocol, {
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      headers: provider.customHeaders,
    });
    const response = await client.generate({
      model: model.model,
      messages: [
        {
          role: "system",
          content: this.prompts.get("subtitle.captcha.system"),
        },
        {
          role: "user",
          content: this.prompts.get("subtitle.captcha.user"),
          images: [{ mediaType: "image/png", dataBase64: png.toString("base64") }],
        },
      ],
      temperature: 0,
      maxOutputTokens: 32,
    });
    const result = response.content.replace(/[^a-zA-Z0-9]/g, "");
    if (result.length < 3 || result.length > 8) {
      throw new Error(`验证码识别结果长度无效：${result.length}`);
    }
    return result;
  }
}

export async function svgToPng(svgContent: string): Promise<Buffer> {
  if (!svgContent.trim().startsWith("<svg")) {
    throw new Error("SubHD 返回的验证码不是有效 SVG");
  }
  return sharp(Buffer.from(svgContent, "utf8"), { density: 300 })
    .resize(450, 150, { fit: "contain", background: "#ffffff" })
    .flatten({ background: "#ffffff" })
    .png()
    .toBuffer();
}
