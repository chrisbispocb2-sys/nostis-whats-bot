import { normalizeMessageContent, toNumber, WAMessageStubType } from "baileys-joss";
import type { WAMessage, WAMessageKey, proto } from "baileys-joss";
import { logger } from "./logger";

/**
 * Avisos de pedido de entrada no grupo (grupo com aprovação de admin ligada) não vêm como conteúdo
 * normal (`msg.message`) — é um "stub" do próprio protocolo do WhatsApp (`messageStubType`), fora
 * do `.message`. Sem isso, toda mensagem desse tipo caía em "não suportada" (igual aparecia como
 * objeto vazio pro resto da função, já que `.message` some ou fica em branco nesses casos).
 */
const JOIN_REQUEST_STUB_TYPES = new Set<number>([
  WAMessageStubType.GROUP_PARTICIPANT_ADD_REQUEST_JOIN,
  WAMessageStubType.GROUP_MEMBERSHIP_JOIN_APPROVAL_REQUEST,
  WAMessageStubType.GROUP_MEMBERSHIP_JOIN_APPROVAL_REQUEST_NON_ADMIN_ADD,
]);

export type ChatMessageType =
  | "text"
  | "image"
  | "video"
  | "audio"
  | "document"
  | "sticker"
  | "location"
  | "contact"
  | "reaction"
  | "revoked"
  /** Aviso do próprio WhatsApp no meio da conversa ("Fulano adicionou Beltrano", "mudou o nome do grupo"...). */
  | "system"
  | "unsupported";

export type SystemEventKind =
  | "add"
  | "remove"
  | "leave"
  | "promote"
  | "demote"
  | "create"
  | "subject"
  | "description"
  | "icon"
  | "invite_link"
  | "announce"
  | "restrict"
  | "change_number"
  | "history_shared"
  | "ephemeral"
  | "pin"
  | "missed_call"
  | "join_request";

/**
 * Um aviso de sistema ainda "cru": quem fez e com quem, como JIDs. Vira texto em `renderSystemText`,
 * quando já dá pra trocar cada JID por um nome (isso depende do histórico da conversa, que esta
 * função não enxerga).
 */
export interface SystemEvent {
  kind: SystemEventKind;
  /** Os JIDs conhecidos de quem fez a ação (telefone e/ou LID). Vazio = o WhatsApp não disse quem foi. */
  actor: string[];
  /** Cada pessoa afetada, com os JIDs conhecidos dela. */
  targets: string[][];
  /** Detalhe da ação: nome novo do grupo, "on"/"off" de uma configuração, data do histórico... */
  value: string | null;
}

export interface ChatContent {
  type: ChatMessageType;
  text: string | null;
  /** Só pra `type: "system"`: o aviso cru, pra virar texto com os nomes (ver `renderSystemText`). */
  system: SystemEvent | null;
  mimeType: string | null;
  fileName: string | null;
  seconds: number | null;
  ptt: boolean;
  quotedId: string | null;
  reactionEmoji: string | null;
  reactionTargetId: string | null;
  /**
   * O objeto de mídia cru (imageMessage/videoMessage/etc.) só pra tipos baixáveis — guardado pra dar
   * pra tentar baixar de novo bem mais tarde, quando o `msg` original já não existe mais em memória.
   */
  mediaEnvelope: unknown | null;
}

function quotedIdOf(contextInfo: proto.IContextInfo | null | undefined): string | null {
  return contextInfo?.stanzaId ?? null;
}

const EMPTY: Omit<ChatContent, "type"> = {
  text: null,
  system: null,
  mimeType: null,
  fileName: null,
  seconds: null,
  ptt: false,
  quotedId: null,
  reactionEmoji: null,
  reactionTargetId: null,
  mediaEnvelope: null,
};

