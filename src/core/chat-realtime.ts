import type { ServerWebSocket } from "bun";
import type { ChatMessageRecord } from "./chat-store";

export interface ChatSocketData {
  accountId: string;
}

type ChatSocket = ServerWebSocket<ChatSocketData>;

/**
 * Empurra mensagens (novas, ou que acabaram de ganhar mídia) pro painel em
 * tempo real, enquanto ele estiver com a aba de Conversas aberta. É só um
 * acelerador: o painel continua lendo por conta própria de tempos em tempos
 * como rede de segurança, então perder um evento (reconexão, aba fechada) não
 * é um problema.
 */
export class ChatRealtime {
  private sockets = new Map<string, Set<ChatSocket>>();

  add(accountId: string, ws: ChatSocket): void {
    let set = this.sockets.get(accountId);
    if (!set) {
      set = new Set();
      this.sockets.set(accountId, set);
    }
    set.add(ws);
  }

  remove(accountId: string, ws: ChatSocket): void {
    const set = this.sockets.get(accountId);
    if (!set) return;
    set.delete(ws);
    if (set.size === 0) this.sockets.delete(accountId);
  }

  /** Quantas conexões abertas existem para uma conta (só pra inspeção/teste). */
  countFor(accountId: string): number {
    return this.sockets.get(accountId)?.size ?? 0;
  }

  /**
   * Avisa quem está com o painel desta conta aberto que uma mensagem chegou, foi enviada ou ganhou mídia.
   * `isNew` separa a mensagem que acabou de chegar de uma atualização de mensagem antiga (mídia baixada,
   * status de entrega, apagada...): o painel só toca o som de mensagem nova no primeiro caso.
   */
  publish(accountId: string, message: ChatMessageRecord, isNew = false): void {
    this.send(accountId, { type: "chat-message", message, isNew });
  }

  /** Avisa que uma mensagem sumiu do histórico (apagada só pra você, neste painel). */
  publishDeleted(accountId: string, chatJid: string, id: string): void {
    this.send(accountId, { type: "chat-message-deleted", chatJid, id });
  }

  private send(accountId: string, payload: unknown): void {
    const set = this.sockets.get(accountId);
    if (!set || set.size === 0) return;

    const data = JSON.stringify(payload);
    for (const ws of set) {
      try {
        ws.send(data);
      } catch {
        // socket morto: o close() correspondente já deve estar a caminho
      }
    }
  }
}
