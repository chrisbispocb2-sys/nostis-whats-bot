import type { Account } from "../core/account";
import type { CampaignInput } from "../core/campaign-store";
import { sendCampaign, getSendState, isSending } from "../services/campaign.service";

export async function handleCampaignRoutes(
  req: Request,
  url: URL,
  account: Account
): Promise<Response | null> {
  const { campaigns: campaignStore, bot, connection } = account;

  if (url.pathname === "/campaigns" && req.method === "GET") {
    return Response.json({ campaigns: campaignStore.list() });
  }

  if (url.pathname === "/campaigns" && req.method === "POST") {
    const body = (await req.json()) as Partial<CampaignInput>;
    if (!body.name?.trim() || !Array.isArray(body.groupJids) || body.groupJids.length === 0) {
      return Response.json(
        { error: "Informe um nome para a campanha e selecione ao menos um grupo de destino." },
        { status: 400 }
      );
    }
    if (!body.message?.trim() && !body.media) {
      return Response.json(
        { error: "Informe uma mensagem ou uma mídia (figurinha/imagem) para a campanha." },
        { status: 400 }
      );
    }
    try {
      const campaign = campaignStore.create({
        name: body.name,
        message: body.message ?? "",
        groupJids: body.groupJids,
        intervalSeconds: body.intervalSeconds,
        media: body.media ?? null,
      });
      return Response.json({ campaign });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return Response.json({ error: message }, { status: 400 });
    }
  }

  const campaignSendMatch = url.pathname.match(/^\/campaigns\/([^/]+)\/send$/);
  if (campaignSendMatch && req.method === "POST") {
    const id = decodeURIComponent(campaignSendMatch[1]!);
    const campaign = campaignStore.get(id);
    if (!campaign) return new Response("Not found", { status: 404 });

    if (campaign.groupJids.length === 0) {
      return Response.json({ error: "Esta campanha não tem grupos de destino." }, { status: 400 });
    }
    if (!connection.connected) {
      return Response.json(
        { error: "O bot não está conectado ao WhatsApp no momento. Conecte-se e tente novamente." },
        { status: 503 }
      );
    }
    if (isSending(id)) {
      return Response.json({ error: "Esta campanha já está sendo enviada." }, { status: 409 });
    }

    void sendCampaign(connection.getSock(), campaign, {
      mediaPath: campaignStore.getMediaPath(campaign),
      groupName: (jid) => bot.groups.find((g) => g.jid === jid)?.name ?? jid,
    });
    return Response.json({ started: true });
  }

  const campaignStatusMatch = url.pathname.match(/^\/campaigns\/([^/]+)\/status$/);
  if (campaignStatusMatch && req.method === "GET") {
    const id = decodeURIComponent(campaignStatusMatch[1]!);
    return Response.json(getSendState(id));
  }

  const campaignMediaMatch = url.pathname.match(/^\/campaigns\/([^/]+)\/media$/);
  if (campaignMediaMatch && req.method === "GET") {
    const id = decodeURIComponent(campaignMediaMatch[1]!);
    const campaign = campaignStore.get(id);
    const mediaPath = campaign ? campaignStore.getMediaPath(campaign) : null;
    if (!mediaPath) return new Response("Not found", { status: 404 });

    const file = Bun.file(mediaPath);
    if (!(await file.exists())) return new Response("Not found", { status: 404 });
    return new Response(file, {
      headers: { "Content-Type": campaign!.mediaMimeType ?? "application/octet-stream" },
    });
  }

  const campaignMatch = url.pathname.match(/^\/campaigns\/([^/]+)$/);
  if (campaignMatch) {
    const id = decodeURIComponent(campaignMatch[1]!);

    if (req.method === "PUT") {
      const body = (await req.json()) as Partial<CampaignInput>;
      try {
        const campaign = campaignStore.update(id, body);
        if (!campaign) return new Response("Not found", { status: 404 });
        return Response.json({ campaign });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return Response.json({ error: message }, { status: 400 });
      }
    }

    if (req.method === "DELETE") {
      if (isSending(id)) {
        return Response.json(
          { error: "Não é possível excluir uma campanha enquanto ela está sendo enviada." },
          { status: 409 }
        );
      }
      const ok = campaignStore.delete(id);
      if (!ok) return new Response("Not found", { status: 404 });
      return Response.json({ ok: true });
    }
  }

  return null;
}