/** Lê o que importa de uma mensagem para o histórico do chat (recebida ou própria). Null = nada pra guardar (protocolo, etc). */
export function extractChatContent(msg: WAMessage): ChatContent | null {
  if (msg.messageStubType != null && JOIN_REQUEST_STUB_TYPES.has(msg.messageStubType)) {
    // Quem pediu vem no primeiro parâmetro (`{ lid, pn }`); o segundo diz o que houve com o pedido.
    // Sem parâmetro (formato antigo), quem pediu é o próprio autor do aviso.
    const params: string[] = msg.messageStubParameters ?? [];
    const requester = params[0] ? participantJids(params[0]) : [];
    const outcome = params[1] === "revoked" || params[1] === "rejected" ? params[1] : "created";
    return {
      ...EMPTY,
      type: "system",
      system: { kind: "join_request", actor: [], targets: [requester.length ? requester : actorOf(msg)], value: outcome },
    };
  }
  if (msg.messageStubType === WAMessageStubType.GROUP_MEMBERSHIP_JOIN_APPROVAL_MODE) {
    return { ...EMPTY, type: "text", text: "🔔 A aprovação de admin para novos membros foi alterada neste grupo." };
  }

  const stubEvent = systemEventFromStub(msg);
  if (stubEvent) return { ...EMPTY, type: "system", system: stubEvent };

  const content = unwrapContent(msg.message);
  if (!content) return null;

  // "Fulano enviou o histórico de mensagens para Beltrano" (quem entrou no grupo recebe as mensagens recentes)
  const history = content.messageHistoryBundle || content.messageHistoryNotice;
  if (history) {
    const oldest = toNumber(history.messageHistoryMetadata?.oldestMessageTimestamp);
    return {
      ...EMPTY,
      type: "system",
      system: {
        kind: "history_shared",
        actor: actorOf(msg),
        targets: (history.messageHistoryMetadata?.historyReceivers ?? []).map((jid) => [jid]),
        value: oldest ? String(oldest * 1000) : null,
      },
    };
  }

  const protocol = content.protocolMessage;
  if (protocol?.type === 3 /* EPHEMERAL_SETTING */) {
    return { ...EMPTY, type: "system", system: { kind: "ephemeral", actor: actorOf(msg), targets: [], value: protocol.ephemeralExpiration ? "on" : "off" } };
  }
  if (content.pinInChatMessage) {
    return { ...EMPTY, type: "system", system: { kind: "pin", actor: actorOf(msg), targets: [], value: content.pinInChatMessage.type === 2 ? "off" : "on" } };
  }

  // Sem nada pra mostrar: só chaves de criptografia/contexto que o WhatsApp manda "por baixo" (é o
  // que chega quando alguém acaba de entrar num grupo) ou avisos de protocolo. Antes viravam uma
  // bolha "Mensagem não suportada por aqui ainda" no meio da conversa.
  const visibleKeys = Object.entries(content)
    .filter(([key, value]) => value != null && !INVISIBLE_CONTENT_KEYS.has(key))
    .map(([key]) => key);
  if (visibleKeys.length === 0) return null;

  if (content.reactionMessage) {
    return {
      ...EMPTY,
      type: "reaction",
      reactionEmoji: content.reactionMessage.text || null,
      reactionTargetId: content.reactionMessage.key?.id ?? null,
    };
  }

  if (content.conversation || content.extendedTextMessage) {
    return {
      ...EMPTY,
      type: "text",
      text: content.conversation || content.extendedTextMessage?.text || "",
      quotedId: quotedIdOf(content.extendedTextMessage?.contextInfo),
    };
  }

  if (content.imageMessage) {
    return {
      ...EMPTY,
      type: "image",
      text: content.imageMessage.caption || null,
      mimeType: content.imageMessage.mimetype || null,
      quotedId: quotedIdOf(content.imageMessage.contextInfo),
      mediaEnvelope: content.imageMessage,
    };
  }

  // `ptvMessage` é o recado de vídeo (a bolinha redonda gravada segurando o botão da câmera): é um
  // vídeo como outro qualquer, só vem em outro campo — antes caía em "não suportada"
  const video = content.videoMessage || content.ptvMessage;
  if (video) {
    return {
      ...EMPTY,
      type: "video",
      text: video.caption || null,
      mimeType: video.mimetype || null,
      seconds: video.seconds ?? null,
      quotedId: quotedIdOf(video.contextInfo),
      mediaEnvelope: video,
    };
  }

  if (content.audioMessage) {
    return {
      ...EMPTY,
      type: "audio",
      mimeType: content.audioMessage.mimetype || null,
      seconds: content.audioMessage.seconds ?? null,
      ptt: !!content.audioMessage.ptt,
      quotedId: quotedIdOf(content.audioMessage.contextInfo),
      mediaEnvelope: content.audioMessage,
    };
  }

  if (content.documentMessage) {
    return {
      ...EMPTY,
      type: "document",
      text: content.documentMessage.caption || null,
      mimeType: content.documentMessage.mimetype || null,
      fileName: content.documentMessage.fileName || null,
      quotedId: quotedIdOf(content.documentMessage.contextInfo),
      mediaEnvelope: content.documentMessage,
    };
  }

  if (content.stickerMessage) {
    return {
      ...EMPTY,
      type: "sticker",
      mimeType: content.stickerMessage.mimetype || null,
      quotedId: quotedIdOf(content.stickerMessage.contextInfo),
      mediaEnvelope: content.stickerMessage,
    };
  }

  const location = content.locationMessage || content.liveLocationMessage;
  if (location) {
    return {
      ...EMPTY,
      type: "location",
      text: location.degreesLatitude != null && location.degreesLongitude != null ? `${location.degreesLatitude},${location.degreesLongitude}` : null,
    };
  }

  if (content.contactMessage) {
    return { ...EMPTY, type: "contact", text: content.contactMessage.displayName || null };
  }

  if (content.contactsArrayMessage) {
    const contacts = content.contactsArrayMessage;
    const count = contacts.contacts?.length ?? 0;
    return {
      ...EMPTY,
      type: "contact",
      text: contacts.displayName || `${count} contato${count === 1 ? "" : "s"} compartilhado${count === 1 ? "" : "s"}`,
    };
  }

  // Mensagem com botões ("Receber atendimento", lista de opções...) e a resposta de quem tocou num:
  // vira texto com o corpo e uma linha por botão — o link fica clicável no painel como qualquer outro
  const interactive = interactiveContent(content);
  if (interactive?.text) {
    return { ...EMPTY, type: "text", text: interactive.text, quotedId: quotedIdOf(interactive.contextInfo) };
  }

  // Enquete: nome da pergunta + opções, como texto simples — não dá pra saber quem votou o quê sem
  // decifrar o voto (criptografado à parte pela própria Uber do WhatsApp), mas já evita o "não suportada"
  const poll = content.pollCreationMessage || content.pollCreationMessageV2 || content.pollCreationMessageV3;
  if (poll) {
    const options = (poll.options || []).map((o) => `• ${o.optionName}`).join("\n");
    return {
      ...EMPTY,
      type: "text",
      text: `📊 Enquete: ${poll.name || ""}${options ? `\n${options}` : ""}`.trim(),
      quotedId: quotedIdOf(poll.contextInfo),
    };
  }

  if (content.pollUpdateMessage) {
    return { ...EMPTY, type: "text", text: "🗳️ Votou numa enquete" };
  }

  if (content.groupInviteMessage) {
    const invite = content.groupInviteMessage;
    return {
      ...EMPTY,
      type: "text",
      text: `🔗 Convite para o grupo "${invite.groupName || ""}"${invite.caption ? `\n${invite.caption}` : ""}`,
      quotedId: quotedIdOf(invite.contextInfo),
    };
  }

  if (content.albumMessage) {
    const album = content.albumMessage;
    const parts = [
      album.expectedImageCount ? `${album.expectedImageCount} foto${album.expectedImageCount === 1 ? "" : "s"}` : null,
      album.expectedVideoCount ? `${album.expectedVideoCount} vídeo${album.expectedVideoCount === 1 ? "" : "s"}` : null,
    ].filter(Boolean);
    return { ...EMPTY, type: "text", text: `🖼️ Álbum${parts.length ? ` (${parts.join(" e ")})` : ""}` };
  }

  // Tipos menos comuns (evento, chamada, produto, pagamento...): viram uma linha de texto que diz o que é
  const other = otherKnownContent(content);
  if (other) return { ...EMPTY, type: "text", text: other.text, quotedId: quotedIdOf(other.contextInfo) };

  // O tipo fica guardado junto da mensagem (e aparece na bolha), pra dar pra saber o que era e tratar
  // depois — a mensagem em si não é guardada crua
  logger.info({ chatJid: msg.key?.remoteJid, id: msg.key?.id, contentKeys: visibleKeys }, "Mensagem de um tipo ainda não tratado pelo painel");
  return { ...EMPTY, type: "unsupported", text: visibleKeys.join(", ") };
}

