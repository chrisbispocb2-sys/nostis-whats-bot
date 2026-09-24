import type { Account } from "../core/account";

export async function handleStickerRoutes(
  req: Request,
  url: URL,
  account: Account
): Promise<Response | null> {
  const { stickers } = account;

  if (url.pathname === "/stickers" && req.method === "GET") {
    return Response.json({ stickers: stickers.list() });
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
