# Mobile menu: pre-animation flicker fix (surgical)

Animation, easing, durations, markup and visuals are unchanged. Files touched: `src/mobile-menu.css`, `src/modules/menu.js`.

Causes found (measured in Chromium, not guessed):
1. **Scrollbar jump** – `html.mm-lock{overflow:hidden}` removed the classic scrollbar on the click frame, so the header/button moved 15px (313 -> 328). Fix: `scrollbar-gutter:stable` while locked.
2. **Button background snap** – `.mb` background is a gradient; gradients can't transition, so it flipped instantly on frame 1. Fix: same two gradients driven by registered `@property` variables, morphing with the existing .5s timing.
3. **Focus ring pop-in** – `mb.focus()` on close made the ring appear instantly. Fix: ring colour fades in; pointer-initiated focus no longer requests `focus-visible`.
4. **Work on the click frame** – `getBoundingClientRect` + forced reflow + scroll-spy ran inside the click. Now done on `pointerdown` (also lets the layer get painted, still fully clipped). Keyboard path is unchanged.

## v3 – real-device (Samsung) investigation
No visual/production CSS change. Added opt-in on-device diagnostics: open `https://<site>/?mmdiag` on the phone
(`src/modules/menu-diag.js`, separate chunk, not requested without the flag). It records frame times, viewport/visualViewport
changes, long-animation-frames and layout shifts for each open/close, and has chips that switch single suspects off for A/B.

## v4 – backdrop-filter finding
On a real S26 Ultra `no-mm-backdrop` removes the jitter. Plain removal lets the page behind ghost through (the layer is only 96.5% opaque),
so v4 adds the diagnostic chip `FIX-opaque-base` (no backdrop-filter + fully opaque base colour) for on-device A/B. Production CSS still unchanged.

## v5 – PRODUCTION FIX (verified on a real Galaxy S26 Ultra via ?mmdiag A/B)
`.mm` in `src/mobile-menu.css`:
- removed `-webkit-backdrop-filter:blur(18px); backdrop-filter:blur(18px)`
- base colour `rgba(4,4,7,.965)` -> `rgb(4,4,7)`
Nothing else changed (gradients, clip-path, transitions, will-change identical). Diagnostic chips `no-mm-backdrop`, `FIX-opaque-base`
are kept; `OLD-backdrop` restores the previous look for comparison. The header's own backdrop-filter is untouched.

## FOUC fix (first-load unstyled HTML)
Root cause: `index.html` contained no stylesheet reference. All CSS (fonts, styles.css, mobile-menu.css) was `import`ed from `src/main.js`, so it
only applied once the JS module graph had been fetched and executed (always the case in `vite dev`/unbuilt serving, where Vite injects the CSS from JS).
Fix: the three stylesheets are now `<link rel="stylesheet">` tags in `<head>` (same order as before; fonts moved to `src/fonts.css` via @import),
and the CSS imports were removed from `main.js`. Vite bundles/hashes these links in `vite build`; no design, animation or JS behaviour changed.
