import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password.js";
import { SecretVault } from "./vault.js";

describe("security primitives", () => {
  it("hashes passwords with a unique salt", async () => {
    const first = await hashPassword("correct horse battery staple");
    const second = await hashPassword("correct horse battery staple");
    expect(first).not.toBe(second);
    expect(await verifyPassword("correct horse battery staple", first)).toBe(true);
    expect(await verifyPassword("wrong password", first)).toBe(false);
  });

  it("encrypts secrets and detects the wrong master key", () => {
    const vault = new SecretVault(Buffer.alloc(32, 1).toString("base64"));
    const encrypted = vault.encrypt("provider-api-key");
    expect(encrypted).not.toContain("provider-api-key");
    expect(vault.decrypt(encrypted)).toBe("provider-api-key");

    const other = new SecretVault(Buffer.alloc(32, 2).toString("base64"));
    expect(() => other.decrypt(encrypted)).toThrow();
  });
});
