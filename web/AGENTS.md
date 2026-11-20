# Frontend conventions

Use the installed `react-spectrum-s2` skill for changes in `web/` and `spectrum-audit` for S2 audits. Read the relevant component reference before changing composition.

Follow the durable preferences and proposal decisions in [docs/ui-decisions.md](../docs/ui-decisions.md). UI-10 (persisting table widths/sort order) is deferred and must not be implemented without a future explicit selection.

- Import components from their documented `@react-spectrum/s2/<Component>` subpath. The root is reserved for types and shared utilities.
- Use `style` from `@react-spectrum/s2/style` with `{ type: "macro" }`. Use `className` on native HTML and `styles` for permitted S2 layout properties.
- Use Spectrum tokens and responsive conditions. Do not add application CSS, inline `style`, `UNSAFE_style`, or `UNSAFE_className`. ESLint enforces these rules; the Spectrum `page.css` import is the sole stylesheet exception.
- Standard dialogs use direct `Heading`, `Content`, and `ButtonGroup` slots. Use a non-dismissible dialog when it has footer actions. `isDismissible` hides the footer ButtonGroup.
- Button groups inside dialog Content must explicitly use `slot={null}` to opt out of the dialog's footer context. Use `CustomDialog` only when the workflow requires a custom layout.
- Keep form submission accessible: an external submit button uses `form` referencing the actual form ID. Preserve pending/disabled state and focus restoration.
- Button labels composed from multiple expressions, or combined with an icon, must use Spectrum `Text` from the button's subpath. S2 only automatically wraps a single string; raw composite children miss the centered label slot. ESLint rejects unwrapped composite labels.
- Use `Panel` for document sections that need an S2 Card surface. Put custom card layouts inside its Content slot; preserve accessible regions and heading levels.
- Let TableView own its scrolling. Use column minWidth values rather than making the table wider than its parent. Supply row textValue and use TableBody renderEmptyState.
- Enable S2 column resizing on all tables and sorting on data columns; action-only columns stay resize-only. Use defaultWidth for uncontrolled resizing, sort raw numbers/dates rather than formatted labels, and keep missing values last in either direction.
- Use S2 Disclosure and Link. Keep the native skip link for its document-focus behavior, and mark API download links with download so the client router does not intercept them.
- Use the Provider's default system color scheme. Merge macro outputs with mergeStyles without also concatenating their original class strings.
- Prefer Adobe ARIA pattern testers for collections and overlays. Import User from @react-aria/test-utils: the currently published @react-spectrum/test-utils 1.0.0-rc.2 declares the re-export but omits it at runtime.
- Before completing UI work, run frontend lint, typecheck, tests, and the production build.
