import type { AppConfig } from "./config.js";
import type { ConfigStore } from "./db/config-store.js";
import type { UserStore } from "./db/user-store.js";
import { hashPassword } from "./security/password.js";

export async function bootstrap(
  config: AppConfig,
  users: UserStore,
  configs: ConfigStore,
): Promise<void> {
  if (users.count() === 0 && (config.adminUsername || config.adminPassword)) {
    if (!config.adminUsername || !config.adminPassword) {
      throw new Error(
        "AUTOFILM_ADMIN_USERNAME and AUTOFILM_ADMIN_PASSWORD must be set together",
      );
    }
    if (config.adminPassword.length < 12) {
      throw new Error("AUTOFILM_ADMIN_PASSWORD must contain at least 12 characters");
    }
    users.create({
      username: config.adminUsername,
      displayName: config.adminUsername,
      passwordHash: await hashPassword(config.adminPassword),
      role: "owner",
    });
  }

  if (configs.listProviders().length === 0 && config.bootstrapAi) {
    const provider = configs.saveProvider({
      name: config.bootstrapAi.name,
      protocol: config.bootstrapAi.protocol,
      baseUrl: config.bootstrapAi.baseUrl,
      apiKey: config.bootstrapAi.apiKey,
      customHeaders: {},
      enabled: true,
    });
    configs.saveModel({
      providerId: provider.id,
      name: config.bootstrapAi.model,
      model: config.bootstrapAi.model,
      isDefault: true,
      enabled: true,
    });
  }
}
