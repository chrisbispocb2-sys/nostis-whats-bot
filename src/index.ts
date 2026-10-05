// src/index.ts
import { APPDATA_DIR, TEMP_DIR, PATHS, ensureDirectories } from "./config/paths";
import { CONFIG } from "./config";
import { acquireLock } from "./core/single-instance";
import { AccountManager } from "./core/account-manager";
import { Overlay } from "./core/overlay";
import { logger } from "./utils/logger";
import { startDashboard } from "./core/dashboard";
import { join } from "path";
import { ChatRealtime } from "./core/chat-realtime";
import { MessageSound } from "./core/message-sound";
import { buildMainWindowCommand, mainWindowProfileDir, mainWindowUrl } from "./core/main-window";
import { buildFallbackCommand, findBrowser } from "./core/pay-window";
import { UserStore } from "./core/user-store";
import { InviteStore } from "./core/invite-store";
import { SessionStore } from "./core/session-store";
import { KeyStore } from "./core/key-store";
import { AuthService } from "./core/auth-service";
import type { AuthProvider } from "./core/auth-provider";
import { RemoteAuthService } from "./core/remote-auth-service";
import { getDeviceId, getDeviceName } from "./core/device-id";
import { LICENSE } from "./config/license";

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

  // O botão da MisticPay solto na tela (Windows) acompanha as contas e a configuração delas
  let overlay: Overlay | undefined;
  const chatRealtime = new ChatRealtime();
  const messageSound = new MessageSound({ wavFile: join(TEMP_DIR, "mensagem-nova.wav") });
  process.on("exit", () => messageSound.stop());
  const manager = new AccountManager({
    onMisticChange: () => overlay?.sync(),
    onChatMessage: (accountId, message, isNew) => {
      // O som é de cada WhatsApp: quem decide é a conta que recebeu a mensagem, não a aberta na tela
      const sound = manager.get(accountId)?.playsSoundFor(message.chatJid) ?? false;
      // Quem toca é o próprio programa (funciona com a janela minimizada ou fechada). Só sobra pro
      // painel onde isso não é possível.
      const playedHere = sound && messageSound.available;
      if (playedHere) messageSound.notify(message, isNew);
      chatRealtime.publish(accountId, message, isNew, sound && !playedHere);
    },
    onChatMessageDeleted: (accountId, chatJid, id) => chatRealtime.publishDeleted(accountId, chatJid, id),
  });

  // Login por convite: sem tela de registro pública, só entra quem tem conta ou um convite válido.
  // Com servidor de licenças configurado (é o caso do exe), quem manda nas contas é ele; sem, as
  // contas ficam neste computador mesmo (modo local, só pra desenvolver).
  let auth: AuthProvider;
  if (LICENSE.serverUrl) {
    const remote: RemoteAuthService = new RemoteAuthService(new SessionStore(PATHS.sessions), {
      serverUrl: LICENSE.serverUrl,
      publicKey: LICENSE.publicKey,
      licenseFile: PATHS.license,
      deviceId: getDeviceId(PATHS.deviceId),
      deviceName: getDeviceName(),
      // A trava do painel não alcança o bot que já está ligado: sem licença que libere o bot de
      // grupo (venceu, conta desativada, saiu, ou tempo demais sem falar com o servidor), ele desliga
      onChange: () => {
        if (remote.allows("groupBot")) return;
        for (const account of manager.list()) {
          if (!account.bot.active) continue;
          account.setBotActive(false);
          logger.warn({ account: account.name }, "Bot DESLIGADO: a licença deste computador não libera o bot de grupo");
        }
      },
    });
    remote.start();
    auth = remote;
  } else {
    logger.warn("Sem servidor de licenças configurado (config/license.ts): rodando em modo local, só pra desenvolvimento");
    auth = new AuthService(new UserStore(PATHS.users), new InviteStore(PATHS.invites), new SessionStore(PATHS.sessions), new KeyStore(PATHS.keys));
  }
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