/**
 * Partes de uma mensagem que nunca são conteúdo visível por si sós: chaves de criptografia,
 * protocolo, e respostas cifradas (reação, comentário, resposta a evento, edição) que só fazem
 * sentido aplicadas a outra mensagem.
 */
const INVISIBLE_CONTENT_KEYS = new Set([
  "senderKeyDistributionMessage",
  "fastRatchetKeySenderKeyDistributionMessage",
  "messageContextInfo",
  "protocolMessage",
  "keepInChatMessage",
  "encReactionMessage",
  "encCommentMessage",
  "encEventResponseMessage",
  "secretEncryptedMessage",
  "stickerSyncRmrMessage",
  "scheduledCallEditMessage",
]);

/** Embrulhos que o `normalizeMessageContent` do baileys não abre (a mensagem de verdade vem dentro, em `.message`). */
const EXTRA_WRAPPER_KEYS = [
  "lottieStickerMessage", // figurinha animada
  "botInvokeMessage",
  "botForwardedMessage",
  "botTaskMessage",
  "groupMentionedMessage",
  "statusMentionMessage",
  "groupStatusMentionMessage",
  "limitSharingMessage",
  "questionMessage",
  "questionReplyMessage",
  "statusAddYours",
  "pollCreationMessageV4",
  "pollCreationOptionImageMessage",
  "eventCoverImage",
] as const;

