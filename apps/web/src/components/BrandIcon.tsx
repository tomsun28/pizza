export function BrandIcon({
	size = 28,
	className,
}: {
	size?: number;
	className?: string;
}) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 16 16"
			xmlns="http://www.w3.org/2000/svg"
			shapeRendering="crispEdges"
			className={className}
			role="img"
			aria-label="pizza"
		>
			{/* Pixel-art pizza slice pointing down */}
			<g fill="#D4A373">
				{/* Crust (rows 1-2) */}
				<rect x="3" y="1" width="10" height="1" />
				<rect x="4" y="2" width="8" height="1" />
			</g>
			<g fill="#F9C74F">
				{/* Cheese body tapering to the tip */}
				<rect x="5" y="3" width="6" height="1" />
				<rect x="5" y="4" width="6" height="1" />
				<rect x="4" y="5" width="8" height="1" />
				<rect x="4" y="6" width="8" height="1" />
				<rect x="4" y="7" width="8" height="1" />
				<rect x="3" y="8" width="10" height="1" />
				<rect x="3" y="9" width="10" height="1" />
				<rect x="3" y="10" width="10" height="1" />
				<rect x="5" y="11" width="6" height="1" />
				<rect x="6" y="12" width="4" height="1" />
				<rect x="7" y="13" width="2" height="1" />
			</g>
			{/* Pepperoni */}
			<g fill="#BC4749">
				<rect x="6" y="5" width="2" height="2" />
				<rect x="9" y="7" width="2" height="2" />
				<rect x="5" y="8" width="2" height="2" />
			</g>
			{/* Basil */}
			<g fill="#43AA8B">
				<rect x="9" y="4" width="1" height="1" />
				<rect x="5" y="10" width="1" height="1" />
			</g>
		</svg>
	);
}
