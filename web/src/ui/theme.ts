export type Theme = "dark" | "light";

export interface ThemeStore {
  getTheme(): Promise<Theme | null>;
  setTheme(theme: Theme): Promise<void>;
}

export interface ThemeControllerOptions {
  readonly store: ThemeStore;
  readonly prefersDark: () => boolean;
  readonly apply: (theme: Theme) => void;
}

/** An explicit device choice wins over the operating system on every later load. */
export function resolveTheme(stored: Theme | null, prefersDark: boolean): Theme {
  return stored ?? (prefersDark ? "dark" : "light");
}

export class ThemeController {
  readonly #store: ThemeStore;
  readonly #prefersDark: () => boolean;
  readonly #apply: (theme: Theme) => void;
  #theme: Theme | null = null;

  public constructor(options: ThemeControllerOptions) {
    this.#store = options.store;
    this.#prefersDark = options.prefersDark;
    this.#apply = options.apply;
  }

  public async initialize(): Promise<Theme> {
    let stored: Theme | null = null;
    try {
      stored = await this.#store.getTheme();
    } catch {
      // A theme failure must not block the locked pairing path. The choice will
      // simply remain session-only until storage is available again.
    }
    const theme = resolveTheme(stored, this.#prefersDark());
    this.#theme = theme;
    this.#apply(theme);
    return theme;
  }

  public async choose(theme: Theme): Promise<void> {
    this.#theme = theme;
    this.#apply(theme);
    try {
      await this.#store.setTheme(theme);
    } catch {
      // The visual choice is still useful for this session without persistence.
    }
  }

  public async toggle(): Promise<Theme> {
    const next = (this.#theme ?? resolveTheme(null, this.#prefersDark())) === "dark" ? "light" : "dark";
    await this.choose(next);
    return next;
  }

  public get theme(): Theme | null {
    return this.#theme;
  }
}
