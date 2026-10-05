import { hasFeatureAccess, type FeatureKey } from "./user-store";
import type { AuthProvider } from "./auth-provider";

const BLOCKED_MESSAGE = "Essa funcionalidade não está liberada para sua conta. Fale com o administrador.";

/** Campos do assistente de corrida dentro de `Settings` — ver settings-store.ts. */
const RIDE_FIELDS = [
  "rideAssistantEnabled",
  "rideAutoChargeEnabled",
  "rideChargeMessage",
  "rideChargeTrigger",
  "rideNear2MinMessage",
  "rideNear1MinMessage",
  "rideArrivedMessage",
  "rideStartedMessage",
  "rideDriverChangedMessage",
  "rideVehicleDetailsEnabled",
];

interface FeatureRule {
  feature: FeatureKey;
  test: (method: string, scopedPath: string) => boolean;
}

const GROUP_MUTATION_PATHS = ["/groups/toggle", "/groups/delay", "/groups/select-all", "/groups/deselect-all"];

/**
 * Uma rota por linha, não um arquivo inteiro por linha: `group.routes.ts`, por exemplo, só trava
 * nas rotas que mudam o bot em grupo — `GET /groups` continua livre porque a Propaganda (e a
 * barra lateral) também precisam da lista de grupos, sem relação com essa funcionalidade.
 */
const ACCOUNT_FEATURE_RULES: FeatureRule[] = [
  {
    feature: "groupBot",
    test: (method, path) =>
      (method === "POST" && (path === "/on" || path === "/off")) ||
      path.startsWith("/rules") ||
      (method === "POST" && GROUP_MUTATION_PATHS.includes(path)),
  },
  { feature: "campaigns", test: (_m, path) => path.startsWith("/campaigns") },
  { feature: "metrics", test: (_m, path) => path.startsWith("/leads") || path.startsWith("/callers") },
  { feature: "chat", test: (_m, path) => path.startsWith("/chats") || path.startsWith("/folders") || path.startsWith("/chat-quick-replies") },
  { feature: "misticPay", test: (_m, path) => path === "/conversations" || path.startsWith("/mistic/") },
];

function blocked(): Response {
  return Response.json({ error: BLOCKED_MESSAGE }, { status: 403 });
}

/**
 * Trava central das 7 funcionalidades vendidas por plano (ver o painel de administração). Devolve
 * a própria `Request` (ou uma nova, com o corpo já filtrado — caso do assistente de corrida)
 * quando está tudo liberado, ou uma `Response` 403 pronta para devolver direto.
 *
 * Não mexe em nada quando não há sessão de cookie (`auth.currentUser` nulo: é o caminho do
 * pay-token da janela de pagamento, que já é confiável e escopado a uma conta só) nem quando o
 * usuário é `admin` (admin nunca é restringido — essas travas controlam clientes, não o dono).
 */
export async function applyFeatureGate(req: Request, url: URL, auth: AuthProvider): Promise<Request | Response> {
  const user = auth.currentUser(req);
  if (!user || user.role === "admin") return req;

  if (url.pathname === "/accounts" && req.method === "POST") {
    return hasFeatureAccess(user, "multiAccount") ? req : blocked();
  }

  const match = url.pathname.match(/^\/accounts\/([^/]+)(\/.+)$/);
  if (!match) return req;
  const scopedPath = match[2]!;

  if (scopedPath === "/settings" && req.method === "PUT" && !hasFeatureAccess(user, "rideAssistant")) {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    for (const field of RIDE_FIELDS) delete body[field];
    req = new Request(req.url, { method: req.method, headers: req.headers, body: JSON.stringify(body) });
  }

  for (const rule of ACCOUNT_FEATURE_RULES) {
    if (rule.test(req.method, scopedPath) && !hasFeatureAccess(user, rule.feature)) return blocked();
  }

  return req;
}
