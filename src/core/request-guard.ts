/**
 * Proteção do painel local contra outros sites abertos no navegador.
 *
 * O painel só escuta em 127.0.0.1, mas qualquer página da internet aberta no
 * mesmo navegador consegue mandar requisições pra lá (por exemplo, um formulário
 * ou um `fetch` que pede um saque). Como agora o painel move dinheiro, duas
 * verificações barram isso:
 *
 * 1. `Host`: só aceita o próprio endereço do painel (barra "DNS rebinding", em que
 *    um site engana o navegador pra achar que 127.0.0.1 é o domínio dele).
 * 2. `Origin` / `Sec-Fetch-Site`: pedidos que alteram algo (POST/PUT/DELETE) só
 *    valem se vierem do próprio painel. Programas locais (curl, testes) não
 *    mandam esses cabeçalhos e continuam funcionando; navegadores sempre mandam.
 */
export function checkRequestOrigin(req: Request, port: number): Response | null {
  const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];

  const host = req.headers.get("host");
  if (host && !allowedHosts.includes(host.toLowerCase())) return forbidden("Endereço não permitido.");

  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD") return null;

  const origin = req.headers.get("origin");
  if (origin) {
    if (!allowedHosts.some((h) => origin.toLowerCase() === `http://${h}`)) {
      return forbidden("Origem não permitida: o painel só aceita pedidos feitos por ele mesmo.");
    }
    return null;
  }

  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") {
    return forbidden("Origem não permitida: o painel só aceita pedidos feitos por ele mesmo.");
  }

  return null;
}

function forbidden(error: string): Response {
  return Response.json({ error }, { status: 403 });
}
