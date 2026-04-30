/* ==========================================================================
   El Amigo · IndexedDB image-store bridge
   ----------------------------------------------------------------------------
   Drop-in addendum to assets/data.js.  Loaded AFTER data.js on every page.

   Why this exists
   ---------------
   In local-only mode, the original Store.uploadFile would turn each photo into
   a base64 data URL and persist it inside the main `elamigo_data` localStorage
   record.  localStorage is capped at ~5 MB per origin, so a few photos blow
   the quota and saving silently fails.

   What this does
   --------------
   • Stores image bytes as Blobs in an IndexedDB database (gigabytes of room).
   • Replaces Store.uploadFile / Store.deleteFile so every upload routes to
     IndexedDB (in local mode), and stores only an `idb://<key>` reference in
     the main data record.
   • Wraps Store.load / Store.save so that:
       - on load:  `idb://<key>` references are swapped for live blob URLs
                   that <img src> can render directly.
       - on save:  blob URLs are swapped back to `idb://<key>` references
                   before the data is persisted, so localStorage stays tiny.

   Public + admin pages should include this AFTER assets/data.js:
       <script src="assets/data.js"></script>
       <script src="assets/image-store.js"></script>

   No backend.  No Supabase.  No code changes required elsewhere.
   ========================================================================== */
