import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  type WASocket,
  type WAMessage,
} from "baileys-joss";
import P from "pino";
import QRCode from "qrcode";

import { dirname } from "path";
import { mkdirSync, rmSync } from "fs";

import { logger } from "../utils/logger";
import type { GroupInfo } from "./state";

/** Conexão de uma conta com o WhatsApp. É uma interface pra poder trocar por uma falsa nos testes. */
export interface Connection {
  readonly connected: boolean;
  /** Texto do QR Code atual, ou null quando a conta já está logada (ou ainda não gerou um). */
  readonly qr: string | null;
  /** Socket atual; lança se ainda não foi inicializado. */
  getSock(): WASocket;
  start(): Promise<void>;
  /** Encerra a conexão (o programa está fechando ou a conta foi removida). */
  stop(): void;
  /**
   * Desvincula o aparelho e apaga a sessão. Por padrão já conecta de novo,
   * gerando um novo QR Code (trocar o número); com `reconnect: false` só
   * desconecta (a conta está sendo removida).
   */
  logout(options?: { reconnect?: boolean }): Promise<void>;
  refreshGroups(): Promise<GroupInfo[]>;
}

export interface ConnectionOptions {
  /** Nome da conta, só pra deixar os logs legíveis. */
  label: () => string;
  authDir: string;
  qrPath: string;
  /** Abre a imagem do QR Code no visualizador do sistema (comportamento antigo, só da primeira conta). */
  openQrViewer: boolean;
  onMessage(sock: WASocket, msg: WAMessage): Promise<void>;
  onGroups(groups: GroupInfo[]): void;
}

export type ConnectionFactory = (options: ConnectionOptions) => Connection;

const MAX_RECONNECT_DELAY_MS = 30_000;

export class WhatsAppConnection implements Connection {
  private sock: WASocket | null = null;
  private _connected = false;
  private _qr: string | null = null;
  private stopped = false;
  private attempts = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private viewerOpened = false;
  /** Cada socket novo invalida os eventos dos antigos. */
  private generation = 0;

  constructor(private readonly options: ConnectionOptions) {}

  get connected(): boolean {
    return this._connected;
  }

  get qr(): string | null {
    return this._qr;
  }

  getSock(): WASocket {
    if (!this.sock) throw new Error("Socket não inicializado");
    return this.sock;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.generation++;
    clearTimeout(this.reconnectTimer);
    this._connected = false;
    this._qr = null;
    try {
      this.sock?.end(undefined);
    } catch {
      // já estava fechado
    }
    this.sock = null;
  }

  async logout({ reconnect = true }: { reconnect?: boolean } = {}): Promise<void> {
    const old = this.sock;
    this.generation++;
    clearTimeout(this.reconnectTimer);
    this._connected = false;
    this._qr = null;
    try {
      await old?.logout();
    } catch {
      // sem conexão: a sessão é apagada de qualquer jeito
    }
    try {
      old?.end(undefined);
    } catch {
      // já estava fechado
    }
    this.sock = null;
    this.clearSession();
    this.attempts = 0;
    this.stopped = !reconnect;
    if (reconnect) await this.connect();
  }

  async refreshGroups(): Promise<GroupInfo[]> {
    const sock = this.getSock();
    const groups = await sock.groupFetchAllParticipating();

    const list: GroupInfo[] = [];

    for (const [jid, metadata] of Object.entries(groups)) {
      let hasPicture = false;
      try {
        await sock.profilePictureUrl(jid, "image");
        hasPicture = true;
      } catch {
        hasPicture = false;
      }

      list.push({
        jid,
        name: metadata.subject ?? "(sem nome)",
        hasPicture,
      });
    }

    this.options.onGroups(list);

    console.log(`\n=== GRUPOS DISPONÍVEIS (${this.options.label()}) ===\n`);
    for (const g of list) {
      console.log(`Nome: ${g.name}`);
      console.log(`JID:  ${g.jid}`);
      console.log("---");
    }
    console.log(`\nTotal: ${list.length} grupos\n`);

    return list;
  }

