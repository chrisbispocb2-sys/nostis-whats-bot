import { normalizeMessageContent } from "baileys-joss";
import type { WAMessage } from "baileys-joss";

export interface MessageContent {
  text: string;
  locations: number;
  /** Áudio, foto, vídeo ou documento: pode ter informação que o bot não consegue ler. */
  hasOpaqueMedia: boolean;
}

/** Lê o que importa de uma mensagem privada. Devolve null pra o que não é conversa (reação, protocolo...). */
export function readContent(msg: WAMessage): MessageContent | null {
  const content = normalizeMessageContent(msg.message);
  if (!content) return null;

  const text = (
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    ""
  ).trim();
  const locations = content.locationMessage || content.liveLocationMessage ? 1 : 0;
  const hasOpaqueMedia = !!(
    content.audioMessage ||
    content.imageMessage ||
    content.videoMessage ||
    content.documentMessage
  );
  const isOtherContent = !!(content.stickerMessage || content.contactMessage);

  if (!text && !locations && !hasOpaqueMedia && !isOtherContent) return null;
  return { text, locations, hasOpaqueMedia };
}

/** Reação (emoji) a uma mensagem: não é conversa, mas mostra que tem uma pessoa presente. */
export function isReaction(msg: WAMessage): boolean {
  return !!normalizeMessageContent(msg.message)?.reactionMessage;
}
