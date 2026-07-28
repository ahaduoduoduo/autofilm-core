import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

export class SecretVault {
  private readonly key: Buffer;

  constructor(masterKey: string) {
    const decoded = Buffer.from(masterKey, "base64");
    this.key =
      decoded.length === 32
        ? decoded
        : createHash("sha256").update(masterKey, "utf8").digest();
  }

  encrypt(value: string): string {
    if (!value) return "";
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const encrypted = Buffer.concat([
      cipher.update(value, "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return ["v1", iv.toString("base64"), tag.toString("base64"), encrypted.toString("base64")].join(".");
  }

  decrypt(value: string | null | undefined): string {
    if (!value) return "";
    const [version, ivText, tagText, encryptedText] = value.split(".");
    if (
      version !== "v1" ||
      !ivText ||
      !tagText ||
      encryptedText === undefined
    ) {
      throw new Error("Unsupported encrypted secret format");
    }
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      Buffer.from(ivText, "base64"),
    );
    decipher.setAuthTag(Buffer.from(tagText, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedText, "base64")),
      decipher.final(),
    ]).toString("utf8");
  }
}
