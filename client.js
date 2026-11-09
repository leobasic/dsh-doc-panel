// dsh-doc-panel — Client half (browser).
//
// What this module is
//   The browser half of the `dsh-doc-panel` bundle: one sidebar entry plus one
//   dashboard-style main panel. The page is a top bar (title/subtitle, rounded
//   search, 全部/收藏 segmented control, refresh), a four-tile KPI row (conversations,
//   documents, favorites, documents added this week with a 7-day bar sparkline),
//   and a two-column body: a 320px left column of cards (favorites, document-type
//   donut + legend, recently updated) beside a right column with a conversation
//   card grid (folder card per conversation: ring donut, compact stats, type chips,
//   latest-document footer), plus folder, favorites, search and preview views.
//   Markdown previews as formatted content (own block/inline parser -> React
//   element tree), HTML previews as a page in a sandboxed iframe over the raw file
//   route, PDF embeds in an iframe, and both Markdown and HTML have an explicit
//   预览/源码 toggle. Documents can be starred from any card or from the preview
//   header; 收藏夹 is read from and written to the Host favorites routes. Donuts,
//   rings and sparklines are pure SVG/CSS (no chart library) and take every color
//   from --dsw-alias-* theme tokens or color-mix() of those tokens.
//
// Registrations (verified live slot catalogue)
//   * sidebar.panellist — { id: 'dsh-doc-panel', order: 30, locale, label } with
//     an inline line-art SVG icon (owner props: { size, active }).
//   * main — { key: 'dsh-doc-panel' } renders <DocPanel/>. The sidebar id
//     addresses this key, so the icon opens the panel.
//   Both registrations go through ctx.slots.inject(...) so they are disposed
//   with the plugin; the zh/en dictionaries go through ctx.effect(() =>
//   ctx.locale.register(...)).
//
// HTTP contract this module depends on (same-origin, relative URL, cookie auth)
//   POST api/dsh-doc-panel/list   body {} | { refresh: true }
//     -> { ok: true, value: { generatedAt, totalConversations, totalDocuments,
//          conversations: [{ id, title, createdAt, updatedAt, workspace,
//          sessionCount, counts: { byKind }, documents: [{ path, relPath, name,
//          ext, kind, size, mtime, delivered, authored, sessionId }] }] } }
//        | { ok: false, error: { code, message } }
//   POST api/dsh-doc-panel/read   body { path }
//     -> { ok: true, value: { kind: 'text', text, bytes, truncated } }
//        | { ok: true, value: { kind: 'binary', url, mime } }
//        | { ok: false, error: { code, message } }
//   GET api/dsh-doc-panel/file?p=<encoded path>  raw bytes, used by the PDF /
//     sandboxed-HTML iframes and the "open in new tab" links.
//   POST api/dsh-doc-panel/favorites  body {}
//     -> { ok: true, value: { favorites: RichFavorite[] } }  (newest first)
//        RichFavorite = { path, name, conversationId, conversationTitle,
//                         addedAt, available, kind, size, mtime }
//        | { ok: false, error: { code, message } }   (older Host: degrade)
//   POST api/dsh-doc-panel/favorites/toggle
//     body { path, name, conversationId, conversationTitle }
//     -> { ok: true, value: { favorites: RichFavorite[], favorited } }
//
// Markdown rendering is a pure factory-scope function `renderMarkdown(text, h)`
// (also exported as `__renderMarkdown` for offline QA): it builds React elements
// only — no HTML-string injection anywhere — so raw HTML embedded in a Markdown
// document is displayed as escaped text, not executed.
//
// Everything below is defensive: fetched shapes are normalised, malformed or
// partial responses never throw during render, and all visible copy goes
// through this plugin's own locale namespace.

