/**
 * Semantic z-index scale for floating UI.
 *
 * Aligned with @pxlkit/ui-kit, which uses z-50 for its dropdowns, z-[80]
 * for modals and z-[90] for toasts — our layers slot in between so mixed
 * pxlkit/app surfaces always stack predictably:
 *
 *   Z.sticky  (10) — sticky gutters/headers inside a scroll pane (local)
 *   Z.overlay (30) — edge hover strips, in-pane hover overlays
 *   Z.chrome  (40) — floating app chrome: collapsed-sidebar flyout,
 *                    find-in-chat bar, pane corner buttons
 *   Z.menu    (50) — dropdowns, popovers, context menus, tooltips
 *   Z.modal   (80) — modal dialogs (matches PxlModal)
 *
 * The values are full Tailwind class literals (not numbers) so the JIT
 * scanner picks them up from this file.
 */
export const Z = {
	sticky: "z-10",
	overlay: "z-30",
	chrome: "z-40",
	menu: "z-50",
	modal: "z-[80]",
} as const;