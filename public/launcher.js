// Build placeholder only. scripts/build-runtime.mjs replaces dist/launcher.js
// with the bundled src/runtime/transport-background.ts coordinator after Vite.
// The production background only ensures offscreen, opens/focuses UI pages and
// mediates the public transfer recovery marker. Wallets never live in the SW.
