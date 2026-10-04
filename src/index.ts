// src/index.ts
import { APPDATA_DIR, TEMP_DIR, PATHS, ensureDirectories } from "./config/paths";
import { CONFIG } from "./config";
import { acquireLock } from "./core/single-instance";
import { AccountManager } from "./core/account-manager";
import { Overlay } from "./core/overlay";
import { logger } from "./utils/logger";
import { startDashboard } from "./core/dashboard";
import { ChatRealtime } from "./core/chat-realtime";
import { buildMainWindowCommand, mainWindowProfileDir, mainWindowUrl } from "./core/main-window";
import { buildFallbackCommand, findBrowser } from "./core/pay-window";
import { UserStore } from "./core/user-store";
import { InviteStore } from "./core/invite-store";
import { SessionStore } from "./core/session-store";
import { KeyStore } from "./core/key-store";
import { AuthService } from "./core/auth-service";

/**
 * Abre o painel como se fosse um aplicativo de verdade — sem barra de endereço nem abas de
 * navegador (estilo client de jogo) — em vez de pedir pra pessoa abrir uma URL no navegador.
 * Sem Chrome/Edge/Brave instalado, cai pro navegador padrão numa aba comum mesmo.
 */
function openMainWindow(port: number, tempDir: string): void {
  const browser = findBrowser();
  const url = mainWindowUrl(port);
  const command = browser ? buildMainWindowCommand(browser, url, mainWindowProfileDir(tempDir)) : buildFallbackCommand(url);
  try {
    Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore", windowsHide: false });
  } catch (err) {
    logger.error({ err }, "Falha ao abrir a janela do painel");
  }
}

async function main() {
  ensureDirectories();
  acquireLock();

  // Login por convite: sem tela de registro pública, só entra quem tem conta ou um convite válido
  const auth = new AuthService(new UserStore(PATHS.users), new InviteStore(PATHS.invites), new SessionStore(PATHS.sessions), new KeyStore(PATHS.keys));

  // O botão da MisticPay solto na tela (Windows) acompanha as contas e a configuração delas
  let overlay: Overlay | undefined;
  const chatRealtime = new ChatRealtime();
  const manager = new AccountManager({
    onMisticChange: () => overlay?.sync(),
    onChatMessage: (accountId, message, isNew) => chatRealtime.publish(accountId, message, isNew),
    onChatMessageDeleted: (accountId, chatJid, id) => chatRealtime.publishDeleted(accountId, chatJid, id),
  });
  overlay = new Overlay({
    accounts: () => manager.list(),
    port: CONFIG.defaultPort,
    dataDir: APPDATA_DIR,
    tempDir: TEMP_DIR,
    hasActiveSession: () => auth.hasActiveSession(),
    issuePayToken: (accountId) => auth.issuePayToken(accountId),
  });
  process.on("exit", () => overlay?.stop());

  startDashboard(manager, CONFIG.defaultPort, {
    overlay,
    chatRealtime,
    auth,
  });
  overlay.sync();
  openMainWindow(CONFIG.defaultPort, TEMP_DIR);

  await manager.startAll();
}

main().catch((error) => {
  logger.fatal({ error }, "Erro fatal na inicialização");
  process.exit(1);
});
