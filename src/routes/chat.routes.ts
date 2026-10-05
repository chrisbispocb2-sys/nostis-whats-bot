import type { Account } from "../core/account";
import type { ChatSummary } from "../core/chat-store";
import type { OperatorMediaInput } from "../services/chat.service";
import type { QuickReplySettingsInput } from "../core/quick-reply-store";
import { identityService } from "../services/identity.service";
import { phoneFromJid, normalizeJid } from "../utils/jid";
import { logger } from "../utils/logger";
import { extractUberShareToken } from "../core/uber-trip";
import { parseAmountToCents } from "../utils/money";

/** JIDs conhecidos dessa pessoa (telefone e/ou LID) — a mesma pessoa pode usar JIDs diferentes em grupos diferentes. */
function knownAliasesOf(account: Account, jid: string): string[] {
  return [...new Set([jid, ...account.conversations.aliasesOf(jid)].map(normalizeJid))];
}

/** Telefone sem precisar de rede: o que o painel já sabe (conversa privada rastreada) ou um JID de telefone direto. */
function resolvePhoneSync(account: Account, jid: string): string | null {
  const known = account.conversations.find(jid)?.phone;
  if (known) return known;
  if (jid.endsWith("@s.whatsapp.net")) return phoneFromJid(jid);
  return null;
}

/**
 * Telefone de verdade por trás de um JID, resolvendo LID (identidade oculta) ao vivo quando
 * preciso. Quando a resolução ao vivo funciona, guarda no rastreador de conversas — assim a
 * próxima vez que a lista for lida (poll a cada poucos segundos) já acha pelo caminho rápido, sem
 * precisar resolver de novo.
 */
async function resolvePhone(account: Account, jid: string): Promise<string | null> {
  const sync = resolvePhoneSync(account, jid);
  if (sync) return sync;
  if (jid.endsWith("@lid") && account.connection.connected) {
    try {
      const resolved = await identityService.resolveJid(account.connection.getSock(), jid);
      if (resolved.endsWith("@s.whatsapp.net")) {
        const phone = phoneFromJid(resolved);
        account.conversations.touch({ chatJid: jid, jids: [jid, resolved], phone, name: null, from: "client" });
        return phone;
      }
    } catch {
      // sem conexão ou sem permissão agora: segue sem telefone
    }
  }
  return null;
}

/**
 * Lista de conversas pronta pro painel: cada uma ganha o telefone de verdade (resolvendo LID ao
 * vivo quando preciso) — o nome que a pessoa escolhe no WhatsApp não é confiável pra identificá-la
 * (ninguém "salvou" ela de fato), então o painel sempre prefere o número.
 */
async function withPhone(account: Account, list: ChatSummary[]): Promise<Array<ChatSummary & { phone: string | null }>> {
  return Promise.all(list.map(async (c) => ({ ...c, phone: c.isGroup ? null : await resolvePhone(account, c.jid) })));
}

async function readBody<T>(req: Request): Promise<T> {
  return (await req.json().catch(() => ({}))) as T;
}

function errorResponse(err: unknown, fallback: string, status = 400): Response {
  return Response.json({ error: err instanceof Error ? err.message : fallback }, { status });
}

