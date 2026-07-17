import type { GraphNodeAttributes } from "../graph/build-graph.ts";
import type { GithubVisibilityLevel } from "../graph/visibility.ts";
import type { Theme } from "./theme.ts";

type Domain = GraphNodeAttributes["domain"];

const domains: readonly Domain[] = ["github", "academic", "research", "project", "personal", "other"];

export interface GraphToolbarActions {
  readonly search: (value: string) => void;
  readonly selectNode: (nodeId: string) => void;
  readonly setGithubLevel: (level: GithubVisibilityLevel) => void;
  readonly setDomains: (domains: ReadonlySet<Domain>) => void;
  readonly zoomIn: () => void;
  readonly zoomOut: () => void;
  readonly resetZoom: () => void;
  readonly clearFocus: () => void;
  readonly refresh: () => void;
  readonly forget: () => void;
  readonly toggleTheme: () => void;
}

export interface GraphToolbar {
  setResults(nodes: readonly GraphNodeAttributes[]): void;
  setGithubLevel(level: GithubVisibilityLevel): void;
  setTheme(theme: Theme): void;
}

function textElement<K extends keyof HTMLElementTagNameMap>(tagName: K, value: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tagName);
  element.textContent = value;
  return element;
}

export function createGraphToolbar(root: HTMLElement, actions: GraphToolbarActions, theme: Theme): GraphToolbar {
  const shell = document.createElement("section");
  shell.className = "graph-toolbar";
  shell.setAttribute("aria-label", "Graph controls");
  const search = document.createElement("input");
  search.type = "search";
  search.placeholder = "Search notes, paths, and tags";
  search.autocomplete = "off";
  search.setAttribute("aria-label", "Search graph");
  search.addEventListener("input", () => actions.search(search.value));
  shell.append(search);

  const domainGroup = document.createElement("div");
  domainGroup.className = "graph-toolbar__domains";
  const selectedDomains = new Set<Domain>(domains);
  for (const domain of domains) {
    const button = textElement("button", domain) as HTMLButtonElement;
    button.type = "button";
    button.dataset.domain = domain;
    button.setAttribute("aria-pressed", "true");
    button.addEventListener("click", () => {
      if (selectedDomains.has(domain)) selectedDomains.delete(domain);
      else selectedDomains.add(domain);
      button.setAttribute("aria-pressed", String(selectedDomains.has(domain)));
      actions.setDomains(new Set(selectedDomains));
    });
    domainGroup.append(button);
  }
  shell.append(domainGroup);

  const githubGroup = document.createElement("div");
  githubGroup.className = "graph-toolbar__github";
  const githubButtons = new Map<GithubVisibilityLevel, HTMLButtonElement>();
  const setGithubButtons = (nextLevel: GithubVisibilityLevel): void => {
    for (const [otherLevel, otherButton] of githubButtons) otherButton.setAttribute("aria-pressed", String(otherLevel === nextLevel));
  };
  for (const level of ["collapsed", "repositories", "activities"] as const) {
    const button = textElement("button", `GitHub ${level}`) as HTMLButtonElement;
    button.type = "button";
    button.addEventListener("click", () => {
      setGithubButtons(level);
      actions.setGithubLevel(level);
    });
    githubButtons.set(level, button);
    githubGroup.append(button);
  }
  setGithubButtons("collapsed");
  shell.append(githubGroup);

  const navigation = document.createElement("div");
  navigation.className = "graph-toolbar__navigation";
  for (const [label, action] of [
    ["Zoom in", actions.zoomIn],
    ["Zoom out", actions.zoomOut],
    ["Reset view", actions.resetZoom],
    ["Clear focus", actions.clearFocus],
    ["Refresh graph", actions.refresh],
    ["Forget this device", actions.forget],
  ] as const) {
    const button = textElement("button", label) as HTMLButtonElement;
    button.type = "button";
    button.addEventListener("click", action);
    navigation.append(button);
  }
  const themeButton = textElement("button", "") as HTMLButtonElement;
  themeButton.type = "button";
  themeButton.setAttribute("aria-label", "Toggle color theme");
  themeButton.addEventListener("click", actions.toggleTheme);
  const setThemeButton = (nextTheme: Theme): void => {
    themeButton.textContent = `Theme: ${nextTheme}`;
  };
  setThemeButton(theme);
  navigation.append(themeButton);
  shell.append(navigation);

  const results = document.createElement("div");
  results.className = "graph-toolbar__results";
  results.setAttribute("aria-label", "Graph search results");
  shell.append(results);
  root.append(shell);

  return {
    setResults(nodes): void {
      results.replaceChildren();
      for (const node of nodes.slice(0, 20)) {
        const button = textElement("button", `${node.label} · ${node.domain}`) as HTMLButtonElement;
        button.type = "button";
        button.addEventListener("click", () => actions.selectNode(node.id));
        results.append(button);
      }
    },
    setGithubLevel(level): void {
      setGithubButtons(level);
    },
    setTheme: setThemeButton,
  };
}
