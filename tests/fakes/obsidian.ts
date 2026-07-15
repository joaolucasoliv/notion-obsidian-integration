export interface FakePluginManifest {
  readonly id: string;
  readonly dir?: string;
}

export class TFile {
  public constructor(
    public readonly path: string,
    public contents: string,
  ) {}

  public get extension(): string {
    const index = this.path.lastIndexOf(".");
    return index === -1 ? "" : this.path.slice(index + 1);
  }
}

type VaultEvent = "modify" | "rename";
type VaultListener = (file: TFile) => unknown;

export class FakeVault {
  public readonly configDir = ".obsidian";
  public readonly adapter = { getBasePath: () => "/synthetic/vault" };
  public readonly modified: Array<{ readonly path: string; readonly contents: string }> = [];
  public readonly created: Array<{ readonly path: string; readonly contents: string }> = [];
  private readonly files = new Map<string, TFile>();
  private readonly listeners = new Map<VaultEvent, VaultListener[]>();

  public addFile(path: string, contents: string): TFile {
    const file = new TFile(path, contents);
    this.files.set(path, file);
    return file;
  }

  public getAbstractFileByPath(path: string): TFile | null {
    return this.files.get(path) ?? null;
  }

  public async read(file: TFile): Promise<string> {
    return file.contents;
  }

  public async modify(file: TFile, contents: string): Promise<void> {
    file.contents = contents;
    this.modified.push({ path: file.path, contents });
  }

  public async create(path: string, contents: string): Promise<TFile> {
    if (this.files.has(path)) throw new Error("file already exists");
    const file = this.addFile(path, contents);
    this.created.push({ path, contents });
    return file;
  }

  public on(event: VaultEvent, listener: VaultListener): { readonly event: VaultEvent; readonly listener: VaultListener } {
    const existing = this.listeners.get(event) ?? [];
    existing.push(listener);
    this.listeners.set(event, existing);
    return { event, listener };
  }

  public listenerCount(event: VaultEvent): number {
    return this.listeners.get(event)?.length ?? 0;
  }

  public async emit(event: VaultEvent, file: TFile): Promise<void> {
    for (const listener of this.listeners.get(event) ?? []) {
      await listener(file);
    }
  }
}

export class FakeWorkspace {
  private readonly callbacks: Array<() => void> = [];
  private activeFile: TFile | null = null;

  public onLayoutReady(callback: () => void): void {
    this.callbacks.push(callback);
  }

  public setActiveFile(file: TFile | null): void {
    this.activeFile = file;
  }

  public getActiveFile(): TFile | null {
    return this.activeFile;
  }

  public triggerLayoutReady(): void {
    for (const callback of this.callbacks) callback();
  }

  public get layoutReadyCallbackCount(): number {
    return this.callbacks.length;
  }
}

export class App {
  public readonly vault = new FakeVault();
  public readonly workspace = new FakeWorkspace();
}

export interface Command {
  readonly id: string;
  readonly name: string;
  readonly callback?: () => unknown;
}

export class Plugin {
  public readonly commands = new Map<string, Command>();
  public readonly settingTabs: PluginSettingTab[] = [];
  public initialData: unknown = null;
  public savedPluginData: unknown = null;

  public constructor(
    public readonly app: App,
    public readonly manifest: FakePluginManifest,
  ) {}

  public async loadData(): Promise<unknown> {
    return this.initialData;
  }

  public async saveData(data: unknown): Promise<void> {
    this.savedPluginData = data;
    this.initialData = data;
  }

  public addCommand(command: Command): Command {
    this.commands.set(command.id, command);
    return command;
  }

  public addSettingTab(tab: PluginSettingTab): void {
    this.settingTabs.push(tab);
  }

  public registerEvent(_event: unknown): void {}
}

export class Notice {
  public static readonly messages: string[] = [];

  public constructor(message: string) {
    Notice.messages.push(message);
  }

  public static clear(): void {
    Notice.messages.length = 0;
  }
}

export class FakeButtonComponent {
  public label = "";
  private callback: (() => unknown) | null = null;

  public setButtonText(label: string): this {
    this.label = label;
    return this;
  }

  public onClick(callback: () => unknown): this {
    this.callback = callback;
    return this;
  }

  public async click(): Promise<void> {
    await this.callback?.();
  }
}

export class FakeSetting {
  public name = "";
  public description = "";
  public readonly buttons: FakeButtonComponent[] = [];
}

export class FakeContainer {
  public readonly settings: FakeSetting[] = [];

  public empty(): void {
    this.settings.length = 0;
  }
}

export class PluginSettingTab {
  public readonly containerEl = new FakeContainer();

  public constructor(
    public readonly app: App,
    public readonly plugin: Plugin,
  ) {}

  public display(): void {}
}

export class Setting {
  private readonly setting: FakeSetting;

  public constructor(containerEl: FakeContainer) {
    this.setting = new FakeSetting();
    containerEl.settings.push(this.setting);
  }

  public setName(name: string): this {
    this.setting.name = name;
    return this;
  }

  public setDesc(description: string): this {
    this.setting.description = description;
    return this;
  }

  public addButton(configure: (button: FakeButtonComponent) => unknown): this {
    const button = new FakeButtonComponent();
    this.setting.buttons.push(button);
    configure(button);
    return this;
  }
}
