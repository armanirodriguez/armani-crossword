// Browser activity source for the solve timer: "is the solver looking at the puzzle right now?"
//
// Active = the document is visible AND the window has focus. In preview mode inside the builder's iframe
// focus is ignored (the builder keeps focus in its own UI), so only visibility counts there.
//
// Shape (consumed by ActivityTimer): { isActive(), reason(), subscribe(fn) -> unsubscribe }

export function createBrowserActivity({ ignoreFocus = false, doc = document, win = window } = {}) {
  const visible = () => doc.visibilityState !== 'hidden';
  const focused = () => {
    if (ignoreFocus) return true;
    try {
      return doc.hasFocus();
    } catch {
      return true;
    }
  };
  // pagehide/freeze can arrive while visibilityState still says 'visible' (bfcache navigation), so they
  // force the inactive state until the page is shown/resumed again.
  let frozen = false;

  return {
    isActive: () => !frozen && visible() && focused(),
    reason: () => (frozen || !visible() ? 'hidden' : !focused() ? 'blurred' : null),
    subscribe(fn) {
      const onChange = () => fn();
      const onHide = () => { frozen = true; fn(); };
      const onShow = () => { frozen = false; fn(); };
      const winEvents = ['focus', 'blur'];
      doc.addEventListener('visibilitychange', onChange);
      doc.addEventListener('freeze', onHide);
      doc.addEventListener('resume', onShow);
      win.addEventListener('pagehide', onHide);
      win.addEventListener('pageshow', onShow);
      for (const e of winEvents) win.addEventListener(e, onChange);
      return () => {
        doc.removeEventListener('visibilitychange', onChange);
        doc.removeEventListener('freeze', onHide);
        doc.removeEventListener('resume', onShow);
        win.removeEventListener('pagehide', onHide);
        win.removeEventListener('pageshow', onShow);
        for (const e of winEvents) win.removeEventListener(e, onChange);
      };
    },
  };
}
