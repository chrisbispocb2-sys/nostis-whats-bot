import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import overlayScript from "./overlay.ps1" with { type: "text" };
import { computeOverlayState, type OverlayAccount, type OverlayState } from "./overlay-state";
import {
  buildFallbackCommand,
  buildPayWindowCommand,
  findBrowser as defaultFindBrowser,
  payWindowProfileDir,
  payWindowUrl,
  type PayWindowRect,
} from "./pay-window";
import { logger } from "../utils/logger";

/** O mínimo que precisamos de um processo filho (facilita trocar por um falso nos testes). */
export interface SpawnedProcess {
  pid: number;
  exited: Promise<number>;
  kill(): void;
}
/**
 * `hide`: o programa iniciado roda escondido, com console próprio e invisível. NÃO usar com
 * programas que têm janela própria (o navegador): o Windows esconderia a primeira janela deles.
 */
export type SpawnFn = (command: string[], options: { hide: boolean }) => SpawnedProcess;

/**
 * Opções do Bun.spawn. Com `hide`, NENHUM canal (entrada, saída, erro) pode ser "inherit":
 * herdar um canal faz o filho dividir o console de quem o abriu (o PowerShell onde você roda o
 * bot) em vez de ganhar um próprio e invisível, e qualquer pedido de "esconder a janela" passa a
 * esconder o SEU console. As mensagens do filho saem por um pipe e vão para o log do bot.
 */
export function spawnOptions(hide: boolean) {
  return { stdin: "ignore", stdout: "ignore", stderr: hide ? "pipe" : "ignore", windowsHide: hide } as const;
}

/** Lê um canal do filho linha a linha até ele fechar (precisa ser lido, senão o pipe enche e o filho trava). */
async function forEachLine(stream: ReadableStream<Uint8Array> | undefined, onLine: (line: string) => void): Promise<void> {
  if (!stream) return;
  const decoder = new TextDecoder();
  let pending = "";
  try {
    for await (const chunk of stream) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) onLine(line.trim());
    }
    if (pending.trim()) onLine(pending.trim());
  } catch {
    // o processo terminou no meio da leitura: nada a fazer
  }
}

const defaultSpawn: SpawnFn = (command, { hide }) => {
  const proc = Bun.spawn(command, spawnOptions(hide));
  // O botão nativo escreve mensagens úteis no canal de erro; o navegador não tem nada a dizer
  if (hide) void forEachLine(proc.stderr as ReadableStream<Uint8Array> | undefined, (line) => logger.info(`[botão flutuante] ${line}`));
  return { pid: proc.pid, exited: proc.exited, kill: () => proc.kill() };
};

export interface OverlayOptions {
  /** Contas de WhatsApp atuais (lido a cada consulta, então acompanha contas criadas/removidas). */
  accounts: () => OverlayAccount[];
  port: number;
  /** Pasta de dados (guarda a posição do botão). */
  dataDir: string;
  /** Pasta temporária (script, perfil da janela de pagamento). */
  tempDir: string;
  platform?: string;
  spawn?: SpawnFn;
  findBrowser?: () => string | null;
  /** Texto do script do botão (só pra testes). */
  script?: string;
  /** Espera antes de reiniciar o botão se ele parar sozinho. */
  restartDelayMs?: number;
}

export interface OverlayStatus {
  /** O botão solto na tela só existe no Windows. */
  supported: boolean;
  running: boolean;
}

const MAX_QUICK_FAILURES = 3;
const QUICK_FAILURE_MS = 10_000;

/**
 * Botão flutuante da MisticPay solto na tela do computador (fora do
 * navegador): um pequeno programa do Windows (PowerShell + WPF) que este
 * programa inicia quando algum WhatsApp tem a MisticPay pronta e configurada
 * para "tela". Ele pergunta o que mostrar (`state()`) e, ao ser clicado, pede
 * a janela de pagamento (`openPayWindow()`).
 */
export class Overlay {
  private child: SpawnedProcess | null = null;
  private payBrowser: SpawnedProcess | null = null;
  private startedAt = 0;
  private quickFailures = 0;
  private stopped = false;
  private restartTimer?: ReturnType<typeof setTimeout>;

  private readonly platform: string;
  private readonly spawn: SpawnFn;
  private readonly findBrowser: () => string | null;

