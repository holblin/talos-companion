# Frontend conventions

Use the installed `react-spectrum-s2` skill for changes in `web/` and `spectrum-audit` for S2 audits. Read the relevant component reference before changing composition.

- Import components from their documented `@react-spectrum/s2/<Component>` subpath. The root is reserved for types and shared utilities.
- Use `style` from `@react-spectrum/s2/style` with `{ type: "macro" }`. Use `className` on native HTML and `styles` for permitted S2 layout properties.
- Use Spectrum tokens and responsive conditions. Do not add application CSS, inline `style`, `UNSAFE_style`, or `UNSAFE_className`. ESLint enforces these rules; the Spectrum `page.css` import is the sole stylesheet exception.
- Standard dialogs use direct `Heading`, `Content`, and `ButtonGroup` slots. Use a non-dismissible dialog when it has footer actions. `isDismissible` hides the footer ButtonGroup.
- Button groups inside dialog Content must explicitly use `slot={null}` to opt out of the dialog's footer context. Use `CustomDialog` only when the workflow requires a custom layout.
- Keep form submission accessible: an external submit button uses `form` referencing the actual form ID. Preserve pending/disabled state and focus restoration.
- Before completing UI work, run frontend lint, typecheck, tests, and the production build.
