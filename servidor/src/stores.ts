import { join } from "path";
import { CONFIG } from "./config";
import { UserStore } from "./user-store";
import { InviteStore } from "./invite-store";
import { KeyStore } from "./key-store";
import { SessionStore } from "./session-store";

/** Os arquivos de dados do servidor, todos dentro de `DATA_DIR` (é essa pasta que precisa de backup). */
export function openStores(dataDir: string = CONFIG.dataDir) {
  return {
    users: new UserStore(join(dataDir, "users.json")),
    invites: new InviteStore(join(dataDir, "invites.json")),
    keys: new KeyStore(join(dataDir, "keys.json")),
    sessions: new SessionStore(join(dataDir, "sessions.json")),
  };
}
