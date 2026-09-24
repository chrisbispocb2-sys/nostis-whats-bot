import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ChargeStore, newRecord } from "./charge-store";
import { ConversationTracker } from "./conversation-tracker";
import { MisticStore } from "./mistic-store";
import { Overlay, spawnOptions, type SpawnedProcess } from "./overlay";
import { computeOverlayState, type OverlayAccount } from "./overlay-state";
import { buildFallbackCommand, buildPayWindowCommand, findBrowser, payWindowUrl } from "./pay-window";
import { handleApiRequest } from "../routes";
import { AccountManager } from "./account-manager";
import { fakeConnections } from "../testing/fakes";

const NOW = 1_800_000_000_000;
const MIN = 60_000;

let dir: string;
let n = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "brinzy-overlay-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Uma "conta" mínima com MisticPay pronta (ligada, com credenciais) e o que o teste quiser mudar. */
function account(name: string, config: Parameters<MisticStore["update"]>[0] = {}): OverlayAccount & {
  tracker: ConversationTracker;
  chargeStore: ChargeStore;
  store: MisticStore;
} {
  const id = `acc${++n}`;
  const store = new MisticStore(join(dir, `${id}-mistic.json`));
  store.update({ enabled: true, clientId: "ci", clientSecret: "cs", ...config });
  const tracker = new ConversationTracker();
  const chargeStore = new ChargeStore(join(dir, `${id}-charges.json`));
  return { id, name, misticSettings: store, conversations: tracker, charges: chargeStore, tracker, chargeStore, store };
}

function talk(a: ReturnType<typeof account>, name: string | null, phone: string, minutesAgo: number) {
  a.tracker.touch({ chatJid: `${phone}@s.whatsapp.net`, jids: [], phone, name, from: "client", at: NOW - minutesAgo * MIN });
}

describe("estado do botão solto na tela", () => {
  test("some quando não há conversa ativa (padrão) e aparece com uma conversa recente", () => {
    const a = account("WhatsApp 1");
    expect(computeOverlayState([a], NOW).visible).toBe(false);

    talk(a, "Maria Silva", "5511977770000", 2);
    const state = computeOverlayState([a], NOW);
    expect(state).toMatchObject({ visible: true, label: "Cobrar Maria", accountId: a.id, accountName: "WhatsApp 1", pending: 0 });
    expect(state.tooltip).toContain("Maria Silva · +55 (11) 97777-0000");
  });

  test("conversa fora do prazo não conta (e o prazo é configurável)", () => {
    const a = account("WhatsApp 1");
    talk(a, "Maria", "5511977770000", 45);
    expect(computeOverlayState([a], NOW).visible).toBe(false); // padrão: 30 min

    a.store.update({ activeWindowMinutes: 60 });
    expect(computeOverlayState([a], NOW).visible).toBe(true);
  });

  test("sem nome, usa o telefone", () => {
    const a = account("WhatsApp 1");
    talk(a, null, "5511977770000", 1);
    expect(computeOverlayState([a], NOW).label).toBe("Cobrar +55 (11) 97777-0000");
  });

  test("modo 'sempre visível' mostra o botão até sem conversa", () => {
    const a = account("WhatsApp 1", { floatMode: "always" });
    expect(computeOverlayState([a], NOW)).toMatchObject({ visible: true, label: "MisticPay", accountId: a.id });
  });

  test("não aparece com a integração desligada, sem credenciais ou configurada pra ficar no painel", () => {
    const off = account("A", { enabled: false });
    talk(off, "Maria", "5511977770000", 1);
    const noCreds = account("B");
    noCreds.store.update({ clientSecret: null });
    talk(noCreds, "Maria", "5511977770001", 1);
    const inPanel = account("C", { floatWhere: "panel" });
    talk(inPanel, "Maria", "5511977770002", 1);

    expect(computeOverlayState([off, noCreds, inPanel], NOW).visible).toBe(false);
  });

  test("com várias contas, vale a que tem a conversa mais recente (e o nome da conta aparece)", () => {
    const a = account("Loja");
    const b = account("Suporte");
    talk(a, "Maria", "5511977770000", 10);
    talk(b, "João", "5511966660000", 3);

    const state = computeOverlayState([a, b], NOW);
    expect(state).toMatchObject({ label: "Cobrar João", accountId: b.id });
    expect(state.tooltip).toContain("(Suporte)");
  });

  test("mostra quantas cobranças estão aguardando pagamento", () => {
    const a = account("WhatsApp 1");
    talk(a, "Maria", "5511977770000", 1);
    a.chargeStore.add(newRecord({ id: "c1", kind: "charge", amountCents: 100, description: "" }));
    a.chargeStore.add(newRecord({ id: "c2", kind: "charge", amountCents: 100, description: "" }));
    a.chargeStore.add({ ...newRecord({ id: "c3", kind: "charge", amountCents: 100, description: "" }), status: "paid" });
    a.chargeStore.add(newRecord({ id: "w1", kind: "withdraw", amountCents: 100, description: "" }));

    const state = computeOverlayState([a], NOW);
    expect(state.pending).toBe(2);
    expect(state.tooltip).toContain("2 cobrança(s) aguardando pagamento");
  });
});

