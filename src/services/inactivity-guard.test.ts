import { beforeEach, describe, expect, test } from "bun:test";
import { InactivityGuard } from "./inactivity-guard";

const PHONE = "5511999990000@s.whatsapp.net";
const LID = "123456789@lid";
const OTHER = "5511888880000@s.whatsapp.net";
const TIMEOUT = 60;
const CORRELATION = 10_000; // bem maior que os testes precisam, exceto o de expiração da janela

const wait = (ms: number) => Bun.sleep(ms);

let enabled: boolean;
let botActive: boolean;
let correlationWindowMs: number;
let shutdowns: Array<{ chatJid: string; waitedMs: number }>;

function newGuard() {
  return new InactivityGuard({
    isEnabled: () => enabled,
    timeoutMs: () => TIMEOUT,
    isBotActive: () => botActive,
    shutdown: (info) => {
      botActive = false;
      shutdowns.push(info);
    },
    correlationWindowMs: () => correlationWindowMs,
  });
}

beforeEach(() => {
  enabled = true;
  botActive = true;
  correlationWindowMs = CORRELATION;
  shutdowns = [];
});

describe("só conta quem foi chamado num grupo há pouco", () => {
  test("mensagem no privado SEM ter sido chamada num grupo: não inicia contagem nenhuma", async () => {
    const guard = newGuard();
    guard.onClientMessage(PHONE, [PHONE]);
    expect(guard.pendingCount).toBe(0);

    await wait(TIMEOUT + 40);
    expect(shutdowns).toEqual([]);
  });

  test("chamada no grupo, depois mensagem no privado: aí sim conta", async () => {
    const guard = newGuard();
    guard.registerGroupCall([PHONE]);
    guard.onClientMessage(PHONE, [PHONE]);
    expect(guard.pendingCount).toBe(1);

    await wait(TIMEOUT + 40);
    expect(shutdowns.length).toBe(1);
    expect(shutdowns[0]!.chatJid).toBe(PHONE);
  });

  test("agradecimento depois de já ter sido atendida não reinicia a contagem", async () => {
    const guard = newGuard();
    guard.registerGroupCall([PHONE]);
    guard.onClientMessage(PHONE, [PHONE]); // "Oi, tem carro?"
    guard.onOperatorReply([PHONE]); // você atende
    expect(guard.pendingCount).toBe(0);

    guard.onClientMessage(PHONE, [PHONE]); // "Obrigado!" — sem ter sido chamada de novo no grupo
    expect(guard.pendingCount).toBe(0);

    await wait(TIMEOUT + 40);
    expect(shutdowns).toEqual([]);
  });

  test("uma chamada no grupo só serve pra UMA mensagem no privado (é consumida)", async () => {
    const guard = newGuard();
    guard.registerGroupCall([PHONE]);
    guard.onClientMessage(PHONE, [PHONE]);
    guard.onOperatorReply([PHONE]);
    expect(guard.pendingCount).toBe(0);

    // insiste de novo, ainda sem ter sido chamada outra vez no grupo
    guard.onClientMessage(PHONE, [PHONE]);
    expect(guard.pendingCount).toBe(0);
  });

  test("chamada de novo no grupo depois de já ter sido atendida: volta a contar", async () => {
    const guard = newGuard();
    guard.registerGroupCall([PHONE]);
    guard.onClientMessage(PHONE, [PHONE]);
    guard.onOperatorReply([PHONE]);
    expect(guard.pendingCount).toBe(0);

    guard.registerGroupCall([PHONE]); // chamou nela de novo no grupo
    guard.onClientMessage(PHONE, [PHONE]);
    expect(guard.pendingCount).toBe(1);

    await wait(TIMEOUT + 40);
    expect(shutdowns.length).toBe(1);
  });

  test("chamada no grupo pelo LID, mensagem no privado pelo telefone: ainda correlaciona", async () => {
    const guard = newGuard();
    guard.registerGroupCall([LID]);
    guard.onClientMessage(PHONE, [PHONE, LID]);
    expect(guard.pendingCount).toBe(1);
  });

  test("chamada no grupo de uma pessoa não impede (nem satisfaz) a de outra", async () => {
    const guard = newGuard();
    guard.registerGroupCall([PHONE]);
    guard.onClientMessage(OTHER, [OTHER]); // outra pessoa, nunca chamada
    expect(guard.pendingCount).toBe(0);

    guard.onClientMessage(PHONE, [PHONE]);
    expect(guard.pendingCount).toBe(1);
  });

  test("chamada no grupo há mais tempo que a janela de correlação: não conta mais", async () => {
    correlationWindowMs = 30;
    const guard = newGuard();
    guard.registerGroupCall([PHONE]);
    await wait(60);
    guard.onClientMessage(PHONE, [PHONE]);
    expect(guard.pendingCount).toBe(0);
  });

  test("registrar a chamada não é obrigatório vir antes da mensagem no mesmo instante: janela ampla ainda vale", async () => {
    const guard = newGuard();
    guard.registerGroupCall([PHONE]);
    await wait(30);
    guard.onClientMessage(PHONE, [PHONE]);
    expect(guard.pendingCount).toBe(1);
  });
});