/** O conteúdo de verdade de uma mensagem, tirando todos os embrulhos (temporária, visualização única, figurinha animada...). */
function unwrapContent(message: proto.IMessage | null | undefined): proto.IMessage | undefined {
  let content = normalizeMessageContent(message);
  for (let depth = 0; depth < 5 && content; depth++) {
    const current: proto.IMessage = content;
    const wrapper = EXTRA_WRAPPER_KEYS.find((key) => current[key]?.message);
    if (!wrapper) break;
    content = normalizeMessageContent(current[wrapper]!.message);
  }
  return content;
}

/** "R$ 12,50" a partir do valor em milésimos que o WhatsApp usa. Null se não veio valor. */
function money1000(amount1000: Parameters<typeof toNumber>[0], currency: string | null | undefined): string | null {
  const value = amount1000 == null ? 0 : toNumber(amount1000) / 1000;
  if (!(value > 0)) return null;
  try {
    return new Intl.NumberFormat("pt-BR", { style: "currency", currency: currency || "BRL" }).format(value);
  } catch {
    return `${currency ?? ""} ${value.toFixed(2)}`.trim();
  }
}

/** Texto (ou legenda) de uma mensagem embutida em outra (a observação de um pagamento, por exemplo). */
function noteText(note: proto.IMessage | null | undefined): string | null {
  return note?.conversation || note?.extendedTextMessage?.text || null;
}

const lines = (parts: Array<string | null | undefined | false>): string => parts.filter(Boolean).join("\n");

/**
 * Tipos de mensagem menos comuns, que o painel mostra como uma linha de texto dizendo o que é (sem
 * tentar reproduzir a aparência do WhatsApp). Null = não é nenhum destes.
 */
