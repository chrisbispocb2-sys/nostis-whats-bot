// src/index.ts
import { APPDATA_DIR, TEMP_DIR, ensureDirectories } from "./config/paths";
import { CONFIG } from "./config";
import { acquireLock } from "./core/single-instance";
import { AccountManager } from "./core/account-manager";
import { Overlay } from "./core/overlay";
import { logger } from "./utils/logger";
import { startDashboard } from "./core/dashboard";

async function main() {
  ensureDirectories();
  acquireLock();

  // O botão da MisticPay solto na tela (Windows) acompanha as contas e a configuração delas
  let overlay: Overlay | undefined;
  const manager = new AccountManager({ onMisticChange: () => overlay?.sync() });
  overlay = new Overlay({
    accounts: () => manager.list(),
    port: CONFIG.defaultPort,
    dataDir: APPDATA_DIR,
    tempDir: TEMP_DIR,
  });
  process.on("exit", () => overlay?.stop());

  startDashboard(manager, CONFIG.defaultPort, overlay);
  overlay.sync();
  await manager.startAll();
}

main().catch((error) => {
  logger.fatal({ error }, "Erro fatal na inicialização");
  process.exit(1);
});
