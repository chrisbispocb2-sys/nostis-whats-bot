import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { applyFeatureGate } from "./feature-guard";
import { AuthService } from "./auth-service";
import { UserStore, type FeatureKey } from "./user-store";
import { InviteStore } from "./invite-store";
import { SessionStore } from "./session-store";
import { KeyStore } from "./key-store";

const PORT = 3000;
let dir: string;
let auth: AuthService;
let adminCookie: string;
let operatorCookie: string;
let adminReq: Request;
let operatorId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "brinzy-feature-guard-"));
  auth = new AuthService(
    new UserStore(join(dir, "users.json")),
    new InviteStore(join(dir, "invites.json")),
    new SessionStore(join(dir, "sessions.json")),
    new KeyStore(join(dir, "keys.json"))
  );
  const { user: admin, cookie: adminRaw } = auth.bootstrap("admin", "senha-forte-123");
  const invite = auth.createInvite(admin.id, "operator");
  const { user: operator, cookie: operatorRaw } = auth.registerViaInvite(invite.id, "operador", "senha-forte-123");
  adminCookie = `brinzy_session=${Bun.Cookie.parse(adminRaw).value}`;
  operatorCookie = `brinzy_session=${Bun.Cookie.parse(operatorRaw).value}`;
  operatorId = operator.id;
  adminReq = req("GET", "/", { cookie: adminCookie });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function req(method: string, path: string, { cookie, body }: { cookie?: string; body?: unknown } = {}): Request {
  const url = `http://127.0.0.1:${PORT}${path}`;
  const headers: Record<string, string> = {};
  if (cookie) headers["cookie"] = cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  return new Request(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
}

async function gate(method: string, path: string, cookie?: string) {
  const request = req(method, path, { cookie });
  return applyFeatureGate(request, new URL(request.url), auth);
}

/** `setUserAccess` exige a sessão de admin como `Request` de verdade, não só o cookie. */
function setOperatorAccess(input: Parameters<AuthService["setUserAccess"]>[2]) {
  auth.setUserAccess(adminReq, operatorId, input);
}

test("admin nunca é bloqueado, em nenhuma das rotas restritas", async () => {
  for (const path of ["/accounts/default/on", "/accounts/default/rules", "/accounts/default/campaigns", "/accounts/default/leads", "/accounts/default/chats", "/accounts/default/mistic/config"]) {
    const result = await gate("GET", path, adminCookie);
    expect(result).not.toBeInstanceOf(Response);
  }
});

test("sem sessão de cookie (caminho do pay-token), não mexe em nada", async () => {
  const result = await gate("GET", "/accounts/default/mistic/config");
  expect(result).not.toBeInstanceOf(Response);
});

const FEATURE_PROBES: Array<{ feature: FeatureKey; method: string; path: string }> = [
  { feature: "groupBot", method: "POST", path: "/accounts/default/on" },
  { feature: "groupBot", method: "GET", path: "/accounts/default/rules" },
  { feature: "groupBot", method: "POST", path: "/accounts/default/groups/toggle" },
  { feature: "campaigns", method: "GET", path: "/accounts/default/campaigns" },
  { feature: "metrics", method: "GET", path: "/accounts/default/leads" },
  { feature: "metrics", method: "GET", path: "/accounts/default/callers" },
  { feature: "chat", method: "GET", path: "/accounts/default/chats" },
  { feature: "chat", method: "GET", path: "/accounts/default/folders" },
  { feature: "misticPay", method: "GET", path: "/accounts/default/mistic/config" },
  { feature: "misticPay", method: "GET", path: "/accounts/default/conversations" },
];

for (const probe of FEATURE_PROBES) {
  test(`${probe.feature}: operador sem a feature é bloqueado em ${probe.method} ${probe.path}`, async () => {
    const result = await gate(probe.method, probe.path, operatorCookie);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(403);
  });

  test(`${probe.feature}: operador COM a feature passa em ${probe.method} ${probe.path}`, async () => {
    setOperatorAccess({ features: { [probe.feature]: true } as Partial<Record<FeatureKey, boolean>> });
    const result = await gate(probe.method, probe.path, operatorCookie);
    expect(result).not.toBeInstanceOf(Response);
  });
}

test("GET /groups nunca é bloqueado por groupBot (campanhas e a barra lateral também precisam dele)", async () => {
  const result = await gate("GET", "/accounts/default/groups", operatorCookie);
  expect(result).not.toBeInstanceOf(Response);
});

test("informações de grupo usadas pelo Chat (metadata/participantes/convite/foto) não dependem de groupBot", async () => {
  for (const path of [
    "/accounts/default/groups/metadata/123",
    "/accounts/default/groups/xyz/participants/abc",
    "/accounts/default/groups/xyz/invite",
    "/accounts/default/groups/picture/xyz",
  ]) {
    const result = await gate("GET", path, operatorCookie);
    expect(result).not.toBeInstanceOf(Response);
  }
});

test("POST /accounts (conectar outro WhatsApp) exige multiAccount", async () => {
  const blocked = await gate("POST", "/accounts", operatorCookie);
  expect(blocked).toBeInstanceOf(Response);
  expect((blocked as Response).status).toBe(403);

  setOperatorAccess({ features: { multiAccount: true } });
  const allowed = await gate("POST", "/accounts", operatorCookie);
  expect(allowed).not.toBeInstanceOf(Response);
});

test("PUT /settings sem rideAssistant: tira só os campos da corrida, o resto do corpo passa intacto", async () => {
  const request = req("PUT", "/accounts/default/settings", {
    cookie: operatorCookie,
    body: { ignoreAdminNames: true, rideAssistantEnabled: true, rideChargeMessage: "oi" },
  });
  const result = await applyFeatureGate(request, new URL(request.url), auth);
  expect(result).toBeInstanceOf(Request);

  const body = (await (result as Request).json()) as Record<string, unknown>;
  expect(body["ignoreAdminNames"]).toBe(true);
  expect(body["rideAssistantEnabled"]).toBeUndefined();
  expect(body["rideChargeMessage"]).toBeUndefined();
});

test("PUT /settings COM rideAssistant: nada é removido do corpo", async () => {
  setOperatorAccess({ features: { rideAssistant: true } });
  const request = req("PUT", "/accounts/default/settings", {
    cookie: operatorCookie,
    body: { rideAssistantEnabled: true, rideChargeMessage: "oi" },
  });
  const result = await applyFeatureGate(request, new URL(request.url), auth);
  expect(result).toBeInstanceOf(Request);

  const body = (await (result as Request).json()) as Record<string, unknown>;
  expect(body["rideAssistantEnabled"]).toBe(true);
  expect(body["rideChargeMessage"]).toBe("oi");
});

test("operador vencido é bloqueado mesmo com a feature marcada", async () => {
  setOperatorAccess({ features: { chat: true }, expiresAt: Date.now() - 1000 });
  const result = await gate("GET", "/accounts/default/chats", operatorCookie);
  expect(result).toBeInstanceOf(Response);
  expect((result as Response).status).toBe(403);
});