/** Conversas (privadas e de grupo) dentro do painel, usando a mesma conexão do bot. */
export async function handleChatRoutes(req: Request, url: URL, account: Account): Promise<Response | null> {
  const { chats } = account;

  if (url.pathname === "/chats" && req.method === "GET") {
    return Response.json({ chats: await withPhone(account, chats.listChats()) });
  }

  // Todas as corridas da Uber em acompanhamento nesta conta (pra lista "Corridas em andamento" do painel)
  if (url.pathname === "/chats/uber-trips" && req.method === "GET") {
    const trips = await Promise.all(
      account.uberTrips.list().map(async (trip) => ({
        ...trip,
        paid: account.isRidePaid(trip.chatJid, trip.paymentSince),
        phone: await resolvePhone(account, trip.chatJid),
        name: account.conversations.find(trip.chatJid)?.name ?? null,
      }))
    );
    return Response.json({ trips });
  }

  if (url.pathname === "/chats/archived" && req.method === "GET") {
    return Response.json({ chats: await withPhone(account, chats.listArchivedChats()) });
  }

  if (url.pathname === "/chat-quick-replies" && req.method === "GET") {
    return Response.json(account.quickReplies.get());
  }

  if (url.pathname === "/chat-quick-replies" && req.method === "PUT") {
    const body = await readBody<QuickReplySettingsInput>(req);
    return Response.json(account.quickReplies.update(body));
  }

  if (url.pathname === "/folders" && req.method === "GET") {
    return Response.json({ folders: chats.listFolders() });
  }

  if (url.pathname === "/folders" && req.method === "POST") {
    const body = await readBody<{ name?: string }>(req);
    const name = (body.name ?? "").trim();
    if (!name) return Response.json({ error: "Informe um nome para a lista." }, { status: 400 });
    return Response.json({ folder: chats.createFolder(name) });
  }

  const folderMatch = url.pathname.match(/^\/folders\/([^/]+)$/);
  if (folderMatch && req.method === "DELETE") {
    const ok = chats.deleteFolder(decodeURIComponent(folderMatch[1]!));
    if (!ok) return new Response("Not found", { status: 404 });
    return Response.json({ ok: true });
  }

  const folderChatsMatch = url.pathname.match(/^\/folders\/([^/]+)\/chats$/);
  if (folderChatsMatch && req.method === "GET") {
    return Response.json({ chats: await withPhone(account, chats.listChatsInFolder(decodeURIComponent(folderChatsMatch[1]!))) });
  }
  if (folderChatsMatch && req.method === "POST") {
    const body = await readBody<{ chatJid?: string }>(req);
    if (!body.chatJid) return Response.json({ error: "Informe a conversa." }, { status: 400 });
    chats.addChatToFolder(decodeURIComponent(folderChatsMatch[1]!), body.chatJid);
    return Response.json({ ok: true });
  }

  const folderChatItemMatch = url.pathname.match(/^\/folders\/([^/]+)\/chats\/([^/]+)$/);
  if (folderChatItemMatch && req.method === "DELETE") {
    chats.removeChatFromFolder(decodeURIComponent(folderChatItemMatch[1]!), decodeURIComponent(folderChatItemMatch[2]!));
    return Response.json({ ok: true });
  }

  const chatFoldersMatch = url.pathname.match(/^\/chats\/([^/]+)\/folders$/);
  if (chatFoldersMatch && req.method === "GET") {
    return Response.json({ folderIds: chats.foldersForChat(decodeURIComponent(chatFoldersMatch[1]!)) });
  }

  const mediaMatch = url.pathname.match(/^\/chats\/([^/]+)\/media\/([^/]+)$/);
  if (mediaMatch && req.method === "GET") {
    const chatJid = decodeURIComponent(mediaMatch[1]!);
    const messageId = decodeURIComponent(mediaMatch[2]!);
    const media = chats.getMediaPath(chatJid, messageId);
    if (!media) return new Response("Not found", { status: 404 });

    const file = Bun.file(media.path);
    if (!(await file.exists())) return new Response("Not found", { status: 404 });
    return new Response(file, {
      headers: {
        "Content-Type": media.mimeType ?? "application/octet-stream",
        "Cache-Control": "private, max-age=86400",
      },
    });
  }

  if (url.pathname === "/chats/read-all" && req.method === "POST") {
    chats.markAllRead();
    return Response.json({ ok: true });
  }

  const readMatch = url.pathname.match(/^\/chats\/([^/]+)\/read$/);
  if (readMatch && req.method === "POST") {
    chats.markRead(decodeURIComponent(readMatch[1]!));
    return Response.json({ ok: true });
  }

  const pinMatch = url.pathname.match(/^\/chats\/([^/]+)\/pin$/);
  if (pinMatch && req.method === "POST") {
    const body = await readBody<{ pinned?: boolean; temporary?: boolean }>(req);
    if (body.temporary && !account.misticSettings.publicView().configured) {
      return Response.json({ error: "Cadastre a MisticPay antes de fixar temporariamente." }, { status: 409 });
    }
    chats.setPinned(decodeURIComponent(pinMatch[1]!), body.pinned !== false, !!body.temporary);
    return Response.json({ ok: true });
  }

  const uberTripMatch = url.pathname.match(/^\/chats\/([^/]+)\/uber-trip$/);
  if (uberTripMatch && req.method === "GET") {
    const chatJid = decodeURIComponent(uberTripMatch[1]!);
    return Response.json({ tracking: account.uberTrips.isTracking(chatJid), trip: account.uberTrips.status(chatJid) });
  }
  if (uberTripMatch && req.method === "POST") {
    const chatJid = decodeURIComponent(uberTripMatch[1]!);
    if (!account.settings.get().rideAssistantEnabled) {
      return Response.json({ error: "Ative o assistente de corrida nas configurações antes de acompanhar uma viagem." }, { status: 409 });
    }
    const body = await readBody<{ link?: string; agreedAmount?: unknown }>(req);

    // Sem link: só define o valor combinado de uma corrida que já está sendo acompanhada (ex.: o
    // link foi mandado pelo celular sem nenhum "chama ?" antes, então ela começou sem valor)
    if (!body.link) {
      const cents = parseAmountToCents(body.agreedAmount);
      if (cents === null) return Response.json({ error: "Informe um valor válido." }, { status: 400 });
      const changed = await account.uberTrips.setAgreedAmount(chatJid, cents);
      if (!changed) return Response.json({ error: "Essa corrida já foi cobrada (ou não está mais sendo acompanhada)." }, { status: 409 });
      return Response.json({ ok: true });
    }

    const shareToken = extractUberShareToken(body.link ?? "");
    if (!shareToken) return Response.json({ error: "Esse não parece um link de viagem da Uber (trip.uber.com/...)." }, { status: 400 });

    // Sem valor informado: tenta achar sozinho no "NN,NN chama ?" mais recente que você mandou nessa conversa
    const agreedAmountCents = parseAmountToCents(body.agreedAmount) ?? account.findRecentChamaAmountCents(chatJid);
    if (agreedAmountCents === null) {
      return Response.json({ error: "Não achei o valor combinado — informe manualmente.", needsAmount: true }, { status: 400 });
    }

    try {
      await account.uberTrips.startTracking(chatJid, shareToken, agreedAmountCents);
      return Response.json({ ok: true });
    } catch (err) {
      logger.error({ err, chatJid }, "Falha ao começar a acompanhar a corrida Uber");
      return errorResponse(err, "Não foi possível acompanhar essa corrida.", 502);
    }
  }
  if (uberTripMatch && req.method === "DELETE") {
    account.uberTrips.stopTracking(decodeURIComponent(uberTripMatch[1]!));
    return Response.json({ ok: true });
  }

  const archiveMatch = url.pathname.match(/^\/chats\/([^/]+)\/archive$/);
  if (archiveMatch && req.method === "POST") {
    const body = await readBody<{ archived?: boolean }>(req);
    chats.setArchived(decodeURIComponent(archiveMatch[1]!), body.archived !== false);
    return Response.json({ ok: true });
  }

  const mediaListMatch = url.pathname.match(/^\/chats\/([^/]+)\/media$/);
  if (mediaListMatch && req.method === "GET") {
    return Response.json({ messages: chats.listMediaMessages(decodeURIComponent(mediaListMatch[1]!)) });
  }

  const groupsInCommonMatch = url.pathname.match(/^\/chats\/([^/]+)\/groups-in-common$/);
  if (groupsInCommonMatch && req.method === "GET") {
    const jid = decodeURIComponent(groupsInCommonMatch[1]!);
    const aliases = knownAliasesOf(account, jid);
    if (jid.endsWith("@lid") && account.connection.connected) {
      try {
        const resolved = await identityService.resolveJid(account.connection.getSock(), jid);
        if (!aliases.includes(resolved)) aliases.push(resolved);
      } catch {
        // sem conexão agora: segue só com os apelidos já conhecidos
      }
    }
    return Response.json({ chats: chats.groupsInCommon(aliases) });
  }

  const identityMatch = url.pathname.match(/^\/chats\/([^/]+)\/identity$/);
  if (identityMatch && req.method === "GET") {
    return Response.json({ phone: await resolvePhone(account, decodeURIComponent(identityMatch[1]!)) });
  }

  const searchMatch = url.pathname.match(/^\/chats\/([^/]+)\/search$/);
  if (searchMatch && req.method === "GET") {
    const chatJid = decodeURIComponent(searchMatch[1]!);
    const query = url.searchParams.get("q") ?? "";
    if (!query.trim()) return Response.json({ messages: [] });
    return Response.json({ messages: chats.searchMessages(chatJid, query.trim()) });
  }

  const forwardMatch = url.pathname.match(/^\/chats\/([^/]+)\/messages\/([^/]+)\/forward$/);
  if (forwardMatch && req.method === "POST") {
    const chatJid = decodeURIComponent(forwardMatch[1]!);
    const messageId = decodeURIComponent(forwardMatch[2]!);
    const body = await readBody<{ to?: string }>(req);
    if (!body.to) return Response.json({ error: "Escolha pra qual conversa encaminhar." }, { status: 400 });

    try {
      const message = await chats.forwardMessage(chatJid, messageId, body.to);
      return Response.json({ message });
    } catch (err) {
      logger.error({ err, chatJid, messageId }, "Falha ao encaminhar mensagem");
      return errorResponse(err, "Não foi possível encaminhar.", 502);
    }
  }

  const deleteEveryoneMatch = url.pathname.match(/^\/chats\/([^/]+)\/messages\/([^/]+)\/delete-everyone$/);
  if (deleteEveryoneMatch && req.method === "POST") {
    const chatJid = decodeURIComponent(deleteEveryoneMatch[1]!);
    const messageId = decodeURIComponent(deleteEveryoneMatch[2]!);
    try {
      const message = await chats.deleteForEveryone(chatJid, messageId);
      return Response.json({ message });
    } catch (err) {
      logger.error({ err, chatJid, messageId }, "Falha ao apagar mensagem para todos");
      return errorResponse(err, "Não foi possível apagar para todos.", 502);
    }
  }

  const retryMediaMatch = url.pathname.match(/^\/chats\/([^/]+)\/messages\/([^/]+)\/retry-media$/);
  if (retryMediaMatch && req.method === "POST") {
    const chatJid = decodeURIComponent(retryMediaMatch[1]!);
    const messageId = decodeURIComponent(retryMediaMatch[2]!);
    try {
      const message = await chats.retryMediaDownload(chatJid, messageId);
      return Response.json({ message });
    } catch (err) {
      logger.error({ err, chatJid, messageId }, "Falha ao tentar baixar a mídia de novo");
      return errorResponse(err, "Não foi possível tentar de novo.", 502);
    }
  }

  const reactMatch = url.pathname.match(/^\/chats\/([^/]+)\/messages\/([^/]+)\/react$/);
  if (reactMatch && req.method === "POST") {
    const chatJid = decodeURIComponent(reactMatch[1]!);
    const messageId = decodeURIComponent(reactMatch[2]!);
    const body = await readBody<{ emoji?: string }>(req);
    try {
      const message = await chats.reactToMessage(chatJid, messageId, (body.emoji ?? "").trim());
      return Response.json({ message });
    } catch (err) {
      logger.error({ err, chatJid, messageId }, "Falha ao reagir à mensagem");
      return errorResponse(err, "Não foi possível reagir.", 502);
    }
  }

  const messageItemMatch = url.pathname.match(/^\/chats\/([^/]+)\/messages\/([^/]+)$/);
  if (messageItemMatch && req.method === "DELETE") {
    const chatJid = decodeURIComponent(messageItemMatch[1]!);
    const messageId = decodeURIComponent(messageItemMatch[2]!);
    const ok = chats.deleteForMe(chatJid, messageId);
    if (!ok) return new Response("Not found", { status: 404 });
    return Response.json({ ok: true });
  }

  const messagesMatch = url.pathname.match(/^\/chats\/([^/]+)\/messages$/);
  if (messagesMatch && req.method === "GET") {
    const chatJid = decodeURIComponent(messagesMatch[1]!);
    const before = url.searchParams.has("before") ? Number(url.searchParams.get("before")) : undefined;
    const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined;
    return Response.json({ messages: await chats.listMessagesWithMentions(chatJid, { before, limit }) });
  }

  if (messagesMatch && req.method === "POST") {
    const chatJid = decodeURIComponent(messagesMatch[1]!);
    const body = await readBody<{ text?: string; media?: OperatorMediaInput; quotedId?: string }>(req);
    const text = (body.text ?? "").trim();
    if (!text && !body.media) return Response.json({ error: "Mensagem vazia." }, { status: 400 });

    try {
      const message = await chats.sendAsOperator(chatJid, { text, media: body.media, quotedId: body.quotedId });
      return Response.json({ message });
    } catch (err) {
      logger.error({ err, chatJid }, "Falha ao enviar mensagem pelo painel");
      return errorResponse(err, "Não foi possível enviar.", 502);
    }
  }

  return null;
}
