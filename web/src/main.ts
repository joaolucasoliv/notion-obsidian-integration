import { GraphAppController, type AppView, type GraphRendererHandle } from "./app/controller.ts";
import type { AppState } from "./app/state.ts";
import { HttpSnapshotSource } from "./api/snapshot-client.ts";
import { GraphRenderer } from "./graph/sigma-renderer.ts";
import { createBrowserSigmaFactory } from "./graph/sigma-browser.ts";
import type { GraphRoute } from "./route.ts";
import { PairingController } from "./pairing/controller.ts";
import { BrowserQrScanner } from "./pairing/qr-scanner.ts";
import { IndexedDbPairingStore } from "./storage/pairing-store.ts";
import { createGraphSurface, type GraphSurface } from "./ui/graph-surface.ts";
import { createLockedView } from "./ui/locked-view.ts";
import { ThemeController, type Theme } from "./ui/theme.ts";
import "./styles/tokens.css";
import "./styles/app.css";
import "./styles/embed.css";

function textElement<K extends keyof HTMLElementTagNameMap>(tagName: K, value: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tagName);
  element.textContent = value;
  return element;
}

class BrowserAppView implements AppView {
  readonly #root: HTMLElement;
  #controller: GraphAppController | null = null;
  #surface: GraphSurface | null = null;
  #renderer: GraphRenderer | null = null;
  #theme: Theme = "dark";
  readonly #toggleTheme: () => void;

  public constructor(root: HTMLElement, toggleTheme: () => void) {
    this.#root = root;
    this.#toggleTheme = toggleTheme;
  }

  public attach(controller: GraphAppController): void {
    this.#controller = controller;
  }

  public setTheme(theme: Theme): void {
    const changed = this.#theme !== theme;
    this.#theme = theme;
    this.#surface?.toolbar.setTheme(theme);
    if (changed && this.#renderer !== null) this.#renderer.replace(this.#renderer.document);
  }

  public createRenderer(): GraphRendererHandle {
    const surface = this.#ensureSurface();
    const renderer = new GraphRenderer({
      container: surface.canvas,
      createSigma: createBrowserSigmaFactory(() => this.#theme),
      reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      onSelection: (node) => surface.inspector.setNode(node),
      onVisibility: () => this.#updateResults(),
    });
    this.#renderer = renderer;
    return renderer;
  }

  public render(state: AppState, route: GraphRoute | null): void {
    const retainedGraph = state.kind === "ready"
      ? state.graph
      : state.kind === "loading" || state.kind === "error"
        ? state.retained
        : null;
    if (route !== null && retainedGraph !== null) {
      const surface = this.#ensureSurface();
      surface.status.setStatus({
        generatedAt: retainedGraph.generatedAt,
        nodes: retainedGraph.nodes.length,
        edges: retainedGraph.edges.length,
        conflicts: retainedGraph.conflicts,
        stale: state.kind !== "ready" || state.stale,
      });
      this.#updateResults();
      return;
    }

    this.#surface = null;
    this.#renderer = null;
    if (state.kind === "locked" && route !== null) {
      this.#renderLocked(route);
      return;
    }
    const shell = document.createElement("main");
    shell.className = "app-shell";
    if (state.kind === "error") shell.dataset.errorCode = state.code;
    shell.append(textElement("p", "Grandbox Bridge"));
    shell.append(textElement("h1", state.kind === "error" ? "This graph is unavailable" : "Preparing the private graph"));
    shell.append(textElement("p", state.kind === "error" ? "Pair again or try the graph link later." : "Checking this device."));
    this.#root.replaceChildren(shell);
  }

  #renderLocked(route: GraphRoute): void {
    const lockedView = createLockedView(this.#root);
    const pairing = new PairingController({
      routeGraphId: route.graphId,
      view: lockedView,
      scanner: new BrowserQrScanner(),
      accept: async (candidate) => {
        await this.#controller?.acceptPairing(candidate);
      },
    });
    lockedView.render({
      submitCode: (code) => pairing.submit(code),
      scanCode: (video) => pairing.scan(video),
      cancelScan: () => pairing.cancelCamera(),
    });
  }

  #ensureSurface(): GraphSurface {
    if (this.#surface !== null) return this.#surface;
    this.#surface = createGraphSurface(this.#root, {
      search: (value) => {
        this.#renderer?.setSearch(value);
        this.#updateResults();
      },
      selectNode: (nodeId) => {
        this.#renderer?.selectNode(nodeId);
        this.#renderer?.focus(nodeId);
        this.#updateResults();
      },
      setGithubLevel: (level) => {
        this.#renderer?.setGithubLevel(level);
        this.#surface?.toolbar.setGithubLevel(level);
        this.#updateResults();
      },
      setDomains: (domains) => {
        this.#renderer?.setDomains(domains);
        this.#updateResults();
      },
      zoomIn: () => this.#renderer?.zoomIn(),
      zoomOut: () => this.#renderer?.zoomOut(),
      resetZoom: () => this.#renderer?.resetZoom(),
      clearFocus: () => {
        this.#renderer?.clearFocus();
        this.#updateResults();
      },
      openNotion: () => this.#renderer?.openSelected("notion"),
      openObsidian: () => this.#renderer?.openSelected("obsidian"),
      refresh: () => void this.#controller?.refresh(),
      forget: () => void this.#controller?.forget(),
      toggleTheme: this.#toggleTheme,
    }, this.#theme);
    return this.#surface;
  }

  #updateResults(): void {
    if (this.#surface === null || this.#renderer === null) return;
    this.#surface.toolbar.setResults(this.#renderer.visibleNodes.filter((node) => node.kind !== "vault"));
  }
}

const root = document.querySelector<HTMLElement>("#app");
if (root === null) throw new Error("Grandbox Bridge requires the app root");

let themeController: ThemeController | null = null;
const view = new BrowserAppView(root, () => void themeController?.toggle());
const pairingStore = new IndexedDbPairingStore();
themeController = new ThemeController({
  store: pairingStore,
  prefersDark: () => window.matchMedia("(prefers-color-scheme: dark)").matches,
  apply: (theme) => {
    document.documentElement.dataset.theme = theme;
    view.setTheme(theme);
  },
});
const controller = new GraphAppController(view, {
  snapshotSource: new HttpSnapshotSource(),
  pairingStore,
  rendererFactory: { create: () => view.createRenderer() },
});
view.attach(controller);
controller.start(window.location.pathname);
void themeController.initialize();
void controller.refresh();
