# FileShift

Reorder files and folders in Obsidian's File Explorer using drag and drop. No filename prefixes, no hacks — just drag items where you want them.

![demo](https://img.shields.io/badge/Obsidian-1.7.2+-blueviolet)

## Features

- **Drag & drop** files and folders to reorder them within the same parent
- **Persistent order** — survives restarts, saved in plugin data
- **Toggle on/off** via ribbon icon or command palette
- **Works with virtual scroll** — uses Obsidian's internal `vChildren` API for reliable rendering
- **Zero file modifications** — order is stored in plugin config, not in filenames

## Installation

### Via BRAT (recommended)

1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin
2. Add this repo: `Qctsu/obsidian-file-shift`
3. Enable "FileShift" in Community Plugins

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest release
2. Create folder `.obsidian/plugins/file-shift/` in your vault
3. Copy the files there
4. Enable "FileShift" in Community Plugins settings

## Usage

1. Click the ↕ ribbon icon (or use command palette: "Toggle custom ordering on/off")
2. Drag files/folders to reorder them
3. Drop indicator shows above/below target position
4. Order persists automatically

## Commands

| Command | Description |
|---------|-------------|
| **Toggle custom ordering on/off** | Enable/disable FileShift |
| **Reset all custom ordering** | Clear all saved orders, revert to default sort |

## How it works

When active, the plugin:
- Intercepts drag events in the file explorer (capture phase)
- Blocks Obsidian's native drag-to-move-into-folder behavior for sibling reordering
- Uses Obsidian's `vChildren.setChildren()` API + `InfinityScroll` invalidation for reliable DOM updates
- Stores order per-folder in `data.json`

## Compatibility

- Obsidian **1.7.2+** (uses `vChildren` / `InfinityScroll` APIs)
- Desktop only (tested on Windows, should work on macOS/Linux)

## License

MIT
