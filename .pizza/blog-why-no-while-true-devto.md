---
title: "Why Does Every AI Agent Still Look Like `while (true) { ... }`?"
published: true
description: "Most agent runtimes share the same brittle skeleton. Here's what happens when you replace it with an event log."
tags: ai, typescript, architecture, opensource
cover_image: https://raw.githubusercontent.com/tomsun28/pizza/main/resources/pizza-desktop-white.png
---

Open any agent codebase today — Claude Code, Codex, Cursor, most of the open-source ones — and you'll find the same skeleton. Something like:

```ts
let state = {};
while (true) {
  const plan = await llm.plan(state);
  const results = await runTools(plan);
  state = updateState(state, results);
  if (isDone(state)) break;
}
```

It's the natural first design. The model is the brain, the loop is the heart, and `state` is whatever bag of objects you've accumulated. It works great for demos.

But after you start living with one of these agents for a while, the same cracks show up everywhere.

---

## The cracks in the loop

**Interruption is a hack.** If the user kills the process mid-turn, or a tool hangs, or the model asks for clarification, you've got this awkward half-finished iteration sitting in `state`. You either throw it away or patch it in place. Either way the state is lying to you about what actually happened.

**Retries are special cases.** A tool fails? Write a `try/catch` around it, maybe retry, maybe pass the error to the model, remember to add it to `state`. After a few months you've got a dozen ad-hoc branches for "what if this turn didn't finish cleanly."

**Parallel tool calls are awkward.** The model wants to call `read` and `grep` at the same time. Now your loop has to either sequence them or spawn promises and reassemble the result before the next `llm.plan()`. Again, more state to manage.

**You can't rewind.** `state` is a pile of mutable objects. You can't branch from an earlier point in the conversation without reconstructing it by hand. You can't replay what the model actually saw. Good luck debugging a long session.

These aren't implementation details. They're the direct result of the `while(true)` shape: one mutable state object that tries to stand in for the entire history of the conversation.

---

## What if the log is the state?

A few months ago I started building a personal agent, **Pizza**, with a different premise: **the log is the source of truth, and the state is just a projection of that log.**

Every message, tool call, result, and file edit becomes one row in an `EventStore`:

```sql
CREATE TABLE events (
  sequence INTEGER PRIMARY KEY,
  event_id TEXT,
  type TEXT,
  payload_json TEXT,
  caused_by TEXT,
  thread_id TEXT,
  ...
);
```

The runtime doesn't hold `state` in memory. It reads the tail of this log, dispatches the next event to a handler, and appends the result back. A "turn" is a state transition, not another loop iteration.

The UI, the LLM context, and the session tree are all just queries over the same log. If you want to see what happened, you read the events. If you want to branch the conversation, you start a new `thread_id` from an earlier `sequence`. If you want to replay, you re-apply the events.

---

## Other things that fall out of the log

Once you commit to the event log being the source of truth, a bunch of otherwise hard features stop being special cases.

### No "new chat" button

There's no hard boundary between tasks. You can keep talking to the same workspace for days, weeks, or years — every previous message, edit, and tool call is still there as an event you can query. The agent manages its own context by projecting the tail of the log, not by asking you to start over with a blank chat. Think of it like a long-running thread with a friend who remembers everything.

### One CLI tool, not a JSON menu

Instead of a long list of `read_file` / `write_file` / `grep` / `git` tools, the model gets one `cli` tool. Built-in commands like `read`, `write`, and `edit` are handled by structured internal handlers, but everything else — `grep`, `sed`, `git`, `npm`, `python`, `ls` — gets passed straight to the user's shell. The model has to learn shell, but it also gets to compose real pipelines. And because every `cli` invocation is one event, the log stays consistent: one row for `read`, one row for `git diff`, one row for `npm test`.

### Git-like session tree

Because every message is an event with a `caused_by` pointer, the conversation is already a tree. You can fork from any earlier message, rewind, branch, and continue. It's not a bolt-on undo stack; it's just how the data is shaped.

### Same runtime for every interface

The TUI, the desktop app, the JSON-RPC server, and the one-shot CLI all consume the same `SessionFacade` event stream. They're different projections of the same log. If you start a session in the terminal and later open the desktop app, it's the same event stream.

### Agents can `tell` each other

One Pizza agent in workspace A can send a `tell` event to an agent in workspace B. Workspace B's agent handles the task in its own event log and writes a result back. The actual project files and context from B never leak into A's log — only the `tell` request and its response are events.

### It can even fix itself (if you enable it)

There's an opt-in skill called `pizza-self-optimization` that reads the local event log as evidence, forks the Pizza repo, reproduces a bug from the log, writes a test, and opens a PR. It only works because the event log is a reproducible record of what the agent actually did.

---

## The trade-offs nobody wants to admit

Event sourcing isn't free. You now have a real database in the hot path. You have to think about replay cost, log size, and snapshotting. If a session has a few thousand events, rebuilding the context from the log on every fork gets slow; you'll want periodic materialized snapshots. I don't have that yet, but it's clearly the next piece.

You also lose the simplicity of "just keep a big state object in memory." If your runtime needs to know something, it has to be in an event. Anything outside the log is an invisible side effect and a bug waiting to happen.

---

## Not a panacea, but not the only shape either

The `while(true)` pattern is still the right default for a lot of agents. It's simple, it runs, and it fits in a tutorial. But if you want long-running sessions, branching conversations, multi-agent collaboration, and the ability to audit or replay what the agent actually did, it starts to feel like the wrong abstraction.

The `EventStore` approach has its own costs, but it makes the hard things — forks, replays, multi-agent collaboration, debugging — into ordinary database operations. That was the bet I made with Pizza, and so far it's the part of the design that's held up best.

If you're curious, the code is open source at [github.com/tomsun28/pizza](https://github.com/tomsun28/pizza). Feedback and arguments welcome.
