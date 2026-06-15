/**
 * Session Management
 *
 * Session persistence via EventStore: in-memory, persistent, continue, or open specific.
 */

import { createSessionFacade } from "pizza";

const cwd = process.cwd();

// In-memory (no persistence)
{
	const { facade } = await createSessionFacade({
		storagePath: ":memory:",
	});
	console.log("In-memory session created");
	facade.dispose();
}

// New persistent session (default storage in .pizza/events/ under cwd)
{
	const { facade } = await createSessionFacade({
		cwd,
	});
	console.log("Persistent session created");
	// The workspace database is at .pizza/events/<workspace-id>/events.db
	facade.dispose();
}

// Continue most recent session (or create new if none)
{
	const { facade, modelFallbackMessage } = await createSessionFacade({
		cwd,
	});
	if (modelFallbackMessage) console.log("Note:", modelFallbackMessage);
	console.log("Session resumed or created");
	facade.dispose();
}

// Open a specific session by ID
{
	const { facade } = await createSessionFacade({
		cwd,
		sessionId: "existing-session-id",
	});
	console.log("Opened specific session");
	facade.dispose();
}

// Fork a session from another workspace
// const { facade } = await createSessionFacade({
//   cwd,
//   forkFrom: {
//     workspaceId: "source-workspace-id",
//     sessionId: "source-session-id",
//   },
// });
