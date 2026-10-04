import { handleApiRequest } from "../routes";
import { handleAuthRoutes } from "../routes/auth.routes";
import { WEB_ASSETS } from "../web/assets";
import { logger } from "../utils/logger";
import { CONFIG } from "../config";
import type { AccountManager } from "./account-manager";
import type { Overlay } from "./overlay";
import type { AuthService } from "./auth-service";
import { checkRequestOrigin, isPanelOrigin } from "./request-guard";
import { applyFeatureGate } from "./feature-guard";
import { ChatRealtime, type ChatSocketData } from "./chat-realtime";

export interface DashboardOptions {
  overlay?: Overlay;
  /** Quem está com o painel aberto nesta conta recebe as mensagens do chat em tempo real (WebSocket). */
  chatRealtime?: ChatRealtime;
  /** Exige login para usar o painel. Sem isto, o painel funciona livre (usado nos testes). */
  auth?: AuthService;
}

const CHAT_SOCKET_PATH = /^\/accounts\/([^/]+)\/chats\/socket$/;

function serveStatic(pathname: string): Response | null {
  if (pathname === "/" || pathname === "/index.html") {
    return new Response(WEB_ASSETS.html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }
  if (pathname === "/style.css") {
    return new Response(WEB_ASSETS.css, {
      headers: { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "no-cache" },
    });
  }
  if (pathname === "/app.js") {
    return new Response(WEB_ASSETS.js, {
      headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache" },
    });
  }
  return null;
}

/**
 * Monta o que decide cada resposta do painel. Extraído do `Bun.serve` pra dar pra testar com um
 * `Request` comum, sem precisar abrir uma porta de verdade.
 */
export function createDashboardHandler(
  manager: AccountManager,
  port: number,
  options: DashboardOptions = {}
): (req: Request) => Promise<Response> {
  const { overlay, auth } = options;

  return async function handle(req: Request): Promise<Response> {
    // Barra outros sites do navegador (o painel move dinheiro e liga/desliga o bot)
    const blocked = checkRequestOrigin(req, port);
    if (blocked) return blocked;

    const url = new URL(req.url);

    if (auth) {
      if (url.pathname.startsWith("/auth/")) {
        return (await handleAuthRoutes(req, url, auth)) ?? new Response("Not found", { status: 404 });
      }

      // O botão flutuante (script local, não é navegador) é tratado à parte: ver Overlay/hasActiveSession.
      // A janela de pagamento (perfil de navegador isolado, sem cookie) se autoriza pelo pay-token.
      const exemptFromSession = url.pathname.startsWith("/overlay/");
      if (!exemptFromSession && !auth.isAuthorizedForAccount(req, url)) {
        return serveStatic(url.pathname) ?? Response.json({ error: "not_authenticated" }, { status: 401 });
      }

      if (!exemptFromSession) {
        const gated = await applyFeatureGate(req, url, auth);
        if (gated instanceof Response) return gated;
        req = gated;
      }
    }

    const apiResponse = await handleApiRequest(req, url, manager, overlay);
    if (apiResponse) return apiResponse;

    return serveStatic(url.pathname) ?? new Response("Not found", { status: 404 });
  };
}

export function startDashboard(manager: AccountManager, port = CONFIG.defaultPort, options: DashboardOptions = {}) {
  const innerHandler = createDashboardHandler(manager, port, options);
  const realtime = options.chatRealtime;
  const auth = options.auth;

  const server = Bun.serve<ChatSocketData>({
    port,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      if (realtime) {
        const match = new URL(req.url).pathname.match(CHAT_SOCKET_PATH);
        if (match) {
          const accountId = decodeURIComponent(match[1]!);
          // O handshake de WebSocket sempre manda Origin de verdade: diferente de uma leitura comum,
          // aqui não dá pra deixar passar sem ele (a conexão fica aberta recebendo as conversas). Com
          // login ativo, também exige sessão (e a funcionalidade de chat liberada): senão a conversa em
          // tempo real vazaria sem passar pela tela de login nem pela trava da funcionalidade.
          const authed = !auth || auth.canUse(req, "chat");
          if (authed && isPanelOrigin(req, port) && manager.get(accountId) && srv.upgrade(req, { data: { accountId } })) {
            return undefined;
          }
          return new Response("Not found", { status: 404 });
        }
      }
      return innerHandler(req);
    },
    websocket: {
      open(ws) {
        realtime?.add(ws.data.accountId, ws);
      },
      close(ws) {
        realtime?.remove(ws.data.accountId, ws);
      },
      message() {
        // O painel só escuta por aqui; não esperamos nada vindo do cliente.
      },
    },
  });

  logger.info(`Dashboard disponível em http://localhost:${port}`);
  return server;
}