function otherKnownContent(content: proto.IMessage): { text: string; contextInfo?: proto.IContextInfo | null } | null {
  // O WhatsApp esconde certos conteúdos dos aparelhos conectados (o painel é um): só abre no celular
  if (content.placeholderMessage) {
    return { text: "🔒 Mensagem que só pode ser vista no celular (o WhatsApp não envia o conteúdo para aparelhos conectados)" };
  }

  const event = content.eventMessage;
  if (event) {
    const start = event.startTime ? HISTORY_DATE_FORMAT.format(new Date(toNumber(event.startTime) * 1000)) : null;
    return {
      text: lines([`📅 Evento${event.isCanceled ? " cancelado" : ""}: ${event.name || ""}`.trim(), start && `Quando: ${start}`, event.location?.name && `Onde: ${event.location.name}`, event.description, event.joinLink]),
      contextInfo: event.contextInfo,
    };
  }

  const callLog = content.callLogMesssage;
  if (callLog) {
    const kind = callLog.isVideo ? "📹 Chamada de vídeo" : "📞 Chamada de voz";
    const missed = callLog.callOutcome != null && callLog.callOutcome !== 0 && callLog.callOutcome !== 5; // nem atendida nem em andamento
    const seconds = callLog.durationSecs ? toNumber(callLog.durationSecs) : 0;
    const duration = seconds > 0 ? ` · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` : "";
    return { text: `${kind}${missed ? " não atendida" : ""}${duration}` };
  }
  if (content.call || content.bcallMessage) return { text: "📞 Chamada", contextInfo: content.call?.contextInfo };

  const scheduledCall = content.scheduledCallCreationMessage;
  if (scheduledCall) {
    const when = scheduledCall.scheduledTimestampMs ? HISTORY_DATE_FORMAT.format(new Date(toNumber(scheduledCall.scheduledTimestampMs))) : null;
    return { text: lines([`📞 Chamada agendada${scheduledCall.title ? `: ${scheduledCall.title}` : ""}`, when && `Quando: ${when}`]) };
  }

  const stickerPack = content.stickerPackMessage;
  if (stickerPack) {
    return { text: lines([`🧩 Pacote de figurinhas${stickerPack.name ? `: ${stickerPack.name}` : ""}`, stickerPack.caption]), contextInfo: stickerPack.contextInfo };
  }

  const product = content.productMessage;
  if (product) {
    const item = product.product;
    return {
      text: lines([`🛍️ Produto${item?.title ? `: ${item.title}` : ""}`, money1000(item?.priceAmount1000, item?.currencyCode), item?.description, product.body, item?.url]),
      contextInfo: product.contextInfo,
    };
  }

  const order = content.orderMessage;
  if (order) {
    const count = order.itemCount ? `${order.itemCount} ${order.itemCount === 1 ? "item" : "itens"}` : null;
    return {
      text: lines([`🧾 Pedido${order.orderTitle ? `: ${order.orderTitle}` : ""}`, [count, money1000(order.totalAmount1000, order.totalCurrencyCode)].filter(Boolean).join(" · "), order.message]),
      contextInfo: order.contextInfo,
    };
  }
  if (content.invoiceMessage) return { text: "🧾 Fatura" };

  const paymentRequest = content.requestPaymentMessage;
  if (paymentRequest) {
    const amount = money1000(paymentRequest.amount1000, paymentRequest.currencyCodeIso4217);
    return { text: lines([`💸 Pedido de pagamento${amount ? `: ${amount}` : ""}`, noteText(paymentRequest.noteMessage)]) };
  }
  if (content.sendPaymentMessage) return { text: lines(["💸 Pagamento pelo WhatsApp", noteText(content.sendPaymentMessage.noteMessage)]) };
  if (content.declinePaymentRequestMessage) return { text: "💸 Pedido de pagamento recusado" };
  if (content.cancelPaymentRequestMessage) return { text: "💸 Pedido de pagamento cancelado" };
  if (content.paymentInviteMessage) return { text: "💸 Convite para usar pagamentos no WhatsApp" };

  if (content.requestPhoneNumberMessage) return { text: "📱 Pediu o seu número de telefone", contextInfo: content.requestPhoneNumberMessage.contextInfo };

  const pollResult = content.pollResultSnapshotMessage || content.pollResultSnapshotMessageV3;
  if (pollResult) {
    const votes = (pollResult.pollVotes ?? []).map((v) => `• ${v.optionName}: ${v.optionVoteCount ? toNumber(v.optionVoteCount) : 0}`);
    return { text: lines([`📊 Resultado da enquete: ${pollResult.name || ""}`.trim(), ...votes]), contextInfo: pollResult.contextInfo };
  }

  const channelInvite = content.newsletterAdminInviteMessage || content.newsletterFollowerInviteMessageV2;
  if (channelInvite) {
    return { text: lines([`📢 Convite para o canal "${channelInvite.newsletterName || ""}"`, channelInvite.caption]), contextInfo: channelInvite.contextInfo };
  }

  // Comentário numa publicação: o que importa é o texto dele
  const comment = noteText(content.commentMessage?.message);
  if (comment) return { text: comment };

  return null;
}

interface InteractiveContent {
  text: string;
  contextInfo: proto.IContextInfo | null | undefined;
}

/** Junta título, corpo, rodapé e botões num texto só, pulando o que veio vazio. */
function joinInteractive(parts: (string | null | undefined)[], buttons: string[]): string {
  const body = parts.map((part) => part?.trim()).filter(Boolean).join("\n");
  return [body, buttons.join("\n")].filter(Boolean).join("\n\n");
}