describe("segurança: desligar o bot se ninguém responder no privado", () => {
  test("mensagem no privado sem resposta dentro do prazo desliga o bot", async () => {
    const guard = newGuard();
    guard.registerGroupCall([PHONE]);
    guard.onClientMessage(PHONE, [PHONE]);
    expect(shutdowns).toEqual([]);

    await wait(TIMEOUT + 40);
    expect(shutdowns.length).toBe(1);
    expect(shutdowns[0]!.chatJid).toBe(PHONE);
    expect(shutdowns[0]!.waitedMs).toBeGreaterThanOrEqual(TIMEOUT - 5);
    expect(botActive).toBe(false);
  });

  test("responder dentro do prazo cancela a contagem", async () => {
    const guard = newGuard();
    guard.registerGroupCall([PHONE]);
    guard.onClientMessage(PHONE, [PHONE]);
    await wait(TIMEOUT / 3);
    guard.onOperatorReply([PHONE]);

    await wait(TIMEOUT + 40);
    expect(shutdowns).toEqual([]);
    expect(botActive).toBe(true);
    expect(guard.pendingCount).toBe(0);
  });

  test("com a segurança desligada nada acontece", async () => {
    enabled = false;
    const guard = newGuard();
    guard.registerGroupCall([PHONE]);
    guard.onClientMessage(PHONE, [PHONE]);
    expect(guard.pendingCount).toBe(0);

    await wait(TIMEOUT + 40);
    expect(shutdowns).toEqual([]);
  });

  test("com o bot desligado nada acontece", async () => {
    botActive = false;
    const guard = newGuard();
    guard.registerGroupCall([PHONE]);
    guard.onClientMessage(PHONE, [PHONE]);
    expect(guard.pendingCount).toBe(0);

    await wait(TIMEOUT + 40);
    expect(shutdowns).toEqual([]);
  });

  test("com a segurança desligada, a mensagem nem consome a chamada do grupo", async () => {
    enabled = false;
    const guard = newGuard();
    guard.registerGroupCall([PHONE]);
    guard.onClientMessage(PHONE, [PHONE]); // ignorado (segurança desligada)

    enabled = true;
    guard.onClientMessage(PHONE, [PHONE]); // agora sim: a chamada do grupo ainda estava lá
    expect(guard.pendingCount).toBe(1);
  });

  test("desligar a segurança no meio da contagem cancela o desligamento", async () => {
    const guard = newGuard();
    guard.registerGroupCall([PHONE]);
    guard.onClientMessage(PHONE, [PHONE]);
    await wait(TIMEOUT / 3);
    enabled = false;

    await wait(TIMEOUT + 40);
    expect(shutdowns).toEqual([]);
    expect(botActive).toBe(true);
  });

  test("o bot desligado à mão no meio da contagem não dispara nada depois", async () => {
    const guard = newGuard();
    guard.registerGroupCall([PHONE]);
    guard.onClientMessage(PHONE, [PHONE]);
    botActive = false;
    guard.reset();

    await wait(TIMEOUT + 40);
    expect(shutdowns).toEqual([]);
  });

  test("o cliente insistindo não reinicia a contagem", async () => {
    const guard = newGuard();
    guard.registerGroupCall([PHONE]);
    guard.onClientMessage(PHONE, [PHONE]);
    await wait(TIMEOUT / 2);
    guard.onClientMessage(PHONE, [PHONE]);
    await wait(TIMEOUT / 2 + 40);

    expect(shutdowns.length).toBe(1);
  });

  test("responder a uma conversa não salva as outras", async () => {
    const guard = newGuard();
    guard.registerGroupCall([PHONE]);
    guard.registerGroupCall([OTHER]);
    guard.onClientMessage(PHONE, [PHONE]);
    guard.onClientMessage(OTHER, [OTHER]);
    guard.onOperatorReply([PHONE]);
    expect(guard.pendingCount).toBe(1);

    await wait(TIMEOUT + 40);
    expect(shutdowns.length).toBe(1);
    expect(shutdowns[0]!.chatJid).toBe(OTHER);
  });

  test("uma resposta sua em outra conversa não cancela esta", async () => {
    const guard = newGuard();
    guard.registerGroupCall([PHONE]);
    guard.onClientMessage(PHONE, [PHONE]);
    guard.onOperatorReply([OTHER]);

    await wait(TIMEOUT + 40);
    expect(shutdowns.length).toBe(1);
  });

  test("desliga uma vez só, mesmo com várias conversas esperando", async () => {
    const guard = newGuard();
    guard.registerGroupCall([PHONE]);
    guard.registerGroupCall([OTHER]);
    guard.onClientMessage(PHONE, [PHONE]);
    guard.onClientMessage(OTHER, [OTHER]);

    await wait(TIMEOUT + 60);
    expect(shutdowns.length).toBe(1);
    expect(guard.pendingCount).toBe(0);
  });

  test("depois de responder, uma NOVA CHAMADA no grupo e nova mensagem começam uma nova contagem", async () => {
    const guard = newGuard();
    guard.registerGroupCall([PHONE]);
    guard.onClientMessage(PHONE, [PHONE]);
    guard.onOperatorReply([PHONE]);
    guard.registerGroupCall([PHONE]);
    guard.onClientMessage(PHONE, [PHONE]);
    expect(guard.pendingCount).toBe(1);

    await wait(TIMEOUT + 40);
    expect(shutdowns.length).toBe(1);
  });
});

