import type { PairingView } from "../pairing/controller.ts";

export interface LockedViewActions {
  readonly submitCode: (code: string) => Promise<void>;
  readonly scanCode: (video: HTMLVideoElement) => Promise<void>;
  readonly cancelScan: () => Promise<void>;
}

export interface LockedView extends PairingView {
  render(actions: LockedViewActions): void;
  showPairingAccepted(): void;
}

function textElement<K extends keyof HTMLElementTagNameMap>(tagName: K, value: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tagName);
  element.textContent = value;
  return element;
}

export function createLockedView(root: HTMLElement): LockedView {
  let error: HTMLElement | null = null;
  let cameraPanel: HTMLElement | null = null;
  let scanButton: HTMLButtonElement | null = null;
  let accepted: HTMLElement | null = null;

  return {
    render(actions: LockedViewActions): void {
      const shell = document.createElement("main");
      shell.className = "app-shell locked-shell";
      shell.append(textElement("p", "Grandbox Bridge"));
      shell.append(textElement("h1", "This graph is locked"));
      shell.append(textElement("p", "Pair this device before viewing your Grandbox graph."));

      const form = document.createElement("form");
      form.noValidate = true;
      const label = textElement("label", "Pairing code");
      const input = document.createElement("textarea");
      input.name = "pairing-code";
      input.autocomplete = "off";
      input.spellcheck = false;
      input.rows = 3;
      input.maxLength = 2_048;
      input.setAttribute("aria-label", "Paste device pairing code");
      label.htmlFor = "pairing-code";
      input.id = "pairing-code";
      const submit = textElement("button", "Pair this device");
      submit.type = "submit";
      form.append(label, input, submit);
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        void actions.submitCode(input.value);
      });
      shell.append(form);

      scanButton = textElement("button", "Scan QR") as HTMLButtonElement;
      scanButton.type = "button";
      const video = document.createElement("video");
      video.autoplay = true;
      video.muted = true;
      video.playsInline = true;
      cameraPanel = document.createElement("section");
      cameraPanel.hidden = true;
      cameraPanel.append(video);
      const cancel = textElement("button", "Cancel scan") as HTMLButtonElement;
      cancel.type = "button";
      cancel.addEventListener("click", () => void actions.cancelScan());
      cameraPanel.append(cancel);
      scanButton.addEventListener("click", () => void actions.scanCode(video));
      shell.append(scanButton, cameraPanel);

      error = document.createElement("p");
      error.hidden = true;
      error.setAttribute("role", "alert");
      shell.append(error);

      accepted = document.createElement("p");
      accepted.hidden = true;
      accepted.textContent = "This device is paired locally. Loading the encrypted graph is the next step.";
      shell.append(accepted);
      root.replaceChildren(shell);
    },
    setSafeError(value: string | null): void {
      if (error === null) return;
      error.textContent = value ?? "";
      error.hidden = value === null;
    },
    setCameraActive(value: boolean): void {
      if (cameraPanel !== null) cameraPanel.hidden = !value;
      if (scanButton !== null) scanButton.disabled = value;
    },
    showPairingAccepted(): void {
      if (accepted !== null) accepted.hidden = false;
    },
  };
}
