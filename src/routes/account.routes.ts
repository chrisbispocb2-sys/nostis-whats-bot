import QRCode from "qrcode";
import type { Account } from "../core/account";
import type { AccountManager } from "../core/account-manager";
import { logger } from "../utils/logger";

/** Resumo de uma conta pra lista lateral do painel. */
function describe(account: Account) {
  const guard = account.guardStatus();
  return {
    id: account.id,
    name: account.name,
    phone: account.phone,
    active: account.bot.active,
    connected: account.connection.connected,
    needsQr: account.connection.qr !== null,
    guardEnabled: guard.enabled,
    guardPending: guard.pending,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Rotas que tratam das contas em si (listar, criar, renomear, remover, QR
 * Code...). As rotas de dentro de uma conta (`/accounts/:id/rules` etc.) são
 * despachadas em routes/index.ts.
 */
export async function handleAccountRoutes(
  req: Request,
  url: URL,
  manager: AccountManager
): Promise<Response | null> {
  if (url.pathname === "/accounts" && req.method === "GET") {
    return Response.json({ accounts: manager.list().map(describe) });
  }

  if (url.pathname === "/accounts" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { name?: string };
    try {
      const account = await manager.create(body.name);
      return Response.json({ account: describe(account) });
    } catch (err) {
      return Response.json({ error: errorMessage(err) }, { status: 400 });
    }
  }

  const match = url.pathname.match(/^\/accounts\/([^/]+)(\/qr|\/avatar|\/logout)?$/);
  if (!match) return null;

  const id = decodeURIComponent(match[1]!);
  const action = match[2];
  const account = manager.get(id);
  if (!account) return Response.json({ error: "Conta não encontrada." }, { status: 404 });

  if (!action && req.method === "PUT") {
    const body = (await req.json().catch(() => ({}))) as { name?: string };
    try {
      const renamed = manager.rename(id, body.name);
      if (!renamed) return new Response("Not found", { status: 404 });
      return Response.json({ account: describe(renamed) });
    } catch (err) {
      return Response.json({ error: errorMessage(err) }, { status: 400 });
    }
  }

  if (!action && req.method === "DELETE") {
    try {
      await manager.remove(id);
      return Response.json({ ok: true });
    } catch (err) {
      return Response.json({ error: errorMessage(err) }, { status: 400 });
    }
  }

  if (action === "/qr" && req.method === "GET") {
    const qr = account.connection.qr;
    if (!qr) return new Response("No QR", { status: 404 });
    const png = await QRCode.toBuffer(qr, { width: 320, margin: 2 });
    return new Response(png, {
      headers: { "Content-Type": "image/png", "Cache-Control": "no-store" },
    });
  }

  if (action === "/avatar" && req.method === "GET") {
    try {
      const sock = account.connection.getSock();
      const jid = sock.user?.id;
      const picUrl = jid ? await sock.profilePictureUrl(jid, "image") : null;
      if (!picUrl) return new Response("No picture", { status: 404 });

      const res = await fetch(picUrl);
      return new Response(await res.arrayBuffer(), {
        headers: {
          "Content-Type": res.headers.get("content-type") ?? "image/jpeg",
          "Cache-Control": "public, max-age=600",
        },
      });
    } catch {
      return new Response("No picture", { status: 404 });
    }
  }

  if (action === "/logout" && req.method === "POST") {
    try {
      await account.connection.logout();
      logger.info(`Conta desconectada via dashboard: ${account.name}`);
      return Response.json({ ok: true });
    } catch (err) {
      return Response.json({ error: errorMessage(err) }, { status: 500 });
    }
  }

  return null;
}