/** Botão de link/ligação/copiar: rótulo + o destino. Sem destino, é um botão de resposta comum. */
function buttonLine(label: string | null | undefined, url?: string | null, phone?: string | null, code?: string | null): string {
  const text = label?.trim() || "";
  if (url) return `🔗 ${text ? `${text}: ` : ""}${url}`;
  if (phone) return `📞 ${text ? `${text}: ` : ""}${phone}`;
  if (code) return `📋 ${text ? `${text}: ` : ""}${code}`;
  return text ? `🔘 ${text}` : "";
}

/** Botão do formato novo (`nativeFlowMessage`): o rótulo e o destino vêm num JSON à parte. */
function nativeFlowButtonLine(button: proto.Message.InteractiveMessage.NativeFlowMessage.INativeFlowButton): string {
  try {
    const params = JSON.parse(button.buttonParamsJson || "{}") as { display_text?: string; title?: string; url?: string; phone_number?: string; copy_code?: string };
    return buttonLine(params.display_text || params.title, params.url, params.phone_number, params.copy_code);
  } catch {
    return "";
  }
}

function interactiveMessageText(interactive: proto.Message.IInteractiveMessage): string {
  const buttons = (interactive.nativeFlowMessage?.buttons ?? []).map(nativeFlowButtonLine).filter(Boolean);
  return joinInteractive([interactive.header?.title, interactive.header?.subtitle, interactive.body?.text, interactive.footer?.text], buttons);
}

/**
 * Mensagens com botões e as respostas a elas. O WhatsApp tem vários formatos pra mesma coisa (o novo
 * `interactiveMessage`, os antigos `templateMessage`/`buttonsMessage`/`listMessage`); todos viram
 * o mesmo texto. Null = não é nenhum desses.
 */
function interactiveContent(content: proto.IMessage): InteractiveContent | null {
  if (content.interactiveMessage) {
    return { text: interactiveMessageText(content.interactiveMessage), contextInfo: content.interactiveMessage.contextInfo };
  }

  const template = content.templateMessage;
  if (template) {
    const hydrated = template.hydratedTemplate || template.hydratedFourRowTemplate;
    if (hydrated) {
      const buttons = (hydrated.hydratedButtons ?? [])
        .map((b) => buttonLine(b.urlButton?.displayText || b.callButton?.displayText || b.quickReplyButton?.displayText, b.urlButton?.url, b.callButton?.phoneNumber))
        .filter(Boolean);
      return {
        text: joinInteractive([hydrated.hydratedTitleText, hydrated.hydratedContentText, hydrated.hydratedFooterText], buttons),
        contextInfo: template.contextInfo,
      };
    }
    if (template.interactiveMessageTemplate) {
      return { text: interactiveMessageText(template.interactiveMessageTemplate), contextInfo: template.contextInfo };
    }
  }

  const buttonsMessage = content.buttonsMessage;
  if (buttonsMessage) {
    const buttons = (buttonsMessage.buttons ?? []).map((b) => buttonLine(b.buttonText?.displayText)).filter(Boolean);
    return {
      text: joinInteractive([buttonsMessage.text, buttonsMessage.contentText, buttonsMessage.footerText], buttons),
      contextInfo: buttonsMessage.contextInfo,
    };
  }

  const list = content.listMessage;
  if (list) {
    const rows = (list.sections ?? []).flatMap((section) => (section.rows ?? []).map((row) => (row.title ? `• ${row.title}` : ""))).filter(Boolean);
    return { text: joinInteractive([list.title, list.description, list.footerText], rows), contextInfo: list.contextInfo };
  }

  // Resposta de quem tocou num botão ou escolheu um item da lista: o que a pessoa escolheu
  const reply = content.buttonsResponseMessage || content.templateButtonReplyMessage;
  if (reply) return { text: reply.selectedDisplayText?.trim() || "", contextInfo: reply.contextInfo };
  if (content.listResponseMessage) {
    return { text: content.listResponseMessage.title?.trim() || "", contextInfo: content.listResponseMessage.contextInfo };
  }
  if (content.interactiveResponseMessage) {
    return { text: content.interactiveResponseMessage.body?.text?.trim() || "", contextInfo: content.interactiveResponseMessage.contextInfo };
  }

  return null;
}

