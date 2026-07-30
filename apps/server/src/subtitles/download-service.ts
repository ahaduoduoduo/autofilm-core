import type { SubHDClient } from "../integrations/subhd.js";
import type { CaptchaRecognizer } from "./captcha-recognizer.js";
import type { CaptchaChallenge, SubtitleDownload } from "./types.js";

export interface AutomaticDownloadResult extends SubtitleDownload {
  attempts: number;
}

export class SubtitleDownloadService {
  constructor(
    private readonly subhd: SubHDClient,
    private readonly recognizer: CaptchaRecognizer,
  ) {}

  async download(subtitleId: string): Promise<AutomaticDownloadResult> {
    let result = await this.subhd.download(subtitleId);
    let attempts = 0;
    while (result.captcha && attempts < 5) {
      attempts += 1;
      let text: string;
      try {
        text = await this.recognizer.recognize(result.captcha.svgContent);
      } catch {
        continue;
      }
      result = await this.subhd.submitCaptcha(result.captcha, text);
    }
    return { ...result, attempts };
  }

  submitCaptcha(
    challenge: CaptchaChallenge,
    answer: string,
  ): Promise<SubtitleDownload> {
    return this.subhd.submitCaptcha(challenge, answer);
  }
}
