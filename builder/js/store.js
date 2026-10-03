// The draft being edited: single source of truth, change events, undo/redo for grid edits, debounced autosave.
//
// Events (EventTarget):
//   'change'    detail { kind: 'load' | 'grid' | 'meta' | 'clues' | 'theme', label?, history? }
//   'status'    detail { status: 'saved' | 'pending' | 'saving' | 'error' | 'conflict', error? }
//   'saved'     detail { draft }   after a successful save (draft.updatedAt was refreshed)
//   'conflict'  detail { kind: 'changed' | 'deleted', updatedAt? }   a save was refused (see below)
//
// Saves are optimistic-concurrency checked: every PUT carries `If-Match: <updatedAt this copy is based on>`. When
// the draft was saved from another tab meanwhile (or deleted there), the server refuses with 409 and the store goes
// to status 'conflict': nothing is overwritten and autosave pauses until the user picks a version
// (main.js: reload the newer one, or overwrite() with this one).

import { api } from './api.js';

const AUTOSAVE_MS = 800;
const RETRY_MS = 5000;
const HISTORY_LIMIT = 200;

/** Grid-related fields captured by undo/redo. Clues are keyed by answer, so they survive grid undo untouched. */
function snapshot(d, label) {
  return {
    label,
    width: d.width,
    height: d.height,
    cells: d.cells.slice(),
    locked: d.locked.slice(),
    circles: d.circles.slice(),
    shaded: d.shaded.slice(),
  };
}

function restore(d, s) {
  d.width = s.width;
  d.height = s.height;
  d.cells = s.cells.slice();
  d.locked = s.locked.slice();
  d.circles = s.circles.slice();
  d.shaded = s.shaded.slice();
}

/** Fill in optional fields so the rest of the builder can rely on them. */
export function normalizeDraft(d) {
  const out = { ...d };
  for (const key of ['locked', 'circles', 'shaded', 'theme']) if (!Array.isArray(out[key])) out[key] = [];
  for (const key of ['clues', 'clueSources']) if (!out[key] || typeof out[key] !== 'object') out[key] = {};
  for (const key of ['title', 'author', 'note', 'date']) if (typeof out[key] !== 'string') out[key] = '';
  if (!['rotational', 'mirror', 'none'].includes(out.symmetry)) out.symmetry = 'rotational';
  if (typeof out.themeText !== 'string') {
    // Builder-only field: the raw theme textarea (so it is preserved exactly as typed).
    out.themeText = out.theme.map((t) => (t.clue ? `${t.raw || t.answer} | ${t.clue}` : (t.raw || t.answer))).join('\n');
  }
  return out;
}

export class DraftStore extends EventTarget {
  #draft = null;
  #undo = [];
  #redo = [];
  #status = 'saved';
  #error = null;
  #timer = null;
  #saving = null;     // promise of the in-flight save
  #dirty = false;     // changes not yet sent
  #version = 0;       // bumps on every change; lets a finished save know whether newer edits exist
  #base = null;       // updatedAt of the saved version this copy is based on (sent as If-Match)
  #conflict = null;   // { kind: 'changed' | 'deleted', updatedAt } while a save is refused