  private clearSession(): void {
    rmSync(this.options.authDir, { recursive: true, force: true });
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const generation = ++this.generation;

    try {
      mkdirSync(this.options.authDir, { recursive: true });
      const { state, saveCreds } = await useMultiFileAuthState(this.options.authDir);
      if (this.stopped || generation !== this.generation) return;

      const sock = makeWASocket({
        auth: state,
        logger: P({ level: "silent" }),
      });
      this.sock = sock;

      sock.ev.on("creds.update", saveCreds);
      sock.ev.on("connection.update", (update) => {
        if (generation !== this.generation) return;
        void this.onConnectionUpdate(update, generation);
      });
      sock.ev.on("messages.upsert", async ({ messages }) => {
        if (generation !== this.generation) return;
        for (const msg of messages) {
          try {
            await this.options.onMessage(sock, msg);
          } catch (err) {
            logger.error({ err, account: this.options.label() }, "Erro ao processar mensagem");
          }
        }
      });
    } catch (err) {
      logger.error({ err, account: this.options.label() }, "Falha ao iniciar a conexão com o WhatsApp");
      this.scheduleReconnect(false);
    }
  }

  private async onConnectionUpdate(
    update: { connection?: string; lastDisconnect?: { error?: unknown }; qr?: string },
    generation: number
  ): Promise<void> {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      this._qr = qr;
      void this.showQrOnDesktop(qr);
    }

    if (connection === "open") {
      this._connected = true;
      this._qr = null;
      this.attempts = 0;
      logger.info(`Bot conectado com sucesso! (${this.options.label()})`);
      this.refreshGroups().catch((err) => {
        logger.error({ err, account: this.options.label() }, "Falha ao carregar os grupos");
      });
    }

    if (connection === "connecting") {
      this._connected = false;
    }

    if (connection === "close") {
      this._connected = false;
      if (this.stopped || generation !== this.generation) return;

      const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)
        ?.output?.statusCode;

      if (statusCode === DisconnectReason.loggedOut) {
        // O WhatsApp encerrou a sessão (desvinculada pelo celular): começa do zero com um novo QR Code
        logger.warn(`Sessão encerrada pelo WhatsApp (${this.options.label()}). Gerando novo QR Code.`);
        this.clearSession();
        this._qr = null;
        this.viewerOpened = false;
        this.scheduleReconnect(true);
        return;
      }

      // Depois de ler o QR Code o WhatsApp pede uma reconexão imediata
      this.scheduleReconnect(statusCode === DisconnectReason.restartRequired);
    }
  }

  private scheduleReconnect(immediate: boolean): void {
    if (this.stopped) return;
    clearTimeout(this.reconnectTimer);

    const delay = immediate
      ? 0
      : Math.min(MAX_RECONNECT_DELAY_MS, 1_000 * 2 ** Math.min(this.attempts, 5));
    if (!immediate) this.attempts++;

    this.reconnectTimer = setTimeout(() => void this.connect(), delay);
  }

  private async showQrOnDesktop(qr: string): Promise<void> {
    if (!this.options.openQrViewer || this.viewerOpened) return;
    this.viewerOpened = true;

    try {
      const qrPath = this.options.qrPath;
      mkdirSync(dirname(qrPath), { recursive: true });
      await QRCode.toFile(qrPath, qr, { width: 400 });
      logger.info(`QR Code gerado em: ${qrPath}`);

      if (process.platform === "win32") {
        Bun.spawn(["cmd", "/c", "start", "", qrPath]);
      } else if (process.platform === "darwin") {
        Bun.spawn(["open", qrPath]);
      } else {
        Bun.spawn(["xdg-open", qrPath]);
      }
    } catch (err) {
      logger.error(err, "Falha ao gerar o QR Code");
    }
  }
}
