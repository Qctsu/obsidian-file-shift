'use strict';

const obsidian = require('obsidian');

const DEFAULT_DATA = {
  version: 1,
  active: false,
  order: {}
};

class DragReorderPlugin extends obsidian.Plugin {

  async onload() {
    const saved = await this.loadData();
    this.data = Object.assign({}, DEFAULT_DATA, saved || {});

    this.isActive = false;
    this.dragState = null;
    this.abortController = null;
    this.mutationObserver = null;
    this.refreshTimer = null;
    this.originalSort = null;

    // Ribbon icon (toggle)
    this.ribbonEl = this.addRibbonIcon(
      'arrow-up-down',
      'Drag Reorder: OFF',
      () => this.toggle()
    );

    // Commands
    this.addCommand({
      id: 'toggle',
      name: 'Toggle custom ordering on/off',
      callback: () => this.toggle()
    });

    this.addCommand({
      id: 'reset-order',
      name: 'Reset all custom ordering',
      callback: () => {
        this.data.order = {};
        this.save();
        if (this.isActive) this.restoreDefaultSort();
        new obsidian.Notice('Custom order reset');
      }
    });

    // Auto-activate on layout ready if was active before
    this.app.workspace.onLayoutReady(() => {
      if (this.data.active) {
        setTimeout(() => this.activate(), 400);
      }
    });

    // Re-apply order on layout changes
    this.registerEvent(
      this.app.workspace.on('layout-change', () => {
        if (this.isActive) this.scheduleRefresh();
      })
    );

    // Handle vault changes
    this.registerEvent(
      this.app.vault.on('create', () => {
        if (this.isActive) this.scheduleRefresh();
      })
    );

    this.registerEvent(
      this.app.vault.on('delete', (file) => {
        if (this.isActive) {
          this.removeFromOrder(file.path);
          this.scheduleRefresh();
        }
      })
    );

    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        if (this.isActive) {
          this.handleRename(oldPath, file.path);
          this.scheduleRefresh();
        }
      })
    );
  }

  onunload() {
    this.cleanup();
  }

  // ─── Toggle & Lifecycle ────────────────────────────────────────

  toggle() {
    if (this.isActive) {
      this.deactivate();
    } else {
      this.activate();
    }
  }

  activate() {
    if (this.isActive) return;

    const explorer = this.getExplorer();
    if (!explorer) {
      new obsidian.Notice('File Explorer not found — open it first');
      return;
    }

    this.isActive = true;
    this.data.active = true;
    this.save();

    this.ribbonEl.setAttribute('aria-label', 'Drag Reorder: ON');
    this.ribbonEl.addClass('is-active');
    this.ribbonEl.addClass('dr-active');

    this.patchSort(explorer);
    this.setupDragHandlers();
    this.applyAllOrders();

    new obsidian.Notice('Drag Reorder: ON');
  }

  deactivate() {
    if (!this.isActive) return;

    this.isActive = false;
    this.data.active = false;
    this.save();

    this.ribbonEl.setAttribute('aria-label', 'Drag Reorder: OFF');
    this.ribbonEl.removeClass('is-active');
    this.ribbonEl.removeClass('dr-active');

    this.cleanup();
    this.restoreDefaultSort();

    new obsidian.Notice('Drag Reorder: OFF');
  }

  cleanup() {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    if (this.mutationObserver) {
      this.mutationObserver.disconnect();
      this.mutationObserver = null;
    }
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.unpatchSort();
    this.clearDraggable();
    this.clearIndicators();
  }

  // ─── Explorer Access ───────────────────────────────────────────

  getExplorer() {
    const leaf = this.app.workspace.getLeavesOfType('file-explorer')[0];
    return leaf ? leaf.view : null;
  }

  getNavContainer() {
    const explorer = this.getExplorer();
    if (!explorer) return null;
    return explorer.containerEl.querySelector('.nav-files-container');
  }

  // Resolve parentPath to the DOM element that holds its children (fallback only)
  getChildrenEl(parentPath) {
    const container = this.getNavContainer();
    if (!container) return null;

    if (parentPath === '/') {
      const modRoot = container.querySelector('.mod-root');
      if (modRoot) {
        const el = modRoot.querySelector('.nav-folder-children');
        if (el) return el;
      }
      return container.querySelector('.nav-folder-children') || container;
    }

    const explorer = this.getExplorer();
    if (explorer && explorer.fileItems) {
      const item = explorer.fileItems[parentPath];
      if (item) {
        const el = item.childrenEl || (item.el ? item.el.querySelector('.nav-folder-children') : null);
        if (el) return el;
      }
    }

    const folderTitle = container.querySelector('.nav-folder-title[data-path="' + CSS.escape(parentPath) + '"]');
    if (folderTitle) {
      const folder = folderTitle.closest('.nav-folder');
      if (folder) return folder.querySelector('.nav-folder-children');
    }

    return null;
  }

  // ─── Sort Patching ─────────────────────────────────────────────

  patchSort(explorer) {
    if (this.originalSort) return;

    const orig = explorer.sort.bind(explorer);
    this.originalSort = orig;

    const self = this;
    explorer.sort = function () {
      orig();
      if (self.isActive) {
        requestAnimationFrame(() => {
          self.applyAllOrders();
          self.refreshDraggable();
        });
      }
    };
  }

  unpatchSort() {
    if (!this.originalSort) return;
    const explorer = this.getExplorer();
    if (explorer) {
      explorer.sort = this.originalSort;
    }
    this.originalSort = null;
  }

  restoreDefaultSort() {
    const explorer = this.getExplorer();
    if (explorer && explorer.sort) {
      explorer.sort();
    }
  }

  // ─── Drag & Drop ──────────────────────────────────────────────

  setupDragHandlers() {
    const container = this.getNavContainer();
    if (!container) return;

    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    // Record drag source before Obsidian sees it
    container.addEventListener('dragstart', (e) => this.onDragStart(e), { capture: true, signal });

    // Document-level capture phase — fires before ANY Obsidian handler
    // We block dragenter/dragover/drop inside file explorer when our drag is active
    document.addEventListener('dragenter', (e) => this.onDragEnter(e), { capture: true, signal });
    document.addEventListener('dragover', (e) => this.onDragOver(e), { capture: true, signal });
    document.addEventListener('drop', (e) => this.onDrop(e), { capture: true, signal });
    container.addEventListener('dragend', (e) => this.onDragEnd(e), { signal });

    this.refreshDraggable();

    // Watch for dynamically added items
    this.mutationObserver = new MutationObserver(() => {
      this.refreshDraggable();
    });
    this.mutationObserver.observe(container, { childList: true, subtree: true });
  }

  refreshDraggable() {
    const container = this.getNavContainer();
    if (!container) return;

    const titles = container.querySelectorAll('.nav-file-title, .nav-folder-title');
    titles.forEach(el => {
      if (!el.hasAttribute('data-dr')) {
        el.setAttribute('draggable', 'true');
        el.setAttribute('data-dr', '1');
      }
    });
  }

  clearDraggable() {
    const container = this.getNavContainer();
    if (!container) return;

    container.querySelectorAll('[data-dr]').forEach(el => {
      el.removeAttribute('data-dr');
    });
  }

  clearIndicators() {
    const container = this.getNavContainer();
    if (!container) return;

    container.querySelectorAll('.dr-drop-above, .dr-drop-below').forEach(el => {
      el.classList.remove('dr-drop-above', 'dr-drop-below');
    });
    container.querySelectorAll('.dr-dragging').forEach(el => {
      el.classList.remove('dr-dragging');
    });
  }

  // ─── Event Handlers ────────────────────────────────────────────

  findTitle(e) {
    return e.target && e.target.closest
      ? e.target.closest('.nav-file-title, .nav-folder-title')
      : null;
  }

  getParentPath(filePath) {
    const idx = filePath.lastIndexOf('/');
    return idx === -1 ? '/' : filePath.substring(0, idx);
  }

  getFileName(filePath) {
    return filePath.split('/').pop();
  }

  onDragStart(e) {
    const title = this.findTitle(e);
    if (!title) return;

    const path = title.getAttribute('data-path');
    if (!path) return;

    this.dragState = {
      path: path,
      name: this.getFileName(path),
      parentPath: this.getParentPath(path),
      pendingDrop: null
    };

    const item = title.closest('.nav-file, .nav-folder');
    if (item) item.classList.add('dr-dragging');
  }

  // Helper: is event target inside file explorer?
  isInsideExplorer(e) {
    const container = this.getNavContainer();
    return container && e.target && container.contains(e.target);
  }

  onDragEnter(e) {
    if (!this.dragState) return;
    if (!this.isInsideExplorer(e)) return;

    // Block Obsidian from auto-expanding folders
    e.preventDefault();
    e.stopPropagation();
  }

  onDragOver(e) {
    if (!this.dragState) return;

    if (!this.isInsideExplorer(e)) {
      // Outside file explorer — clear state but let event pass through
      this.clearDropIndicators();
      if (this.dragState) this.dragState.pendingDrop = null;
      return;
    }

    // ── ALWAYS block Obsidian inside explorer during our drag ──
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';

    // Now check if we have a valid reorder target
    const title = this.findTitle(e);
    if (!title) {
      this.clearDropIndicators();
      if (this.dragState) this.dragState.pendingDrop = null;
      return;
    }

    const path = title.getAttribute('data-path');
    if (!path || path === this.dragState.path) {
      this.clearDropIndicators();
      if (this.dragState) this.dragState.pendingDrop = null;
      return;
    }

    // Only reorder within same parent
    const parentPath = this.getParentPath(path);
    if (parentPath !== this.dragState.parentPath) {
      this.clearDropIndicators();
      if (this.dragState) this.dragState.pendingDrop = null;
      return;
    }

    // Same parent sibling — 50/50 above/below
    const rect = title.getBoundingClientRect();
    const ratio = (e.clientY - rect.top) / rect.height;
    const position = ratio < 0.5 ? 'above' : 'below';

    this.clearDropIndicators();
    title.classList.add(position === 'above' ? 'dr-drop-above' : 'dr-drop-below');

    // Keep source item visually dragged
    const container = this.getNavContainer();
    const dragItem = container.querySelector(
      `.nav-file-title[data-path="${CSS.escape(this.dragState.path)}"], .nav-folder-title[data-path="${CSS.escape(this.dragState.path)}"]`
    );
    if (dragItem) {
      const item = dragItem.closest('.nav-file, .nav-folder');
      if (item) item.classList.add('dr-dragging');
    }

    this.dragState.pendingDrop = {
      targetName: this.getFileName(path),
      position: position === 'above' ? 'before' : 'after'
    };
  }

  // Only clears drop lines, NOT the dr-dragging class on source
  clearDropIndicators() {
    const container = this.getNavContainer();
    if (!container) return;
    container.querySelectorAll('.dr-drop-above, .dr-drop-below').forEach(el => {
      el.classList.remove('dr-drop-above', 'dr-drop-below');
    });
  }

  onDrop(e) {
    if (!this.dragState) return;
    if (!this.isInsideExplorer(e)) return;

    // ALWAYS block Obsidian's drop inside explorer
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    // Execute reorder if we have a valid target
    if (this.dragState.pendingDrop) {
      const { targetName, position } = this.dragState.pendingDrop;
      this.reorderItem(
        this.dragState.parentPath,
        this.dragState.name,
        targetName,
        position
      );
    }

    this.clearIndicators();
    this.finishDrag();
    if (this.isActive) this.applyAllOrders();
  }

  onDragEnd() {
    // Fallback: drop didn't fire (e.g. released outside explorer)
    if (this.dragState && this.dragState.pendingDrop) {
      const { targetName, position } = this.dragState.pendingDrop;
      this.reorderItem(
        this.dragState.parentPath,
        this.dragState.name,
        targetName,
        position
      );
      if (this.isActive) this.applyAllOrders();
    }
    this.clearIndicators();
    this.finishDrag();
  }

  finishDrag() {
    const container = this.getNavContainer();
    if (container) {
      container.querySelectorAll('.dr-dragging').forEach(el => {
        el.classList.remove('dr-dragging');
      });
    }
    this.dragState = null;
  }

  // ─── Order Management ─────────────────────────────────────────

  captureCurrentOrder(parentPath) {
    const parentEl = this.getChildrenEl(parentPath);
    if (!parentEl) return [];

    const order = [];
    for (const child of parentEl.children) {
      const title = child.querySelector(':scope > .nav-file-title[data-path], :scope > .nav-folder-title[data-path]');
      if (title) {
        const path = title.getAttribute('data-path');
        if (path) order.push(this.getFileName(path));
      }
    }
    return order;
  }

  reorderItem(parentPath, sourceName, targetName, position) {
    let order = this.data.order[parentPath];
    if (!order || order.length === 0) {
      order = this.captureCurrentOrder(parentPath);
    }

    // Remove source from current position
    order = order.filter(n => n !== sourceName);

    // Find target and insert
    const targetIdx = order.indexOf(targetName);
    if (targetIdx === -1) {
      order.push(sourceName);
    } else {
      const insertIdx = position === 'before' ? targetIdx : targetIdx + 1;
      order.splice(insertIdx, 0, sourceName);
    }

    this.data.order[parentPath] = order;
    this.save();
  }

  applyAllOrders() {
    const explorer = this.getExplorer();
    if (!explorer) return;

    const container = this.getNavContainer();
    if (!container) return;

    for (const [parentPath, order] of Object.entries(this.data.order)) {
      if (!order || order.length === 0) continue;
      this.applyFolderOrder(explorer, container, parentPath, order);
    }
  }

  // Convert our parentPath ("/") to Obsidian's internal path ("")
  toObsidianPath(parentPath) {
    return parentPath === '/' ? '' : parentPath;
  }

  applyFolderOrder(explorer, navContainer, parentPath, order) {
    const obsPath = this.toObsidianPath(parentPath);

    if (explorer.fileItems) {
      // For root: no fileItems[""] — root is the .parent of any top-level item
      let folderItem;
      if (parentPath === '/') {
        const firstKey = Object.keys(explorer.fileItems)[0];
        if (firstKey) {
          const fi = explorer.fileItems[firstKey];
          if (fi && fi.parent && fi.parent.vChildren && typeof fi.parent.vChildren.setChildren === 'function') {
            folderItem = fi.parent;
          }
        }
      } else {
        folderItem = explorer.fileItems[obsPath];
      }

      if (folderItem && folderItem.vChildren && typeof folderItem.vChildren.setChildren === 'function') {
        // Get the vault folder to enumerate children
        let folder;
        if (parentPath === '/') {
          folder = this.app.vault.root;
          if (!folder) {
            try { folder = this.app.vault.getFolderByPath('/'); } catch(e) {}
          }
        } else {
          folder = this.app.vault.getFolderByPath(obsPath);
        }

        if (folder && folder.children) {
          const pathToItem = new Map();
          for (const child of folder.children) {
            const item = explorer.fileItems[child.path];
            if (item) pathToItem.set(this.getFileName(child.path), item);
          }

          const sortedItems = [];
          const used = new Set();

          for (const name of order) {
            if (pathToItem.has(name)) {
              sortedItems.push(pathToItem.get(name));
              used.add(name);
            }
          }
          for (const [name, item] of pathToItem) {
            if (!used.has(name)) {
              sortedItems.push(item);
            }
          }

          folderItem.vChildren.setChildren(sortedItems);
          // Force virtual scroller to re-render DOM
          if (explorer.tree && explorer.tree.infinityScroll) {
            explorer.tree.infinityScroll.invalidateAll();
            explorer.tree.infinityScroll.compute();
          }
          return;
        }
      }
    }

    // ── DOM fallback ──
    const parentEl = this.getChildrenEl(parentPath);
    if (!parentEl) return;

    const nameToEl = new Map();
    const children = Array.from(parentEl.children);

    for (const child of children) {
      const title = child.querySelector(':scope > .nav-file-title[data-path], :scope > .nav-folder-title[data-path]');
      if (title) {
        const path = title.getAttribute('data-path');
        if (path) {
          nameToEl.set(this.getFileName(path), child);
        }
      }
    }

    const ordered = [];
    const used = new Set();

    for (const name of order) {
      if (nameToEl.has(name)) {
        ordered.push(nameToEl.get(name));
        used.add(name);
      }
    }

    for (const [name, el] of nameToEl) {
      if (!used.has(name)) {
        ordered.push(el);
      }
    }

    for (const el of ordered) {
      parentEl.appendChild(el);
    }
  }

  // ─── Vault Event Handlers ─────────────────────────────────────

  removeFromOrder(filePath) {
    const parentPath = this.getParentPath(filePath);
    const name = this.getFileName(filePath);

    if (this.data.order[parentPath]) {
      this.data.order[parentPath] = this.data.order[parentPath].filter(n => n !== name);
      if (this.data.order[parentPath].length === 0) {
        delete this.data.order[parentPath];
      }
      this.save();
    }

    // Remove folder's own order if it was deleted
    if (this.data.order[filePath]) {
      delete this.data.order[filePath];
      this.save();
    }
  }

  handleRename(oldPath, newPath) {
    const oldParent = this.getParentPath(oldPath);
    const newParent = this.getParentPath(newPath);
    const oldName = this.getFileName(oldPath);
    const newName = this.getFileName(newPath);

    // Update in parent's order
    const order = this.data.order[oldParent];
    if (order) {
      const idx = order.indexOf(oldName);
      if (idx !== -1) {
        if (oldParent === newParent) {
          order[idx] = newName;
        } else {
          order.splice(idx, 1);
          if (!this.data.order[newParent]) {
            this.data.order[newParent] = this.captureCurrentOrder(newParent);
          }
          this.data.order[newParent].push(newName);
        }
        this.save();
      }
    }

    // Update folder's own order key
    if (this.data.order[oldPath]) {
      this.data.order[newPath] = this.data.order[oldPath];
      delete this.data.order[oldPath];
      this.save();
    }
  }

  scheduleRefresh() {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshDraggable();
      this.applyAllOrders();
    }, 200);
  }

  // ─── Persistence ──────────────────────────────────────────────

  save() {
    this.saveData(this.data);
  }
}

module.exports = DragReorderPlugin;