(function () {
  'use strict';

  if (!('indexedDB' in window)) {
    console.warn('[image-store] IndexedDB not supported; falling back to original Store.');
    return;
  }

  var DB_NAME = 'elamigo-images';
  var DB_VERSION = 1;
  var STORE_NAME = 'images';
  var IDB_PREFIX = 'idb://';

  // ─── IndexedDB helpers ───────────────────────────────────────────────
  var _dbPromise = null;
  function openDB() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
      req.onsuccess = function (e) { resolve(e.target.result); };
      req.onerror = function () { reject(req.error); };
    });
    return _dbPromise;
  }

  function idbPut(key, blob) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(blob, key);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error); };
      });
    });
  }

  function idbGet(key) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE_NAME, 'readonly');
        var req = tx.objectStore(STORE_NAME).get(key);
        req.onsuccess = function () { resolve(req.result || null); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function idbDelete(key) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).delete(key);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function idbAllKeys() {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE_NAME, 'readonly');
        var req = tx.objectStore(STORE_NAME).getAllKeys();
        req.onsuccess = function () { resolve(req.result || []); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  // ─── Optional client-side compression (keeps DB small) ───────────────
  function compressIfImage(file, opts) {
    if (!opts || !opts.compress) return Promise.resolve(file);
    if (!file || !file.type || !/^image\//.test(file.type)) return Promise.resolve(file);

    return new Promise(function (resolve) {
      var img = new Image();
      var url = URL.createObjectURL(file);
      img.onload = function () {
        URL.revokeObjectURL(url);
        var maxDim = 1600;
        var w = img.width, h = img.height;
        if (w > maxDim || h > maxDim) {
          var ratio = Math.min(maxDim / w, maxDim / h);
          w = Math.round(w * ratio);
          h = Math.round(h * ratio);
        }
        var canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        var ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        canvas.toBlob(function (blob) {
          resolve(blob || file);
        }, 'image/jpeg', 0.85);
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        resolve(file);
      };
      img.src = url;
    });
  }

  function genKey(prefix) {
    var safe = (prefix || 'img').toString().replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '') || 'img';
    return safe + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  // ─── Mappings between live blob URLs and stable idb:// keys ──────────
  // Live blob URL -> idb key           (used at save-time to re-stable-ify)
  var keyByBlobURL = new Map();
  // idb key -> live blob URL           (cache; avoids re-creating object URLs)
  var blobURLByKey = new Map();

  function getOrCreateBlobURL(key) {
    if (blobURLByKey.has(key)) return Promise.resolve(blobURLByKey.get(key));
    return idbGet(key).then(function (blob) {
      if (!blob) return null;
      var url = URL.createObjectURL(blob);
      blobURLByKey.set(key, url);
      keyByBlobURL.set(url, key);
      return url;
    });
  }

  // ─── Walk data, swap idb:// references for live blob URLs ────────────
  // Mutates `obj` in place so existing render code "just works".
  function rehydrate(obj, seen) {
    seen = seen || new WeakSet();
    if (!obj || typeof obj !== 'object') return Promise.resolve();
    if (seen.has(obj)) return Promise.resolve();
    seen.add(obj);

    var pending = [];
    if (Array.isArray(obj)) {
      for (var i = 0; i < obj.length; i++) {
        (function (i) {
          var v = obj[i];
          if (typeof v === 'string' && v.indexOf(IDB_PREFIX) === 0) {
            pending.push(getOrCreateBlobURL(v.slice(IDB_PREFIX.length)).then(function (url) {
              if (url) obj[i] = url;
            }));
          } else if (v && typeof v === 'object') {
            pending.push(rehydrate(v, seen));
          }
        })(i);
      }
    } else {
      Object.keys(obj).forEach(function (k) {
        var v = obj[k];
        if (typeof v === 'string' && v.indexOf(IDB_PREFIX) === 0) {
          pending.push(getOrCreateBlobURL(v.slice(IDB_PREFIX.length)).then(function (url) {
            if (url) obj[k] = url;
          }));
        } else if (v && typeof v === 'object') {
          pending.push(rehydrate(v, seen));
        }
      });
    }
    return Promise.all(pending);
  }

  // ─── Walk data, swap blob URLs for stable idb:// references ──────────
  // Returns a *deep clone* with replacements; original is untouched so the
  // admin UI can keep displaying images after a save.
  function dehydrate(obj, seen) {
    seen = seen || new WeakMap();
    if (obj === null || typeof obj !== 'object') return obj;
    if (seen.has(obj)) return seen.get(obj);

    var out;
    if (Array.isArray(obj)) {
      out = [];
      seen.set(obj, out);
      for (var i = 0; i < obj.length; i++) {
        var v = obj[i];
        if (typeof v === 'string' && keyByBlobURL.has(v)) {
          out.push(IDB_PREFIX + keyByBlobURL.get(v));
        } else if (v && typeof v === 'object') {
          out.push(dehydrate(v, seen));
        } else {
          out.push(v);
        }
      }
      return out;
    }

    out = {};
    seen.set(obj, out);
    Object.keys(obj).forEach(function (k) {
      var v = obj[k];
      if (typeof v === 'string' && keyByBlobURL.has(v)) {
        out[k] = IDB_PREFIX + keyByBlobURL.get(v);
      } else if (v && typeof v === 'object') {
        out[k] = dehydrate(v, seen);
      } else {
        out[k] = v;
      }
    });
    return out;
  }

  // ─── Public API ───────────────────────────────────────────────────────
  var ImageStore = {
    /**
     * Upload a File/Blob to IndexedDB.
     * Returns { url, path } where:
     *   url  = a live blob: URL safe for <img src>
     *   path = stable "idb://<key>" reference (what gets persisted)
     */
    upload: function (file, prefix, opts) {
      return compressIfImage(file, opts).then(function (blob) {
        var key = genKey(prefix);
        return idbPut(key, blob).then(function () {
          var url = URL.createObjectURL(blob);
          blobURLByKey.set(key, url);
          keyByBlobURL.set(url, key);
          return { url: url, path: IDB_PREFIX + key };
        });
      });
    },

    /** Delete by either an `idb://<key>` reference or a live blob URL. */
    remove: function (ref) {
      var key = null;
      if (typeof ref === 'string') {
        if (ref.indexOf(IDB_PREFIX) === 0) key = ref.slice(IDB_PREFIX.length);
        else if (keyByBlobURL.has(ref)) key = keyByBlobURL.get(ref);
      }
      if (!key) return Promise.resolve();
      return idbDelete(key).then(function () {
        var url = blobURLByKey.get(key);
        if (url) {
          try { URL.revokeObjectURL(url); } catch (e) {}
          keyByBlobURL.delete(url);
          blobURLByKey.delete(key);
        }
      });
    },

    /** Sweep IDB of any keys not referenced anywhere in the given data. */
    gc: function (rootData) {
      var referenced = new Set();
      function walk(o) {
        if (!o || typeof o !== 'object') return;
        if (Array.isArray(o)) { o.forEach(walk); return; }
        Object.keys(o).forEach(function (k) {
          var v = o[k];
          if (typeof v === 'string' && v.indexOf(IDB_PREFIX) === 0) {
            referenced.add(v.slice(IDB_PREFIX.length));
          } else if (v && typeof v === 'object') {
            walk(v);
          }
        });
      }
      walk(rootData);
      return idbAllKeys().then(function (keys) {
        var deletions = keys
          .filter(function (k) { return !referenced.has(k); })
          .map(function (k) { return idbDelete(k); });
        return Promise.all(deletions).then(function () {
          return { removed: deletions.length, kept: referenced.size };
        });
      });
    },

    /** Total bytes currently in IndexedDB (best-effort). */
    usage: function () {
      if (navigator.storage && navigator.storage.estimate) {
        return navigator.storage.estimate();
      }
      return Promise.resolve({ usage: null, quota: null });
    },

    rehydrate: rehydrate,
    dehydrate: dehydrate,

    // expose internals for debugging
    _idb: { put: idbPut, get: idbGet, delete: idbDelete, allKeys: idbAllKeys }
  };

  window.ImageStore = ImageStore;

  // ─── Monkey-patch Store once data.js has registered it ───────────────
  function patchStore() {
    if (!window.Store) {
      // data.js not loaded yet; try again shortly.
      setTimeout(patchStore, 30);
      return;
    }
    if (window.Store.__imageStorePatched) return;
    window.Store.__imageStorePatched = true;

    var origLoad   = typeof window.Store.load        === 'function' ? window.Store.load.bind(window.Store)        : null;
    var origSave   = typeof window.Store.save        === 'function' ? window.Store.save.bind(window.Store)        : null;
    var origUpload = typeof window.Store.uploadFile  === 'function' ? window.Store.uploadFile.bind(window.Store)  : null;
    var origDelete = typeof window.Store.deleteFile  === 'function' ? window.Store.deleteFile.bind(window.Store)  : null;
    var isRemote   = typeof window.Store.isRemote    === 'function' ? window.Store.isRemote.bind(window.Store)    : function () { return false; };

    if (origLoad) {
      window.Store.load = function () {
        return origLoad.apply(null, arguments).then(function (data) {
          return rehydrate(data).then(function () { return data; });
        });
      };
    }

    if (origSave) {
      window.Store.save = function (data) {
        var cleaned = dehydrate(data);
        return origSave.call(null, cleaned);
      };
    }

    if (origUpload) {
      window.Store.uploadFile = function (file, prefix, opts) {
        // If a real remote backend is wired up, defer to it (legacy path).
        if (isRemote()) return origUpload(file, prefix, opts);
        return ImageStore.upload(file, prefix, opts);
      };
    }

    if (origDelete) {
      window.Store.deleteFile = function (path) {
        if (typeof path === 'string' && path.indexOf(IDB_PREFIX) === 0) {
          return ImageStore.remove(path);
        }
        return origDelete(path);
      };
    }

    // Many UIs use Store.isRemote() to gate "you must connect Supabase first"
    // banners on uploads.  Keep isRemote() honest, but advertise local upload
    // capability via a new Store.canUpload() helper.
    window.Store.canUpload = function () { return true; };

    console.log('[image-store] Store patched. Image uploads now go to IndexedDB.');
  }

  patchStore();
})();