/** Quem mandou a mensagem / fez a ação, com todos os JIDs que o WhatsApp informou (telefone e LID). */
function actorOf(msg: WAMessage): string[] {
  const key = msg.key as (WAMessageKey & { participantAlt?: string | null }) | undefined;
  return [key?.participantAlt, key?.participant, msg.participant].filter((jid): jid is string => !!jid);
}

/** Um participante afetado: o WhatsApp manda como JSON (`{ id, phoneNumber, lid }`) ou, em versões antigas, só o JID. */
function participantJids(param: string): string[] {
  try {
    const parsed = JSON.parse(param) as { id?: string; phoneNumber?: string; lid?: string; pn?: string };
    if (parsed && typeof parsed === "object") {
      return [parsed.phoneNumber, parsed.pn, parsed.id, parsed.lid].filter((jid): jid is string => !!jid);
    }
  } catch {
    // não era JSON: é o JID puro
  }
  return param ? [param] : [];
}

const PARTICIPANT_STUB_KINDS: Partial<Record<number, SystemEventKind>> = {
  [WAMessageStubType.GROUP_PARTICIPANT_ADD]: "add",
  [WAMessageStubType.GROUP_PARTICIPANT_INVITE]: "add",
  [WAMessageStubType.GROUP_PARTICIPANT_REMOVE]: "remove",
  [WAMessageStubType.GROUP_PARTICIPANT_LEAVE]: "leave",
  [WAMessageStubType.GROUP_PARTICIPANT_PROMOTE]: "promote",
  [WAMessageStubType.GROUP_PARTICIPANT_DEMOTE]: "demote",
};

const VALUE_STUB_KINDS: Partial<Record<number, SystemEventKind>> = {
  [WAMessageStubType.GROUP_CREATE]: "create",
  [WAMessageStubType.GROUP_CHANGE_SUBJECT]: "subject",
  [WAMessageStubType.GROUP_CHANGE_DESCRIPTION]: "description",
  [WAMessageStubType.GROUP_CHANGE_ICON]: "icon",
  [WAMessageStubType.GROUP_CHANGE_INVITE_LINK]: "invite_link",
  [WAMessageStubType.GROUP_CHANGE_ANNOUNCE]: "announce",
  [WAMessageStubType.GROUP_CHANGE_RESTRICT]: "restrict",
  [WAMessageStubType.GROUP_PARTICIPANT_CHANGE_NUMBER]: "change_number",
};

const MISSED_CALL_STUBS: Partial<Record<number, string>> = {
  [WAMessageStubType.CALL_MISSED_VOICE]: "voice",
  [WAMessageStubType.CALL_MISSED_VIDEO]: "video",
  [WAMessageStubType.CALL_MISSED_GROUP_VOICE]: "voice",
  [WAMessageStubType.CALL_MISSED_GROUP_VIDEO]: "video",
};

/**
 * Avisos de grupo ("adicionou", "saiu", "mudou o nome"...) e chamadas perdidas não vêm como conteúdo
 * (`msg.message`): são "stubs" do protocolo. Antes eram simplesmente descartados — no WhatsApp
 * aparecem como aquela linha centralizada no meio da conversa, e aqui não aparecia nada.
 */
