# Grandbox Bridge

Private Notion and Obsidian synchronization with an encrypted knowledge graph.

Created by João Lucas Oliveira.

## Development

Requires Node.js 22.12.0 or newer.

```sh
npm install
npm run check
```

## Try the private graph locally

```sh
npm run demo
```

The command builds the web app and opens a local fixture relay at the URL and
with the pairing code printed in the terminal. It uses only a synthetic,
encrypted graph (`nodal`, `angico-core`, and `GitHub Vault`)—it never reads
`The Grandbox`, Notion, GitHub, or provider credentials.

## Obsidian plugin foundation

`plugin/` builds the desktop-only Grandbox Bridge controller. Its persisted
plugin data contains only an installation UUID; runtime paths and worker
arguments are derived transiently. The installed plugin contains exactly
`main.js`, `bridge-worker.cjs`, `manifest.json`, and `styles.css`.

## Connect The Grandbox to Notion

1. In Notion's developer dashboard, create an internal connection with content
   read, insert, and update capabilities. Create or choose one parent **page**,
   share it with that connection through `•••` → **Connections**, and copy that
   page's URL. Do not use the workspace ID.
2. Reload Obsidian, enable **Grandbox Bridge** under Community Plugins, then
   open its settings.
3. Under **Connect Notion**, paste that shared parent-page URL and the
   connection token, then choose **Connect Notion**. The bridge creates a
   `Grandbox Notes` database beneath the shared page. The token is passed to
   the local worker through stdin and stored in macOS Keychain, never in
   Obsidian's `data.json` or this repository.
4. Open a Markdown note in The Grandbox and use **Grandbox Bridge: Opt active
   note into sync**. Then choose **Sync now**. Only notes with
   `notion_sync: true` participate in the two-way sync.

The encrypted graph preview remains separate from the content-sync onboarding;
it is not yet published as a live Notion embed.

Licensed under the MIT License.
