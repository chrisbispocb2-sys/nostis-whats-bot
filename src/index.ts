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
function openMainWindow(port: number, tempDir: string): { exited: Promise<number> } | null {
  const browser = findBrowser();
  const url = mainWindowUrl(port);
  const command = browser ? buildMainWindowCommand(browser, url, mainWindowProfileDir(tempDir)) : buildFallbackCommand(url);
  try {
    const proc = Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore", windowsHide: false });
    // Só dá pra saber quando a janela fecha no modo aplicativo (navegador próprio desta janela). No
    // modo de reserva (uma aba do navegador padrão) o comando volta na hora e não representa a janela.
    return browser ? { exited: proc.exited } : null;
  } catch (err) {
    logger.error({ err }, "Falha ao abrir a janela do painel");
    return null;
  }
}

async function main() {
  ensureDirectories();
  acquireLock();

  // O botão da MisticPay solto na tela (Windows) acompanha as contas e a configuração delas
  let overlay: Overlay | undefined;
  const chatRealtime = new ChatRealtime();
  const messageSound = new MessageSound({ wavFile: join(TEMP_DIR, "mensagem-nova.wav") });
  // Com servidor de licenças configurado (é o caso do exe), quem manda nas contas é ele — e é por
  // ele também que as instalações conectadas no mesmo WhatsApp combinam entre si (vez do bot, listas).
  // Sem servidor, as contas ficam neste computador mesmo (modo local, só pra desenvolver).
  let onLicenseChange = () => {};
  const remote = LICENSE.serverUrl
    ? new RemoteAuthService(new SessionStore(PATHS.sessions), {
        serverUrl: LICENSE.serverUrl,
        publicKey: LICENSE.publicKey,
        licenseFile: PATHS.license,
        deviceId: getDeviceId(PATHS.deviceId),
        deviceName: getDeviceName(),
        onChange: () => onLicenseChange(),
      })
    : null;

  const manager = new AccountManager({
    coordinator: remote ?? undefined,
    // Funcionário de empresa: o dinheiro passa pelo servidor do líder (quem decide é o próprio `remote`,
    // pelo papel da licença). Sem servidor de licenças (modo local), cada conta usa a MisticPay local.
    money: remote ?? undefined,
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
  let auth: AuthProvider;
  if (remote) {
    // A trava do painel não alcança o bot que já está ligado: sem licença que libere o bot de
    // grupo (venceu, conta desativada, saiu, ou tempo demais sem falar com o servidor), ele desliga
    onLicenseChange = () => {
      if (remote.allows("groupBot")) return;
      for (const account of manager.list()) {
        if (!account.bot.active) continue;
        account.setBotActive(false);
        logger.warn({ account: account.name }, "Bot DESLIGADO: a licença deste computador não libera o bot de grupo");
      }
    };
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
  // Limpeza num lugar só: roda uma vez, em qualquer saída (fechar a janela, sinal, erro) — solta as
  // contas (conexões, navegadores das corridas, bancos do chat), o botão flutuante, o som e o lock.
  let cleaned = false;
  process.on("exit", () => {
    if (cleaned) return;
    cleaned = true;
    try {
      manager.stopAll();
    } catch (err) {
      logger.error({ err }, "Falha ao encerrar as contas");
    }
    overlay?.stop();
    messageSound.stop();
  });

  startDashboard(manager, CONFIG.defaultPort, {
    overlay,
    chatRealtime,
    auth,
  });
  overlay.sync();

  // Fechar a janela do painel (o X) encerra o programa todo. Sem isso, o Bun e os PowerShell (botão
  // flutuante, som) continuavam rodando escondidos, segurando o lock e impedindo abrir de novo.
  const mainWindow = openMainWindow(CONFIG.defaultPort, TEMP_DIR);
  const openedAt = Date.now();
  if (mainWindow) {
    void mainWindow.exited.then(() => {
      // O navegador às vezes repassa a janela pra uma instância já aberta e sai na hora: aí não dá pra
      // saber quando ela fecha, então o programa segue rodando em vez de se encerrar por engano.
      if (Date.now() - openedAt < 3000) {
        logger.warn("A janela do painel saiu logo ao abrir (o navegador pode tê-la repassado): o programa segue rodando.");
        return;
      }
      logger.info("Janela do painel fechada: encerrando o programa.");
      process.exit(0); // dispara a limpeza do process.on("exit") acima
    });
  }

  await manager.startAll();
}

main().catch((error) => {
  logger.fatal({ error }, "Erro fatal na inicialização");
  process.exit(1);
});
