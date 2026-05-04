(function () {
  'use strict';

  const injectTime = performance.now();
  (async () => {
    const { onExecute } = await import(
      /* @vite-ignore */
      chrome.runtime.getURL("assets/injector.ts-386b6f12.js")
    );
    onExecute?.({ perf: { injectTime, loadTime: performance.now() - injectTime } });
  })().catch(console.error);

})();
