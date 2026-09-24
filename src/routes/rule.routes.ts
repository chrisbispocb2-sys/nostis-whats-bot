import type { Account } from "../core/account";
import type { KeywordRuleInput } from "../core/keyword-store";

export async function handleRuleRoutes(
  req: Request,
  url: URL,
  account: Account
): Promise<Response | null> {
  const { keywords } = account;

  if (url.pathname === "/rules" && req.method === "GET") {
    return Response.json({ rules: keywords.list() });
  }

  if (url.pathname === "/rules" && req.method === "POST") {
    const body = (await req.json()) as Partial<KeywordRuleInput>;
    if (
      !Array.isArray(body.keywords) ||
      !Array.isArray(body.responses) ||
      body.keywords.filter((k) => String(k).trim()).length === 0 ||
      body.responses.filter((r) => String(r).trim()).length === 0
    ) {
      return new Response("Bad request", { status: 400 });
    }
    try {
      const rule = keywords.create({
        keywords: body.keywords,
        responses: body.responses,
        cooldownMinutes: body.cooldownMinutes,
        replyToTrigger: body.replyToTrigger,
        reactionEmoji: body.reactionEmoji,
        trackMetrics: body.trackMetrics,
        useUrlButton: body.useUrlButton,
        buttonText: body.buttonText,
        buttonMessage: body.buttonMessage,
        greetingEnabled: body.greetingEnabled,
        greetingMessages: body.greetingMessages,
        greetingPartialMessages: body.greetingPartialMessages,
        greetingCompleteMessages: body.greetingCompleteMessages,
        enabled: body.enabled,
      });
      return Response.json({ rule });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return Response.json({ error: message }, { status: 400 });
    }
  }

  const ruleMatch = url.pathname.match(/^\/rules\/([^/]+)$/);
  if (ruleMatch) {
    const id = decodeURIComponent(ruleMatch[1]!);

    if (req.method === "PUT") {
      const body = (await req.json()) as Partial<KeywordRuleInput>;
      try {
        const rule = keywords.update(id, body);
        if (!rule) return new Response("Not found", { status: 404 });
        return Response.json({ rule });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return Response.json({ error: message }, { status: 400 });
      }
    }

    if (req.method === "DELETE") {
      const ok = keywords.delete(id);
      if (!ok) return new Response("Not found", { status: 404 });
      return Response.json({ ok: true });
    }
  }

  return null;
}
