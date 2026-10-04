import { tmpdir } from "os";
import { join } from "path";
import { mkdtempSync, rmSync } from "fs";
import { findBrowser } from "./pay-window";
import { buildUberStatusRequestBody, type UberStatusFetcher } from "./uber-trip";

/**
 * Implementação de verdade de `UberStatusFetcher`: abre uma aba de Chrome headless no link público
 * da corrida (isso dá os cookies de sessão que a chamada seguinte precisa), e a partir daí consulta
 * o status repetidas vezes rodando um `fetch()` de dentro da própria página (evita ter que reproduzir
 * cookies/headers anti-bot na unha). Não é uma API oficial — ver aviso em uber-trip.ts.
 */
export async function openUberStatusFetcher(shareToken: string): Promise<UberStatusFetcher> {
  const browser = findBrowser();
  if (!browser) throw new Error("Nenhum navegador (Chrome/Edge/Brave) encontrado pra acompanhar a corrida.");

  const port = await findFreePort();
  const profileDir = mkdtempSync(join(tmpdir(), "brinzy-uber-trip-"));
  const proc = Bun.spawn(
    [browser, `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, "--headless=new", "--no-first-run", "--disable-gpu"],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore", windowsHide: true }
  );

  const cleanupProfile = () => {
    setTimeout(() => {
      try {
        rmSync(profileDir, { recursive: true, force: true });
      } catch {}
    }, 500); // dá tempo do processo soltar os arquivos (ver lição aprendida: EBUSY se apagar na hora)
  };

  let conn: CdpConnection;
  try {
    conn = await connectCdp(port, proc);
    await conn.send("Page.enable");
    const loaded = waitForLoadEvent(conn);
    await conn.send("Page.navigate", { url: `https://trip.uber.com/${shareToken}` });
    await Promise.race([loaded, Bun.sleep(15_000)]);
  } catch (err) {
    proc.kill();
    cleanupProfile();
    throw err;
  }

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      conn.ws.close();
    } catch {}
    proc.kill();
    cleanupProfile();
  };

  const fetchStatus = async (): Promise<unknown> => {
    const result = await conn.send("Runtime.evaluate", {
      expression: `
        fetch("https://m.uber.com/go/graphql", {
          method: "POST",
          headers: { "content-type": "application/json", "x-csrf-token": "x" },
          body: ${JSON.stringify(buildUberStatusRequestBody(shareToken))},
        }).then((r) => r.json())
      `,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || "Falha ao consultar o status da corrida");
    }
    return result.result?.value;
  };

  return { fetchStatus, close };
}

/** Prazo de cada comando mandado ao navegador (inclui a consulta à Uber feita de dentro da página). */
const CDP_COMMAND_TIMEOUT_MS = 15_000;

interface CdpConnection {
  ws: WebSocket;
  send(method: string, params?: Record<string, unknown>): Promise<any>;
}

async function connectCdp(port: number, proc: { exitCode: number | null }): Promise<CdpConnection> {
  let webSocketDebuggerUrl: string | null = null;
  // Até ~15 s: num computador ocupado o navegador demora mais que 5 s pra subir, e desistir cedo
  // fazia a corrida não ser acompanhada
  for (let i = 0; i < 150; i++) {
    if (proc.exitCode !== null) throw new Error("O navegador fechou antes de começar a acompanhar a corrida.");
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" });
      if (res.ok) {
        webSocketDebuggerUrl = ((await res.json()) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl;
        break;
      }
    } catch {}
    await Bun.sleep(100);
  }
  if (!webSocketDebuggerUrl) throw new Error("O navegador não respondeu a tempo (CDP).");

  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("Falha ao conectar no navegador via CDP")));
  });

  let seq = 0;
  const send = (method: string, params: Record<string, unknown> = {}): Promise<any> => {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      // Navegador fechado/travado nunca responde: sem prazo, a leitura ficava pendurada pra sempre
      // (nem contava como falha, então o acompanhamento nunca desistia nem avisava ninguém)
      if (ws.readyState !== WebSocket.OPEN) return reject(new Error("O navegador que acompanha a corrida foi fechado."));

      const cleanup = () => {
        clearTimeout(timer);
        ws.removeEventListener("message", onMessage);
        ws.removeEventListener("close", onClose);
      };
      const onMessage = (ev: MessageEvent) => {
        const data = JSON.parse(ev.data as string);
        if (data.id !== id) return;
        cleanup();
        if (data.error) reject(new Error(data.error.message || "Erro no CDP"));
        else resolve(data.result);
      };
      const onClose = () => {
        cleanup();
        reject(new Error("O navegador que acompanha a corrida foi fechado."));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`O navegador não respondeu a tempo (${method}).`));
      }, CDP_COMMAND_TIMEOUT_MS);

      ws.addEventListener("message", onMessage);
      ws.addEventListener("close", onClose);
      ws.send(JSON.stringify({ id, method, params }));
    });
  };

  return { ws, send };
}

function waitForLoadEvent(conn: CdpConnection): Promise<void> {
  return new Promise((resolve) => {
    const onMessage = (ev: MessageEvent) => {
      const data = JSON.parse(ev.data as string);
      if (data.method === "Page.loadEventFired") {
        conn.ws.removeEventListener("message", onMessage);
        resolve();
      }
    };
    conn.ws.addEventListener("message", onMessage);
  });
}

async function findFreePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port ?? 0;
  probe.stop(true);
  if (!port) throw new Error("Não conseguiu achar uma porta livre pro navegador.");
  return port;
}
