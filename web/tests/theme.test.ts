import { describe, expect, it } from "vitest";
import { ThemeController, resolveTheme, type Theme, type ThemeStore } from "../src/ui/theme.ts";

class MemoryThemeStore implements ThemeStore {
  public value: Theme | null;

  public constructor(value: Theme | null) {
    this.value = value;
  }

  public async getTheme(): Promise<Theme | null> {
    return this.value;
  }

  public async setTheme(theme: Theme): Promise<void> {
    this.value = theme;
  }
}

describe("resolveTheme", () => {
  it("uses the OS preference only when the device has no explicit choice", () => {
    expect(resolveTheme(null, true)).toBe("dark");
    expect(resolveTheme(null, false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
  });
});

describe("ThemeController", () => {
  it("persists an explicit device choice across reloads", async () => {
    const store = new MemoryThemeStore(null);
    let prefersDark = true;
    const applied: Theme[] = [];
    const first = new ThemeController({
      store,
      prefersDark: () => prefersDark,
      apply: (theme) => applied.push(theme),
    });

    expect(await first.initialize()).toBe("dark");
    await first.choose("light");
    prefersDark = false;

    const reloaded = new ThemeController({
      store,
      prefersDark: () => prefersDark,
      apply: (theme) => applied.push(theme),
    });
    expect(await reloaded.initialize()).toBe("light");
    expect(applied).toEqual(["dark", "light", "light"]);
  });
});
