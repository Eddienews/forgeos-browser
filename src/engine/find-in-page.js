'use strict';

// Chrome-only search state. Never inject the query or the result into a page
// script, agent snapshot, or the general browser state broadcast.
class FindInPage {
  constructor(notify) {
    this.notify = notify;
    this.tab = null;
    this.query = '';
    this.requestId = null;
    this.opened = false;
  }

  status(matches = 0, active = 0) {
    this.notify({ open: this.opened, matches, active });
  }

  open(tab) {
    if (!tab || tab.closing || tab.wc.isDestroyed()) return false;
    if (this.opened && this.tab === tab) return true;
    if (this.tab && this.tab !== tab) this.close();
    this.tab = tab;
    this.opened = true;
    this.status();
    return true;
  }

  search(tab, query, direction = 'forward') {
    if (!this.opened || tab !== this.tab || !tab || tab.wc.isDestroyed() ||
        typeof query !== 'string' || query.length > 512 || !['forward', 'backward'].includes(direction)) return false;
    if (!query) {
      this.clear();
      this.status();
      return true;
    }
    const same = query === this.query;
    this.query = query;
    try {
      // Electron's findNext=false advances an existing query; true starts a new search.
      this.requestId = tab.wc.findInPage(query, { forward: direction === 'forward', findNext: !same });
      this.status();
      return true;
    } catch {
      this.clear();
      this.status();
      return false;
    }
  }

  result(tab, event) {
    if (!this.opened || tab !== this.tab || event.requestId !== this.requestId) return;
    this.status(event.matches || 0, event.activeMatchOrdinal || 0);
  }

  clear() {
    if (this.tab && !this.tab.wc.isDestroyed()) {
      try { this.tab.wc.stopFindInPage('clearSelection'); } catch {}
    }
    this.query = '';
    this.requestId = null;
  }

  close() {
    if (!this.opened && !this.tab) return;
    this.clear();
    this.opened = false;
    this.tab = null;
    this.status();
  }
}

module.exports = { FindInPage };
