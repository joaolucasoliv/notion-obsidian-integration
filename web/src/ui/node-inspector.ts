import type { GraphNodeAttributes } from "../graph/build-graph.ts";

export interface NodeInspectorActions {
  readonly openNotion: () => void;
  readonly openObsidian: () => void;
}

export interface NodeInspector {
  setNode(node: GraphNodeAttributes | null): void;
}

function textElement<K extends keyof HTMLElementTagNameMap>(tagName: K, value: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tagName);
  element.textContent = value;
  return element;
}

/** Uses text nodes for every graph-derived field so node metadata never becomes markup. */
export function createNodeInspector(root: HTMLElement, actions: NodeInspectorActions): NodeInspector {
  const shell = document.createElement("aside");
  shell.className = "node-inspector";
  shell.setAttribute("aria-label", "Selected graph node");
  root.append(shell);

  return {
    setNode(node): void {
      shell.replaceChildren();
      if (node === null) {
        shell.append(textElement("p", "Select a node to inspect its links."));
        return;
      }
      shell.append(textElement("p", node.domain));
      shell.append(textElement("h2", node.label));
      if (node.path !== null) shell.append(textElement("p", node.path));
      if (node.tags.length > 0) shell.append(textElement("p", node.tags.join(" · ")));
      if (node.notionUrl !== null) {
        const notion = textElement("button", "Open in Notion") as HTMLButtonElement;
        notion.type = "button";
        notion.addEventListener("click", actions.openNotion);
        shell.append(notion);
      }
      if (node.obsidianUrl !== null) {
        const obsidian = textElement("button", "Open in Obsidian") as HTMLButtonElement;
        obsidian.type = "button";
        obsidian.addEventListener("click", actions.openObsidian);
        shell.append(obsidian);
      }
    },
  };
}
