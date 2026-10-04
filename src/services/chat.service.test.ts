import { describe, expect, test } from "bun:test";
import { downloadWithHostFallback } from "./chat.service";

/** O erro que o `fetch` devolve quando o nome do servidor não existe no DNS (igual ao do log real). */
function unknownHostError(): Error {
  return Object.assign(new TypeError("getaddrinfo ENOTFOUND a.whatsapp.net"), { code: "ENOTFOUND", syscall: "getaddrinfo", hostname: "a.whatsapp.net" });
}

describe("downloadWithHostFallback", () => {
  test("servidor indicado pela mensagem funciona: baixa por ele, sem tentar outro", async () => {
    const hosts: Array<string | undefined> = [];
    const buffer = await downloadWithHostFallback(async (host) => {
      hosts.push(host);
      return Buffer.from("midia");
    });

    expect(buffer.toString()).toBe("midia");
    expect(hosts).toEqual([undefined]);
  });

  test("servidor da mensagem não existe no DNS (a.whatsapp.net): baixa pelo servidor padrão", async () => {
    const hosts: Array<string | undefined> = [];
    const buffer = await downloadWithHostFallback(async (host) => {
      hosts.push(host);
      if (!host) throw unknownHostError();
      return Buffer.from("midia");
    });

    expect(buffer.toString()).toBe("midia");
    expect(hosts).toEqual([undefined, "mmg.whatsapp.net"]);
  });

  test("outro tipo de falha (link expirado, sem internet) não troca de servidor: o erro segue como veio", async () => {
    let calls = 0;
    const expired = Object.assign(new Error("Gone"), { status: 410 });
    await expect(
      downloadWithHostFallback(async () => {
        calls++;
        throw expired;
      })
    ).rejects.toBe(expired);
    expect(calls).toBe(1);
  });

  test("nem o servidor padrão responde: devolve o erro dessa segunda tentativa", async () => {
    await expect(
      downloadWithHostFallback(async (host) => {
        throw host ? new Error("falha no servidor padrão") : unknownHostError();
      })
    ).rejects.toThrow("falha no servidor padrão");
  });
});
