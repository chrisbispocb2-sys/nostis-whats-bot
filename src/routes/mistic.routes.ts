import type { Account } from "../core/account";
import { MisticConfigError, type MisticConfigInput } from "../core/mistic-store";
import { MisticError } from "../services/mistic/client";
import type { CreateChargeInput, WithdrawRequest } from "../services/mistic/service";
import { maskTail } from "../utils/documents";
import { logger } from "../utils/logger";
import { randomPersonName } from "../utils/random-name";

function statusFor(err: MisticError): number {
  switch (err.code) {
    case "validation":
      return 400;
    case "not_configured":
      return 409;
    case "rate_limit":
      return 429;
    default:
      return 502; // a MisticPay (ou a internet) é que falhou
  }
}

/** Devolve o erro como resposta do painel. Erros inesperados não vazam detalhes. */
function errorResponse(err: unknown): Response {
  if (err instanceof MisticError) return Response.json({ error: err.message }, { status: statusFor(err) });
  if (err instanceof MisticConfigError) return Response.json({ error: err.message }, { status: 400 });
  logger.error({ err }, "Erro inesperado na integração com a MisticPay");
  return Response.json({ error: "Erro inesperado. Veja o console do programa." }, { status: 500 });
}

async function readBody<T>(req: Request): Promise<T> {
  return (await req.json().catch(() => ({}))) as T;
}

/** Conversas privadas recentes, pro painel saber com quem você está falando e mostrar o botão de cobrança. */
export async function handleConversationRoutes(
  req: Request,
  url: URL,
  account: Account
): Promise<Response | null> {
  if (url.pathname !== "/conversations" || req.method !== "GET") return null;

  const config = account.misticSettings.get();
  const windowMs = config.activeWindowMinutes * 60_000;
  const now = Date.now();
  return Response.json({
    conversations: account.conversations.list().map((c) => ({ ...c, active: now - c.lastActivityAt <= windowMs })),
    activeWindowMinutes: config.activeWindowMinutes,
  });
}

export async function handleMisticRoutes(
  req: Request,
  url: URL,
  account: Account
): Promise<Response | null> {
  const conversationRes = await handleConversationRoutes(req, url, account);
  if (conversationRes) return conversationRes;

  if (!url.pathname.startsWith("/mistic/")) return null;
  const { misticSettings, mistic } = account;

  try {
    if (url.pathname === "/mistic/config" && req.method === "GET") {
      return Response.json(misticSettings.publicView());
    }

    if (url.pathname === "/mistic/config" && req.method === "PUT") {
      misticSettings.update(await readBody<MisticConfigInput>(req));
      account.notifyMisticChange();
      return Response.json(misticSettings.publicView());
    }

    if (url.pathname === "/mistic/test" && req.method === "POST") {
      const body = await readBody<{ clientId?: string; clientSecret?: string; authHeader?: string }>(req);
      const info = await mistic.testConnection(body);
      return Response.json({ ok: true, info: { ...info, document: maskTail(info.document) } });
    }

    if (url.pathname === "/mistic/account" && req.method === "GET") {
      const info = await mistic.accountInfo();
      return Response.json({ info: { ...info, document: maskTail(info.document) } });
    }

    if (url.pathname === "/mistic/statement" && req.method === "GET") {
      const page = Number(url.searchParams.get("page") ?? 1) || 1;
      const status = url.searchParams.get("status") || undefined;
      return Response.json(await mistic.statement(page, status));
    }

    if (url.pathname === "/mistic/charges" && req.method === "GET") {
      return Response.json({ charges: mistic.list() });
    }

    if (url.pathname === "/mistic/charges" && req.method === "POST") {
      const input = await readBody<CreateChargeInput>(req);
      const charge = await mistic.createCharge(input);
      // Sem envio pelo WhatsApp (cliente aleatório ou "copiar"): devolve já o texto pronto para colar
      const copyOnly = input.random === true || input.send === false;
      return Response.json(copyOnly ? { charge, text: mistic.chargeText(charge.id) } : { charge });
    }

    if (url.pathname === "/mistic/random-name" && req.method === "GET") {
      return Response.json({ name: randomPersonName() });
    }

    const chargeAction = url.pathname.match(/^\/mistic\/charges\/([^/]+)\/(check|resend)$/);
    if (chargeAction && req.method === "POST") {
      const id = decodeURIComponent(chargeAction[1]!);
      const charge = chargeAction[2] === "check" ? await mistic.checkNow(id) : await mistic.resend(id);
      return Response.json({ charge });
    }

    const chargeText = url.pathname.match(/^\/mistic\/charges\/([^/]+)\/text$/);
    if (chargeText && req.method === "GET") {
      return Response.json({ text: mistic.chargeText(decodeURIComponent(chargeText[1]!)) });
    }

    const chargeItem = url.pathname.match(/^\/mistic\/charges\/([^/]+)$/);
    if (chargeItem && req.method === "DELETE") {
      mistic.deleteCharge(decodeURIComponent(chargeItem[1]!));
      return Response.json({ ok: true });
    }

    if (url.pathname === "/mistic/withdraw" && req.method === "POST") {
      const record = await mistic.withdraw(await readBody<WithdrawRequest>(req));
      return Response.json({ withdrawal: record });
    }
  } catch (err) {
    return errorResponse(err);
  }

  return null;
}