window.__ModuleLoader__.load({
  id: 'dsh-doc-panel',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'dsh-doc-panel';

    // ---------------------------------------------------------------------
    // Locale dictionaries — flat string -> string, dotted keys, zh + en.
    // The pair form guarantees every key exists in both languages.
    // ---------------------------------------------------------------------
    const STRINGS = {
      'nav.label': ['文档', 'Documents'],
      'panel.summary': ['{conversations} 个对话 · {documents} 个文档', '{conversations} conversations · {documents} documents'],
      'search.placeholder': ['搜索对话或文档', 'Search conversations or documents'],
      'search.aria': ['搜索对话或文档', 'Search conversations or documents'],
      'search.empty': ['没有匹配的对话', 'No matching conversations'],
      'refresh.title': ['重新扫描文档', 'Rescan documents'],
      'state.loading': ['正在扫描文档…', 'Scanning documents…'],
      'state.loadingHint': ['首次加载会扫描历史对话，请稍候', 'The first scan reads past conversations and may take a while'],
      'state.errorTitle': ['加载失败', 'Failed to load'],
      'state.retry': ['重试', 'Retry'],
      'state.rescan': ['重新扫描', 'Rescan'],
      'state.refreshFailed': ['刷新失败，当前显示上次的结果', 'Refresh failed; showing the previous result'],
      'state.emptyTitle': ['暂无文档', 'No documents yet'],
      'state.emptyText': ['对话中产出的文档会出现在这里。', 'Documents produced in your conversations will appear here.'],
      'state.noSelectionTitle': ['未选择对话', 'No conversation selected'],
      'state.noSelectionText': ['选择左侧的对话文件夹或收藏夹', 'Select a conversation folder or Favorites on the left'],
      'state.networkError': ['网络请求失败', 'Network request failed'],
      'state.requestFailed': ['请求失败', 'Request failed'],
      'state.invalidResponse': ['返回数据格式不正确', 'Unexpected response format'],
      'conv.untitled': ['未命名对话', 'Untitled conversation'],
      'conv.meta': ['{documents} 个文档 · {size} · {time}', '{documents} documents · {size} · {time}'],
      'doc.meta': ['{size} · {time}', '{size} · {time}'],
      'doc.delivered': ['交付物', 'Deliverable'],
      'doc.none': ['该对话没有匹配的文档', 'No documents matching the search'],
      'detail.summary': ['{documents} 个文档 · 共 {size}', '{documents} documents · {size} total'],
      'preview.back': ['返回', 'Back'],
      'preview.openInTab': ['在新标签页打开', 'Open in new tab'],
      'preview.loading': ['正在读取文件…', 'Reading file…'],
      'preview.readError': ['无法读取该文件', 'Could not read this file'],
      'preview.truncated': ['内容较长，仅显示开头部分。', 'The file is long; only the beginning is shown.'],
      'preview.htmlSource': ['HTML 以源代码形式展示，不在面板内执行。', 'HTML is shown as source and is not executed in the panel.'],
      'preview.binaryHint': ['该文件类型不支持面板内预览，可在新标签页中打开。', 'This file type cannot be previewed here; open it in a new tab.'],
      'preview.openFile': ['打开文件', 'Open file'],
      'preview.render': ['预览', 'Preview'],
      'preview.source': ['源码', 'Source'],
      'preview.modeAria': ['预览方式', 'Preview mode'],
      'section.conversations': ['对话', 'Conversations'],
      'fav.title': ['收藏夹', 'Favorites'],
      'fav.documentCount': ['{count} 个文档', '{count} documents'],
      'fav.hint': ['在对话内点击文档右侧的星标即可收藏', 'Star a document from a conversation to add it here'],
      'fav.empty': ['还没有收藏的文档', 'No favorite documents yet'],
      'fav.unavailable': ['收藏暂不可用', 'Favorites are unavailable'],
      'fav.add': ['收藏', 'Add to favorites'],
      'fav.remove': ['取消收藏', 'Remove from favorites'],
      'fav.error': ['收藏操作失败', 'Favorite action failed'],
      'fav.itemUnavailable': ['文件不可用', 'File unavailable'],
      'explorer.name': ['名称', 'Name'],
      'explorer.location': ['位置', 'Location'],
      'explorer.conversation': ['所属对话', 'Conversation'],
      'explorer.type': ['类型', 'Type'],
      'explorer.size': ['大小', 'Size'],
      'explorer.modified': ['修改时间', 'Modified'],
      'explorer.root': ['根目录', 'Root'],
      'folder.detail': ['{documents} 个文档 · 共 {size} · 最近更新 {time}', '{documents} documents · {size} total · updated {time}'],
      'search.results': ['搜索结果', 'Search results'],
      'search.resultsCount': ['{count} 个结果', '{count} results'],
      'search.noDocs': ['没有匹配的文档', 'No matching documents'],
      'panel.subtitle': ['{conversations} 个对话 · {documents} 个文档 · 最近更新 {time}', '{conversations} conversations · {documents} documents · updated {time}'],
      'topbar.all': ['全部', 'All'],
      'topbar.favorites': ['收藏', 'Favorites'],
      'topbar.viewAria': ['视图切换', 'View'],
      'kpi.conversations': ['对话', 'Conversations'],
      'kpi.conversationsSub': ['其中 {count} 个有收藏', '{count} with favorites'],
      'kpi.documents': ['文档', 'Documents'],
      'kpi.documentsSub': ['{count} 种类型', '{count} types'],
      'kpi.favorites': ['收藏', 'Favorites'],
      'kpi.favoritesSub': ['最近收藏 · {time}', 'Latest favorite · {time}'],
      'kpi.favoritesEmpty': ['暂无收藏', 'No favorites yet'],
      'kpi.weekly': ['本周新增', 'Added this week'],
      'kpi.weeklySub': ['近 7 天 · +{count}', 'Last 7 days · +{count}'],
      'kpi.sparklineAria': ['近 7 天每日新增文档', 'Documents added per day over the last 7 days'],
      'kpi.sparklineBar': ['{date} · {count} 个', '{date} · {count}'],
      'left.viewAll': ['查看全部', 'View all'],
      'left.favoritesEmptyHint': ['在文档右侧点星标即可收藏', 'Star a document to add it here'],
      'left.types': ['文档类型', 'Document types'],
      'left.typesEmpty': ['暂无文档', 'No documents yet'],
      'left.recent': ['最近更新', 'Recently updated'],
      'left.recentEmpty': ['暂无更新', 'Nothing updated yet'],
      'types.donutAria': ['文档类型分布', 'Document type distribution'],
      'conv.docLabel': ['文档', 'docs'],
      'conv.noWorkspace': ['未关联工作区', 'No workspace'],
      'conv.sortAria': ['排序方式', 'Sort by'],
      'sort.updated': ['最近更新', 'Recently updated'],
      'sort.count': ['文档数', 'Document count'],
      'sort.name': ['名称', 'Name'],
      'conv.statSize': ['总大小', 'Size'],
      'conv.statDelivered': ['已交付', 'Delivered'],
      'conv.statTypes': ['类型', 'Types'],
      'conv.statDocs': ['文档', 'Docs'],
      'conv.recentLine': ['最近 · {name}', 'Latest · {name}'],
      'conv.emptyLine': ['暂无文档', 'No documents'],
      'conv.openAria': ['打开对话文件夹 {title}', 'Open conversation folder {title}'],
      'type.md': ['MD', 'MD'],
      'type.html': ['HTML', 'HTML'],
      'type.pdf': ['PDF', 'PDF'],
      'type.docx': ['DOCX', 'DOCX'],
      'type.xlsx': ['XLSX', 'XLSX'],
      'type.pptx': ['PPTX', 'PPTX'],
      'type.csv': ['CSV', 'CSV'],
      'type.txt': ['TXT', 'TXT'],
      'type.other': ['其他', 'OTHER'],
      'time.justNow': ['刚刚', 'just now'],
      'time.minutes': ['{n} 分钟前', '{n} min ago'],
      'time.hours': ['{n} 小时前', '{n} h ago'],
      'time.days': ['{n} 天前', '{n} d ago'],
      'time.unknown': ['时间未知', 'time unknown'],
    };

    const DICT = { zh: {}, en: {} };
    Object.keys(STRINGS).forEach(function (key) {
      DICT.zh[key] = STRINGS[key][0];
      DICT.en[key] = STRINGS[key][1];
    });

    // Replaced in apply() with the bound translator of our locale namespace.
    // Until then the key itself is rendered, which keeps the module renderable.
    let translate = function (key) { return key; };

    function t(key) {
      try {
        const value = translate(key);
        return typeof value === 'string' && value ? value : key;
      } catch (err) {
        return key;
      }
    }

    function tt(key, vars) {
      const text = t(key);
      if (!vars) return text;
      return text.replace(/\{(\w+)\}/g, function (match, name) {
        return vars[name] === undefined || vars[name] === null ? match : String(vars[name]);
      });
    }

    // ---------------------------------------------------------------------
    // Defensive shape helpers — a partial server response must not blank the UI.
    // ---------------------------------------------------------------------
    function asObject(value) {
      return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    }
    function asArray(value) {
      return Array.isArray(value) ? value : [];
    }
    function asString(value) {
      return typeof value === 'string' ? value : '';
    }
    function asNumber(value) {
      return typeof value === 'number' && isFinite(value) ? value : 0;
    }

    const TYPE_KEYS = ['md', 'html', 'pdf', 'docx', 'xlsx', 'pptx', 'csv', 'txt'];
    const KIND_ALIASES = { markdown: 'md', mdx: 'md', htm: 'html', xls: 'xlsx', text: 'txt', plaintext: 'txt' };

    function kindKey(kind, ext) {
      let raw = asString(kind).toLowerCase().replace(/^\./, '');
      if (!raw) raw = asString(ext).toLowerCase().replace(/^\./, '');
      const key = KIND_ALIASES[raw] || raw;
      return TYPE_KEYS.indexOf(key) === -1 ? 'other' : key;
    }

    function extOf(name) {
      const text = asString(name);
      const dot = text.lastIndexOf('.');
      return dot > 0 ? text.slice(dot + 1).toLowerCase() : '';
    }

    function baseName(filePath) {
      const text = asString(filePath).replace(/\\/g, '/');
      const slash = text.lastIndexOf('/');
      return slash >= 0 ? text.slice(slash + 1) : text;
    }

    function formatSize(bytes) {
      const n = Math.max(0, Math.round(asNumber(bytes)));
      if (n < 1024) return n + ' B';
      const kb = n / 1024;
      if (kb < 1024) return round1(kb) + ' KB';
      const mb = kb / 1024;
      if (mb < 1024) return round1(mb) + ' MB';
      return round1(mb / 1024) + ' GB';
    }

    function round1(value) {
      return String(Math.round(value * 10) / 10);
    }

    function formatRelative(timestamp) {
      const ts = asNumber(timestamp);
      if (!ts) return t('time.unknown');
      let diff = Date.now() - ts;
      if (diff < 0) diff = 0;
      const minutes = Math.floor(diff / 60000);
      if (minutes < 1) return t('time.justNow');
      if (minutes < 60) return tt('time.minutes', { n: minutes });
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return tt('time.hours', { n: hours });
      const days = Math.floor(hours / 24);
      if (days < 7) return tt('time.days', { n: days });
      try {
        return new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
      } catch (err) {
        return new Date(ts).toISOString().slice(0, 10);
      }
    }

    function errorText(payload) {
      const data = asObject(payload);
      if (!data) return '';
      const error = data.error;
      if (typeof error === 'string') return error;
      const info = asObject(error);
      if (!info) return '';
      if (typeof info.message === 'string' && info.message) return info.message;
      if (typeof info.code === 'string' && info.code) return info.code;
      return '';
    }

    function messageOf(error) {
      if (error && typeof error.message === 'string' && error.message) return error.message;
      return t('state.requestFailed');
    }

    // POST JSON to a same-origin route and unwrap the { ok, value } envelope.
    function requestJson(route, body) {
      const init = {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      };
      return fetch(route, init).then(function (response) {
        return response.text().then(function (text) {
          let data = null;
          if (text) {
            try { data = JSON.parse(text); } catch (err) { data = null; }
          }
          if (!response.ok) {
            throw new Error(errorText(data) || (t('state.requestFailed') + ' (HTTP ' + response.status + ')'));
          }
          if (!data || typeof data !== 'object') {
            throw new Error(t('state.invalidResponse'));
          }
          if (data.ok === false) {
            throw new Error(errorText(data) || t('state.requestFailed'));
          }
          return data.value;
        });
      }, function () {
        throw new Error(t('state.networkError'));
      });
    }

    // ---------------------------------------------------------------------
    // Normalisers — every optional field gets a safe default.
    // ---------------------------------------------------------------------
    function normalizeDoc(raw) {
      const data = asObject(raw);
      if (!data) return null;
      const filePath = asString(data.path) || asString(data.relPath);
      if (!filePath) return null;
      const relPath = asString(data.relPath) || filePath;
      const name = asString(data.name) || baseName(relPath) || baseName(filePath) || relPath;
      const ext = (asString(data.ext) || extOf(name)).replace(/^\./, '').toLowerCase();
      const kind = asString(data.kind).toLowerCase() || ext || 'other';
      return {
        path: filePath,
        relPath: relPath,
        name: name,
        ext: ext,
        kind: kind,
        size: asNumber(data.size),
        mtime: asNumber(data.mtime) || asNumber(data.updatedAt) || 0,
        delivered: data.delivered === true,
        authored: data.authored === true,
      };
    }

    function normalizeConversation(raw, index) {
      const data = asObject(raw);
      if (!data) return null;
      const docs = [];
      asArray(data.documents).forEach(function (entry) {
        const doc = normalizeDoc(entry);
        if (doc) docs.push(doc);
      });
      if (!docs.length) return null; // conversations without documents are not shown

      const byKind = {};
      let size = 0;
      docs.forEach(function (doc) {
        const key = kindKey(doc.kind, doc.ext);
        byKind[key] = (byKind[key] || 0) + 1;
        size += doc.size;
      });

      const createdAt = asNumber(data.createdAt);
      return {
        id: asString(data.id) || ('conversation-' + index),
        title: asString(data.title).trim() || t('conv.untitled'),
        createdAt: createdAt,
        updatedAt: asNumber(data.updatedAt) || createdAt,
        workspace: asString(data.workspace),
        sessionCount: asNumber(data.sessionCount),
        docs: docs,
        byKind: byKind,
        size: size,
      };
    }

    function normalizeIndex(value) {
      const data = asObject(value) || {};
      const conversations = [];
      asArray(data.conversations).forEach(function (entry, index) {
        const conversation = normalizeConversation(entry, index);
        if (conversation) conversations.push(conversation);
      });
      conversations.sort(function (a, b) { return b.updatedAt - a.updatedAt; });
      let totalDocuments = 0;
      conversations.forEach(function (conversation) { totalDocuments += conversation.docs.length; });
      return {
        generatedAt: asNumber(data.generatedAt),
        conversations: conversations,
        totalDocuments: totalDocuments,
      };
    }

    function normalizeRead(value) {
      const data = asObject(value);
      if (!data) return { kind: 'text', text: '', bytes: 0, truncated: false };
      const kind = asString(data.kind).toLowerCase();
      const url = asString(data.url);
      if (kind === 'binary' || (kind !== 'text' && url)) {
        return { kind: 'binary', url: url, mime: asString(data.mime) };
      }
      return {
        kind: 'text',
        text: typeof data.text === 'string' ? data.text : '',
        bytes: asNumber(data.bytes),
        truncated: data.truncated === true,
      };
    }

    function typeLabel(kind, ext) {
      return t('type.' + kindKey(kind, ext));
    }

    function fileUrlForPath(filePath) {
      const path = asString(filePath);
      if (!path) return '';
      return 'api/dsh-doc-panel/file?p=' + encodeURIComponent(path);
    }

    function rawFileUrl(doc) {
      return fileUrlForPath(doc && doc.path);
    }

    // Single switch point for the HTML iframe source: if the raw route ever needs
    // to become a Blob URL, only this helper (and its caller) changes.
    function htmlFrameSrc(doc) {
      return rawFileUrl(doc);
    }

    function previewUrl(doc, value) {
      if (value && typeof value.url === 'string' && value.url) return value.url;
      return rawFileUrl(doc);
    }

    function descriptorKind(doc, value) {
      const key = kindKey(doc.kind, doc.ext);
      if (key !== 'other') return key;
      if (value && value.kind === 'binary' && asString(value.mime).toLowerCase().indexOf('pdf') !== -1) return 'pdf';
      return 'other';
    }

    // Favorites are matched by path, case-insensitively and slash-normalised;
    // the original path is always what gets sent back to the Host.
    function favoriteKey(filePath) {
      return asString(filePath).replace(/\\/g, '/').toLowerCase();
    }

    function dirOf(filePath) {
      const text = asString(filePath).replace(/\\/g, '/');
      const slash = text.lastIndexOf('/');
      if (slash < 0) return t('explorer.root');
      const dir = text.slice(0, slash);
      return dir ? dir : t('explorer.root');
    }

    function normalizeFavorite(raw) {
      const data = asObject(raw);
      if (!data) return null;
      const filePath = asString(data.path);
      if (!filePath) return null;
      const name = asString(data.name) || baseName(filePath) || filePath;
      const ext = extOf(name);
      const kind = asString(data.kind).toLowerCase() || ext || 'other';
      return {
        path: filePath,
        name: name,
        conversationId: asString(data.conversationId),
        conversationTitle: asString(data.conversationTitle).trim() || t('conv.untitled'),
        addedAt: asNumber(data.addedAt),
        available: data.available !== false,
        kind: kind,
        size: asNumber(data.size),
        mtime: asNumber(data.mtime),
      };
    }

    function normalizeFavorites(value) {
      const data = asObject(value);
      const list = asArray(data ? data.favorites : value);
      const favorites = [];
      list.forEach(function (entry) {
        const favorite = normalizeFavorite(entry);
        if (favorite) favorites.push(favorite);
      });
      return favorites;
    }

    // Kind -> theme-token accent. Every entry is a token or a color-mix() of
    // tokens, so light and dark themes stay automatic; no literal colors here.
    const KIND_COLORS = {
      md: 'var(--dsw-alias-brand-primary)',
      html: 'var(--dsw-alias-state-warn-primary)',
      pdf: 'var(--dsw-alias-state-error-primary)',
      docx: 'var(--dsw-alias-state-success-primary)',
      xlsx: 'color-mix(in srgb, var(--dsw-alias-brand-primary) 55%, var(--dsw-alias-state-success-primary))',
      pptx: 'color-mix(in srgb, var(--dsw-alias-state-warn-primary) 55%, var(--dsw-alias-state-success-primary))',
      other: 'var(--dsw-alias-state-idle-primary)',
    };

    function kindColor(kind) {
      return KIND_COLORS[kindKey(kind, '')] || KIND_COLORS.other;
    }

    function tintOf(color, percent) {
      return 'color-mix(in srgb, ' + color + ' ' + percent + '%, transparent)';
    }

    function formatDate(timestamp) {
      const ts = asNumber(timestamp);
      if (!ts) return '';
      try {
        return new Date(ts).toLocaleDateString();
      } catch (err) {
        return '';
      }
    }

    // ---------------------------------------------------------------------
    // Markdown -> React element tree.
    // Pure: text in, React nodes out; no HTML strings, no DOM, no timers, so QA
    // can call renderMarkdown(sample, stubH) offline. Raw HTML embedded in the
    // Markdown stays a text node (React escapes it) and is never executed.
    // ---------------------------------------------------------------------
    const MD_HEADING_RE = /^( {0,3})(#{1,6})\s+(.*)$/;
    const MD_HR_RE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
    const MD_LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
    const MD_QUOTE_RE = /^ {0,3}>/;
    const MD_INDENTED_RE = /^(?: {4}|\t)/;
    const MD_FENCE_RE = /^\s{0,3}(`{3,}|~{3,})\s*([^`]*)$/;
    const MD_INLINE_RE = /`([^`\n]*)`|!\[([^\]]*)\]\(([^)\n]*)\)|\[([^\]]*)\]\(([^)\n]*)\)|<((?:https?:\/\/|mailto:)[^>\s]+)>|\*\*\*([^*\n]+?)\*\*\*|\*\*([^*\n]+?)\*\*|__([^_\n]+?)__|~~([^~\n]+?)~~|\*([^*\n]+?)\*|_([^_\n]+?)_|\\([\\`*_{}\[\]()#+\-.!~>|])/g;

    function nextMarkdownKey(keyRef) {
      keyRef.n += 1;
      return 'md-' + keyRef.n;
    }

    function markdownAlignStyle(align) {
      return align ? { textAlign: align } : undefined;
    }

    function isAbsoluteAssetPath(src) {
      const value = asString(src).trim();
      if (!value) return false;
      if (/^[A-Za-z]:[\\/]/.test(value)) return true; // C:\... or C:/...
      if (/^\\\\/.test(value)) return true;           // \\server\share
      if (/^file:/i.test(value)) return true;         // file://...
      if (value.charAt(0) === '/') return true;       // /absolute/path
      return false;
    }

    function safeMarkdownHref(href) {
      const value = asString(href).trim();
      if (!value) return '';
      const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(value);
      if (scheme) {
        const name = scheme[1].toLowerCase();
        if (name === 'http' || name === 'https' || name === 'mailto') return value;
        return '';
      }
      return value; // relative path or #anchor
    }

    function renderMarkdownImage(alt, src, h, keyRef) {
      const raw = asString(src).trim().replace(/^<|>$/g, '');
      const label = asString(alt).trim();
      const key = nextMarkdownKey(keyRef);
      const hideOnError = function (event) {
        const target = event && event.target;
        if (target && target.style) target.style.display = 'none';
      };
      if (isAbsoluteAssetPath(raw)) {
        return h('img', {
          key: key,
          className: 'dsh-doc-panel-md__img',
          src: fileUrlForPath(raw),
          alt: label,
          loading: 'lazy',
          onError: hideOnError,
        });
      }
      if (/^(?:https?:|data:)/i.test(raw)) {
        return h('img', {
          key: key,
          className: 'dsh-doc-panel-md__img',
          src: raw,
          alt: label,
          loading: 'lazy',
          onError: hideOnError,
        });
      }
      // Relative asset paths are not servable today: show the alt text, not a
      // broken image. Never render an <img> with an unresolvable src.
      if (!label && !raw) return null;
      return h('span', { key: key, className: 'dsh-doc-panel-md__img-alt' }, label || raw);
    }

    function renderMarkdownInline(text, h, keyRef) {
      const source = asString(text);
      const nodes = [];
      if (!source) return nodes;
      const pattern = new RegExp(MD_INLINE_RE.source, 'g');
      let last = 0;
      let match = pattern.exec(source);
      while (match) {
        if (match.index > last) nodes.push(source.slice(last, match.index));
        if (match[1] !== undefined) {
          nodes.push(h('code', { key: nextMarkdownKey(keyRef), className: 'dsh-doc-panel-md__code-inline' }, match[1]));
        } else if (match[2] !== undefined) {
          nodes.push(renderMarkdownImage(match[2], match[3], h, keyRef));
        } else if (match[4] !== undefined) {
          const href = safeMarkdownHref(match[5]);
          const children = renderMarkdownInline(match[4], h, keyRef);
          nodes.push(href
            ? h('a', { key: nextMarkdownKey(keyRef), href: href, target: '_blank', rel: 'noreferrer' }, children)
            : h('span', { key: nextMarkdownKey(keyRef) }, children));
        } else if (match[6] !== undefined) {
          const href = safeMarkdownHref(match[6]);
          nodes.push(href
            ? h('a', { key: nextMarkdownKey(keyRef), href: href, target: '_blank', rel: 'noreferrer' }, match[6])
            : match[6]);
        } else if (match[7] !== undefined) {
          nodes.push(h('strong', { key: nextMarkdownKey(keyRef) },
            h('em', { key: nextMarkdownKey(keyRef) }, renderMarkdownInline(match[7], h, keyRef))));
        } else if (match[8] !== undefined) {
          nodes.push(h('strong', { key: nextMarkdownKey(keyRef) }, renderMarkdownInline(match[8], h, keyRef)));
        } else if (match[9] !== undefined) {
          nodes.push(h('strong', { key: nextMarkdownKey(keyRef) }, renderMarkdownInline(match[9], h, keyRef)));
        } else if (match[10] !== undefined) {
          nodes.push(h('del', { key: nextMarkdownKey(keyRef) }, renderMarkdownInline(match[10], h, keyRef)));
        } else if (match[11] !== undefined) {
          nodes.push(h('em', { key: nextMarkdownKey(keyRef) }, renderMarkdownInline(match[11], h, keyRef)));
        } else if (match[12] !== undefined) {
          nodes.push(h('em', { key: nextMarkdownKey(keyRef) }, renderMarkdownInline(match[12], h, keyRef)));
        } else if (match[13] !== undefined) {
          nodes.push(match[13]);
        } else {
          nodes.push(match[0]);
        }
        last = pattern.lastIndex;
        if (pattern.lastIndex === match.index) pattern.lastIndex += 1;
        match = pattern.exec(source);
      }
      if (last < source.length) nodes.push(source.slice(last));
      return nodes;
    }

    function renderMarkdownCodeBlock(code, info, h, keyRef) {
      const language = asString(info).trim().replace(/[^A-Za-z0-9+#.-]/g, '');
      return h('pre', { key: nextMarkdownKey(keyRef), className: 'dsh-doc-panel-md__pre' },
        h('code', {
          key: nextMarkdownKey(keyRef),
          className: language ? 'dsh-doc-panel-md__code language-' + language : 'dsh-doc-panel-md__code',
        }, code));
    }

    function splitMarkdownTableRow(line) {
      let text = asString(line).trim();
      if (text.charAt(0) === '|') text = text.slice(1);
      if (text.charAt(text.length - 1) === '|') text = text.slice(0, -1);
      return text.split('|').map(function (cell) { return cell.trim(); });
    }

    function isMarkdownTableSeparator(line) {
      const text = asString(line).trim();
      if (!text || text.indexOf('|') === -1) return false;
      const cells = splitMarkdownTableRow(text);
      if (!cells.length) return false;
      return cells.every(function (cell) { return /^:?-{1,}:?$/.test(cell); });
    }

    function markdownTableAlign(cell) {
      const text = asString(cell).trim();
      const left = text.charAt(0) === ':';
      const right = text.charAt(text.length - 1) === ':';
      if (left && right) return 'center';
      if (right) return 'right';
      return '';
    }

    function renderMarkdownTable(header, aligns, rows, h, keyRef) {
      const columns = header.length;
      const headCells = header.map(function (cell, index) {
        return h('th', { key: nextMarkdownKey(keyRef), style: markdownAlignStyle(aligns[index]) },
          renderMarkdownInline(cell, h, keyRef));
      });
      const bodyRows = rows.map(function (row) {
        const cells = [];
        for (let column = 0; column < columns; column += 1) {
          cells.push(h('td', { key: nextMarkdownKey(keyRef), style: markdownAlignStyle(aligns[column]) },
            renderMarkdownInline(row[column] === undefined ? '' : row[column], h, keyRef)));
        }
        return h('tr', { key: nextMarkdownKey(keyRef) }, cells);
      });
      const table = h('table', { key: nextMarkdownKey(keyRef), className: 'dsh-doc-panel-md__table' },
        h('thead', { key: nextMarkdownKey(keyRef) },
          h('tr', { key: nextMarkdownKey(keyRef) }, headCells)),
        bodyRows.length ? h('tbody', { key: nextMarkdownKey(keyRef) }, bodyRows) : null);
      return h('div', { key: nextMarkdownKey(keyRef), className: 'dsh-doc-panel-md__tablewrap' }, table);
    }

    function collectMarkdownList(lines, start) {
      const items = [];
      let index = start;
      while (index < lines.length) {
        const item = MD_LIST_RE.exec(lines[index]);
        if (item) {
          items.push({
            indent: item[1].replace(/\t/g, '    ').length,
            ordered: /\d/.test(item[2]),
            text: item[3],
          });
          index += 1;
          continue;
        }
        if (!lines[index].trim()) {
          // A blank line keeps a loose list together only while the next item
          // still belongs to it; a different marker type at the same indent
          // starts a new list block instead.
          let cursor = index + 1;
          while (cursor < lines.length && !lines[cursor].trim()) cursor += 1;
          const next = cursor < lines.length ? lines[cursor] : undefined;
          if (next === undefined) break;
          const nextItem = MD_LIST_RE.exec(next);
          if (nextItem) {
            const nextIndent = nextItem[1].replace(/\t/g, '    ').length;
            const nextOrdered = /\d/.test(nextItem[2]);
            const baseOrdered = items[0].ordered;
            const baseIndent = items[0].indent;
            if (nextOrdered !== baseOrdered && nextIndent <= baseIndent) break;
            index = cursor;
            continue;
          }
          if (/^[ \t]+\S/.test(next)) {
            index = cursor;
            continue;
          }
          break;
        }
        if (items.length && /^[ \t]+\S/.test(lines[index])) {
          items[items.length - 1].text += '\n' + lines[index].trim();
          index += 1;
          continue;
        }
        break;
      }
      return { items: items, next: index };
    }

    function buildMarkdownList(items, start, indent, h, keyRef) {
      const tag = items[start].ordered ? 'ol' : 'ul';
      const children = [];
      let index = start;
      while (index < items.length && items[index].indent === indent) {
        const item = items[index];
        index += 1;
        let sub = null;
        if (index < items.length && items[index].indent > indent) {
          const built = buildMarkdownList(items, index, items[index].indent, h, keyRef);
          sub = built.node;
          index = built.next;
        }
        children.push(h('li', { key: nextMarkdownKey(keyRef) },
          renderMarkdownInline(item.text, h, keyRef), sub));
      }
      return {
        node: h(tag, { key: nextMarkdownKey(keyRef), className: 'dsh-doc-panel-md__list' }, children),
        next: index,
      };
    }

    function renderMarkdownBlocks(lines, h, keyRef) {
      const nodes = [];
      let index = 0;
      while (index < lines.length) {
        const line = lines[index];
        if (!line.trim()) {
          index += 1;
          continue;
        }

        // Fenced code block (```lang or ~~~).
        const fence = MD_FENCE_RE.exec(line);
        if (fence) {
          const marker = fence[1].charAt(0);
          const closing = marker === '`' ? /^\s{0,3}`{3,}\s*$/ : /^\s{0,3}~{3,}\s*$/;
          const body = [];
          index += 1;
          while (index < lines.length) {
            if (closing.test(lines[index])) {
              index += 1;
              break;
            }
            body.push(lines[index]);
            index += 1;
          }
          nodes.push(renderMarkdownCodeBlock(body.join('\n'), fence[2], h, keyRef));
          continue;
        }

        // ATX heading.
        const heading = MD_HEADING_RE.exec(line);
        if (heading) {
          const level = heading[2].length;
          const content = heading[3].replace(/\s+#+\s*$/, '').trim();
          nodes.push(h('h' + level, { key: nextMarkdownKey(keyRef) }, renderMarkdownInline(content, h, keyRef)));
          index += 1;
          continue;
        }

        // Horizontal rule.
        if (MD_HR_RE.test(line)) {
          nodes.push(h('hr', { key: nextMarkdownKey(keyRef), className: 'dsh-doc-panel-md__hr' }));
          index += 1;
          continue;
        }

        // Blockquote: strip one level and parse the inner lines recursively.
        if (MD_QUOTE_RE.test(line)) {
          const inner = [];
          let cursor = index;
          while (cursor < lines.length) {
            if (MD_QUOTE_RE.test(lines[cursor])) {
              inner.push(lines[cursor].replace(/^ {0,3}> ?/, ''));
              cursor += 1;
            } else if (!lines[cursor].trim()) {
              const next = lines[cursor + 1];
              if (next !== undefined && MD_QUOTE_RE.test(next)) {
                inner.push('');
                cursor += 1;
              } else {
                break;
              }
            } else {
              break;
            }
          }
          nodes.push(h('blockquote', { key: nextMarkdownKey(keyRef), className: 'dsh-doc-panel-md__quote' },
            renderMarkdownBlocks(inner, h, keyRef)));
          index = cursor;
          continue;
        }

        // GFM pipe table.
        if (line.indexOf('|') !== -1 && index + 1 < lines.length && isMarkdownTableSeparator(lines[index + 1])) {
          const header = splitMarkdownTableRow(line);
          const aligns = splitMarkdownTableRow(lines[index + 1]).map(markdownTableAlign);
          const rows = [];
          let cursor = index + 2;
          while (cursor < lines.length) {
            const rowLine = lines[cursor];
            if (!rowLine.trim() || rowLine.indexOf('|') === -1) break;
            if (isMarkdownTableSeparator(rowLine)) {
              cursor += 1;
              continue;
            }
            rows.push(splitMarkdownTableRow(rowLine));
            cursor += 1;
          }
          nodes.push(renderMarkdownTable(header, aligns, rows, h, keyRef));
          index = cursor;
          continue;
        }

        // List (nested by indentation).
        if (MD_LIST_RE.test(line)) {
          const collected = collectMarkdownList(lines, index);
          if (collected.items.length) {
            nodes.push(buildMarkdownList(collected.items, 0, collected.items[0].indent, h, keyRef).node);
          }
          index = collected.next;
          continue;
        }

        // Indented code block.
        if (MD_INDENTED_RE.test(line)) {
          const body = [];
          let cursor = index;
          while (cursor < lines.length) {
            if (MD_INDENTED_RE.test(lines[cursor])) {
              body.push(lines[cursor].replace(/^(?: {4}|\t)/, ''));
              cursor += 1;
            } else if (!lines[cursor].trim()) {
              body.push('');
              cursor += 1;
            } else {
              break;
            }
          }
          while (body.length && !body[body.length - 1].trim()) body.pop();
          nodes.push(renderMarkdownCodeBlock(body.join('\n'), '', h, keyRef));
          index = cursor;
          continue;
        }

        // Paragraph: soft line breaks are preserved by CSS (pre-wrap).
        const paragraph = [line.trim()];
        index += 1;
        while (index < lines.length) {
          const next = lines[index];
          if (!next.trim()) break;
          if (MD_FENCE_RE.test(next) || MD_HEADING_RE.test(next) || MD_HR_RE.test(next) ||
              MD_QUOTE_RE.test(next) || MD_LIST_RE.test(next) || MD_INDENTED_RE.test(next)) break;
          if (next.indexOf('|') !== -1 && index + 1 < lines.length && isMarkdownTableSeparator(lines[index + 1])) break;
          paragraph.push(next.trim());
          index += 1;
        }
        nodes.push(h('p', { key: nextMarkdownKey(keyRef), className: 'dsh-doc-panel-md__p' },
          renderMarkdownInline(paragraph.join('\n'), h, keyRef)));
      }
      return nodes;
    }

    function renderMarkdown(text, h) {
      const source = typeof text === 'string' ? text : '';
      const lines = source.replace(/\r\n?/g, '\n').split('\n');
      const keyRef = { n: 0 };
      return h('div', { className: 'dsh-doc-panel-md' }, renderMarkdownBlocks(lines, h, keyRef));
    }

    // ---------------------------------------------------------------------
    // Styles — one scoped <style> element, theme tokens only.
    // ---------------------------------------------------------------------
    const CSS = `
.dsh-doc-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 320px;
  min-width: 0;
  overflow: hidden;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 1.5;
}
.dsh-doc-panel *,
.dsh-doc-panel *::before,
.dsh-doc-panel *::after { box-sizing: border-box; }
.dsh-doc-panel button,
.dsh-doc-panel input { color: inherit; font-family: inherit; }
.dsh-doc-panel button:focus-visible,
.dsh-doc-panel a:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }

.dsh-doc-panel__header {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 52px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.dsh-doc-panel__heading { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.dsh-doc-panel__title { font-size: 15px; font-weight: 600; letter-spacing: -0.01em; white-space: nowrap; }
.dsh-doc-panel__summary {
  min-width: 0;
  overflow: hidden;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.dsh-doc-panel__tools { display: flex; align-items: center; gap: 8px; margin-left: auto; min-width: 0; }
.dsh-doc-panel__searchwrap { position: relative; display: flex; align-items: center; }
.dsh-doc-panel__search-icon {
  position: absolute;
  left: 9px;
  top: 50%;
  display: block;
  color: var(--dsw-alias-label-secondary);
  pointer-events: none;
  transform: translateY(-50%);
}
.dsh-doc-panel__search {
  width: 216px;
  max-width: 100%;
  height: 28px;
  padding: 0 8px 0 28px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 6px;
  outline: none;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
  transition: border-color .15s ease, background .15s ease;
}
.dsh-doc-panel__search::placeholder { color: var(--dsw-alias-label-secondary); }
.dsh-doc-panel__search:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
.dsh-doc-panel__search:focus { border-color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-bg-base); }
.dsh-doc-panel__search:disabled { opacity: .6; cursor: default; }
.dsh-doc-panel__iconbtn {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  transition: background .15s ease, color .15s ease;
}
.dsh-doc-panel__iconbtn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); }
.dsh-doc-panel__iconbtn:disabled { opacity: .65; cursor: default; }

.dsh-doc-panel__body { flex: 1 1 auto; display: flex; flex-direction: column; min-height: 0; }
.dsh-doc-panel__panes { flex: 1 1 auto; display: flex; min-width: 0; min-height: 0; }
.dsh-doc-panel__pane { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.dsh-doc-panel__pane--list {
  flex: 0 0 300px;
  width: 300px;
  overflow: hidden;
  border-right: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
}
.dsh-doc-panel__pane--detail { flex: 1 1 auto; overflow: hidden; background: var(--dsw-alias-bg-base); }

/* pinned favorites row + scrolling conversation folders */
.dsh-doc-panel__favpin {
  flex: 0 0 auto;
  padding: 8px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.dsh-doc-panel__fav {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 8px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.dsh-doc-panel__fav:hover { background: var(--dsw-alias-bg-layer-2); }
.dsh-doc-panel__fav.is-active {
  border-color: var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-brand-primary);
}
.dsh-doc-panel__fav-icon { flex: 0 0 auto; display: inline-flex; color: var(--dsw-alias-brand-primary); }
.dsh-doc-panel__fav-label { flex: 1 1 auto; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.dsh-doc-panel__count {
  flex: 0 0 auto;
  min-width: 20px;
  padding: 0 6px;
  border-radius: 9px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  line-height: 18px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}
.dsh-doc-panel__caption {
  flex: 0 0 auto;
  padding: 10px 14px 4px;
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  letter-spacing: .04em;
}
.dsh-doc-panel__folders {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-height: 0;
  padding: 2px 8px 10px;
  overflow-x: hidden;
  overflow-y: auto;
}

.dsh-doc-panel__folder {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  width: 100%;
  padding: 7px 8px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  text-align: left;
  cursor: pointer;
}
.dsh-doc-panel__folder:hover { background: var(--dsw-alias-bg-layer-2); }
.dsh-doc-panel__folder.is-active {
  border-color: var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-base);
}
.dsh-doc-panel__folder-icon { flex: 0 0 auto; display: inline-flex; margin-top: 1px; color: var(--dsw-alias-label-secondary); }
.dsh-doc-panel__folder.is-active .dsh-doc-panel__folder-icon { color: var(--dsw-alias-brand-primary); }
.dsh-doc-panel__folder-main { flex: 1 1 auto; display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.dsh-doc-panel__folder-title {
  display: block;
  overflow: hidden;
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.dsh-doc-panel__folder.is-active .dsh-doc-panel__folder-title { color: var(--dsw-alias-brand-primary); }
.dsh-doc-panel__folder-meta,
.dsh-doc-panel__folder-types {
  display: block;
  overflow: hidden;
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.dsh-doc-panel__folder-types { opacity: .9; }

/* right content pane: explorer tables */
.dsh-doc-panel__view { flex: 1 1 auto; display: flex; flex-direction: column; min-height: 0; }
.dsh-doc-panel__viewhead {
  flex: 0 0 auto;
  padding: 14px 16px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.dsh-doc-panel__viewtitle {
  overflow: hidden;
  font-size: 14px;
  font-weight: 600;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.dsh-doc-panel__viewmeta { margin-top: 2px; color: var(--dsw-alias-label-secondary); font-size: 12px; overflow-wrap: anywhere; }
.dsh-doc-panel__viewhint { margin-top: 2px; color: var(--dsw-alias-label-secondary); font-size: 11px; overflow-wrap: anywhere; }
.dsh-doc-panel__viewtypes { margin-top: 2px; color: var(--dsw-alias-label-secondary); font-size: 11px; }
.dsh-doc-panel__viewbanner {
  flex: 0 0 auto;
  margin: 8px 12px 0;
  padding: 5px 8px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-state-warn-primary);
  font-size: 11px;
  overflow-wrap: anywhere;
}
.dsh-doc-panel__tablewrap { flex: 1 1 auto; min-height: 0; overflow: auto; }
.dsh-doc-panel__thead,
.dsh-doc-panel__row {
  display: grid;
  align-items: center;
  gap: 8px;
  min-width: 540px;
  padding: 0 12px;
}
.dsh-doc-panel__thead {
  position: sticky;
  top: 0;
  z-index: 1;
  height: 30px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
}
.dsh-doc-panel__thead--folder,
.dsh-doc-panel__row--folder { grid-template-columns: minmax(0, 1fr) minmax(90px, 1.1fr) 72px 96px 28px; }
.dsh-doc-panel__thead--fav,
.dsh-doc-panel__row--fav { grid-template-columns: minmax(0, 1fr) minmax(120px, 1fr) 56px 72px 96px 28px; }
.dsh-doc-panel__row {
  width: 100%;
  min-height: 34px;
  padding-top: 4px;
  padding-bottom: 4px;
  border: 0;
  border-bottom: 1px solid var(--dsw-alias-border-l2);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.dsh-doc-panel__row:hover { background: var(--dsw-alias-bg-layer-1); }
.dsh-doc-panel__row.is-unavailable { opacity: .55; cursor: default; }
.dsh-doc-panel__row.is-unavailable:hover { background: transparent; }
.dsh-doc-panel__cell {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.dsh-doc-panel__cell--num {
  justify-content: flex-end;
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.dsh-doc-panel__cell--star { justify-content: flex-end; }
.dsh-doc-panel__nametext { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.dsh-doc-panel__rowhint { flex: 0 0 auto; color: var(--dsw-alias-state-warn-primary); font-size: 10px; }

.dsh-doc-panel__star {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}
.dsh-doc-panel__star:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-brand-primary); }
.dsh-doc-panel__star.is-on { color: var(--dsw-alias-brand-primary); }
.dsh-doc-panel__star:disabled { opacity: .4; cursor: default; }

.dsh-doc-panel__badge {
  flex: 0 0 auto;
  min-width: 38px;
  padding: 1px 5px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 4px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
  font-size: 10px;
  font-weight: 600;
  line-height: 16px;
  letter-spacing: .04em;
  text-align: center;
}
.dsh-doc-panel__badge--lg { min-width: 44px; padding: 2px 8px; font-size: 11px; line-height: 18px; }

.dsh-doc-panel__preview { flex: 1 1 auto; display: flex; flex-direction: column; min-height: 0; }
.dsh-doc-panel__preview-head {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.dsh-doc-panel__back {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  cursor: pointer;
  transition: background .15s ease, color .15s ease;
}
.dsh-doc-panel__back:hover { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); }
.dsh-doc-panel__preview-titlewrap { flex: 1 1 auto; display: flex; flex-direction: column; min-width: 0; }
.dsh-doc-panel__preview-namewrap { display: flex; align-items: center; gap: 6px; min-width: 0; }
.dsh-doc-panel__preview-name {
  overflow: hidden;
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.dsh-doc-panel__preview-meta {
  overflow: hidden;
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.dsh-doc-panel__open {
  flex: 0 0 auto;
  padding: 4px 8px;
  border-radius: 6px;
  color: var(--dsw-alias-brand-primary);
  font-size: 12px;
  white-space: nowrap;
  text-decoration: none;
}
.dsh-doc-panel__open:hover { background: var(--dsw-alias-bg-layer-1); text-decoration: underline; }
.dsh-doc-panel__preview-body {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}
.dsh-doc-panel__spin { animation: dsh-doc-panel-spin .9s linear infinite; }
.dsh-doc-panel__notice {
  flex: 0 0 auto;
  margin: 8px 12px 0;
  padding: 6px 8px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  line-height: 1.5;
}
.dsh-doc-panel__pre {
  flex: 1 1 auto;
  min-height: 0;
  margin: 0;
  padding: 12px 16px 24px;
  overflow: auto;
  color: var(--dsw-alias-label-primary);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.65;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.dsh-doc-panel__frame {
  flex: 1 1 auto;
  width: 100%;
  min-height: 0;
  border: 0;
  background: var(--dsw-alias-bg-base);
}
.dsh-doc-panel__mdwrap { flex: 1 1 auto; min-height: 0; overflow: auto; }

.dsh-doc-panel__toggle {
  flex: 0 0 auto;
  display: inline-flex;
  overflow: hidden;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 6px;
}
.dsh-doc-panel__toggle-btn {
  padding: 3px 10px;
  border: 0;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
}
.dsh-doc-panel__toggle-btn:hover { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); }
.dsh-doc-panel__toggle-btn.is-active { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.dsh-doc-panel__toggle-btn + .dsh-doc-panel__toggle-btn { border-left: 1px solid var(--dsw-alias-border-l1); }

.dsh-doc-panel-md {
  padding: 16px 20px 32px;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 1.7;
  overflow-wrap: anywhere;
}
.dsh-doc-panel-md > :first-child { margin-top: 0; }
.dsh-doc-panel-md > :last-child { margin-bottom: 0; }
.dsh-doc-panel-md h1,
.dsh-doc-panel-md h2,
.dsh-doc-panel-md h3,
.dsh-doc-panel-md h4,
.dsh-doc-panel-md h5,
.dsh-doc-panel-md h6 {
  margin: 20px 0 8px;
  color: var(--dsw-alias-label-primary);
  font-weight: 600;
  line-height: 1.35;
}
.dsh-doc-panel-md h1 { font-size: 20px; }
.dsh-doc-panel-md h2 { font-size: 17px; }
.dsh-doc-panel-md h3 { font-size: 15px; }
.dsh-doc-panel-md h4 { font-size: 14px; }
.dsh-doc-panel-md h5 { font-size: 13px; }
.dsh-doc-panel-md h6 { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dsh-doc-panel-md p { margin: 0 0 10px; white-space: pre-wrap; }
.dsh-doc-panel-md ul,
.dsh-doc-panel-md ol { margin: 0 0 10px; padding-left: 22px; }
.dsh-doc-panel-md li { margin: 2px 0; }
.dsh-doc-panel-md li > ul,
.dsh-doc-panel-md li > ol { margin: 2px 0; }
.dsh-doc-panel-md__pre {
  margin: 0 0 12px;
  padding: 10px 12px;
  overflow: auto;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-1);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre;
}
.dsh-doc-panel-md__code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}
.dsh-doc-panel-md__code-inline {
  padding: 1px 4px;
  border-radius: 4px;
  background: var(--dsw-alias-bg-layer-1);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}
.dsh-doc-panel-md__quote {
  margin: 0 0 12px;
  padding: 2px 0 2px 12px;
  border-left: 2px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-secondary);
}
.dsh-doc-panel-md__quote > :last-child { margin-bottom: 0; }
.dsh-doc-panel-md__hr { margin: 16px 0; border: 0; border-top: 1px solid var(--dsw-alias-border-l1); }
.dsh-doc-panel-md__tablewrap { margin: 0 0 12px; overflow-x: auto; }
.dsh-doc-panel-md__table { border-collapse: collapse; font-size: 12px; }
.dsh-doc-panel-md__table th,
.dsh-doc-panel-md__table td {
  padding: 5px 10px;
  border: 1px solid var(--dsw-alias-border-l1);
  text-align: left;
  vertical-align: top;
}
.dsh-doc-panel-md__table th { background: var(--dsw-alias-bg-layer-1); font-weight: 600; }
.dsh-doc-panel-md a { color: var(--dsw-alias-brand-primary); text-decoration: none; }
.dsh-doc-panel-md a:hover { text-decoration: underline; }
.dsh-doc-panel-md strong { font-weight: 600; }
.dsh-doc-panel-md em { font-style: italic; }
.dsh-doc-panel-md del { color: var(--dsw-alias-label-secondary); }
.dsh-doc-panel-md__img { display: block; max-width: 100%; height: auto; margin: 8px 0; border-radius: 6px; }
.dsh-doc-panel-md__img-alt { color: var(--dsw-alias-label-secondary); font-style: italic; }

.dsh-doc-panel__bincard {
  align-self: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  max-width: 440px;
  margin: auto;
  padding: 24px;
  text-align: center;
}
.dsh-doc-panel__binname { font-size: 14px; font-weight: 600; overflow-wrap: anywhere; }
.dsh-doc-panel__binpath { color: var(--dsw-alias-label-secondary); font-size: 11px; overflow-wrap: anywhere; }
.dsh-doc-panel__binhint { color: var(--dsw-alias-label-secondary); font-size: 12px; }

.dsh-doc-panel__btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
  padding: 5px 12px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
  line-height: 18px;
  text-decoration: none;
  cursor: pointer;
}
.dsh-doc-panel__btn:hover { border-color: var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); }

.dsh-doc-panel__banner {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 8px 12px 0;
  padding: 6px 10px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-1);
  font-size: 12px;
}
.dsh-doc-panel__banner-text {
  flex: 1 1 auto;
  overflow: hidden;
  color: var(--dsw-alias-state-warn-primary);
  white-space: nowrap;
  text-overflow: ellipsis;
}
.dsh-doc-panel__banner-action {
  flex: 0 0 auto;
  padding: 2px 6px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--dsw-alias-brand-primary);
  font-size: 12px;
  cursor: pointer;
}
.dsh-doc-panel__banner-action:hover { background: var(--dsw-alias-bg-layer-2); }

.dsh-doc-panel__state {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  min-height: 0;
  padding: 40px 24px;
  text-align: center;
}
.dsh-doc-panel__state-title { font-size: 14px; font-weight: 600; }
.dsh-doc-panel__state--error .dsh-doc-panel__state-title { color: var(--dsw-alias-state-error-primary); }
.dsh-doc-panel__state-text {
  max-width: 420px;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.dsh-doc-panel__hint { padding: 16px 12px; color: var(--dsw-alias-label-secondary); font-size: 12px; text-align: center; }

.dsh-doc-panel__spinner {
  width: 18px;
  height: 18px;
  border: 2px solid var(--dsw-alias-border-l1);
  border-top-color: var(--dsw-alias-brand-primary);
  border-radius: 50%;
  animation: dsh-doc-panel-spin .9s linear infinite;
}
@keyframes dsh-doc-panel-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .dsh-doc-panel__spinner,
  .dsh-doc-panel__spin { animation: none; }
}

/* =====================================================================
   Dashboard layout — cards, KPI tiles, donuts, conversation card grid.
   Appended after the base rules so these declarations win.
   ===================================================================== */
.dsh-doc-panel {
  display: block;
  height: 100%;
  min-height: 320px;
  padding: 16px 18px 28px;
  overflow-x: hidden;
  overflow-y: auto;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 1.5;
}
.dsh-doc-panel__page {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 1320px;
  min-width: 0;
  margin: 0 auto;
}

/* top bar */
.dsh-doc-panel__topbar { display: flex; align-items: flex-start; gap: 16px; flex-wrap: wrap; }
.dsh-doc-panel__topbar-main { min-width: 0; }
.dsh-doc-panel__title { margin: 0; font-size: 20px; font-weight: 650; letter-spacing: -0.02em; line-height: 1.25; }
.dsh-doc-panel__subtitle { margin-top: 3px; color: var(--dsw-alias-label-secondary); font-size: 12px; overflow-wrap: anywhere; }
.dsh-doc-panel__toolbar { display: flex; align-items: center; gap: 8px; margin-left: auto; flex-wrap: wrap; min-width: 0; }
.dsh-doc-panel__search {
  width: 280px;
  max-width: 100%;
  height: 34px;
  padding: 0 12px 0 31px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  outline: none;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font-size: 12.5px;
  transition: border-color .15s ease, background .15s ease, box-shadow .15s ease;
}
.dsh-doc-panel__search::placeholder { color: var(--dsw-alias-label-secondary); }
.dsh-doc-panel__search:hover:not(:disabled) { border-color: var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); }
.dsh-doc-panel__search:focus { border-color: var(--dsw-alias-brand-primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent); }
.dsh-doc-panel__search-icon { left: 11px; }
.dsh-doc-panel__segmented {
  display: inline-flex;
  padding: 2px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
}
.dsh-doc-panel__segmented-btn {
  padding: 4px 12px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 20px;
  cursor: pointer;
}
.dsh-doc-panel__segmented-btn:hover { color: var(--dsw-alias-label-primary); }
.dsh-doc-panel__segmented-btn.is-active {
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent);
  color: var(--dsw-alias-brand-primary);
  font-weight: 500;
}
.dsh-doc-panel__iconbtn {
  width: 34px;
  height: 34px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
}
.dsh-doc-panel__iconbtn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }

/* KPI tiles */
.dsh-doc-panel__kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.dsh-doc-panel__kpi {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  padding: 14px 16px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1);
  box-shadow: 0 1px 2px color-mix(in srgb, var(--dsw-alias-label-primary) 7%, transparent);
}
.dsh-doc-panel__kpi-label { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dsh-doc-panel__kpi-value {
  font-size: 26px;
  font-weight: 650;
  line-height: 1.25;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
}
.dsh-doc-panel__kpi-sub {
  overflow: hidden;
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.dsh-doc-panel__spark { display: flex; align-items: flex-end; gap: 3px; height: 30px; margin-top: 6px; }
.dsh-doc-panel__spark__bar {
  flex: 1 1 0;
  min-height: 2px;
  border-radius: 2px;
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 25%, transparent);
}
.dsh-doc-panel__spark__bar.is-today { background: var(--dsw-alias-brand-primary); }

/* body grid */
.dsh-doc-panel__grid { display: grid; grid-template-columns: 320px minmax(0, 1fr); gap: 16px; align-items: start; min-width: 0; }
.dsh-doc-panel__left,
.dsh-doc-panel__right { display: flex; flex-direction: column; gap: 12px; min-width: 0; }

/* generic cards */
.dsh-doc-panel__card {
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1);
  box-shadow: 0 1px 2px color-mix(in srgb, var(--dsw-alias-label-primary) 7%, transparent);
}
.dsh-doc-panel__card-head { display: flex; align-items: center; gap: 8px; padding: 12px 14px 10px; }
.dsh-doc-panel__card-title { flex: 1 1 auto; min-width: 0; overflow: hidden; font-size: 13px; font-weight: 600; white-space: nowrap; text-overflow: ellipsis; }
.dsh-doc-panel__pillcount {
  flex: 0 0 auto;
  min-width: 20px;
  padding: 0 7px;
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  line-height: 18px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}
.dsh-doc-panel__card-empty { padding: 4px 14px 16px; color: var(--dsw-alias-label-secondary); font-size: 11.5px; overflow-wrap: anywhere; }
.dsh-doc-panel__card-link {
  width: 100%;
  padding: 9px 14px;
  border: 0;
  border-top: 1px solid var(--dsw-alias-border-l1);
  background: transparent;
  color: var(--dsw-alias-brand-primary);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.dsh-doc-panel__card-link:hover { background: var(--dsw-alias-bg-layer-2); }

/* left-column mini lists */
.dsh-doc-panel__mini-list { display: flex; flex-direction: column; }
.dsh-doc-panel__mini-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 14px;
  border: 0;
  border-top: 1px solid var(--dsw-alias-border-l1);
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.dsh-doc-panel__mini-row:first-child { border-top: 0; }
.dsh-doc-panel__mini-row:hover { background: var(--dsw-alias-bg-layer-2); }
.dsh-doc-panel__mini-row.is-disabled { opacity: .55; cursor: default; }
.dsh-doc-panel__mini-row.is-disabled:hover { background: transparent; }
.dsh-doc-panel__mini-main { flex: 1 1 auto; display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.dsh-doc-panel__mini-name { overflow: hidden; font-size: 12px; white-space: nowrap; text-overflow: ellipsis; }
.dsh-doc-panel__mini-sub { overflow: hidden; color: var(--dsw-alias-label-secondary); font-size: 10.5px; white-space: nowrap; text-overflow: ellipsis; }
.dsh-doc-panel__dot { flex: 0 0 auto; width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-brand-primary); }

/* document-type donut + legend */
.dsh-doc-panel__types-body { display: flex; align-items: center; gap: 14px; padding: 4px 14px 16px; min-width: 0; }
.dsh-doc-panel__donut { position: relative; flex: 0 0 auto; display: flex; align-items: center; justify-content: center; }
.dsh-doc-panel__donut svg { display: block; }
.dsh-doc-panel__donut__center { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; pointer-events: none; }
.dsh-doc-panel__donut__value { font-size: 16px; font-weight: 650; line-height: 1.1; font-variant-numeric: tabular-nums; }
.dsh-doc-panel__donut__label { margin-top: 1px; color: var(--dsw-alias-label-secondary); font-size: 9px; }
.dsh-doc-panel__donut--compact .dsh-doc-panel__donut__value { font-size: 13px; }
.dsh-doc-panel__donut--compact .dsh-doc-panel__donut__label { font-size: 8px; }
.dsh-doc-panel__legend { flex: 1 1 auto; display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.dsh-doc-panel__legend-row { display: grid; grid-template-columns: 8px minmax(0, 1fr) auto auto; align-items: center; gap: 7px; font-size: 11.5px; }
.dsh-doc-panel__legend-dot { width: 8px; height: 8px; border-radius: 2px; }
.dsh-doc-panel__legend-name { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.dsh-doc-panel__legend-count { font-weight: 600; font-variant-numeric: tabular-nums; }
.dsh-doc-panel__legend-pct { min-width: 32px; color: var(--dsw-alias-label-secondary); text-align: right; font-variant-numeric: tabular-nums; }

/* conversation section header: title + type filter chips + sort */
.dsh-doc-panel__section-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; min-width: 0; padding: 2px 2px 0; }
.dsh-doc-panel__section-titles { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.dsh-doc-panel__section-title { font-size: 15px; font-weight: 650; }
.dsh-doc-panel__section-sub { color: var(--dsw-alias-label-secondary); font-size: 12px; font-variant-numeric: tabular-nums; }
.dsh-doc-panel__section-controls { display: flex; align-items: center; gap: 8px; margin-left: auto; flex-wrap: wrap; min-width: 0; }
.dsh-doc-panel__filterchips { display: flex; flex-wrap: wrap; gap: 5px; }
.dsh-doc-panel__chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 9px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  line-height: 16px;
  cursor: pointer;
}
.dsh-doc-panel__chip:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.dsh-doc-panel__chip.is-active {
  border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 45%, var(--dsw-alias-border-l1));
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, transparent);
  color: var(--dsw-alias-brand-primary);
}
.dsh-doc-panel__chip-dot { width: 7px; height: 7px; border-radius: 50%; }
.dsh-doc-panel__chip.is-static { cursor: default; }
.dsh-doc-panel__chip.is-static:hover { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary); }
.dsh-doc-panel__right-main { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.dsh-doc-panel__card.dsh-doc-panel__card-empty { padding: 24px 14px; }
.dsh-doc-panel__sort {
  height: 28px;
  padding: 0 8px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 999px;
  outline: none;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font-size: 11.5px;
  cursor: pointer;
}

/* conversation card grid */
.dsh-doc-panel__convgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px; }
.dsh-doc-panel__convcard {
  display: flex;
  flex-direction: column;
  gap: 9px;
  min-width: 0;
  padding: 13px 14px 12px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1);
  box-shadow: 0 1px 2px color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent);
  cursor: pointer;
  transition: border-color .15s ease, box-shadow .15s ease;
}
.dsh-doc-panel__convcard:hover {
  border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 45%, var(--dsw-alias-border-l1));
  box-shadow: 0 2px 8px color-mix(in srgb, var(--dsw-alias-label-primary) 9%, transparent);
}
.dsh-doc-panel__convcard-head { display: flex; align-items: flex-start; gap: 8px; min-width: 0; }
.dsh-doc-panel__convcard-icon { flex: 0 0 auto; display: inline-flex; margin-top: 1px; color: var(--dsw-alias-label-secondary); }
.dsh-doc-panel__convcard-title {
  flex: 1 1 auto;
  min-width: 0;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.4;
}
.dsh-doc-panel__convcard-time {
  flex: 0 0 auto;
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  text-align: right;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.dsh-doc-panel__convcard-date { color: var(--dsw-alias-label-secondary); font-size: 10px; opacity: .85; }
.dsh-doc-panel__workspace {
  align-self: flex-start;
  max-width: 100%;
  padding: 1px 8px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
  font-size: 10.5px;
  line-height: 18px;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.dsh-doc-panel__convcard-body { display: flex; align-items: center; gap: 12px; min-width: 0; }
.dsh-doc-panel__stats { flex: 1 1 auto; display: grid; grid-template-columns: 1fr 1fr; gap: 3px 10px; min-width: 0; }
.dsh-doc-panel__statline { display: flex; align-items: baseline; gap: 5px; min-width: 0; color: var(--dsw-alias-label-secondary); font-size: 10.5px; white-space: nowrap; }
.dsh-doc-panel__statline b { color: var(--dsw-alias-label-primary); font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; }
.dsh-doc-panel__chips { display: flex; flex-wrap: wrap; gap: 5px; }
.dsh-doc-panel__convcard-foot {
  padding-top: 8px;
  overflow: hidden;
  border-top: 1px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  white-space: nowrap;
  text-overflow: ellipsis;
}

/* folder view card */
.dsh-doc-panel__folderhead { display: flex; align-items: flex-start; gap: 10px; flex-wrap: wrap; padding: 14px 16px 10px; min-width: 0; }
.dsh-doc-panel__foldertitles { flex: 1 1 260px; min-width: 0; }
.dsh-doc-panel__foldertitle { overflow-wrap: anywhere; font-size: 16px; font-weight: 650; line-height: 1.35; }
.dsh-doc-panel__foldermeta { margin-top: 2px; color: var(--dsw-alias-label-secondary); font-size: 12px; overflow-wrap: anywhere; }
.dsh-doc-panel__folderhead .dsh-doc-panel__foldermeta { margin-left: auto; margin-top: 0; text-align: right; }
.dsh-doc-panel__foldertags { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 16px 12px; }
.dsh-doc-panel__back { padding: 5px 9px; border-radius: 8px; }

/* favorites card grid */
.dsh-doc-panel__docgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; padding: 14px; }
.dsh-doc-panel__doccard {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  padding: 12px 14px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  text-align: left;
  cursor: pointer;
  transition: border-color .15s ease, box-shadow .15s ease;
}
.dsh-doc-panel__doccard:hover {
  border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 45%, var(--dsw-alias-border-l1));
  box-shadow: 0 2px 8px color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent);
}
.dsh-doc-panel__doccard.is-unavailable { opacity: .55; cursor: default; }
.dsh-doc-panel__doccard.is-unavailable:hover { border-color: var(--dsw-alias-border-l1); box-shadow: none; }
.dsh-doc-panel__doccard-kind {
  display: inline-flex;
  align-items: center;
  align-self: flex-start;
  min-width: 30px;
  padding: 1px 6px;
  border-radius: 6px;
  font-size: 10px;
  font-weight: 650;
  line-height: 18px;
  letter-spacing: .04em;
  text-align: center;
}
.dsh-doc-panel__doccard-star { position: absolute; top: 8px; right: 8px; }
.dsh-doc-panel__doccard-name {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  padding-right: 26px;
  font-size: 12.5px;
  font-weight: 600;
  line-height: 1.4;
  overflow-wrap: anywhere;
}
.dsh-doc-panel__doccard-meta { display: flex; align-items: center; gap: 8px; color: var(--dsw-alias-label-secondary); font-size: 11px; font-variant-numeric: tabular-nums; }
.dsh-doc-panel__doccard-note { color: var(--dsw-alias-state-warn-primary); font-size: 11px; }

