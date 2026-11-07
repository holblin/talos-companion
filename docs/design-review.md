# Interface review — 2026-11-07

Impeccable 4.8.0 audit and polish guidance was applied to the existing Spectrum
S2 interface. This was a refinement of an operational homelab tool: preserve the
dark appearance, routes, content, authentication, recovery behavior, and native
S2 controls. The source and license are installed under
`.agents/skills/impeccable`; provenance is in its `UPSTREAM.md`.

The implementation now uses a consistent S2 macro system. The principal
integrity failure was the positive appearance of disconnected services; this
has been corrected. The mechanical source detector returned `[]` (exit 0).
That result is separate from the visual and interaction review below.

| Dimension | Before | After | Evidence and limits |
| --- | --- | --- | --- |
| Accessibility | 3/4 | 3/4 | S2 controls, labels and keyboard navigation retained; full screen-reader and WCAG conformance audits were not performed. |
| Performance | 3/4 | 3/4 | Production build succeeds; an initial JavaScript chunk remains above Vite's 500 kB warning threshold. |
| Theming | 3/4 | 4/4 | App typography, layout and document defaults use S2 macros and tokens. Document color scheme matches the existing dark Provider. |
| Responsive behavior | 2/4 | 3/4 | Compact mobile summary, responsive downloads, and no horizontal overflow in the checked scenarios. Chromium emulation, not physical-device testing. |
| Implementation integrity | 2/4 | 3/4 | Honest service states, loading labels, shared semantic styles, and removal of decorative dashboard glyphs. |
| Total | 13/20 | 16/20 | Reviewer assessment: acceptable → good. Scores do not certify accessibility or performance. |

## Findings and implemented changes

- **P1 — Misleading service state:** the overview gave “Not connected” the same
  green badge as successful configuration. It now uses S2 `StatusLight` with a
  neutral variant for unavailable integrations and a positive variant for
  configured/connected integrations. Text continues to communicate the state.
- **P2 — Mobile recovery actions buried:** three tall metric cards preceded the
  recovery panel. A semantic definition list now presents compact label/value
  rows on phones and three columns on larger screens. Pending data says
  “Loading…” instead of presenting zero as a loaded value. Account counts use
  singular/plural labels.
- **P2 — Competing visual emphasis:** duplicated heading kickers, decorative
  Unicode dashboard glyphs, and an oversized recovery-panel arrow competed with
  the primary task. Those were removed; infrastructure icons now come from S2.
  The main create-backup action remains the accent control.
- **P2 — Excess empty table space:** the fixed 320 px recovery table reserved
  space after short lists. Its height now follows content, and its filename
  column gets twice the flexible width. Mobile retains downloadable file cards.
- **P2 — Split styling system:** global CSS selectors owned document typography,
  brand details, secrets, and setup progress. App-owned CSS was deleted and
  replaced with `style()` macros in `web/src/layout.ts`, applied explicitly to
  native elements through `documentClass()`. S2's own `page.css` remains the
  standard package reset. Setup progress has an explicit current-step style;
  programmatic heading focus does not draw a decorative box.
- **P3 — Dense secondary details:** workspace subtitles and service descriptions
  now use explicit block styles and Spectrum secondary text tokens. Browser
  document background matches the dark application during scrolling.

## Verification

- Strict ESLint, TypeScript, Prettier, production build, and the frontend Vitest
  suite were run. All 20 frontend tests passed.
- Twenty Playwright scenarios covered dashboard navigation, sign-in, initial
  setup, and empty recovery files at 320, 390, 768, 1024, and 1440 px. They found
  no page errors or horizontal overflow. Dashboard navigation exercised keyboard
  focus and either the mobile picker or desktop sidebar.
- Desktop (1440 × 1000) and mobile (390 × 844) recordings exercise overview,
  scrolling, and navigation to Backups. Both phases use the same synthetic
  administrator, three recovery files, and disconnected Drive state. Every API
  request is intercepted: these are visual demonstrations, not live backend or
  OAuth tests. Mobile uses an emulated touch-capable Chromium viewport; the tour
  uses mouse-wheel scrolling and does not certify physical touch gestures.
- The final videos align the first matching rendered overview frame, excluding
  development-server startup time. They are silent H.264 MP4s with before/after
  labels. Backup destination behavior visible in the final recording includes
  concurrent work already underway in the shared checkout; this review does not
  claim that work as an Impeccable change.

The Rust backend and live storage integrations were outside this styling pass.
The remaining bundle-size warning is a follow-up for `impeccable optimize`;
cross-browser and assistive-technology checks would strengthen the evidence.

## Videos and repeatable capture

- [Desktop comparison](assets/desktop-before-after.mp4)
- [Mobile comparison](assets/mobile-before-after.mp4)

`scripts/capture-ui.py` needs Python Playwright with Chromium installed.
`scripts/compose-ui-video.py` needs Pillow and FFmpeg. The capture defaults to
port 5174; use `--url` for a production preview on another port. Keep the initial
recording before changing the source, then record the final production preview:

```powershell
python scripts/capture-ui.py before --url http://127.0.0.1:5174
# Implement changes, build the web app, then run its Vite preview on port 5175.
python scripts/capture-ui.py after --url http://127.0.0.1:5175
python scripts/capture-ui.py after --url http://127.0.0.1:5175 --check
python scripts/compose-ui-video.py --ffmpeg ffmpeg
```

The scripts write raw recordings, screenshots, browser-check JSON, and composite
videos into ignored `dist/ui-review/`. The two delivered MP4s are also retained
in `docs/assets/`. No automatic agent hooks were enabled by the skill install.
