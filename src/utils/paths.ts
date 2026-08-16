/**
 * Returns true if the value is NOT a package source (npm:, git:, file:, etc.)
 * or a URL protocol. Bare names and relative paths without ./ prefix
 * are considered local.
 */
export function isLocalPath(value: string): boolean {
	const trimmed = value.trim();
	// Known non-local prefixes
	if (
		trimmed.startsWith("npm:") ||
		trimmed.startsWith("git:") ||
		trimmed.startsWith("git+ssh:") ||
		trimmed.startsWith("git+https:") ||
		trimmed.startsWith("git+http:") ||
		trimmed.startsWith("github:") ||
		trimmed.startsWith("file:") ||
		trimmed.startsWith("http:") ||
		trimmed.startsWith("https:") ||
		trimmed.startsWith("ssh:")
	) {
		return false;
	}
	return true;
}
