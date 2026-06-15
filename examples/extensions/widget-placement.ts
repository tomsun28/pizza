import type { ExtensionAPI } from "pizza";

export default function widgetPlacementExtension(pizza: ExtensionAPI) {
	pizza.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setWidget("widget-above", ["Above editor widget"]);
		ctx.ui.setWidget("widget-below", ["Below editor widget"], { placement: "belowEditor" });
	});
}
