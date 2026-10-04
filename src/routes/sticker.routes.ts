import { createHash } from "crypto";
import type { Account } from "../core/account";

export async function handleStickerRoutes(
  req: Request,
  url: URL,
  account: Account
): Promise<Response | null> {
  const { stickers } = account;

  if (url.pathname === "/stickers" && req.method === "GET") {
    return Response.json({ stickers: stickers.list(), recentlyUsed: stickers.listRecentlyUsed() });
  }

  const stickerUseMatch = url.pathname.match(/^\/stickers\/([^/]+)\/use$/);
  if (stickerUseMatch && req.method === "POST") {
    const ok = stickers.markUsed(decodeURIComponent(stickerUseMatch[1]!));
    if (!ok) return new Response("Not found", { status: 404 });
    return Response.json({ ok: true });
  }

  /** Salva uma figurinha na biblioteca (enviada ou recebida pelo chat) — mesma dedupe por hash do coletor automático. */
  if (url.pathname === "/stickers" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { dataBase64?: string; sourceName?: string };
    if (!body.dataBase64) return Response.json({ error: "Envie a figurinha." }, { status: 400 });

    let buffer: Buffer;
    try {
      buffer = Buffer.from(body.dataBase64, "base64");
    } catch {
      return Response.json({ error: "Figurinha inválida." }, { status: 400 });
    }

    stickers.addSeen(buffer, body.sourceName || "Chat");
    const hash = createHash("sha256").update(buffer).digest("hex");
    return Response.json({ sticker: stickers.list().find((s) => s.hash === hash) ?? null });
  }

  const stickerMediaMatch = url.pathname.match(/^\/stickers\/([^/]+)\/media$/);
  if (stickerMediaMatch && req.method === "GET") {
    const id = decodeURIComponent(stickerMediaMatch[1]!);
    const sticker = stickers.get(id);
    if (!sticker) return new Response("Not found", { status: 404 });

    const file = Bun.file(stickers.getMediaPath(sticker));
    if (!(await file.exists())) return new Response("Not found", { status: 404 });
    return new Response(file, {
      headers: { "Content-Type": "image/webp", "Cache-Control": "public, max-age=86400" },
    });
  }

  const stickerMatch = url.pathname.match(/^\/stickers\/([^/]+)$/);
  if (stickerMatch && req.method === "DELETE") {
    const id = decodeURIComponent(stickerMatch[1]!);
    const ok = stickers.delete(id);
    if (!ok) return new Response("Not found", { status: 404 });
    return Response.json({ ok: true });
  }

  return null;
}
