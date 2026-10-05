import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

export abstract class JsonFileStore<T> {
  protected data: T;
  protected readonly filePath: string;

  constructor(filePath: string, defaultData: T) {
    this.filePath = filePath;
    this.data = defaultData;
    this.load(defaultData);
  }

  protected load(defaultData: T): void {
    if (!existsSync(this.filePath)) {
      this.data = defaultData;
      return;
    }
    try {
      const raw = readFileSync(this.filePath, "utf-8");
      this.data = JSON.parse(raw) as T;
    } catch (err) {
      console.error(`Falha ao carregar ${this.filePath}:`, err);
      this.data = defaultData;
    }
  }

  protected save(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), "utf-8");
    } catch (err) {
      console.error(`Falha ao salvar ${this.filePath}:`, err);
    }
  }
}