describe("identidade (telefone x LID)", () => {
  test("cliente chegou pelo LID e você respondeu pelo telefone", async () => {
    const guard = newGuard();
    guard.registerGroupCall([LID]);
    guard.onClientMessage(LID, [PHONE, LID]);
    guard.onOperatorReply([PHONE]);

    await wait(TIMEOUT + 40);
    expect(shutdowns).toEqual([]);
  });

  test("dispositivo no JID (:12) não atrapalha", async () => {
    const guard = newGuard();
    guard.registerGroupCall([PHONE]);
    guard.onClientMessage(PHONE, [PHONE]);
    guard.onOperatorReply(["5511999990000:12@s.whatsapp.net"]);

    await wait(TIMEOUT + 40);
    expect(shutdowns).toEqual([]);
  });
});

describe("mensagens antigas", () => {
  test("uma resposta sua ANTERIOR à mensagem do cliente (histórico) não conta", async () => {
    const guard = newGuard();
    const now = Date.now();
    guard.registerGroupCall([PHONE]);
    guard.onClientMessage(PHONE, [PHONE], now);
    guard.onOperatorReply([PHONE], now - 60 * 60_000);

    await wait(TIMEOUT + 40);
    expect(shutdowns.length).toBe(1);
  });

  test("uma resposta sua depois da mensagem do cliente conta", async () => {
    const guard = newGuard();
    const now = Date.now();
    guard.registerGroupCall([PHONE]);
    guard.onClientMessage(PHONE, [PHONE], now);
    guard.onOperatorReply([PHONE], now + 2_000);

    await wait(TIMEOUT + 40);
    expect(shutdowns).toEqual([]);
  });
});

describe("prazo exibido no painel", () => {
  test("informa quantas conversas esperam e quando o bot vai desligar", () => {
    const guard = newGuard();
    expect(guard.nextDeadline).toBeNull();
    expect(guard.pendingCount).toBe(0);

    const before = Date.now();
    guard.registerGroupCall([PHONE]);
    guard.onClientMessage(PHONE, [PHONE]);
    expect(guard.pendingCount).toBe(1);
    expect(guard.nextDeadline).toBeGreaterThanOrEqual(before + TIMEOUT);
    guard.reset();
    expect(guard.nextDeadline).toBeNull();
  });
});
