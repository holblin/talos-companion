# Spectrum Audit: Talos Companion frontend

**Spectrum Adherence Score: 100/100 (A)**
0 unresolved Critical · 0 unresolved High · 0 unresolved Medium · 0 unresolved Low

## Summary

Reviewed `src/**/*.{ts,tsx}`, the frontend tests, npm dependencies, and Vite configuration against all six installed Spectrum audit checklists and the applicable S2 component references. The issues found were remediated using the installed `react-spectrum-s2` skill; this score describes the resulting source, not the original release or a guarantee of complete browser accessibility. Component composition and style-macro enforcement are now guarded by lint and the existing strict typecheck.

## Scores by category

| Category | Score | Grade | Unresolved findings |
|----------|-------|-------|---------------------|
| Setup & configuration | 100 | A | 0 |
| Component usage | 100 | A | 0 |
| Styling | 100 | A | 0 |
| Accessibility | 100 | A | 0 |
| Versioning & maintenance | 100 | A | 0 |
| Testing | 100 | A | 0 |

Each category has zero outstanding severity deductions. Weighted score: `round(100 × .25 + 100 × .20 + 100 × .20 + 100 × .20 + 100 × .10 + 100 × .05) = 100`.

## Findings

No unresolved findings from the six checklists. The following findings were fixed:

- [BackupSetup.tsx](src/BackupSetup.tsx) — **Composite button labels and contextual-help slots.** Use the button's `Text` slot for multi-part labels; use the documented Heading slot in ContextualHelp. _Checks:_ 02 — Component usage; 04 — Accessibility & correctness.
- [Panel.tsx](src/Panel.tsx:19) — **Custom card surfaces.** The shared document panel, access-method tiles, backup destinations, and Omni setup now use S2 Card and Content. Custom layouts stay inside Content; native sections preserve landmarks and heading levels. These settings panels do not need CardView selection or bulk actions. _Check:_ 02 — Component usage.
- [BackupTable.tsx](src/BackupTable.tsx:18) and [App.tsx](src/App.tsx:1315) — **Collection scrolling, text values, and empty states.** Removed outer overflow scrollers and oversized table minimum width. Column minimum widths let TableView scroll internally. Rich rows provide explicit `textValue`; backup empty content uses TableBody `renderEmptyState`. _Check:_ 02 — Component usage.
- [OmniSetup.tsx](src/OmniSetup.tsx), [RecoveryPassphrase.tsx](src/RecoveryPassphrase.tsx), [BackupSetup.tsx](src/BackupSetup.tsx), and [App.tsx](src/App.tsx) — **Native disclosure and link replacements.** Replaced native details/summary with Disclosure, DisclosureTitle, and DisclosurePanel, and navigational anchors with S2 Link. API certificate downloads bypass the client router using `download`. The native document skip link remains because it explicitly manages heading focus. _Check:_ 02 — Component usage.
- [layout.ts](src/layout.ts:483) — **Macro precedence.** Removed concatenated copies of the original macro class strings; both layout helpers return only `mergeStyles` output. _Check:_ 03 — Styling.
- [App.tsx](src/App.tsx:225) and [AccessPages.tsx](src/AccessPages.tsx) — **Text without a matching slot context.** Account email uses an explicitly styled native span; contextual-help prose uses a native paragraph rather than an unrelated Text slot. _Check:_ 04 — Accessibility & correctness.
- [router.tsx](src/router.tsx:20) and [main.tsx](src/main.tsx) — **Forced color scheme.** Removed the hard-coded dark Provider prop and document override. The single router-aware root Provider follows the operating-system preference. _Check:_ 04 — Accessibility & correctness.
- [vite.config.ts](vite.config.ts:8) — **Locale optimization.** Enabled Adobe's locale optimizer for the app's existing `en-US` locale. Existing single-bundle CSS (`cssCodeSplit: false`), lightningcss, and macro-plugin configuration were retained. _Check:_ 01 — Setup & configuration.
- [backups.test.tsx](tests/backups.test.tsx:99) and [omni.test.tsx](tests/omni.test.tsx:346) — **ARIA pattern testers.** Picker interactions and keyboard dialog dismissal use Adobe's testers. Disclosure coverage checks collapsed/expanded accessibility behavior rather than a native details implementation. _Check:_ 06 — Testing.

## Action items

- **Fix now:** complete for the findings above.
- **Improve:** lint now rejects native replacements for S2 disclosures/buttons/pickers/tables, missing row text values, and unwrapped composite button labels.
- **Polish:** existing macro/import/unsafe-style checks remain enabled; conventions are documented in [AGENTS.md](AGENTS.md).
- **Follow-ups:** validate on physical Safari/iOS when available. The existing Vite large-JavaScript-chunk advisory remains; it is not a component-composition failure.

## What looks good

- React 19; S2 1.8.2 matches the npm registry's latest release checked during this audit. No Spectrum 1 or third-party design-system mixing.
- Single root Provider with client-router integration; accessible collection and icon-action names; typed collection items; native form field labels supplied through S2 props.
- Documented component subpath imports, macro styling with Spectrum tokens and responsive breakpoints, no application CSS or unsafe style overrides.
- Standard dialog slots, nested ButtonGroup `slot={null}`, external form submission, pending/disabled behavior, and focus restoration were retained.

## Validation and scope

- Frontend lint, strict typecheck, 39 tests, and production build.
- Chromium: all six main routes at 390px and 1280px, each in light and dark modes (24 route/viewport/theme combinations), with no document overflow or runtime console errors. Backup setup and local HTTPS dialog actions also checked in each combination.
- Local demo API data was used; production accounts, network settings, and deployment were not changed.
- `@react-spectrum/test-utils` 1.0.0-rc.2 declares a `User` re-export but does not export it in its published JavaScript. Tests therefore import the same Adobe ARIA testers directly from the pinned `@react-aria/test-utils` package. The documented Spectrum import was tried before making this compatibility adjustment.