describe("janela de pagamento", () => {
  test("procura o Chrome, depois o Edge e por fim o Brave", () => {
    const env = { ProgramFiles: "C:\\PF", "ProgramFiles(x86)": "C:\\PF86", LOCALAPPDATA: "C:\\Local" };
    const chrome = "C:\\PF\\Google\\Chrome\\Application\\chrome.exe";
    const edge = "C:\\PF86\\Microsoft\\Edge\\Application\\msedge.exe";
    const brave = "C:\\PF\\BraveSoftware\\Brave-Browser\\Application\\brave.exe";

    expect(findBrowser((p) => p === chrome, env)).toBe(chrome);
    expect(findBrowser((p) => p === edge, env)).toBe(edge);
    expect(findBrowser((p) => p === brave, env)).toBe(brave);
    expect(findBrowser((p) => p === chrome || p === edge || p === brave, env)).toBe(chrome);
    expect(findBrowser((p) => p === edge || p === brave, env)).toBe(edge);
    expect(findBrowser(() => false, env)).toBeNull();
  });

  test("abre só o modal, com perfil próprio, no tamanho e no lugar pedidos", () => {
    const url = payWindowUrl(3000, "acc 1");
    expect(url).toBe("http://127.0.0.1:3000/?pay=1&account=acc%201");

    const cmd = buildPayWindowCommand("chrome.exe", url, "C:\\tmp\\perfil", { x: 1200.4, y: 80, width: 500, height: 780 });
    expect(cmd[0]).toBe("chrome.exe");
    expect(cmd).toContain(`--app=${url}`);
    expect(cmd).toContain("--user-data-dir=C:\\tmp\\perfil");
    expect(cmd).toContain("--window-size=500,780");
    expect(cmd).toContain("--window-position=1200,80");
    expect(cmd).toContain("--no-first-run");
    // perfil só pra esta janela: nada de sincronização/extensões/atualizações em segundo plano
    expect(cmd).toContain("--disable-sync");
    expect(cmd).toContain("--disable-background-networking");
  });

  test("sem posição só não manda a posição; tamanho padrão", () => {
    const cmd = buildPayWindowCommand("chrome.exe", "http://x", "p");
    expect(cmd.some((a) => a.startsWith("--window-position"))).toBe(false);
    expect(cmd).toContain("--window-size=500,780");
  });

  test("sem Chrome nem Edge, abre no navegador padrão", () => {
    expect(buildFallbackCommand("http://x")).toEqual(["cmd", "/c", "start", "", "http://x"]);
  });
});

/** Processo filho de mentira que o teste controla. */
class FakeProc implements SpawnedProcess {
  hide: boolean | undefined;
  killed = false;
  private finish!: (code: number) => void;
  exited = new Promise<number>((resolve) => (this.finish = resolve));
  constructor(readonly pid: number, readonly command: string[]) {}
  kill() {
    this.killed = true;
    this.finish(1);
  }
  exit(code: number) {
    this.finish(code);
  }
}

function setup(accountsList: OverlayAccount[], options: { platform?: string; browser?: string | null; restartDelayMs?: number } = {}) {
  const spawned: FakeProc[] = [];
  const overlay = new Overlay({
    accounts: () => accountsList,
    port: 3000,
    dataDir: join(dir, "data"),
    tempDir: join(dir, "temp"),
    platform: options.platform ?? "win32",
    spawn: (command, { hide }) => {
      const proc = new FakeProc(1000 + spawned.length, command);
      proc.hide = hide;
      spawned.push(proc);
      return proc;
    },
    findBrowser: () => (options.browser === undefined ? "C:\\chrome.exe" : options.browser),
    script: "# script de teste",
    restartDelayMs: options.restartDelayMs ?? 5,
  });
  return { overlay, spawned };
}

