import { describe, expect, test } from "bun:test";
import { checkRequestOrigin } from "./request-guard";

const PORT = 3000;

function req(method: string, headers: Record<string, string> = {}) {
  return new Request(`http://127.0.0.1:${PORT}/accounts/default/mistic/withdraw`, { method, headers });
}

const blocked = (r: Response | null) => r?.status === 403;

describe("proteção do painel contra outros sites", () => {
  test("o próprio painel funciona (mesmo endereço, com e sem Origin)", () => {
    expect(checkRequestOrigin(req("POST", { host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}` }), PORT)).toBeNull();
    expect(checkRequestOrigin(req("POST", { host: `localhost:${PORT}`, origin: `http://localhost:${PORT}` }), PORT)).toBeNull();
    expect(checkRequestOrigin(req("POST", { host: `[::1]:${PORT}`, origin: `http://[::1]:${PORT}` }), PORT)).toBeNull();
    expect(checkRequestOrigin(req("PUT", { host: `127.0.0.1:${PORT}`, "sec-fetch-site": "same-origin" }), PORT)).toBeNull();
  });

  test("um site qualquer não consegue fazer POST/PUT/DELETE (nem 'sem CORS')", () => {
    for (const method of ["POST", "PUT", "DELETE"]) {
      expect(blocked(checkRequestOrigin(req(method, { host: `127.0.0.1:${PORT}`, origin: "https://site-malicioso.com" }), PORT))).toBe(true);
    }
    // Origin "null" (formulário de página sandbox/arquivo local)
    expect(blocked(checkRequestOrigin(req("POST", { host: `127.0.0.1:${PORT}`, origin: "null" }), PORT))).toBe(true);
    // outra porta do mesmo computador também é outro site
    expect(blocked(checkRequestOrigin(req("POST", { host: `127.0.0.1:${PORT}`, origin: "http://127.0.0.1:8080" }), PORT))).toBe(true);
    expect(blocked(checkRequestOrigin(req("POST", { host: `127.0.0.1:${PORT}`, origin: `https://127.0.0.1:${PORT}` }), PORT))).toBe(true);
  });

  test("sem Origin, o Sec-Fetch-Site do navegador decide", () => {
    expect(blocked(checkRequestOrigin(req("POST", { host: `127.0.0.1:${PORT}`, "sec-fetch-site": "cross-site" }), PORT))).toBe(true);
    expect(blocked(checkRequestOrigin(req("POST", { host: `127.0.0.1:${PORT}`, "sec-fetch-site": "same-site" }), PORT))).toBe(true);
    expect(checkRequestOrigin(req("POST", { host: `127.0.0.1:${PORT}`, "sec-fetch-site": "none" }), PORT)).toBeNull();
  });

  test("programas locais (sem cabeçalhos de navegador) continuam funcionando", () => {
    expect(checkRequestOrigin(req("POST", { host: `127.0.0.1:${PORT}` }), PORT)).toBeNull();
    expect(checkRequestOrigin(req("POST"), PORT)).toBeNull();
  });

  test("DNS rebinding: um domínio apontando pra 127.0.0.1 não passa nem em GET", () => {
    expect(blocked(checkRequestOrigin(req("GET", { host: "evil.example.com" }), PORT))).toBe(true);
    expect(blocked(checkRequestOrigin(req("GET", { host: `evil.example.com:${PORT}` }), PORT))).toBe(true);
    expect(blocked(checkRequestOrigin(req("POST", { host: "evil.example.com", origin: "http://evil.example.com" }), PORT))).toBe(true);
  });

  test("leituras normais do painel passam", () => {
    expect(checkRequestOrigin(req("GET", { host: `127.0.0.1:${PORT}` }), PORT)).toBeNull();
    expect(checkRequestOrigin(req("GET", { host: `localhost:${PORT}`, "sec-fetch-site": "same-origin" }), PORT)).toBeNull();
  });

  test("a resposta de bloqueio é um JSON com a explicação", async () => {
    const res = checkRequestOrigin(req("POST", { host: `127.0.0.1:${PORT}`, origin: "https://x.com" }), PORT)!;
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toContain("Origem não permitida");
  });
});