/* preview card */
.dsh-doc-panel__previewcard { display: flex; flex-direction: column; height: 72vh; min-height: 440px; }
.dsh-doc-panel__previewcard .dsh-doc-panel__preview { flex: 1 1 auto; min-height: 0; }
.dsh-doc-panel__previewcard .dsh-doc-panel__preview-head { padding: 10px 14px; }

/* tables inside cards */
.dsh-doc-panel__tablewrap { border-top: 1px solid var(--dsw-alias-border-l1); }
.dsh-doc-panel__thead { background: var(--dsw-alias-bg-layer-1); }
.dsh-doc-panel__row:hover { background: var(--dsw-alias-bg-layer-2); }
.dsh-doc-panel__searchcard-head { display: flex; align-items: baseline; gap: 8px; padding: 12px 16px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dsh-doc-panel__searchcard-title { font-size: 13px; font-weight: 600; }
.dsh-doc-panel__searchcard-sub { color: var(--dsw-alias-label-secondary); font-size: 12px; font-variant-numeric: tabular-nums; }
.dsh-doc-panel__searchcard-empty { padding: 28px 16px; color: var(--dsw-alias-label-secondary); font-size: 12px; text-align: center; }

/* states inside a card */
.dsh-doc-panel__statecard { display: flex; align-items: center; justify-content: center; min-height: 240px; padding: 8px; }
.dsh-doc-panel__statecard .dsh-doc-panel__state { padding: 36px 20px; }
.dsh-doc-panel__banner { margin: 0; }

@media (max-width: 1100px) {
  .dsh-doc-panel__kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 980px) {
  .dsh-doc-panel__grid { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 640px) {
  .dsh-doc-panel { padding: 12px 12px 22px; }
  .dsh-doc-panel__toolbar { width: 100%; }
  .dsh-doc-panel__search { flex: 1 1 160px; width: auto; }
  .dsh-doc-panel__kpis { grid-template-columns: minmax(0, 1fr); }
  .dsh-doc-panel__convgrid { grid-template-columns: minmax(0, 1fr); }
  .dsh-doc-panel__docgrid { grid-template-columns: minmax(0, 1fr); }
}
`;

    // ---------------------------------------------------------------------
    // Icons
    // ---------------------------------------------------------------------
    function SidebarIcon(props) {
      const owner = props || {};
      const size = typeof owner.size === 'number' && owner.size > 0 ? owner.size : 20;
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        'aria-hidden': true,
        style: {
          display: 'block',
          color: owner.active ? 'var(--dsw-alias-brand-primary)' : 'currentColor',
        },
      },
        h('path', {
          d: 'M6.4 3.9h6.6l4.6 4.6v10.4a1.3 1.3 0 0 1-1.3 1.3H6.4a1.3 1.3 0 0 1-1.3-1.3V5.2a1.3 1.3 0 0 1 1.3-1.3Z',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M12.9 4.1v3.6a.9.9 0 0 0 .9.9h3.6',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M8.2 12.2h6.2M8.2 15.4h4.2',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
        })
      );
    }

    function SearchIcon() {
      return h('svg', {
        className: 'dsh-doc-panel__search-icon',
        viewBox: '0 0 16 16',
        width: 12,
        height: 12,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        'aria-hidden': true,
      },
        h('circle', { cx: 7, cy: 7, r: 4.5 }),
        h('path', { d: 'M10.5 10.5 14 14', strokeLinecap: 'round' })
      );
    }

    function RefreshIcon(props) {
      const owner = props || {};
      return h('svg', {
        className: owner.spinning ? 'dsh-doc-panel__spin' : undefined,
        viewBox: '0 0 24 24',
        width: 14,
        height: 14,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
      },
        h('path', { d: 'M20.5 12a8.5 8.5 0 1 1-2.49-6.01' }),
        h('path', { d: 'M20.5 4.5v6h-6' })
      );
    }

    function BackIcon() {
      return h('svg', {
        viewBox: '0 0 16 16',
        width: 12,
        height: 12,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
      },
        h('path', { d: 'M9.5 3.5 5 8l4.5 4.5' })
      );
    }

    function StarIcon(props) {
      const owner = props || {};
      return h('svg', {
        viewBox: '0 0 24 24',
        width: owner.size || 14,
        height: owner.size || 14,
        fill: owner.filled ? 'currentColor' : 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinejoin: 'round',
        'aria-hidden': true,
      },
        h('path', {
          d: 'M12 3.6l2.6 5.27 5.82.85-4.21 4.1.99 5.8L12 16.88l-5.2 2.74.99-5.8-4.21-4.1 5.82-.85L12 3.6Z',
        })
      );
    }

    function FolderIcon() {
      return h('svg', {
        viewBox: '0 0 20 20',
        width: 15,
        height: 15,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinejoin: 'round',
        'aria-hidden': true,
      },
        h('path', {
          d: 'M3 5.5A1.5 1.5 0 0 1 4.5 4h3l1.5 1.8h6.5A1.5 1.5 0 0 1 17 7.3v7.2a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 14.5v-9Z',
        })
      );
    }

    // ---------------------------------------------------------------------
    // Charts — pure SVG donuts/rings and a CSS bar sparkline (no libraries).
    // ---------------------------------------------------------------------
    function DonutChart(props) {
      const owner = props || {};
      const segments = asArray(owner.segments);
      const size = typeof owner.size === 'number' && owner.size > 0 ? owner.size : 120;
      const thickness = typeof owner.thickness === 'number' && owner.thickness > 0 ? owner.thickness : 12;
      const box = 100;
      const radius = (box - thickness) / 2;
      const circumference = 2 * Math.PI * radius;
      let total = 0;
      segments.forEach(function (segment) { total += asNumber(segment.count); });
      const circles = [];
      let offset = 0;
      if (total > 0) {
        segments.forEach(function (segment, index) {
          const count = asNumber(segment.count);
          if (count <= 0) return;
          const length = (count / total) * circumference;
          circles.push(h('circle', {
            key: 'seg-' + (segment.key || index),
            cx: box / 2,
            cy: box / 2,
            r: radius,
            fill: 'none',
            stroke: segment.color || KIND_COLORS.other,
            strokeWidth: thickness,
            strokeDasharray: length + ' ' + Math.max(0, circumference - length),
            strokeDashoffset: -offset,
            transform: 'rotate(-90 ' + (box / 2) + ' ' + (box / 2) + ')',
          }));
          offset += length;
        });
      }
      return h('div', {
        className: 'dsh-doc-panel__donut' + (owner.compact ? ' dsh-doc-panel__donut--compact' : ''),
        style: { width: size, height: size },
        role: 'img',
        'aria-label': owner.ariaLabel || owner.centerLabel || '',
      },
        h('svg', { viewBox: '0 0 ' + box + ' ' + box, width: size, height: size, 'aria-hidden': true },
          h('circle', {
            cx: box / 2,
            cy: box / 2,
            r: radius,
            fill: 'none',
            stroke: 'var(--dsw-alias-bg-layer-2)',
            strokeWidth: thickness,
          }),
          circles
        ),
        h('div', { className: 'dsh-doc-panel__donut__center' },
          h('span', { className: 'dsh-doc-panel__donut__value' }, String(owner.centerValue === undefined ? total : owner.centerValue)),
          owner.centerLabel ? h('span', { className: 'dsh-doc-panel__donut__label' }, owner.centerLabel) : null
        )
      );
    }

    function Sparkline(props) {
      const owner = props || {};
      const days = asArray(owner.days);
      let max = 0;
      days.forEach(function (day) { max = Math.max(max, asNumber(day.count)); });
      if (max < 1) max = 1;
      const bars = days.map(function (day, index) {
        const count = asNumber(day.count);
        const pct = count <= 0 ? 8 : Math.max(14, Math.round((count / max) * 100));
        return h('span', {
          key: 'spark-' + index,
          className: 'dsh-doc-panel__spark__bar' + (index === days.length - 1 ? ' is-today' : ''),
          style: { height: pct + '%' },
          title: tt('kpi.sparklineBar', { date: day.label, count: count }),
        });
      });
      return h('div', { className: 'dsh-doc-panel__spark', role: 'img', 'aria-label': owner.ariaLabel || '' }, bars);
    }

    // ---------------------------------------------------------------------
    // Main panel
    // ---------------------------------------------------------------------
    function DocPanel() {
      const [loading, setLoading] = React.useState(true);
      const [index, setIndex] = React.useState(null);
      const [error, setError] = React.useState('');
      const [slow, setSlow] = React.useState(false);
      const [query, setQuery] = React.useState('');
      const [selection, setSelection] = React.useState(null);
      const [preview, setPreview] = React.useState(null);
      const [favorites, setFavorites] = React.useState([]);
      const [favoritesAvailable, setFavoritesAvailable] = React.useState(false);
      const [favoritesError, setFavoritesError] = React.useState('');
      const [tab, setTab] = React.useState('all');
      const [activeKind, setActiveKind] = React.useState('all');
      const [sort, setSort] = React.useState('updated');

      const alive = React.useRef(true);
      const loadSeq = React.useRef(0);
      const previewSeq = React.useRef(0);
      const toggleSeq = React.useRef(0);

      const runLoad = React.useCallback(function (refresh) {
        loadSeq.current += 1;
        const seq = loadSeq.current;
        setLoading(true);
        setError('');
        requestJson('api/dsh-doc-panel/list', refresh === true ? { refresh: true } : {}).then(function (value) {
          if (!alive.current || loadSeq.current !== seq) return;
          setIndex(normalizeIndex(value));
          setLoading(false);
        }).catch(function (err) {
          if (!alive.current || loadSeq.current !== seq) return;
          setLoading(false);
          setError(messageOf(err));
        });
      }, []);

      const loadFavorites = React.useCallback(function () {
        requestJson('api/dsh-doc-panel/favorites', {}).then(function (value) {
          if (!alive.current) return;
          setFavorites(normalizeFavorites(value));
          setFavoritesAvailable(true);
          setFavoritesError('');
        }).catch(function (err) {
          if (!alive.current) return;
          setFavoritesError(messageOf(err));
        });
      }, []);

      const refreshAll = React.useCallback(function () {
        runLoad(true);
        loadFavorites();
      }, [runLoad, loadFavorites]);

      React.useEffect(function () {
        alive.current = true;
        runLoad(false);
        loadFavorites();
        return function () { alive.current = false; };
      }, [runLoad, loadFavorites]);

      // The first scan can take a while; reveal the explanatory hint only then.
      React.useEffect(function () {
        if (!loading) {
          setSlow(false);
          return undefined;
        }
        const timer = setTimeout(function () { setSlow(true); }, 1500);
        return function () { clearTimeout(timer); };
      }, [loading]);

      // Drop a folder selection whose conversation disappeared after a refresh.
      React.useEffect(function () {
        if (!index || !selection) return;
        const stillThere = index.conversations.some(function (conversation) { return conversation.id === selection; });
        if (!stillThere) {
          setSelection(null);
          setPreview(null);
        }
      }, [index, selection]);

      const needle = query.trim().toLowerCase();

      const searchResults = React.useMemo(function () {
        const search = query.trim().toLowerCase();
        if (!search) return [];
        const rows = [];
        const conversations = index ? index.conversations : [];
        conversations.forEach(function (conversation) {
          const titleHit = conversation.title.toLowerCase().indexOf(search) !== -1;
          conversation.docs.forEach(function (doc) {
            const docHit = (doc.name + ' ' + doc.relPath).toLowerCase().indexOf(search) !== -1;
            if (titleHit || docHit) rows.push({ doc: doc, conversation: conversation });
          });
        });
        return rows;
      }, [index, query]);

      const favoriteMap = React.useMemo(function () {
        const map = {};
        favorites.forEach(function (favorite) { map[favoriteKey(favorite.path)] = favorite; });
        return map;
      }, [favorites]);

      const selectedConversation = React.useMemo(function () {
        if (!index || !selection) return null;
        for (let i = 0; i < index.conversations.length; i += 1) {
          if (index.conversations[i].id === selection) return index.conversations[i];
        }
        return null;
      }, [index, selection]);

      // Every KPI / donut / sparkline value comes from this one derivation pass.
      const dashboard = React.useMemo(function () {
        const conversations = index ? index.conversations : [];
        const allDocs = [];
        const kindTotals = {};
        conversations.forEach(function (conversation) {
          conversation.docs.forEach(function (doc) {
            const key = kindKey(doc.kind, doc.ext);
            kindTotals[key] = (kindTotals[key] || 0) + 1;
            allDocs.push({ doc: doc, conversation: conversation });
          });
        });
        allDocs.sort(function (a, b) { return (b.doc.mtime || 0) - (a.doc.mtime || 0); });
        const kinds = Object.keys(kindTotals).map(function (key) {
          return { key: key, count: kindTotals[key], color: kindColor(key) };
        }).sort(function (a, b) {
          if (b.count !== a.count) return b.count - a.count;
          return a.key < b.key ? -1 : 1;
        });

        const dayMs = 86400000;
        const today = new Date(Date.now());
        today.setHours(0, 0, 0, 0);
        const todayStart = today.getTime();
        const days = [];
        for (let i = 6; i >= 0; i -= 1) {
          const start = todayStart - i * dayMs;
          days.push({
            start: start,
            end: start + dayMs,
            count: 0,
            label: new Date(start).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' }),
          });
        }
        let weekly = 0;
        allDocs.forEach(function (entry) {
          const mtime = entry.doc.mtime;
          if (!mtime) return;
          if (mtime >= days[0].start) weekly += 1;
          for (let i = 0; i < days.length; i += 1) {
            if (mtime >= days[i].start && mtime < days[i].end) {
              days[i].count += 1;
              break;
            }
          }
        });

        let latestUpdate = 0;
        let latestFavorite = 0;
        allDocs.forEach(function (entry) { latestUpdate = Math.max(latestUpdate, entry.doc.mtime || 0); });
        favorites.forEach(function (favorite) { latestFavorite = Math.max(latestFavorite, favorite.addedAt || 0); });

        const favoriteKeys = {};
        favorites.forEach(function (favorite) { favoriteKeys[favoriteKey(favorite.path)] = true; });
        let conversationsWithFavorites = 0;
        conversations.forEach(function (conversation) {
          const has = conversation.docs.some(function (doc) { return !!favoriteKeys[favoriteKey(doc.path)]; });
          if (has) conversationsWithFavorites += 1;
        });

        return {
          conversations: conversations,
          totalDocuments: allDocs.length,
          kinds: kinds,
          days: days,
          weekly: weekly,
          latestUpdate: latestUpdate,
          latestFavorite: latestFavorite,
          conversationsWithFavorites: conversationsWithFavorites,
          recent: allDocs.slice(0, 5),
        };
      }, [index, favorites]);

      // Conversation cards honour the search query, the type-filter chips and sort.
      const conversationCards = React.useMemo(function () {
        let list = index ? index.conversations.slice() : [];
        if (needle) {
          list = list.filter(function (conversation) {
            if (conversation.title.toLowerCase().indexOf(needle) !== -1) return true;
            return conversation.docs.some(function (doc) {
              return (doc.name + ' ' + doc.relPath).toLowerCase().indexOf(needle) !== -1;
            });
          });
        }
        if (activeKind !== 'all') {
          list = list.filter(function (conversation) { return !!conversation.byKind[activeKind]; });
        }
        if (sort === 'count') {
          list.sort(function (a, b) { return b.docs.length - a.docs.length || b.updatedAt - a.updatedAt; });
        } else if (sort === 'name') {
          list.sort(function (a, b) { return a.title.localeCompare(b.title); });
        } else {
          list.sort(function (a, b) { return b.updatedAt - a.updatedAt; });
        }
        return list;
      }, [index, needle, activeKind, sort]);

      function isFavorited(filePath) {
        return !!favoriteMap[favoriteKey(filePath)];
      }

      function findFavorite(filePath) {
        return favoriteMap[favoriteKey(filePath)] || null;
      }

      function openFolder(id) {
        previewSeq.current += 1;
        setTab('all');
        setSelection(id);
        setPreview(null);
      }

      function closeFolder() {
        previewSeq.current += 1;
        setSelection(null);
        setPreview(null);
      }

      function selectTab(mode) {
        previewSeq.current += 1;
        setTab(mode === 'favorites' ? 'favorites' : 'all');
        setSelection(null);
        setPreview(null);
      }

      function closePreview() {
        previewSeq.current += 1;
        setPreview(null);
      }

      function previewKind(doc) {
        return doc ? kindKey(doc.kind, doc.ext) : 'other';
      }

      function targetForDoc(doc, conversation) {
        const existing = findFavorite(doc.path);
        return {
          path: doc.path,
          name: doc.name,
          conversationId: conversation ? conversation.id : (existing ? existing.conversationId : ''),
          conversationTitle: conversation ? conversation.title : (existing ? existing.conversationTitle : ''),
          kind: doc.kind || extOf(doc.name) || 'other',
          size: doc.size,
          mtime: doc.mtime,
        };
      }

      function targetForFavorite(favorite) {
        return {
          path: favorite.path,
          name: favorite.name,
          conversationId: favorite.conversationId,
          conversationTitle: favorite.conversationTitle,
          kind: favorite.kind,
          size: favorite.size,
          mtime: favorite.mtime,
        };
      }

      function docFromFavorite(favorite) {
        const ext = extOf(favorite.name);
        return {
          path: favorite.path,
          relPath: favorite.path,
          name: favorite.name,
          ext: ext,
          kind: favorite.kind || ext || 'other',
          size: favorite.size,
          mtime: favorite.mtime,
          delivered: false,
          authored: false,
        };
      }

      function toggleFavorite(target) {
        if (!target || !favoritesAvailable) return;
        const key = favoriteKey(target.path);
        const wasFavorited = !!favoriteMap[key];
        const previous = favorites;
        toggleSeq.current += 1;
        const seq = toggleSeq.current;
        setFavoritesError('');
        // Optimistic update first; the Host response replaces the whole list.
        if (wasFavorited) {
          setFavorites(previous.filter(function (favorite) { return favoriteKey(favorite.path) !== key; }));
        } else {
          setFavorites([{
            path: target.path,
            name: target.name,
            conversationId: target.conversationId,
            conversationTitle: target.conversationTitle,
            addedAt: Date.now(),
            available: true,
            kind: target.kind || extOf(target.name) || 'other',
            size: target.size,
            mtime: target.mtime,
          }].concat(previous));
        }
        requestJson('api/dsh-doc-panel/favorites/toggle', {
          path: target.path,
          name: target.name,
          conversationId: target.conversationId,
          conversationTitle: target.conversationTitle,
        }).then(function (value) {
          if (!alive.current || toggleSeq.current !== seq) return;
          setFavorites(normalizeFavorites(value));
          setFavoritesAvailable(true);
        }).catch(function (err) {
          if (!alive.current || toggleSeq.current !== seq) return;
          setFavorites(previous);
          setFavoritesError(messageOf(err));
          loadFavorites();
        });
      }

      function loadPreview(doc, mode, target) {
        previewSeq.current += 1;
        const seq = previewSeq.current;
        const kind = previewKind(doc);
        const renderMode = mode === 'source' ? 'source' : 'render';
        const payload = target || targetForDoc(doc, null);
        // HTML renders straight from the raw route inside a sandboxed iframe, so
        // a ~2 MB report is neither truncated by /read nor inlined here.
        if (renderMode === 'render' && kind === 'html') {
          setPreview({ doc: doc, target: payload, mode: renderMode, status: 'ready', value: null, error: '' });
          return;
        }
        setPreview({ doc: doc, target: payload, mode: renderMode, status: 'loading', value: null, error: '' });
        requestJson('api/dsh-doc-panel/read', { path: doc.path }).then(function (value) {
          if (!alive.current || previewSeq.current !== seq) return;
          setPreview({ doc: doc, target: payload, mode: renderMode, status: 'ready', value: normalizeRead(value), error: '' });
        }).catch(function (err) {
          if (!alive.current || previewSeq.current !== seq) return;
          setPreview({ doc: doc, target: payload, mode: renderMode, status: 'error', value: null, error: messageOf(err) });
        });
      }

      function openDocument(doc, target) {
        loadPreview(doc, 'render', target);
      }

      function switchPreviewMode(mode) {
        if (!preview || preview.mode === mode) return;
        const doc = preview.doc;
        if (mode === 'render' && previewKind(doc) === 'html') {
          loadPreview(doc, 'render', preview.target);
          return;
        }
        if (preview.value) {
          setPreview({ doc: doc, target: preview.target, mode: mode, status: 'ready', value: preview.value, error: preview.error });
          return;
        }
        loadPreview(doc, mode, preview.target);
      }

      function actionButton(label, onClick) {
        return h('button', { type: 'button', className: 'dsh-doc-panel__btn', onClick: onClick }, label);
      }

      function renderState(kind, title, text, extra) {
        return h('div', { className: 'dsh-doc-panel__state' + (kind === 'error' ? ' dsh-doc-panel__state--error' : '') },
          kind === 'loading' ? h('span', { className: 'dsh-doc-panel__spinner', 'aria-hidden': true }) : null,
          h('div', { className: 'dsh-doc-panel__state-title' }, title),
          text ? h('div', { className: 'dsh-doc-panel__state-text' }, text) : null,
          extra || null
        );
      }

      function renderBanner() {
        return h('div', { className: 'dsh-doc-panel__banner' },
          h('span', { className: 'dsh-doc-panel__banner-text', title: error }, t('state.refreshFailed') + ' · ' + error),
          h('button', {
            type: 'button',
            className: 'dsh-doc-panel__banner-action',
            onClick: function () { refreshAll(); },
          }, t('state.retry'))
        );
      }

      function renderFavoritesErrorBanner() {
        return h('div', { className: 'dsh-doc-panel__banner' },
          h('span', { className: 'dsh-doc-panel__banner-text', title: favoritesError },
            t('fav.error') + ' · ' + favoritesError),
          h('button', {
            type: 'button',
            className: 'dsh-doc-panel__banner-action',
            onClick: function () { loadFavorites(); },
          }, t('state.retry'))
        );
      }

      function kindSegments(conversation) {
        const entries = Object.keys(conversation.byKind).map(function (key) {
          return { key: key, count: conversation.byKind[key], color: kindColor(key) };
        });
        entries.sort(function (a, b) {
          if (b.count !== a.count) return b.count - a.count;
          return a.key < b.key ? -1 : 1;
        });
        return entries;
      }

      function typeChips(conversation) {
        return kindSegments(conversation).map(function (entry) {
          return h('span', { key: 'chip-' + entry.key, className: 'dsh-doc-panel__chip is-static' },
            h('span', { className: 'dsh-doc-panel__chip-dot', style: { background: entry.color } }),
            t('type.' + entry.key) + ' ' + entry.count);
        });
      }

      function statLine(label, value) {
        return h('span', { className: 'dsh-doc-panel__statline' }, label, h('b', null, value));
      }

      function workspaceLabel(workspace) {
        return baseName(workspace) || t('conv.noWorkspace');
      }

      function typeFilterChips() {
        const chips = [h('button', {
          key: 'kind-all',
          type: 'button',
          className: 'dsh-doc-panel__chip' + (activeKind === 'all' ? ' is-active' : ''),
          'aria-pressed': activeKind === 'all' ? 'true' : 'false',
          onClick: function () { setActiveKind('all'); },
        }, t('topbar.all'))];
        dashboard.kinds.forEach(function (entry) {
          chips.push(h('button', {
            key: 'kind-' + entry.key,
            type: 'button',
            className: 'dsh-doc-panel__chip' + (activeKind === entry.key ? ' is-active' : ''),
            'aria-pressed': activeKind === entry.key ? 'true' : 'false',
            onClick: function () { setActiveKind(entry.key); },
          },
            h('span', { className: 'dsh-doc-panel__chip-dot', style: { background: entry.color } }),
            t('type.' + entry.key) + ' ' + entry.count
          ));
        });
        return chips;
      }

      function rowKeyHandler(action) {
        return function (event) {
          if (!event) return;
          const key = event.key;
          if (key === 'Enter' || key === ' ' || key === 'Spacebar') {
            if (typeof event.preventDefault === 'function') event.preventDefault();
            action();
          }
        };
      }

      function starButton(target) {
        const active = isFavorited(target.path);
        const disabled = !favoritesAvailable;
        const label = disabled ? t('fav.unavailable') : (active ? t('fav.remove') : t('fav.add'));
        return h('button', {
          type: 'button',
          className: 'dsh-doc-panel__star' + (active ? ' is-on' : ''),
          title: label,
          'aria-label': label,
          'aria-pressed': active ? 'true' : 'false',
          disabled: disabled,
          onClick: function (event) {
            if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
            toggleFavorite(target);
          },
        }, h(StarIcon, { filled: active }));
      }

      function tableHeader(variant, labels, numericColumns) {
        const cells = labels.map(function (label, index) {
          let className = 'dsh-doc-panel__cell';
          if (numericColumns.indexOf(index) !== -1) className += ' dsh-doc-panel__cell--num';
          if (index === labels.length - 1) className += ' dsh-doc-panel__cell--star';
          return h('span', { key: 'head-' + index, className: className }, label);
        });
        return h('div', { className: 'dsh-doc-panel__thead dsh-doc-panel__thead--' + variant }, cells);
      }

      function tableView(variant, labels, numericColumns, rows) {
        return h('div', { className: 'dsh-doc-panel__tablewrap' },
          tableHeader(variant, labels, numericColumns),
          rows
        );
      }

      function convCard(conversation) {
        const lastDoc = conversation.docs.slice().sort(function (a, b) { return (b.mtime || 0) - (a.mtime || 0); })[0] || null;
        const delivered = conversation.docs.filter(function (doc) { return doc.delivered; }).length;
        const open = function () { openFolder(conversation.id); };
        return h('article', {
          key: conversation.id,
          className: 'dsh-doc-panel__convcard',
          role: 'button',
          tabIndex: 0,
          title: conversation.title,
          'aria-label': tt('conv.openAria', { title: conversation.title }),
          onClick: open,
          onKeyDown: rowKeyHandler(open),
        },
          h('div', { className: 'dsh-doc-panel__convcard-head' },
            h('span', { className: 'dsh-doc-panel__convcard-icon' }, h(FolderIcon)),
            h('div', { className: 'dsh-doc-panel__convcard-title' }, conversation.title),
            h('div', { className: 'dsh-doc-panel__convcard-time' },
              h('div', null, formatRelative(conversation.updatedAt)),
              h('div', { className: 'dsh-doc-panel__convcard-date' }, formatDate(conversation.updatedAt)))
          ),
          h('span', { className: 'dsh-doc-panel__workspace', title: conversation.workspace || '' }, workspaceLabel(conversation.workspace)),
          h('div', { className: 'dsh-doc-panel__convcard-body' },
            h(DonutChart, {
              segments: kindSegments(conversation),
              size: 62,
              thickness: 8,
              compact: true,
              centerValue: conversation.docs.length,
              centerLabel: t('conv.docLabel'),
              ariaLabel: conversation.title,
            }),
            h('div', { className: 'dsh-doc-panel__stats' },
              statLine(t('conv.statDocs'), String(conversation.docs.length)),
              statLine(t('conv.statSize'), formatSize(conversation.size)),
              statLine(t('conv.statDelivered'), String(delivered)),
              statLine(t('conv.statTypes'), String(Object.keys(conversation.byKind).length))
            )
          ),
          h('div', { className: 'dsh-doc-panel__chips' }, typeChips(conversation)),
          h('div', { className: 'dsh-doc-panel__convcard-foot' },
            tt('conv.recentLine', { name: lastDoc ? lastDoc.name : t('conv.emptyLine') }))
        );
      }

      function leftFavoriteRow(favorite) {
        const unavailable = favorite.available === false;
        const target = targetForFavorite(favorite);
        const props = {
          key: favoriteKey(favorite.path),
          className: 'dsh-doc-panel__mini-row' + (unavailable ? ' is-disabled' : ''),
          title: favorite.path,
        };
        if (!unavailable) {
          props.onClick = function () { openDocument(docFromFavorite(favorite), target); };
        }
        return h('div', props,
          h('span', { className: 'dsh-doc-panel__dot', style: { background: kindColor(kindKey(favorite.kind, extOf(favorite.name))) } }),
          h('span', { className: 'dsh-doc-panel__mini-main' },
            h('span', { className: 'dsh-doc-panel__mini-name' }, favorite.name),
            h('span', { className: 'dsh-doc-panel__mini-sub' }, unavailable ? t('fav.itemUnavailable') : (favorite.conversationTitle || t('conv.untitled')))),
          starButton(target)
        );
      }

      function leftRecentRow(entry) {
        return h('button', {
          key: favoriteKey(entry.doc.path),
          type: 'button',
          className: 'dsh-doc-panel__mini-row',
          title: entry.doc.relPath || entry.doc.name,
          onClick: function () { openDocument(entry.doc, targetForDoc(entry.doc, entry.conversation)); },
        },
          h('span', { className: 'dsh-doc-panel__dot', style: { background: kindColor(kindKey(entry.doc.kind, entry.doc.ext)) } }),
          h('span', { className: 'dsh-doc-panel__mini-main' },
            h('span', { className: 'dsh-doc-panel__mini-name' }, entry.doc.name),
            h('span', { className: 'dsh-doc-panel__mini-sub' }, formatRelative(entry.doc.mtime) + ' · ' + entry.conversation.title))
        );
      }

      function favoriteDocCard(favorite) {
        const unavailable = favorite.available === false;
        const kind = kindKey(favorite.kind, extOf(favorite.name));
        const color = kindColor(kind);
        const target = targetForFavorite(favorite);
        const props = {
          key: favoriteKey(favorite.path),
          className: 'dsh-doc-panel__doccard' + (unavailable ? ' is-unavailable' : ''),
          title: favorite.path,
        };
        if (!unavailable) {
          props.role = 'button';
          props.tabIndex = 0;
          props.onClick = function () { openDocument(docFromFavorite(favorite), target); };
          props.onKeyDown = rowKeyHandler(props.onClick);
        }
        return h('div', props,
          h('span', { className: 'dsh-doc-panel__doccard-kind', style: { color: color, background: tintOf(color, 14) } }, t('type.' + kind)),
          h('span', { className: 'dsh-doc-panel__doccard-star' }, starButton(target)),
          h('div', { className: 'dsh-doc-panel__doccard-name' }, favorite.name),
          unavailable ? h('div', { className: 'dsh-doc-panel__doccard-note' }, t('fav.itemUnavailable')) : null,
          h('span', { className: 'dsh-doc-panel__workspace' }, favorite.conversationTitle || t('conv.untitled')),
          h('div', { className: 'dsh-doc-panel__doccard-meta' },
            h('span', null, formatSize(favorite.size)),
            h('span', null, formatRelative(favorite.mtime)))
        );
      }

      function renderLeftColumn() {
        const favoritesCard = h('section', { className: 'dsh-doc-panel__card' },
          h('div', { className: 'dsh-doc-panel__card-head' },
            h('div', { className: 'dsh-doc-panel__card-title' }, t('fav.title')),
            h('span', { className: 'dsh-doc-panel__pillcount' }, String(favorites.length))),
          favorites.length
            ? h('div', { className: 'dsh-doc-panel__mini-list' },
                favorites.slice(0, 6).map(function (favorite) { return leftFavoriteRow(favorite); }))
            : h('div', { className: 'dsh-doc-panel__card-empty' },
                favoritesAvailable ? t('left.favoritesEmptyHint') : t('fav.unavailable')),
          h('button', {
            type: 'button',
            className: 'dsh-doc-panel__card-link',
            onClick: function () { selectTab('favorites'); },
          }, t('left.viewAll'))
        );

        const typesCard = h('section', { className: 'dsh-doc-panel__card' },
          h('div', { className: 'dsh-doc-panel__card-head' },
            h('div', { className: 'dsh-doc-panel__card-title' }, t('left.types'))),
          h('div', { className: 'dsh-doc-panel__types-body' },
            h(DonutChart, {
              segments: dashboard.kinds,
              size: 118,
              thickness: 13,
              centerValue: dashboard.totalDocuments,
              centerLabel: t('conv.docLabel'),
              ariaLabel: t('types.donutAria'),
            }),
            h('div', { className: 'dsh-doc-panel__legend' },
              dashboard.kinds.length
                ? dashboard.kinds.map(function (entry) {
                    return h('div', { key: 'legend-' + entry.key, className: 'dsh-doc-panel__legend-row' },
                      h('span', { className: 'dsh-doc-panel__legend-dot', style: { background: entry.color } }),
                      h('span', { className: 'dsh-doc-panel__legend-name' }, t('type.' + entry.key)),
                      h('span', { className: 'dsh-doc-panel__legend-count' }, String(entry.count)),
                      h('span', { className: 'dsh-doc-panel__legend-pct' }, Math.round((entry.count / Math.max(1, dashboard.totalDocuments)) * 100) + '%'));
                  })
                : h('div', { className: 'dsh-doc-panel__card-empty' }, t('left.typesEmpty'))))
        );

        const recentCard = h('section', { className: 'dsh-doc-panel__card' },
          h('div', { className: 'dsh-doc-panel__card-head' },
            h('div', { className: 'dsh-doc-panel__card-title' }, t('left.recent'))),
          dashboard.recent.length
            ? h('div', { className: 'dsh-doc-panel__mini-list' },
                dashboard.recent.map(function (entry) { return leftRecentRow(entry); }))
            : h('div', { className: 'dsh-doc-panel__card-empty' }, t('left.recentEmpty'))
        );

        return h('div', { className: 'dsh-doc-panel__left' }, favoritesCard, typesCard, recentCard);
      }

      function renderTopbar() {
        return h('div', { className: 'dsh-doc-panel__topbar' },
          h('div', { className: 'dsh-doc-panel__topbar-main' },
            h('h1', { className: 'dsh-doc-panel__title' }, t('nav.label')),
            h('div', { className: 'dsh-doc-panel__subtitle' }, index
              ? tt('panel.subtitle', {
                  conversations: index.conversations.length,
                  documents: dashboard.totalDocuments,
                  time: formatRelative(dashboard.latestUpdate),
                })
              : t('state.loading'))),
          h('div', { className: 'dsh-doc-panel__toolbar' },
            h('div', { className: 'dsh-doc-panel__searchwrap' },
              h(SearchIcon),
              h('input', {
                type: 'search',
                className: 'dsh-doc-panel__search',
                value: query,
                placeholder: t('search.placeholder'),
                'aria-label': t('search.aria'),
                spellCheck: false,
                disabled: !index,
                onChange: function (event) { setQuery(event.target.value); },
              })),
            h('div', { className: 'dsh-doc-panel__segmented', role: 'group', 'aria-label': t('topbar.viewAria') },
              h('button', {
                type: 'button',
                className: 'dsh-doc-panel__segmented-btn' + (tab === 'all' ? ' is-active' : ''),
                'aria-pressed': tab === 'all' ? 'true' : 'false',
                onClick: function () { selectTab('all'); },
              }, t('topbar.all')),
              h('button', {
                type: 'button',
                className: 'dsh-doc-panel__segmented-btn' + (tab === 'favorites' ? ' is-active' : ''),
                'aria-pressed': tab === 'favorites' ? 'true' : 'false',
                onClick: function () { selectTab('favorites'); },
              }, t('topbar.favorites'))),
            h('button', {
              type: 'button',
              className: 'dsh-doc-panel__iconbtn',
              title: t('refresh.title'),
              'aria-label': t('refresh.title'),
              disabled: loading,
              onClick: function () { refreshAll(); },
            }, h(RefreshIcon, { spinning: loading })))
        );
      }

      function renderKpis() {
        return h('div', { className: 'dsh-doc-panel__kpis' },
          h('div', { className: 'dsh-doc-panel__kpi' },
            h('div', { className: 'dsh-doc-panel__kpi-label' }, t('kpi.conversations')),
            h('div', { className: 'dsh-doc-panel__kpi-value' }, String(index ? index.conversations.length : 0)),
            h('div', { className: 'dsh-doc-panel__kpi-sub' }, tt('kpi.conversationsSub', { count: dashboard.conversationsWithFavorites }))),
          h('div', { className: 'dsh-doc-panel__kpi' },
            h('div', { className: 'dsh-doc-panel__kpi-label' }, t('kpi.documents')),
            h('div', { className: 'dsh-doc-panel__kpi-value' }, String(dashboard.totalDocuments)),
            h('div', { className: 'dsh-doc-panel__kpi-sub' }, tt('kpi.documentsSub', { count: dashboard.kinds.length }))),
          h('div', { className: 'dsh-doc-panel__kpi' },
            h('div', { className: 'dsh-doc-panel__kpi-label' }, t('kpi.favorites')),
            h('div', { className: 'dsh-doc-panel__kpi-value' }, String(favorites.length)),
            h('div', { className: 'dsh-doc-panel__kpi-sub' }, !favoritesAvailable
              ? t('fav.unavailable')
              : (favorites.length ? tt('kpi.favoritesSub', { time: formatRelative(dashboard.latestFavorite) }) : t('kpi.favoritesEmpty')))),
          h('div', { className: 'dsh-doc-panel__kpi' },
            h('div', { className: 'dsh-doc-panel__kpi-label' }, t('kpi.weekly')),
            h('div', { className: 'dsh-doc-panel__kpi-value' }, String(dashboard.weekly)),
            h('div', { className: 'dsh-doc-panel__kpi-sub' }, tt('kpi.weeklySub', { count: dashboard.weekly })),
            h(Sparkline, { days: dashboard.days, ariaLabel: t('kpi.sparklineAria') }))
        );
      }

      function renderSectionHead() {
        return h('div', { className: 'dsh-doc-panel__section-head' },
          h('div', { className: 'dsh-doc-panel__section-titles' },
            h('div', { className: 'dsh-doc-panel__section-title' }, t('section.conversations')),
            h('div', { className: 'dsh-doc-panel__section-sub' }, String(conversationCards.length))),
          h('div', { className: 'dsh-doc-panel__section-controls' },
            h('div', { className: 'dsh-doc-panel__filterchips' }, typeFilterChips()),
            h('select', {
              className: 'dsh-doc-panel__sort',
              value: sort,
              'aria-label': t('conv.sortAria'),
              onChange: function (event) { setSort(event.target.value); },
            },
              h('option', { value: 'updated' }, t('sort.updated')),
              h('option', { value: 'count' }, t('sort.count')),
              h('option', { value: 'name' }, t('sort.name'))))
        );
      }

      function renderConversationGrid() {
        if (!conversationCards.length) {
          return h('div', { className: 'dsh-doc-panel__card dsh-doc-panel__card-empty' }, t('search.empty'));
        }
        return h('div', { className: 'dsh-doc-panel__convgrid' }, conversationCards.map(convCard));
      }

      function renderRightColumn() {
        if (preview) return renderPreview();
        if (needle) return renderSearchView();
        if (tab === 'favorites') return renderFavoritesView();
        if (selectedConversation) return renderFolderView(selectedConversation);
        return h('div', { className: 'dsh-doc-panel__right-main' },
          renderSectionHead(),
          renderConversationGrid());
      }

      function documentTableRow(doc, conversation) {
        const target = targetForDoc(doc, conversation);
        const open = function () { openDocument(doc, target); };
        return h('div', {
          key: favoriteKey(doc.path),
          className: 'dsh-doc-panel__row dsh-doc-panel__row--folder',
          role: 'button',
          tabIndex: 0,
          title: doc.relPath || doc.name,
          onClick: open,
          onKeyDown: rowKeyHandler(open),
        },
          h('span', { className: 'dsh-doc-panel__cell dsh-doc-panel__cell--name' },
            h('span', { className: 'dsh-doc-panel__badge' }, typeLabel(doc.kind, doc.ext)),
            h('span', { className: 'dsh-doc-panel__nametext' }, doc.name),
            doc.delivered
              ? h('span', { className: 'dsh-doc-panel__rowhint', title: t('doc.delivered') }, t('doc.delivered'))
              : null),
          h('span', { className: 'dsh-doc-panel__cell' }, dirOf(doc.relPath)),
          h('span', { className: 'dsh-doc-panel__cell dsh-doc-panel__cell--num' }, formatSize(doc.size)),
          h('span', { className: 'dsh-doc-panel__cell dsh-doc-panel__cell--num' }, formatRelative(doc.mtime)),
          h('span', { className: 'dsh-doc-panel__cell dsh-doc-panel__cell--star' }, starButton(target))
        );
      }

      function searchTableRow(doc, conversation) {
        const target = targetForDoc(doc, conversation);
        const open = function () { openDocument(doc, target); };
        return h('div', {
          key: favoriteKey(doc.path),
          className: 'dsh-doc-panel__row dsh-doc-panel__row--fav',
          role: 'button',
          tabIndex: 0,
          title: doc.relPath || doc.name,
          onClick: open,
          onKeyDown: rowKeyHandler(open),
        },
          h('span', { className: 'dsh-doc-panel__cell dsh-doc-panel__cell--name' },
            h('span', { className: 'dsh-doc-panel__badge' }, typeLabel(doc.kind, doc.ext)),
            h('span', { className: 'dsh-doc-panel__nametext' }, doc.name)),
          h('span', { className: 'dsh-doc-panel__cell' }, conversation.title),
          h('span', { className: 'dsh-doc-panel__cell' }, typeLabel(doc.kind, doc.ext)),
          h('span', { className: 'dsh-doc-panel__cell dsh-doc-panel__cell--num' }, formatSize(doc.size)),
          h('span', { className: 'dsh-doc-panel__cell dsh-doc-panel__cell--num' }, formatRelative(doc.mtime)),
          h('span', { className: 'dsh-doc-panel__cell dsh-doc-panel__cell--star' }, starButton(target))
        );
      }

      function renderFolderView(conversation) {
        return h('section', { className: 'dsh-doc-panel__card' },
          h('div', { className: 'dsh-doc-panel__folderhead' },
            h('button', {
              type: 'button',
              className: 'dsh-doc-panel__back',
              title: t('preview.back'),
              'aria-label': t('preview.back'),
              onClick: closeFolder,
            }, h(BackIcon), h('span', null, t('preview.back'))),
            h('span', { className: 'dsh-doc-panel__convcard-icon' }, h(FolderIcon)),
            h('div', { className: 'dsh-doc-panel__foldertitles' },
              h('div', { className: 'dsh-doc-panel__foldertitle' }, conversation.title),
              conversation.workspace
                ? h('span', { className: 'dsh-doc-panel__workspace', title: conversation.workspace }, workspaceLabel(conversation.workspace))
                : null),
            h('div', { className: 'dsh-doc-panel__foldermeta' }, tt('folder.detail', {
              documents: conversation.docs.length,
              size: formatSize(conversation.size),
              time: formatRelative(conversation.updatedAt),
            }))),
          h('div', { className: 'dsh-doc-panel__foldertags' }, typeChips(conversation)),
          conversation.docs.length
            ? tableView(
                'folder',
                [t('explorer.name'), t('explorer.location'), t('explorer.size'), t('explorer.modified'), ''],
                [2, 3],
                conversation.docs.map(function (doc) { return documentTableRow(doc, conversation); }))
            : h('div', { className: 'dsh-doc-panel__card-empty' }, t('doc.none'))
        );
      }

      function renderFavoritesView() {
        return h('section', { className: 'dsh-doc-panel__card' },
          h('div', { className: 'dsh-doc-panel__card-head' },
            h('div', { className: 'dsh-doc-panel__card-title' }, t('fav.title')),
            h('span', { className: 'dsh-doc-panel__pillcount' }, String(favorites.length)),
            h('span', { className: 'dsh-doc-panel__section-sub' }, t('fav.hint'))),
          !favoritesAvailable
            ? h('div', { className: 'dsh-doc-panel__card-empty' }, t('fav.unavailable'))
            : null,
          favorites.length
            ? h('div', { className: 'dsh-doc-panel__docgrid' },
                favorites.map(function (favorite) { return favoriteDocCard(favorite); }))
            : h('div', { className: 'dsh-doc-panel__card-empty' }, favoritesAvailable ? t('fav.empty') : t('fav.unavailable'))
        );
      }

      function renderSearchView() {
        return h('section', { className: 'dsh-doc-panel__card' },
          h('div', { className: 'dsh-doc-panel__searchcard-head' },
            h('div', { className: 'dsh-doc-panel__searchcard-title' }, t('search.results')),
            h('div', { className: 'dsh-doc-panel__searchcard-sub' }, tt('search.resultsCount', { count: searchResults.length }))),
          searchResults.length
            ? tableView(
                'fav',
                [t('explorer.name'), t('explorer.conversation'), t('explorer.type'), t('explorer.size'), t('explorer.modified'), ''],
                [3, 4],
                searchResults.map(function (row) { return searchTableRow(row.doc, row.conversation); }))
            : h('div', { className: 'dsh-doc-panel__searchcard-empty' }, t('search.noDocs'))
        );
      }

      function renderBinaryCard(doc, rawUrl) {
        return h('div', { className: 'dsh-doc-panel__bincard' },
          h('span', { className: 'dsh-doc-panel__badge dsh-doc-panel__badge--lg' }, typeLabel(doc.kind, doc.ext)),
          h('div', { className: 'dsh-doc-panel__binname' }, doc.name),
          h('div', { className: 'dsh-doc-panel__binpath' }, doc.relPath),
          h('div', { className: 'dsh-doc-panel__binhint' }, t('preview.binaryHint')),
          rawUrl
            ? h('a', {
                className: 'dsh-doc-panel__btn',
                href: rawUrl,
                target: '_blank',
                rel: 'noopener noreferrer',
              }, t('preview.openFile'))
            : null
        );
      }

      function notice(text) {
        return h('div', { className: 'dsh-doc-panel__notice' }, text);
      }

      function renderPreviewContent(doc, value) {
        const kind = descriptorKind(doc, value);
        const mode = preview.mode === 'source' ? 'source' : 'render';

        // Markdown / HTML render by default; 源码 is the explicit fallback.
        if (kind === 'html' && mode === 'render') {
          return h('div', { className: 'dsh-doc-panel__preview-body' },
            h('iframe', {
              className: 'dsh-doc-panel__frame',
              sandbox: 'allow-scripts allow-downloads',
              src: htmlFrameSrc(doc),
              title: doc.name,
            })
          );
        }

        if (kind === 'md' && mode === 'render' && value && value.kind === 'text') {
          return h('div', { className: 'dsh-doc-panel__preview-body' },
            value.truncated ? notice(t('preview.truncated')) : null,
            h('div', { className: 'dsh-doc-panel__mdwrap' }, renderMarkdown(value.text, h))
          );
        }

        const rawUrl = previewUrl(doc, value);
        if (kind === 'pdf' && rawUrl) {
          return h('div', { className: 'dsh-doc-panel__preview-body' },
            h('iframe', { className: 'dsh-doc-panel__frame', src: rawUrl, title: doc.name })
          );
        }

        if (value && value.kind === 'text') {
          return h('div', { className: 'dsh-doc-panel__preview-body' },
            kind === 'html' && mode === 'source' ? notice(t('preview.htmlSource')) : null,
            value.truncated ? notice(t('preview.truncated')) : null,
            h('pre', { className: 'dsh-doc-panel__pre' }, value.text)
          );
        }

        return h('div', { className: 'dsh-doc-panel__preview-body' }, renderBinaryCard(doc, rawUrl));
      }

      function renderPreview() {
        const doc = preview.doc;
        const value = preview.value;
        const kind = previewKind(doc);
        const toggleable = kind === 'md' || kind === 'html';
        const ready = preview.status === 'ready';
        const rawUrl = rawFileUrl(doc);
        const showOpen = !!rawUrl && (toggleable || (ready && value && value.kind === 'text'));
        const mode = preview.mode === 'source' ? 'source' : 'render';
        const content = preview.status === 'loading'
          ? renderState('loading', t('preview.loading'), '')
          : preview.status === 'error'
            ? renderState('error', t('preview.readError'), preview.error,
                actionButton(t('state.retry'), function () { loadPreview(doc, preview.mode, preview.target); }))
            : renderPreviewContent(doc, value);

        return h('div', { className: 'dsh-doc-panel__preview dsh-doc-panel__card dsh-doc-panel__previewcard' },
          h('div', { className: 'dsh-doc-panel__preview-head' },
            h('button', {
              type: 'button',
              className: 'dsh-doc-panel__back',
              title: t('preview.back'),
              'aria-label': t('preview.back'),
              onClick: closePreview,
            }, h(BackIcon), h('span', null, t('preview.back'))),
            h('div', { className: 'dsh-doc-panel__preview-titlewrap' },
              h('div', { className: 'dsh-doc-panel__preview-namewrap' },
                h('span', { className: 'dsh-doc-panel__badge' }, typeLabel(doc.kind, doc.ext)),
                h('div', { className: 'dsh-doc-panel__preview-name', title: doc.name }, doc.name)
              ),
              h('div', { className: 'dsh-doc-panel__preview-meta', title: doc.relPath },
                tt('doc.meta', { size: formatSize(doc.size), time: formatRelative(doc.mtime) }) +
                (doc.relPath ? ' · ' + doc.relPath : ''))
            ),
            showOpen
              ? h('a', {
                  className: 'dsh-doc-panel__open',
                  href: rawUrl,
                  target: '_blank',
                  rel: 'noopener noreferrer',
                  title: t('preview.openInTab'),
                }, t('preview.openInTab'))
              : null,
            preview.target ? starButton(preview.target) : null,
            toggleable
              ? h('div', { className: 'dsh-doc-panel__toggle', role: 'group', 'aria-label': t('preview.modeAria') },
                  h('button', {
                    type: 'button',
                    className: 'dsh-doc-panel__toggle-btn' + (mode === 'render' ? ' is-active' : ''),
                    'aria-pressed': mode === 'render' ? 'true' : 'false',
                    onClick: function () { switchPreviewMode('render'); },
                  }, t('preview.render')),
                  h('button', {
                    type: 'button',
                    className: 'dsh-doc-panel__toggle-btn' + (mode === 'source' ? ' is-active' : ''),
                    'aria-pressed': mode === 'source' ? 'true' : 'false',
                    onClick: function () { switchPreviewMode('source'); },
                  }, t('preview.source'))
                )
              : null
          ),
          content
        );
      }

      const topbar = renderTopbar();
      const kpis = index ? renderKpis() : null;

      let bodyContent;
      if (!index) {
        if (loading) {
          bodyContent = h('div', { className: 'dsh-doc-panel__card dsh-doc-panel__statecard' },
            renderState('loading', t('state.loading'), slow ? t('state.loadingHint') : ''));
        } else if (error) {
          bodyContent = h('div', { className: 'dsh-doc-panel__card dsh-doc-panel__statecard' },
            renderState('error', t('state.errorTitle'), error,
              actionButton(t('state.retry'), function () { refreshAll(); })));
        } else {
          bodyContent = h('div', { className: 'dsh-doc-panel__card dsh-doc-panel__statecard' },
            renderState('empty', t('state.emptyTitle'), t('state.emptyText'), null));
        }
      } else if (!index.conversations.length && !favorites.length) {
        bodyContent = h('div', { className: 'dsh-doc-panel__card dsh-doc-panel__statecard' },
          renderState('empty', t('state.emptyTitle'), t('state.emptyText'),
            actionButton(t('state.rescan'), function () { refreshAll(); })));
      } else {
        bodyContent = h('div', { className: 'dsh-doc-panel__grid' },
          renderLeftColumn(),
          h('div', { className: 'dsh-doc-panel__right' }, renderRightColumn()));
      }

      return h('div', { className: 'dsh-doc-panel', 'data-dsh-plugin': 'dsh-doc-panel' },
        h('style', { 'data-dsh-style': 'dsh-doc-panel' }, CSS),
        h('div', { className: 'dsh-doc-panel__page' },
          topbar,
          error && index ? renderBanner() : null,
          favoritesError ? renderFavoritesErrorBanner() : null,
          kpis,
          bodyContent
        )
      );
    }

    // ---------------------------------------------------------------------
    // Plugin definition
    // ---------------------------------------------------------------------
    return {
      name: 'dsh-doc-panel',
      inject: ['slots', 'locale'],
      // Pure Markdown -> React node renderer, exposed for the offline QA harness.
      __renderMarkdown: renderMarkdown,
      apply(ctx) {
        ctx.effect(function () {
          const dispose = ctx.locale.register(NS, DICT);
          return typeof dispose === 'function' ? dispose : undefined;
        }, 'dsh-doc-panel: locale');

        translate = ctx.locale.bind(NS);

        ctx.slots.inject('sidebar.panellist', function () {
          return ctx.slots.register({
            name: 'sidebar.panellist',
            id: NS,
            order: 30,
            locale: NS,
            label: function () { return t('nav.label'); },
          }, SidebarIcon);
        });

        ctx.slots.inject('main', function () {
          return ctx.slots.register({ name: 'main', key: NS }, DocPanel);
        });
      },
    };
  },
});
