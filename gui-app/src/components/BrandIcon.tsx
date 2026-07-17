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
			{/* Pizza slice silhouette — triangle pointing up */}
			<g fill="currentColor">
				{/* Crust base (rows 12-13, full width tapering) */}
				<rect x="3" y="12" width="10" height="1" />
				<rect x="4" y="13" width="8" height="1" />
				{/* Cheese body (rows 3-11, tapering triangle) */}
				<rect x="7" y="2" width="2" height="1" />
				<rect x="6" y="3" width="4" height="1" />
				<rect x="5" y="4" width="6" height="1" />
				<rect x="5" y="5" width="6" height="1" />
				<rect x="4" y="6" width="8" height="1" />
				<rect x="4" y="7" width="8" height="1" />
				<rect x="4" y="8" width="8" height="1" />
				<rect x="3" y="9" width="10" height="1" />
				<rect x="3" y="10" width="10" height="1" />
				<rect x="3" y="11" width="10" height="1" />
			</g>
			{/* Pepperoni dots */}
			<g fill="#c9613e" fillOpacity="0.9">
				<rect x="6" y="6" width="2" height="2" />
				<rect x="9" y="8" width="2" height="2" />
				<rect x="5" y="9" width="2" height="2" />
			</g>
			{/* Highlight stripe (light from upper-left) */}
			<g fill="#ffffff" fillOpacity="0.25">
				<rect x="5" y="4" width="1" height="7" />
			</g>
		</svg>
	);
}
