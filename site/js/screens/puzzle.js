// A puzzle route: the intro card first, then the solving view (created on first Play, kept while the
// route is open so going back to the card and resuming is instant).

import { loadPuzzle } from '../../shared/puzzle.js';
import { loadProgress, progressKey } from '../progress.js';
import { buildIntro } from './intro.js';
import { createPlayView } from './play.js';
import { shareNow, shareTextFor } from './share-action.js';

/**
 * @param {object} o
 * @param {object} o.ctx
 * @param {object} o.raw        validated published puzzle
 * @param {object|null} o.entry index entry
 * @param {string} o.label      eyebrow ("Today's puzzle", "Latest puzzle", "Puzzle", "Preview")
 * @param {string} [o.notice]
 * @param {boolean} [o.autoStart] skip the intro (used when a live preview reloads mid-solve)
 * @param {(el: Node) => void} o.mount   replaces the page content
 */
export function createPuzzleScreen({ ctx, raw, entry, label, notice = '', autoStart = false, mount }) {
  const loaded = loadPuzzle(raw);
  let play = null;
  let intro = null;

  const progressNow = () => (play ? play.progress : loadProgress(ctx.storage, raw.id, loaded, raw.checksum));

  function showIntro({ refresh = false } = {}) {
    if (play) play.leave();
    const progress = progressNow();
    intro = buildIntro({
      ctx, raw, loaded, entry, label, notice, progress,
      onPlay: showPlay,
      onShare: () => shareNow(shareTextFor(ctx, raw, entry, loaded, progress)),
    });
    if (refresh) intro.classList.add('is-refresh'); // no entrance animation for a live update
    mount(intro);
    document.title = `${raw.title || 'Puzzle'} · ${ctx.config.siteName}`;
  }

  function showPlay() {
    if (!play) {
      play = createPlayView({ ctx, raw, loaded, entry, onBack: showIntro });
    }
    intro = null;
    mount(play.el);
    play.enter();
    document.title = `${raw.title || 'Puzzle'} · ${ctx.config.siteName}`;
  }

  // Another tab saved progress for this puzzle: keep the intro card's status / Play label current.
  const key = progressKey(raw.id);
  const onStorage = (e) => {
    if (e.key !== key && e.key !== null) return;
    if (!intro?.isConnected) return;
    play?.sync();
    showIntro({ refresh: true });
  };
  if (!ctx.preview) window.addEventListener('storage', onStorage);

  if (autoStart) showPlay();
  else showIntro();

  return {
    destroy() {
      window.removeEventListener('storage', onStorage);
      play?.destroy();
      play = null;
    },
    get playing() { return Boolean(play?.el.isConnected); },
  };
}