  constructor(private readonly options: OverlayOptions) {
    this.platform = options.platform ?? process.platform;
    this.spawn = options.spawn ?? defaultSpawn;
    this.findBrowser = options.findBrowser ?? (() => defaultFindBrowser());
  }

  status(): OverlayStatus {
    return { supported: this.platform === "win32", running: this.child !== null };
  }

  state(): OverlayState {
    return computeOverlayState(this.options.accounts());
  }

  /** Alguma conta quer o botão solto na tela? */
  private wanted(): boolean {
    return this.options.accounts().some((a) => a.misticSettings.isConfigured() && a.misticSettings.get().floatWhere === "desktop");
  }

  /** Liga ou desliga o botão conforme as configurações atuais (chame quando algo mudar). */
  sync(): void {
    if (this.platform !== "win32" || this.stopped) return;

    if (this.wanted()) {
      if (!this.child && this.quickFailures < MAX_QUICK_FAILURES) this.launch();
    } else if (this.child) {
      this.child.kill();
    }
  }

  private launch(): void {
    try {
      mkdirSync(this.options.tempDir, { recursive: true });
      const scriptPath = join(this.options.tempDir, "overlay.ps1");
      // O PowerShell 5.1 só entende UTF-8 se o arquivo tiver BOM
      writeFileSync(scriptPath, `﻿${this.options.script ?? overlayScript}`, "utf-8");

      const child = this.spawn([
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-STA",
        "-ExecutionPolicy",
        "Bypass",
        // Sem "-WindowStyle Hidden" de propósito: o filho já nasce sem janela (ver spawnOptions) e esse
        // parâmetro esconderia o console de quem abriu o bot se algum dia ele fosse compartilhado
        "-File",
        scriptPath,
        "-Port",
        String(this.options.port),
        "-ParentPid",
        String(process.pid),
        "-PosFile",
        join(this.options.dataDir, "overlay-position.json"),
      ], { hide: true });
      this.child = child;
      this.startedAt = Date.now();
      logger.info(`Botão flutuante da MisticPay iniciado (PID ${child.pid})`);

      void child.exited.then((code) => this.onExit(child, code));
    } catch (err) {
      logger.error({ err }, "Não foi possível iniciar o botão flutuante da MisticPay");
      this.quickFailures = MAX_QUICK_FAILURES;
    }
  }

  private onExit(child: SpawnedProcess, code: number): void {
    if (this.child !== child) return;
    this.child = null;
    if (this.stopped) return;

    const quick = Date.now() - this.startedAt < QUICK_FAILURE_MS;
    this.quickFailures = quick ? this.quickFailures + 1 : 0;
    logger.info(`Botão flutuante da MisticPay encerrado (código ${code})`);

    if (this.quickFailures >= MAX_QUICK_FAILURES) {
      logger.warn("O botão flutuante da MisticPay não conseguiu iniciar; o painel mostra o botão dentro da página.");
      return;
    }
    this.restartTimer = setTimeout(() => this.sync(), this.options.restartDelayMs ?? 2_000);
  }

  /** Encerra o botão e a janela de pagamento (o programa está fechando). */
  stop(): void {
    this.stopped = true;
    clearTimeout(this.restartTimer);
    this.child?.kill();
    this.child = null;
    this.payBrowser?.kill();
    this.payBrowser = null;
  }

  /** Abre a janela de pagamento (só o modal da MisticPay) da conta pedida, do tamanho e no lugar sugeridos. */
  openPayWindow(accountId: string, rect: PayWindowRect = {}): { url: string; browser: string | null } {
    if (!this.options.accounts().some((a) => a.id === accountId)) throw new Error("Conta não encontrada.");

    const url = payWindowUrl(this.options.port, accountId);
    const browser = this.findBrowser();
    const command = browser
      ? buildPayWindowCommand(browser, url, payWindowProfileDir(this.options.tempDir), rect)
      : buildFallbackCommand(url);

    // O navegador tem janela própria e precisa aparecer; o "cmd /c start" do plano B só entrega a página ao navegador padrão
    const proc = this.spawn(command, { hide: !browser });
    if (browser) {
      // O primeiro comando vira o navegador da janela; os seguintes só entregam a janela a ele e terminam
      this.payBrowser = proc;
      void proc.exited.then(() => {
        if (this.payBrowser === proc) this.payBrowser = null;
      });
    }
    return { url, browser };
  }
}