function systemEventFromStub(msg: WAMessage): SystemEvent | null {
  const stubType = msg.messageStubType;
  if (stubType == null) return null;
  const params: string[] = msg.messageStubParameters ?? [];

  const participantKind = PARTICIPANT_STUB_KINDS[stubType];
  if (participantKind) {
    const targets = params.map(participantJids).filter((jids) => jids.length > 0);
    if (targets.length === 0) return null;
    return { kind: participantKind, actor: actorOf(msg), targets, value: null };
  }

  const valueKind = VALUE_STUB_KINDS[stubType];
  if (valueKind) return { kind: valueKind, actor: actorOf(msg), targets: [], value: valueKind === "change_number" ? null : (params[0] ?? null) };

  const call = MISSED_CALL_STUBS[stubType];
  if (call) return { kind: "missed_call", actor: actorOf(msg), targets: [], value: call };

  return null;
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} e ${names[names.length - 1]}`;
}

const HISTORY_DATE_FORMAT = new Intl.DateTimeFormat("pt-BR", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

/**
 * O texto do aviso, como o WhatsApp mostra ("~Xx adicionou ~Isabelli"). `nameOf` troca os JIDs de uma
 * pessoa pelo nome a mostrar ("Você"/"você" pra própria conta, conforme a posição na frase).
 */
export function renderSystemText(event: SystemEvent, nameOf: (jids: string[], role: "actor" | "target") => string): string {
  const actor = event.actor.length ? nameOf(event.actor, "actor") : null;
  const who = actor ?? "Alguém";
  const targets = joinNames(event.targets.map((jids) => nameOf(jids, "target")));
  const several = event.targets.length > 1;
  const on = event.value === "on";
  // Quem entra pelo link (ou sai por conta própria) aparece como autor e alvo da mesma ação
  const actedOnSelf = event.targets.length === 1 && event.targets[0]!.some((jid) => event.actor.includes(jid));
  const subject = (names: string) => names.charAt(0).toUpperCase() + names.slice(1); // "você" no começo da frase

  switch (event.kind) {
    case "add":
      return !actor || actedOnSelf ? `${subject(targets)} ${several ? "entraram" : "entrou"} no grupo` : `${actor} adicionou ${targets}`;
    case "remove":
      return !actor || actedOnSelf ? `${subject(targets)} ${several ? "saíram" : "saiu"} do grupo` : `${actor} removeu ${targets}`;
    case "leave":
      return `${subject(targets)} ${several ? "saíram" : "saiu"} do grupo`;
    case "promote":
      return `${subject(targets)} agora ${several ? "são admins" : "é admin"} do grupo`;
    case "demote":
      return `${subject(targets)} não ${several ? "são mais admins" : "é mais admin"} do grupo`;
    case "create":
      return `${who} criou o grupo${event.value ? ` "${event.value}"` : ""}`;
    case "subject":
      return `${who} mudou o nome do grupo${event.value ? ` para "${event.value}"` : ""}`;
    case "description":
      return `${who} mudou a descrição do grupo`;
    case "icon":
      return event.value ? `${who} mudou a foto do grupo` : `${who} removeu a foto do grupo`;
    case "invite_link":
      return `${who} redefiniu o link de convite do grupo`;
    case "announce":
      return on ? `${who} mudou as configurações: só admins podem enviar mensagens` : `${who} mudou as configurações: todos os participantes podem enviar mensagens`;
    case "restrict":
      return on ? `${who} mudou as configurações: só admins podem editar os dados do grupo` : `${who} mudou as configurações: todos os participantes podem editar os dados do grupo`;
    case "change_number":
      return `${who} mudou de número`;
    case "history_shared": {
      const since = event.value ? ` que começa em ${HISTORY_DATE_FORMAT.format(new Date(Number(event.value)))}` : "";
      return `${who} enviou o histórico de mensagens${since}${targets ? ` para ${targets}` : ""}`;
    }
    case "ephemeral":
      return on ? `${who} ativou as mensagens temporárias` : `${who} desativou as mensagens temporárias`;
    case "pin":
      return on ? `${who} fixou uma mensagem` : `${who} desafixou uma mensagem`;
    case "missed_call":
      return event.value === "video" ? "📹 Chamada de vídeo perdida" : "📞 Chamada de voz perdida";
    case "join_request": {
      const requester = targets || "alguém";
      if (event.value === "revoked") return `${subject(requester)} cancelou o pedido para entrar no grupo`;
      if (event.value === "rejected") return `O pedido de ${requester} para entrar no grupo foi recusado`;
      // O painel reconhece este final de frase pra tornar o aviso clicável (ver JOIN_REQUEST_SUFFIX em chat.js)
      return `${subject(requester)} pediu para entrar no grupo`;
    }
  }
}

/**
 * Se esta mensagem é um aviso de "apagar para todos" (seu, ou de outra pessoa/aparelho), devolve a
 * chave da mensagem original que deve ser apagada. Esse aviso não é conversa — nunca vira uma linha
 * própria no histórico, só atualiza a mensagem alvo pra "apagada".
 */
export function extractRevokeKey(msg: WAMessage): WAMessageKey | null {
  const content = normalizeMessageContent(msg.message);
  if (content?.protocolMessage?.type !== 0 /* REVOKE */) return null;
  return (content.protocolMessage.key as WAMessageKey | undefined) ?? null;
}