  get draft() { return this.#draft; }
  get status() { return this.#status; }
  get error() { return this.#error; }
  get canUndo() { return this.#undo.length > 0; }
  get canRedo() { return this.#redo.length > 0; }
  get undoLabel() { return this.#undo.at(-1)?.label || ''; }
  get redoLabel() { return this.#redo.at(-1)?.label || ''; }
  /** The saved version (updatedAt) this copy is based on. */
  get baseVersion() { return this.#base; }
  /** { kind: 'changed' | 'deleted', updatedAt } while a save is refused because of another tab, else null. */
  get conflict() { return this.#conflict; }
  /** Edits that are not on disk yet (pending, failed or refused). */
  get hasUnsaved() { return Boolean(this.#draft) && (this.#dirty || Boolean(this.#saving)); }
  /** Nothing pending and nothing in flight: the copy here equals the saved version it is based on. */
  get clean() { return Boolean(this.#draft) && !this.#dirty && !this.#saving && this.#status === 'saved'; }

  load(draft) {
    clearTimeout(this.#timer);
    this.#draft = normalizeDraft(draft);
    this.#undo = [];
    this.#redo = [];
    this.#dirty = false;
    this.#base = typeof draft?.updatedAt === 'string' && draft.updatedAt ? draft.updatedAt : null;
    this.#conflict = null;
    this.#setStatus('saved');
    this.#emit('change', { kind: 'load' });
  }

  unload() {
    clearTimeout(this.#timer);
    this.#draft = null;
    this.#undo = [];
    this.#redo = [];
    this.#dirty = false;
    this.#base = null;
    this.#conflict = null;
  }

  /**
   * Mutate the draft. `mutator(draft)` changes it in place.
   * Options: kind ('grid' records an undo step by default), label (shown as "Undo <label>"), record, save.
   */
  update(mutator, { kind = 'meta', label = '', record = kind === 'grid', save = true } = {}) {
    const d = this.#draft;
    if (!d) return;
    if (record) {
      this.#undo.push(snapshot(d, label));
      if (this.#undo.length > HISTORY_LIMIT) this.#undo.shift();
      this.#redo = [];
    }
    mutator(d);
    this.#version++;
    this.#emit('change', { kind, label });
    if (save) this.#markDirty();
  }

  undo() {
    const d = this.#draft;
    const s = this.#undo.pop();
    if (!d || !s) return false;
    this.#redo.push(snapshot(d, s.label));
    restore(d, s);
    this.#afterHistory();
    return s.label || true;
  }

  redo() {
    const d = this.#draft;
    const s = this.#redo.pop();
    if (!d || !s) return false;
    this.#undo.push(snapshot(d, s.label));
    restore(d, s);
    this.#afterHistory();
    return s.label || true;
  }

  #afterHistory() {
    this.#version++;
    this.#emit('change', { kind: 'grid', history: true });
    this.#markDirty();
  }

  #markDirty() {
    this.#dirty = true;
    clearTimeout(this.#timer);
    if (this.#conflict) return; // keep the edits, but never overwrite the other version until the user decides
    this.#setStatus('pending');
    this.#timer = setTimeout(() => this.#save(), AUTOSAVE_MS);
  }

  async #save({ force = false } = {}) {
    clearTimeout(this.#timer);
    if (this.#saving) return this.#saving.then(() => (this.#dirty ? this.#save({ force }) : undefined));
    const d = this.#draft;
    if (!d || !this.#dirty) return undefined;
    if (this.#conflict && !force) return undefined;
    const version = this.#version;
    const id = d.id;
    this.#dirty = false;
    this.#setStatus('saving');
    this.#saving = (async () => {
      try {
        // Serialised synchronously, so later edits are not half-sent. `force` (the user chose "keep mine")
        // drops the version check and also recreates a draft that was deleted elsewhere.
        const res = await api.saveDraft(d, { ifMatch: force ? null : this.#base });
        if (this.#draft?.id !== id) return;
        d.updatedAt = res.updatedAt;
        this.#base = res.updatedAt;
        this.#conflict = null;
        this.#emit('saved', { draft: d });
        if (this.#version === version && !this.#dirty) this.#setStatus('saved');
      } catch (err) {
        if (this.#draft?.id !== id) return;
        this.#dirty = true;
        this.#error = err;
        if (err?.status === 409 && err.body?.conflict) {
          // Saved (or deleted) somewhere else since this copy was loaded: stop autosaving and ask.
          this.#conflict = { kind: err.body.conflict === 'deleted' ? 'deleted' : 'changed', updatedAt: err.body.updatedAt || '' };
          this.#setStatus('conflict');
          this.#emit('conflict', this.#conflict);
        } else {
          this.#setStatus('error');
          this.#timer = setTimeout(() => this.#save(), RETRY_MS);
        }
      } finally {
        this.#saving = null;
      }
    })();
    await this.#saving;
    if (this.#dirty && !['error', 'conflict'].includes(this.#status) && this.#draft?.id === id) return this.#save();
    return undefined;
  }

  /**
   * Save now if anything is pending (before publishing, switching drafts …). Rejects if the save fails or is
   * refused because of a conflict (err.status 409, err.body.conflict).
   */
  async flush() {
    if (this.#saving) await this.#saving;
    if (this.#dirty && !this.#conflict) await this.#save();
    if (this.#status === 'error' || this.#status === 'conflict') throw this.#error || new Error('Could not save the draft');
  }

  /** "Keep my version": save this copy over whatever is on disk now (recreating the draft if it was deleted). */
  async overwrite() {
    if (!this.#draft) return;
    if (this.#saving) await this.#saving;
    this.#conflict = null;
    this.#dirty = true;
    await this.#save({ force: true });
    if (this.#status === 'error' || this.#status === 'conflict') throw this.#error || new Error('Could not save the draft');
  }

  /**
   * Best-effort save while the page is being closed. Returns true when the browser should warn before leaving
   * (edits that may not reach the disk: a failed or refused save, or one still in flight).
   */
  saveOnUnload() {
    if (!this.#draft || (!this.#dirty && !this.#saving)) return false;
    if (this.#conflict || this.#status === 'error') return true;
    if (!this.#dirty) return false; // the save in flight already has everything
    if (this.#saving) return true;  // newer edits are queued behind it: ask the browser to wait
    api.saveDraft(this.#draft, { keepalive: true, ifMatch: this.#base }).catch(() => {});
    return false;
  }

  #setStatus(status) {
    if (status !== 'error' && status !== 'conflict') this.#error = null;
    this.#status = status;
    this.#emit('status', { status, error: this.#error });
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}
