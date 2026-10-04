import type { Account } from "../core/account";
import { normalizeJid } from "../utils/jid";
import { logger } from "../utils/logger";

export async function handleGroupRoutes(
  req: Request,
  url: URL,
  account: Account
): Promise<Response | null> {
  const { bot, groupDelays, connection } = account;

  if (url.pathname === "/groups" && req.method === "GET") {
    return Response.json({
      groups: bot.groups,
      enabled: bot.enabledGroups,
      delays: groupDelays.getAll(),
    });
  }

  if (url.pathname === "/groups/toggle" && req.method === "POST") {
    const body = (await req.json()) as { jid?: string; enabled?: boolean };
    if (!body.jid || typeof body.enabled !== "boolean") {
      return new Response("Bad request", { status: 400 });
    }
    bot.setGroupEnabled(body.jid, body.enabled);
    return Response.json({ ok: true });
  }

  if (url.pathname === "/groups/delay" && req.method === "POST") {
    const body = (await req.json()) as { jid?: string; delayMs?: number };
    if (!body.jid || typeof body.delayMs !== "number" || Number.isNaN(body.delayMs)) {
      return new Response("Bad request", { status: 400 });
    }
    groupDelays.set(body.jid, body.delayMs);
    return Response.json({ ok: true, delayMs: groupDelays.get(body.jid) });
  }

  if (url.pathname === "/groups/select-all" && req.method === "POST") {
    if (bot.groups.length === 0) {
      return Response.json(
        {
          error:
            'Nenhum grupo carregado ainda. Conecte o bot ao WhatsApp e clique em "Atualizar" antes de selecionar todos.',
        },
        { status: 409 }
      );
    }
    bot.enableAllGroups();
    return Response.json({
      groups: bot.groups,
      enabled: bot.enabledGroups,
    });
  }

  if (url.pathname === "/groups/deselect-all" && req.method === "POST") {
    bot.disableAllGroups();
    return Response.json({
      groups: bot.groups,
      enabled: bot.enabledGroups,
    });
  }

  if (url.pathname === "/groups/refresh" && req.method === "POST") {
    if (!connection.connected) {
      return Response.json(
        {
          error:
            "O bot não está conectado ao WhatsApp no momento (aguardando conexão ou QR Code). Conecte-se e tente novamente.",
        },
        { status: 503 }
      );
    }
    try {
      const groups = await connection.refreshGroups();
      return Response.json({ groups, enabled: bot.enabledGroups });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err }, "Falha ao atualizar grupos via dashboard");
      return Response.json(
        { error: `Falha ao atualizar grupos: ${message}` },
        { status: 500 }
      );
    }
  }

  if (url.pathname.startsWith("/groups/metadata/")) {
    const jid = decodeURIComponent(url.pathname.replace("/groups/metadata/", ""));
    try {
      const sock = connection.getSock();
      const meta = await sock.groupMetadata(jid);
      // A sua própria entrada no grupo pode vir em qualquer uma dessas formas (lid OU telefone,
      // dependendo do grupo) — comparar só uma dava "falso" pra admin de verdade em grupo com LID.
      const selfJids = new Set(
        [sock.user?.id, sock.user?.lid, sock.user?.phoneNumber].filter((x): x is string => !!x).map(normalizeJid)
      );
      const isSelfParticipant = (p: { id: string; phoneNumber?: string }) =>
        selfJids.has(normalizeJid(p.id)) || (!!p.phoneNumber && selfJids.has(normalizeJid(p.phoneNumber)));
      const participants = meta.participants.map((p) => ({
        jid: p.id,
        phone: p.phoneNumber ? p.phoneNumber.split("@")[0] : null,
        name: p.name || p.notify || null,
        isAdmin: p.admin === "admin" || p.isAdmin === true,
        isSuperAdmin: p.admin === "superadmin" || p.isSuperAdmin === true,
        isSelf: isSelfParticipant(p),
      }));
      return Response.json({
        description: meta.desc || null,
        memberCount: participants.length,
        ephemeralDuration: meta.ephemeralDuration || 0,
        selfIsAdmin: participants.some((p) => p.isSelf && (p.isAdmin || p.isSuperAdmin)),
        participants,
      });
    } catch (err) {
      logger.error({ err, jid }, "Falha ao buscar dados do grupo");
      return Response.json({ error: "Não foi possível buscar os dados do grupo." }, { status: 502 });
    }
  }

  const participantMatch = url.pathname.match(/^\/groups\/([^/]+)\/participants\/([^/]+)$/);
  if (participantMatch && req.method === "POST") {
    const jid = decodeURIComponent(participantMatch[1]!);
    const participantJid = decodeURIComponent(participantMatch[2]!);
    const body = (await req.json().catch(() => ({}))) as { action?: string };
    if (!body.action || !["add", "remove", "promote", "demote"].includes(body.action)) {
      return Response.json({ error: "Ação inválida." }, { status: 400 });
    }
    try {
      const sock = connection.getSock();
      const result = await sock.groupParticipantsUpdate(jid, [participantJid], body.action as "add" | "remove" | "promote" | "demote");
      // "add" pode "funcionar" mas a pessoa recusar (privacidade dela) — o WhatsApp devolve status por participante
      const status = result?.[0]?.status;
      if (body.action === "add" && status && status !== "200") {
        return Response.json(
          { error: "Não foi possível adicionar: a pessoa só pode entrar por um convite direto (configuração de privacidade dela)." },
          { status: 409 }
        );
      }
      return Response.json({ ok: true });
    } catch (err) {
      logger.error({ err, jid, participantJid, action: body.action }, "Falha ao atualizar participante do grupo");
      return Response.json({ error: "Não foi possível fazer essa alteração no grupo." }, { status: 502 });
    }
  }

  const joinRequestsMatch = url.pathname.match(/^\/groups\/([^/]+)\/join-requests$/);
  if (joinRequestsMatch && req.method === "GET") {
    const jid = decodeURIComponent(joinRequestsMatch[1]!);
    try {
      const requests = await connection.getSock().groupRequestParticipantsList(jid);
      return Response.json({
        requests: requests.map((r) => ({ jid: r["jid"] ?? "", method: r["request_method"] ?? null, requestedAt: r["request_time"] ? Number(r["request_time"]) * 1000 : null })),
      });
    } catch (err) {
      logger.error({ err, jid }, "Falha ao buscar pedidos de entrada pendentes do grupo");
      return Response.json({ error: "Não foi possível buscar os pedidos de entrada." }, { status: 502 });
    }
  }
  if (joinRequestsMatch && req.method === "POST") {
    const jid = decodeURIComponent(joinRequestsMatch[1]!);
    const body = (await req.json().catch(() => ({}))) as { jids?: string[]; action?: string };
    if (!Array.isArray(body.jids) || body.jids.length === 0 || (body.action !== "approve" && body.action !== "reject")) {
      return Response.json({ error: "Informe os pedidos e a ação (approve ou reject)." }, { status: 400 });
    }
    try {
      await connection.getSock().groupRequestParticipantsUpdate(jid, body.jids, body.action);
      return Response.json({ ok: true });
    } catch (err) {
      logger.error({ err, jid, action: body.action }, "Falha ao responder pedido de entrada do grupo");
      return Response.json({ error: "Não foi possível responder esse pedido de entrada." }, { status: 502 });
    }
  }

  const inviteMatch = url.pathname.match(/^\/groups\/([^/]+)\/invite$/);
  if (inviteMatch && req.method === "GET") {
    const jid = decodeURIComponent(inviteMatch[1]!);
    try {
      const code = await connection.getSock().groupInviteCode(jid);
      if (!code) return Response.json({ error: "Não foi possível buscar o link de convite." }, { status: 502 });
      return Response.json({ code, link: `https://chat.whatsapp.com/${code}` });
    } catch (err) {
      logger.error({ err, jid }, "Falha ao buscar o link de convite do grupo");
      return Response.json({ error: "Não foi possível buscar o link de convite." }, { status: 502 });
    }
  }
  if (inviteMatch && req.method === "POST") {
    const jid = decodeURIComponent(inviteMatch[1]!);
    try {
      const code = await connection.getSock().groupRevokeInvite(jid);
      if (!code) return Response.json({ error: "Não foi possível gerar um novo link." }, { status: 502 });
      return Response.json({ code, link: `https://chat.whatsapp.com/${code}` });
    } catch (err) {
      logger.error({ err, jid }, "Falha ao gerar um novo link de convite do grupo");
      return Response.json({ error: "Não foi possível gerar um novo link." }, { status: 502 });
    }
  }

  if (url.pathname.startsWith("/groups/picture/")) {
    const jid = decodeURIComponent(url.pathname.replace("/groups/picture/", ""));
    try {
      const sock = connection.getSock();
      const picUrl = await sock.profilePictureUrl(jid, "image");

      if (!picUrl) {
        return new Response("No picture", { status: 404 });
      }

      const res = await fetch(picUrl);
      const buf = await res.arrayBuffer();
      return new Response(buf, {
        headers: {
          "Content-Type": res.headers.get("content-type") ?? "image/jpeg",
          "Cache-Control": "public, max-age=3600",
        },
      });
    } catch {
      return new Response("No picture", { status: 404 });
    }
  }

  return null;
}
