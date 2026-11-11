# UI preferences and decisions — 2026-11-11

This records the desktop/mobile UI review and the user's decisions in this session.
It governs future proposals alongside [frontend conventions](../web/AGENTS.md).

## Durable preferences

- Use React Spectrum S2 components and the S2 `style` macro only, with Spectrum tokens and responsive conditions.
- Prefer tables for listings on both desktop and mobile. Do not replace them with cards or stacked lists. Let tables own their horizontal scrolling.
- Keep the interface compact. Avoid unnecessary form rearrangement, extra visible explanations, and additional spacing that reduces information density.
- Keep secondary explanations in contextual help. For truncated backup filenames specifically, use an ellipsis and an S2 tooltip, not contextual help; the full filename must be available on hover and keyboard focus.
- Make all tables sortable and resizable using native S2 behavior. Data columns sort; action-only columns resize without sorting. Sort raw dates/numbers, keep missing values last, and use `defaultWidth` for uncontrolled resizing.
- Review improvements on desktop and mobile. Each new proposal needs a stable identifier, a partial before screenshot, a partial after screenshot, and a one-line description. Obtain the user's selection before implementing a proposal.
- A possible future idea is not implementation approval. Preserve rejected proposals and their rationale rather than proposing the same tradeoffs again.

## Decision register

| ID | Proposal | User decision and rationale | Result |
| --- | --- | --- | --- |
| UI-01 | Replace the mobile backup table with stacked rows. | Rejected: tables are superior for listings. | Not implemented. |
| UI-02 | Replace the mobile account table with summary cards/rows. | Rejected for the same reason: keep tables. | Not implemented. |
| UI-03 | Show an actionable warning for local-only recovery backups. | Approved. | Implemented: “Add an external recovery copy” notice with “Configure backup destinations.” |
| UI-04 | Pair backup frequency and destination in a two-column form. | Rejected: unnecessary. | Not implemented. |
| UI-05 | Expose access-method descriptions outside contextual help. | Rejected: less compact; the information already exists in contextual help. | Not implemented. |
| UI-06 | Compact backup rows and move Download earlier. | Approved with a change: filename ellipsis and tooltip instead of contextual help. | Implemented: Created / Download / Size, with a focusable filename download link and full-filename tooltip. |
| UI-07 | Put account actions immediately after account identity. | Approved. | Implemented: Account / Actions / Email / Role / Created by / Created at / Last login at. |
| UI-08 | Compact credential Copy and Reveal controls. | Approved. | Implemented: S2 icon actions with tooltips and accessible labels; copying keeps the credential masked. |
| UI-09 | Add sortable backup columns. | Approved and expanded: all tables should be sortable and resizable. | Implemented for Accounts, Backup history, and Recent recovery files; action/download columns resize only. |
| UI-10 | Remember table column widths and sort order across reloads. | Possible future option only; explicitly do not implement yet. | Deferred. No persistence is included in the application. Requires a future explicit selection. |

## Implementation details to preserve

- UI-03 treats connected Google Drive, configured NFS/SMB destinations, and legacy mounted NAS destinations as external destinations. Unknown status stays neutral. The notice does not claim a verified restore or successful external transfer.
- UI-06 keeps API download links marked `download` so the client router does not intercept them.
- UI-07 preserves editing, deletion, self-deletion, and last-administrator safeguards.
- UI-08 handles unavailable or denied clipboard access with a safe toast, prevents duplicate pending copies, and does not expose credentials or raw exceptions in feedback.
- UI-09 uses stable, immutable sorting with natural, case-insensitive text comparison. Recovery files start newest-first; accounts start by account name ascending. The native header menu exposes sorting and resize mode, including keyboard resizing.
- UI-10 was explored only in an isolated prototype. That prototype is not an application implementation or an approval to add local storage.

## Review evidence and validation

The session's local, ignored review galleries contain partial before/after screenshots:

- `dist/ui-review/review.html`: UI-01 through UI-05.
- `dist/ui-review-round2/review.html`: UI-06 through UI-08.
- `dist/ui-review-round3/review.html`: UI-09.
- `dist/ui-review-round4/review.html`: UI-10 prototype only.

These artifacts are local review material, not tracked release files. The decisions above are the durable record.

Before release preparation, frontend lint, TypeScript, formatting, the production build, and all 71 tests passed. Synthetic browser checks covered sorting, pointer/keyboard resizing, filename tooltips, masked credential copying, and table-contained scrolling at 360/390px mobile widths. A Vite large-chunk warning remains. These checks are not a full accessibility certification or physical-device audit.
