# Independent UI/UX qualification — 2026-11-07

The requested minimum was 7/10 in each of the ten previously reviewed
categories. Each category was assigned to a separate sub-agent using
`fork_turns="none"`. Reviewers received one category, the current source and
synthetic browser evidence. They were explicitly excluded from prior reports,
other reviewers' results and previous scores. The requested passing threshold
was not included in their prompts. Scores below are the reviewers' actual
judgments, without normalization or adjustment.

| Category | Independent score /10 | Reviewer |
| --- | ---: | --- |
| Visual design and consistency | 8.0 | `/root/grade_visual` |
| Hierarchy and scanability | 7.5 | `/root/grade_hierarchy` |
| Navigation and discoverability | 8.2 | `/root/grade_navigation` |
| Onboarding and forms | 8.4 | `/root/grade_onboarding` |
| Backup and recovery confidence | 8.0 | `/root/grade_recovery` |
| Status, feedback and error recovery | 7.5 | `/root/grade_feedback` |
| Mobile usability | 7.5 | `/root/grade_mobile` |
| Accessibility foundations | 7.8 | `/root/grade_accessibility` |
| Copy and guidance | 8.1 | `/root/grade_copy` |
| Perceived performance | 7.5 | `/root/grade_performance` |

Every category met the minimum. These are heuristic reviews, not user-research
results, security assessments or accessibility certifications.

Side-by-side recordings compare the committed 0.3.6 interface (`6df4384`) with
this qualification pass, using identical synthetic accounts and recovery files:

- [Desktop comparison](assets/desktop-qualified-before-after.mp4)
- [Mobile comparison](assets/mobile-qualified-before-after.mp4)

Both are silent, labeled MP4s showing the overview, scrolling and Backups page.
Use `capture-ui.py --out <directory>` for an isolated set of phase recordings,
then `compose-ui-video.py --directory <directory>` to align and combine them.

## Implemented changes

- Replaced the aggregate dashboard query with independent TanStack Query
  queries for settings/infrastructure, recovery files, accounts and recovery
  material. Errors no longer erase successful sections or fabricate zero
  backups and unconfigured infrastructure. Failed sections have their own
  retry controls; existing cached data carries a stale-data explanation.
- Distinguished pending, unavailable, empty and configured states. The header
  reports data loading/failure rather than asserting unconditional service
  health. The local backup destination no longer claims an untested “Ready.”
- Added a recovery-readiness summary with latest local archive date/download,
  configured backup interval and destination, external-copy setup status, and
  explicit passphrase/restore-test guidance. Archive dates are read only from
  recognized server-generated names; unknown names show an unavailable date.
  No restore-verification or remote-copy-success claim is invented.
- Labeled the primary action “Create local backup.” Omni and Google Drive have
  separate actions; the Drive action uses a TanStack Router hash destination
  and focuses the correct setup section.
- Put recovery files first on Backups. Destination/schedule configuration,
  recovery-material management and restore instructions use S2 disclosures.
  Mobile lists show readable dates and downloads, with full filenames available
  on demand rather than as the primary label.
- Added a visible-on-focus skip link, route-heading focus and document titles.
  Closing destination setup returns focus to the button that opened it.
- Moved the recovery table into a lazy-loaded module. The final production build
  no longer emits the previous chunk-size warning. This removes table code from
  the initial application module; the Overview still requests it when needed.

All new app styling uses React Spectrum S2 `style()` macros in TypeScript.
There is no app-owned CSS file. Controls use S2, including the disclosures,
buttons, status lights, progress indicators, links and recovery table.

## Verification and evidence limits

- Strict TypeScript, ESLint, Prettier, production build and frontend tests pass.
  The full frontend suite passed 26 tests, including independent failed-query
  retries, pending data, logout cache removal, destination navigation and focus
  restoration. Date parsing has a regression test for unknown filenames.
- `scripts/verify-ui.py` passed 23 Chromium scenarios using synthetic API
  fixtures. These cover five viewport widths (320, 390, 768, 1024, 1440),
  dashboard/empty/sign-in/setup rendering, expanded destination setup,
  independent accounts and recovery-file failures/retries, route focus, setup
  close focus, the Drive shortcut, the skip link and a CSS-zoom layout check.
- Impeccable's source detector returned `[]`; this checks source patterns and
  does not certify usability, contrast or accessibility.
- Screenshots and machine-readable check results are in ignored
  `dist/ui-review/qualification/`. Early desktop/mobile navigation reviewers
  saw a screenshot during S2 picker dismissal. Captures now wait for that
  animation to finish; their original scores were retained rather than raised
  manually to remove this conservative uncertainty.
- The performance reviewer measured local synthetic production rendering at
  414 ms cold and 257 ms on repeat navigation, with FCP at 204/96 ms. Those
  figures are localhost observations, not production/network benchmarks.
  Initial assets still include approximately 969 kB decoded JavaScript;
  observed initial transfer was about 306 kB before the table. Routing disables
  browser cache, so the repeat result is not a caching claim.
- Mobile uses emulated Chromium. The 200% check uses CSS zoom, which preserves
  desktop media-query choices and showed cramped columns; it is not equivalent
  to a real browser-zoom or physical-device reflow test. Full screen-reader,
  contrast, reduced-motion, mobile Safari and slow-network audits remain open.
- No production backup, restore, OAuth or NAS operation was performed by this
  qualification. Existing concurrent backend/deployment edits in the checkout
  were preserved and are outside this UI change set.

## Remaining improvements identified independently

The reviewers still recommend operational run history (last scheduled outcome,
next execution and remote-transfer results), an explicit recorded restore drill,
larger mobile touch areas, less dashboard scrolling, operation-specific progress
and completion feedback, item-specific accessible control names, and a complete
assistive-technology/reflow audit. These would strengthen the UI beyond the
requested floor; they are not represented as already verified features.

Copy still has a few legacy references, such as “Open Identity” in setup where
navigation now says “Omni configuration,” and poetic titles that are less useful
in an incident. Some configuration is available from both Settings and Backups.
Google authorization state reflects saved credentials, not a live token test.

## Reproduce the browser evidence

Install Python Playwright and its Chromium browser, build the frontend, and run
Vite's production preview. Then:

```powershell
python scripts/verify-ui.py --url http://127.0.0.1:5175
```

The verifier intercepts API traffic with synthetic fixtures. It never needs the
installation's real administrator credentials.