const tick = (ms = 20) => Bun.sleep(ms);

describe("como o processo é iniciado", () => {
  // Regressão: com um canal "inherit" o filho divide o console do bot em vez de ganhar um próprio e invisível
  test("escondido: nenhum canal é herdado (senão o filho divide e esconde o seu console)", () => {
    const opts = spawnOptions(true);
    expect(opts.windowsHide).toBe(true);
    for (const channel of [opts.stdin, opts.stdout, opts.stderr]) expect(channel).not.toBe("inherit");
    expect(opts.stderr).toBe("pipe"); // as mensagens do botão vão pro log, não pro seu console
  });

  test("o navegador (com janela própria) não é iniciado como escondido", () => {
    const opts = spawnOptions(false);
    expect(opts.windowsHide).toBe(false);
    for (const channel of [opts.stdin, opts.stdout, opts.stderr]) expect(channel).not.toBe("inherit");
  });
});

describe("processo do botão", () => {
  test("fora do Windows não existe (o painel mostra o botão dentro da página)", () => {
    const { overlay, spawned } = setup([account("A")], { platform: "linux" });
    overlay.sync();
    expect(spawned).toEqual([]);
    expect(overlay.status()).toEqual({ supported: false, running: false });
  });

  test("inicia quando há conta com a MisticPay pronta e passa os argumentos certos", () => {
    const a = account("A");
    const { overlay, spawned } = setup([a]);
    overlay.sync();

    expect(spawned.length).toBe(1);
    const cmd = spawned[0]!.command;
    expect(cmd[0]).toBe("powershell.exe");
    expect(spawned[0]!.hide).toBe(true); // o console do PowerShell não aparece
    expect(cmd).toContain("-STA");
    expect(cmd).toContain("Bypass");
    expect(cmd[cmd.indexOf("-Port") + 1]).toBe("3000");
    expect(cmd[cmd.indexOf("-ParentPid") + 1]).toBe(String(process.pid));
    expect(cmd[cmd.indexOf("-PosFile") + 1]).toBe(join(dir, "data", "overlay-position.json"));
    expect(overlay.status()).toEqual({ supported: true, running: true });

    // "-WindowStyle Hidden" esconde o console onde o bot roda quando ele é compartilhado com o filho (o PowerShell do usuário sumia)
    expect(cmd.map((a) => a.toLowerCase())).not.toContain("-windowstyle");

    // o script vai pro disco com BOM (PowerShell 5.1 só entende UTF-8 assim)
    const written = readFileSync(cmd[cmd.indexOf("-File") + 1]!, "utf-8");
    expect(written.startsWith("\uFEFF# script de teste")).toBe(true);
  });

  test("chamar sync várias vezes não abre vários botões", () => {
    const { overlay, spawned } = setup([account("A")]);
    overlay.sync();
    overlay.sync();
    overlay.sync();
    expect(spawned.length).toBe(1);
  });

  test("não inicia sem ninguém que queira o botão solto na tela", () => {
    const { overlay, spawned } = setup([account("A", { enabled: false }), account("B", { floatWhere: "panel" })]);
    overlay.sync();
    expect(spawned).toEqual([]);
    expect(overlay.status().running).toBe(false);
  });

  test("encerra quando a configuração deixa de pedir o botão", () => {
    const a = account("A");
    const { overlay, spawned } = setup([a]);
    overlay.sync();
    a.store.update({ floatWhere: "panel" });
    overlay.sync();
    expect(spawned[0]!.killed).toBe(true);
  });

  test("se o botão parar sozinho, volta depois de um instante", async () => {
    const { overlay, spawned } = setup([account("A")]);
    overlay.sync();
    spawned[0]!.exit(0);
    await tick(60);
    expect(spawned.length).toBe(2);
    expect(overlay.status().running).toBe(true);
  });

  test("se falhar logo ao iniciar várias vezes, desiste (o painel assume o botão)", async () => {
    const { overlay, spawned } = setup([account("A")]);
    overlay.sync();
    for (let i = 0; i < 6; i++) {
      spawned.at(-1)!.exit(1);
      await tick(30);
    }
    expect(spawned.length).toBe(3);
    expect(overlay.status().running).toBe(false);
  });

  test("stop() encerra tudo e não reinicia", async () => {
    const { overlay, spawned } = setup([account("A")]);
    overlay.sync();
    overlay.openPayWindow("acc" + n, {});
    overlay.stop();
    await tick(40);

    expect(spawned[0]!.killed).toBe(true); // botão
    expect(spawned[1]!.killed).toBe(true); // janela de pagamento
    expect(spawned.length).toBe(2);
    overlay.sync();
    expect(spawned.length).toBe(2);
  });

  test("abre a janela de pagamento da conta certa, ao lado do botão", () => {
    const a = account("A");
    const { overlay, spawned } = setup([a]);
    const result = overlay.openPayWindow(a.id, { x: 1400, y: 200, width: 500, height: 780 });

    expect(result.browser).toBe("C:\\chrome.exe");
    // o navegador NÃO pode ser iniciado "escondido": o Windows esconderia a janela dele
    expect(spawned[0]!.hide).toBe(false);
    const cmd = spawned[0]!.command;
    expect(cmd).toContain(`--app=http://127.0.0.1:3000/?pay=1&account=${a.id}`);
    expect(cmd).toContain("--window-position=1400,200");
  });

  test("sem Chrome/Edge cai no navegador padrão; conta desconhecida é recusada", () => {
    const a = account("A");
    const { overlay, spawned } = setup([a], { browser: null });
    overlay.openPayWindow(a.id);
    expect(spawned[0]!.command.slice(0, 3)).toEqual(["cmd", "/c", "start"]);
    expect(spawned[0]!.hide).toBe(true);
    expect(() => overlay.openPayWindow("nao-existe")).toThrow("Conta não encontrada");
  });
});

