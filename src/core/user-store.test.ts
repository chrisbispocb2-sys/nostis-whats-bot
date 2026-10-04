import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { AuthError, FEATURE_KEYS, UserStore, featuresWith, hasFeatureAccess } from "./user-store";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "brinzy-users-"));
  file = join(dir, "users.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("começa vazio", () => {
  const store = new UserStore(file);
  expect(store.isEmpty()).toBe(true);
  expect(store.list()).toEqual([]);
});

test("cria um usuário e nunca devolve o hash da senha", () => {
  const store = new UserStore(file);
  store.create("Admin", "senha-forte-123", "admin");
  expect(store.isEmpty()).toBe(false);

  const [user] = store.list();
  expect(user!.username).toBe("admin"); // normalizado em minúsculas
  expect(user!.role).toBe("admin");
  expect((user as unknown as { passwordHash?: unknown }).passwordHash).toBeUndefined();
});

test("recusa nome de usuário duplicado (sem diferenciar maiúsculas)", () => {
  const store = new UserStore(file);
  store.create("joao", "senha-forte-123", "operator");
  expect(() => store.create("JOAO", "outrasenha123", "operator")).toThrow("já está em uso");
});

test("recusa senha curta", () => {
  const store = new UserStore(file);
  expect(() => store.create("joao", "123", "operator")).toThrow(/pelo menos/);
});

test("login certo funciona, login errado falha, usuário inexistente também falha (mesmo resultado: null)", () => {
  const store = new UserStore(file);
  const created = store.create("joao", "senha-forte-123", "operator");

  const ok = store.verifyCredentials("joao", "senha-forte-123");
  expect(ok?.id).toBe(created.id);

  expect(store.verifyCredentials("joao", "errada")).toBeNull();
  expect(store.verifyCredentials("ninguem", "senha-forte-123")).toBeNull();
});

test("depois de muitas senhas erradas, trava mesmo a senha certa", () => {
  const store = new UserStore(file);
  store.create("joao", "senha-forte-123", "operator");

  for (let i = 0; i < 5; i++) {
    expect(store.verifyCredentials("joao", "errada")).toBeNull();
  }
  // a conta está bloqueada agora: nem a senha certa entra
  expect(store.verifyCredentials("joao", "senha-forte-123")).toBeNull();
});

test("acertar antes do limite zera o contador de tentativas", () => {
  const store = new UserStore(file);
  store.create("joao", "senha-forte-123", "operator");

  for (let i = 0; i < 4; i++) store.verifyCredentials("joao", "errada");
  expect(store.verifyCredentials("joao", "senha-forte-123")).not.toBeNull();

  // o contador zerou: precisa de mais 5 erradas pra travar de novo
  for (let i = 0; i < 4; i++) store.verifyCredentials("joao", "errada");
  expect(store.verifyCredentials("joao", "senha-forte-123")).not.toBeNull();
});

test("usuário desativado não consegue mais logar, mesmo com a senha certa", () => {
  const store = new UserStore(file);
  const user = store.create("joao", "senha-forte-123", "operator");
  store.setDisabled(user.id, true);
  expect(store.verifyCredentials("joao", "senha-forte-123")).toBeNull();
});

test("não deixa desativar o último admin ativo", () => {
  const store = new UserStore(file);
  const admin = store.create("admin", "senha-forte-123", "admin");
  store.create("operador", "senha-forte-123", "operator");

  expect(() => store.setDisabled(admin.id, true)).toThrow(AuthError);
  expect(() => store.setDisabled(admin.id, true)).toThrow("último administrador");
});

test("com dois admins, dá para desativar um deles", () => {
  const store = new UserStore(file);
  const admin1 = store.create("admin1", "senha-forte-123", "admin");
  store.create("admin2", "senha-forte-123", "admin");

  expect(() => store.setDisabled(admin1.id, true)).not.toThrow();
});

test("usuário novo (convite) começa sem nenhuma funcionalidade liberada e sem vencimento", () => {
  const store = new UserStore(file);
  const user = store.create("operador", "senha-forte-123", "operator");
  expect(user.expiresAt).toBeNull();
  for (const key of FEATURE_KEYS) expect(user.features[key]).toBe(false);
});

test("create() aceita features iniciais (usado pelo bootstrap do primeiro admin)", () => {
  const store = new UserStore(file);
  const user = store.create("admin", "senha-forte-123", "admin", featuresWith(true));
  for (const key of FEATURE_KEYS) expect(user.features[key]).toBe(true);
});

test("hasFeatureAccess: admin sempre livre, mesmo vencido e sem nenhuma feature marcada", () => {
  const admin = { role: "admin" as const, expiresAt: Date.now() - 1000, features: featuresWith(false) };
  for (const key of FEATURE_KEYS) expect(hasFeatureAccess(admin, key)).toBe(true);
});

test("hasFeatureAccess: operador segue o interruptor de cada funcionalidade", () => {
  const user = { role: "operator" as const, expiresAt: null, features: { ...featuresWith(false), chat: true } };
  expect(hasFeatureAccess(user, "chat")).toBe(true);
  expect(hasFeatureAccess(user, "metrics")).toBe(false);
});

test("hasFeatureAccess: operador vencido perde tudo, mesmo com a feature marcada", () => {
  const user = { role: "operator" as const, expiresAt: Date.now() - 1000, features: featuresWith(true) };
  for (const key of FEATURE_KEYS) expect(hasFeatureAccess(user, key)).toBe(false);
});

test("setExpiresAt define e remove (null) o prazo de acesso", () => {
  const store = new UserStore(file);
  const user = store.create("operador", "senha-forte-123", "operator");
  const future = Date.now() + 1000;

  const updated = store.setExpiresAt(user.id, future);
  expect(updated.expiresAt).toBe(future);

  const cleared = store.setExpiresAt(user.id, null);
  expect(cleared.expiresAt).toBeNull();
});

test("extendExpiry soma a partir de agora quando não tinha prazo (ou já tinha vencido)", () => {
  const store = new UserStore(file);
  const user = store.create("operador", "senha-forte-123", "operator");

  const before = Date.now();
  const updated = store.extendExpiry(user.id, 30);
  expect(updated.expiresAt).toBeGreaterThanOrEqual(before + 30 * 24 * 60 * 60 * 1000);
});

test("extendExpiry soma a partir do prazo atual quando ele ainda não venceu (não desperdiça dias)", () => {
  const store = new UserStore(file);
  const user = store.create("operador", "senha-forte-123", "operator");
  const currentExpiry = Date.now() + 10 * 24 * 60 * 60 * 1000; // 10 dias restantes
  store.setExpiresAt(user.id, currentExpiry);

  const updated = store.extendExpiry(user.id, 30);
  expect(updated.expiresAt).toBe(currentExpiry + 30 * 24 * 60 * 60 * 1000);
});

test("setFeatures mescla: só altera o que foi passado, o resto continua igual", () => {
  const store = new UserStore(file);
  const user = store.create("operador", "senha-forte-123", "operator", featuresWith(false));

  const updated = store.setFeatures(user.id, { chat: true });
  expect(updated.features.chat).toBe(true);
  expect(updated.features.metrics).toBe(false);

  const updated2 = store.setFeatures(user.id, { metrics: true });
  expect(updated2.features.chat).toBe(true); // continua ligado
  expect(updated2.features.metrics).toBe(true);
});
