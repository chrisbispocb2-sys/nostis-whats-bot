import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { WAMessage, WASocket } from "baileys-joss";
import type { Connection, ConnectionFactory, ConnectionOptions } from "../core/connection";
import type { GroupInfo } from "../core/state";

/** Só pra testes: nada aqui é usado pelo programa de verdade. */

export interface SentMessage {
  jid: string;
  content: { text?: string } & Record<string, unknown>;
  options?: { messageId?: string } & Record<string, unknown>;
}

/** Socket do WhatsApp de mentira que só anota o que o bot tentou enviar. */
export class FakeSock {
  sent: SentMessage[] = [];
  presence: Array<{ state: string; jid: string }> = [];
  user = { id: "5511900000000:1@s.whatsapp.net" };
  /** Mapa LID → telefone que o "WhatsApp" conhece. */
  lidToPhone: Record<string, string> = {};

  sendMessage = async (jid: string, content: SentMessage["content"], options?: SentMessage["options"]) => {
    this.sent.push({ jid, content, options });
    return { key: { id: options?.messageId ?? "generated" } };
  };

  sendPresenceUpdate = async (state: string, jid: string) => {
    this.presence.push({ state, jid });
  };

  signalRepository = {
    lidMapping: { getPNForLID: async (lid: string) => this.lidToPhone[lid] ?? null },
  };

  profilePictureUrl = async () => null;

  /** Números que "existem no WhatsApp" (só dígitos) → JID devolvido. */
  registered: Record<string, string> = {};

  onWhatsApp = async (jid: string) => {
    const digits = jid.split("@")[0]!;
    const found = this.registered[digits];
    return [{ jid: found ?? jid, exists: !!found }];
  };

  /** Textos enviados pro chat informado. */
  textsTo(jid: string): string[] {
    return this.sent.filter((m) => m.jid === jid).map((m) => String(m.content.text ?? ""));
  }
}

/** Conexão de mentira: não fala com o WhatsApp e deixa o teste "entregar" mensagens. */
export class FakeConnection implements Connection {
  connected = false;
  qr: string | null = null;
  started = false;
  stopped = false;
  logouts: Array<{ reconnect?: boolean } | undefined> = [];
  groups: GroupInfo[] = [];
  readonly sock = new FakeSock();

  constructor(readonly options: ConnectionOptions) {}

  getSock(): WASocket {
    return this.sock as unknown as WASocket;
  }

  async start(): Promise<void> {
    this.started = true;
  }

  stop(): void {
    this.stopped = true;
  }

  async logout(options?: { reconnect?: boolean }): Promise<void> {
    this.logouts.push(options);
  }

  async refreshGroups(): Promise<GroupInfo[]> {
    this.options.onGroups(this.groups);
    return this.groups;
  }

  /** Simula uma mensagem chegando do WhatsApp. */
  deliver(msg: WAMessage): Promise<void> {
    return this.options.onMessage(this.getSock(), msg);
  }
}

/** Fábrica que guarda as conexões criadas, na ordem, pro teste alcançá-las. */
export function fakeConnections() {
  const created: FakeConnection[] = [];
  const factory: ConnectionFactory = (options) => {
    const connection = new FakeConnection(options);
    created.push(connection);
    return connection;
  };
  return { factory, created };
}

export interface MessageExtras {
  id?: string;
  fromMe?: boolean;
  /** Segundos, igual ao WhatsApp. */
  timestamp?: number;
  pushName?: string;
  /** Telefone real quando o chat vem por LID. */
  alt?: string;
}

let counter = 0;

/** Mensagem de texto num chat privado. */
export function privateText(chatJid: string, text: string, extras: MessageExtras = {}): WAMessage {
  return {
    key: {
      remoteJid: chatJid,
      fromMe: extras.fromMe ?? false,
      id: extras.id ?? `MSG${++counter}`,
      remoteJidAlt: extras.alt,
    },
    message: { conversation: text },
    messageTimestamp: extras.timestamp,
    pushName: extras.pushName,
  } as WAMessage;
}

/** Mensagem de texto num grupo. */
export function groupText(
  groupJid: string,
  participantJid: string,
  text: string,
  extras: MessageExtras = {}
): WAMessage {
  return {
    key: { remoteJid: groupJid, participant: participantJid, fromMe: false, id: extras.id ?? `MSG${++counter}` },
    message: { conversation: text },
    messageTimestamp: extras.timestamp,
    pushName: extras.pushName,
  } as WAMessage;
}

/** Duas pastas temporárias (dados e temp) que são apagadas no fim do teste. */
export function tempDirs() {
  const root = mkdtempSync(join(tmpdir(), "brinzy-test-"));
  return {
    appDataDir: join(root, "appdata"),
    tempDir: join(root, "temp"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
