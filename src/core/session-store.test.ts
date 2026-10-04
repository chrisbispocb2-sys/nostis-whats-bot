import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { SessionStore } from "./session-store";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "brinzy-sessions-"));
  file = join(dir, "sessions.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("cria uma sessão e acha ela de volta pelo token bruto", () => {
  const store = new SessionStore(file);
  const { session, rawToken } = store.create("user-1");
  expect(session.userId).toBe("user-1");

  const found = store.findByToken(rawToken);
  expect(found?.id).toBe(session.id);
});

test("o token bruto nunca fica salvo em disco (só o hash)", () => {
  const store = new SessionStore(file);
  const { rawToken } = store.create("user-1");
  const onDisk = readFileSync(file, "utf-8");
  expect(onDisk).not.toContain(rawToken);
});

test("token desconhecido não acha nada", () => {
  const store = new SessionStore(file);
  expect(store.findByToken("nao-existe")).toBeNull();
});

test("deleteByToken remove a sessão (logout)", () => {
  const store = new SessionStore(file);
  const { rawToken } = store.create("user-1");
  store.deleteByToken(rawToken);
  expect(store.findByToken(rawToken)).toBeNull();
});

test("deleteAllForUser derruba todas as sessões daquele usuário, sem afetar as de outro", () => {
  const store = new SessionStore(file);
  const a1 = store.create("user-1");
  const a2 = store.create("user-1");
  const b1 = store.create("user-2");

  store.deleteAllForUser("user-1");

  expect(store.findByToken(a1.rawToken)).toBeNull();
  expect(store.findByToken(a2.rawToken)).toBeNull();
  expect(store.findByToken(b1.rawToken)).not.toBeNull();
});

test("hasActive: nada até criar uma sessão; nada depois de expirar", () => {
  const store = new SessionStore(file);
  expect(store.hasActive()).toBe(false);

  const { session } = store.create("user-1");
  expect(store.hasActive()).toBe(true);

  session.expiresAt = Date.now() - 1000;
  expect(store.hasActive()).toBe(false);
});

test("sessão expirada não é encontrada (mesmo token certo)", () => {
  const store = new SessionStore(file);
  const { session, rawToken } = store.create("user-1");
  session.expiresAt = Date.now() - 1000;
  expect(store.findByToken(rawToken)).toBeNull();
});

test("onlineUserIds: só entra quem foi visto recentemente (touch) e ainda não expirou", () => {
  const store = new SessionStore(file);
  const { rawToken: tokenA } = store.create("user-1");
  store.create("user-2"); // nunca tocado: lastSeenAt fica no momento da criação

  store.touch(tokenA);
  expect(store.onlineUserIds().has("user-1")).toBe(true);

  const { session: sessionA } = { session: store.findByToken(tokenA)! };
  sessionA.lastSeenAt = Date.now() - 10 * 60_000; // visto há 10 minutos: não conta mais como online
  expect(store.onlineUserIds().has("user-1")).toBe(false);
});

test("touch de um token que não existe não quebra nada", () => {
  const store = new SessionStore(file);
  expect(() => store.touch("token-invalido")).not.toThrow();
});
