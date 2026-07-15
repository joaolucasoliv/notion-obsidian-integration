# Grandbox Bridge

Private Notion and Obsidian synchronization with an encrypted knowledge graph.

Created by João Lucas Oliveira with Codex 5.6.

## Development

Requires Node.js 22.12.0 or newer.

```sh
npm install
npm run check
```

## Obsidian plugin foundation

`plugin/` builds the desktop-only Grandbox Bridge controller. Its persisted
plugin data contains only an installation UUID; runtime paths and worker
arguments are derived transiently. The public plugin build emits `main.js`
alongside `manifest.json` and `styles.css`; a later installer supplies the
local worker artifact. The controller has no pairing, graph, relay, credential,
or live-service setup flow.

Licensed under the MIT License.
