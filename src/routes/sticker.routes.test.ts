import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AccountManager } from "../core/account-manager";
import { fakeConnections, tempDirs } from "../testing/fakes";
import { handleApiRequest } from ".";

let dirs: ReturnType<typeof tempDirs>;
let manager: AccountManager;

async function api(method: string, path: string, body?: unknown) {
  const url = new URL(`http://127.0.0.1:3000${path}`);
  const req = new Request(url.href, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await handleApiRequest(req, url, manager);
  const text = res ? await res.text() : "";
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    // não era JSON
  }
  return { status: res?.status ?? 0, json };
}

beforeEach(() => {
  dirs = tempDirs();
  const fake = fakeConnections();
  manager = new AccountManager({ appDataDir: dirs.appDataDir, tempDir: dirs.tempDir, createConnection: fake.factory, notify: () => {} });
});

afterEach(() => {
  manager.stopAll();
  dirs.cleanup();
});

describe("POST /stickers (salvar figurinha do chat na biblioteca)", () => {
  test("salva, aparece em GET /stickers, e não duplica a mesma figurinha (dedupe por hash)", async () => {
    const dataBase64 = Buffer.from("fake-webp-bytes").toString("base64");

    const { status, json } = await api("POST", "/accounts/default/stickers", { dataBase64, sourceName: "Chat" });
    expect(status).toBe(200);
    expect(json.sticker).toMatchObject({ sourceGroupName: "Chat", timesSeen: 1 });

    const again = await api("POST", "/accounts/default/stickers", { dataBase64 });
    expect(again.json.sticker).toMatchObject({ id: json.sticker.id, timesSeen: 2 });

    const list = await api("GET", "/accounts/default/stickers");
    expect(list.json.stickers.length).toBe(1);
  });

  test("sem dataBase64 é recusado (400)", async () => {
    const { status, json } = await api("POST", "/accounts/default/stickers", {});
    expect(status).toBe(400);
    expect(json.error).toBeTruthy();
  });
});

describe("POST /stickers/:id/use (usadas recentemente)", () => {
  test("marcar como usada faz aparecer em recentlyUsed; quem nunca foi usada não aparece", async () => {
    const a = await api("POST", "/accounts/default/stickers", { dataBase64: Buffer.from("figurinha-a").toString("base64") });
    await api("POST", "/accounts/default/stickers", { dataBase64: Buffer.from("figurinha-b").toString("base64") }); // nunca usada

    const before = await api("GET", "/accounts/default/stickers");
    expect(before.json.recentlyUsed).toEqual([]);

    const { status } = await api("POST", `/accounts/default/stickers/${a.json.sticker.id}/use`);
    expect(status).toBe(200);

    const after = await api("GET", "/accounts/default/stickers");
    expect(after.json.recentlyUsed).toMatchObject([{ id: a.json.sticker.id }]);
    expect(after.json.stickers.length).toBe(2); // continua tendo as duas na lista completa
  });

  test("figurinha que não existe devolve 404", async () => {
    const { status } = await api("POST", "/accounts/default/stickers/nao-existe/use");
    expect(status).toBe(404);
  });
});
