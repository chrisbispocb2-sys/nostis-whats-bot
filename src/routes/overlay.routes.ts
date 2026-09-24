import type { Overlay } from "../core/overlay";

/**
 * Rotas do botão solto na tela (não pertencem a uma conta específica: o botão
 * representa a conversa mais recente entre todas as contas).
 */
export async function handleOverlayRoutes(req: Request, url: URL, overlay: Overlay): Promise<Response | null> {
  if (url.pathname === "/overlay/status" && req.method === "GET") {
    return Response.json(overlay.status());
  }

  if (url.pathname === "/overlay/state" && req.method === "GET") {
    return Response.json(overlay.state());
  }

  if (url.pathname === "/overlay/open" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as {
      accountId?: string;
      x?: number;
      y?: number;
      width?: number;
      height?: number;
    };
    if (!body.accountId) return Response.json({ error: "Informe a conta." }, { status: 400 });

    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    try {
      const result = overlay.openPayWindow(body.accountId, {
        x: num(body.x),
        y: num(body.y),
        width: num(body.width),
        height: num(body.height),
      });
      return Response.json({ ok: true, ...result });
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 404 });
    }
  }

  return null;
}