describe("rotas do botão", () => {
  test("estado, situação e abertura da janela pela API", async () => {
    const manager = new AccountManager({ appDataDir: join(dir, "appdata"), tempDir: join(dir, "t"), createConnection: fakeConnections().factory });
    const acc = manager.get("default")!;
    acc.misticSettings.update({ enabled: true, clientId: "ci", clientSecret: "cs" });
    acc.conversations.touch({ chatJid: "5511977770000@s.whatsapp.net", jids: [], phone: "5511977770000", name: "Maria Silva", from: "client" });

    const spawned: FakeProc[] = [];
    const overlay = new Overlay({
      accounts: () => manager.list(),
      port: 3000,
      dataDir: join(dir, "data"),
      tempDir: join(dir, "temp"),
      platform: "win32",
      spawn: (command, { hide }) => {
        const p = new FakeProc(500 + spawned.length, command);
        p.hide = hide;
        spawned.push(p);
        return p;
      },
      findBrowser: () => "C:\\chrome.exe",
      script: "#",
    });

    async function call(method: string, path: string, body?: unknown) {
      const url = new URL(`http://127.0.0.1:3000${path}`);
      const res = await handleApiRequest(new Request(url.href, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }), url, manager, overlay);
      return { status: res?.status ?? 0, json: res ? await res.json() : null } as { status: number; json: any };
    }

    expect((await call("GET", "/overlay/status")).json).toEqual({ supported: true, running: false });
    const state = (await call("GET", "/overlay/state")).json;
    expect(state).toMatchObject({ visible: true, label: "Cobrar Maria", accountId: "default" });

    const open = await call("POST", "/overlay/open", { accountId: "default", x: 1300, y: 90, width: 500, height: 780 });
    expect(open.status).toBe(200);
    expect(spawned[0]!.command).toContain("--window-position=1300,90");

    expect((await call("POST", "/overlay/open", {})).status).toBe(400);
    expect((await call("POST", "/overlay/open", { accountId: "nada" })).status).toBe(404);
    // valores que não são número são ignorados em vez de virar flags estranhas
    await call("POST", "/overlay/open", { accountId: "default", x: "1300; calc.exe", y: 5 });
    expect(spawned[1]!.command.some((a) => a.startsWith("--window-position"))).toBe(false);

    manager.stopAll();
  });
});
