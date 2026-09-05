import { randomUUID } from "node:crypto";

export interface StoredState<T> {
	stateId: string;
	resourceKey: string;
	epoch: number;
	value: T;
}

export class StaleResourceStateError extends Error {
	constructor(readonly resourceKey: string, readonly expectedEpoch: number, readonly actualEpoch: number) {
		super(`State is stale for ${resourceKey}: expected epoch ${expectedEpoch}, current epoch ${actualEpoch}.`);
		this.name = "StaleResourceStateError";
	}
}

/** Bounded insertion-ordered store for immutable agent-facing observations. */
export class StateStore<T> {
	private readonly records = new Map<string, StoredState<T>>();

	constructor(private readonly limit = 128) {}

	create(resourceKey: string, epoch: number, value: T): StoredState<T> {
		const record = { stateId: randomUUID(), resourceKey, epoch, value };
		this.set(record);
		return record;
	}

	set(record: StoredState<T>): void {
		this.records.delete(record.stateId);
		this.records.set(record.stateId, record);
		while (this.records.size > this.limit) {
			const oldest = this.records.keys().next().value as string | undefined;
			if (!oldest) break;
			this.records.delete(oldest);
		}
	}

	get(stateId: string): StoredState<T> | undefined {
		return this.records.get(stateId);
	}

	clear(): void {
		this.records.clear();
	}

	get size(): number {
		return this.records.size;
	}
}

interface ResourceRecord {
	epoch: number;
	tail: Promise<void>;
}

/**
 * Orders live operations per physical resource while allowing unrelated
 * resources to overlap. Cached state queries bypass this scheduler entirely.
 */
export class ResourceScheduler {
	private readonly resources = new Map<string, ResourceRecord>();
	private closed = false;

	epoch(resourceKey: string): number {
		return this.resource(resourceKey).epoch;
	}

	restoreEpoch(resourceKey: string, epoch: number): void {
		const record = this.resource(resourceKey);
		record.epoch = Math.max(record.epoch, Math.max(0, Math.trunc(epoch)));
	}

	async read<T>(resourceKey: string, work: (epoch: number) => Promise<T>): Promise<{ value: T; epoch: number }> {
		return await this.enqueue(resourceKey, async (record) => ({ value: await work(record.epoch), epoch: record.epoch }));
	}

	async readAt<T>(resourceKey: string, expectedEpoch: number, work: (epoch: number) => Promise<T>): Promise<{ value: T; epoch: number }> {
		return await this.enqueue(resourceKey, async (record) => {
			if (record.epoch !== expectedEpoch) throw new StaleResourceStateError(resourceKey, expectedEpoch, record.epoch);
			return { value: await work(record.epoch), epoch: record.epoch };
		});
	}

	async write<T>(resourceKey: string, baseEpoch: number, work: (nextEpoch: number) => Promise<T>): Promise<{ value: T; epoch: number }> {
		return await this.enqueue(resourceKey, async (record) => {
			if (record.epoch !== baseEpoch) throw new StaleResourceStateError(resourceKey, baseEpoch, record.epoch);
			const nextEpoch = record.epoch + 1;
			// Invalidate the base state before dispatch. If native execution becomes
			// uncertain or throws after a partial effect, later writes still fail safe.
			record.epoch = nextEpoch;
			return { value: await work(nextEpoch), epoch: nextEpoch };
		});
	}

	async drain(): Promise<void> {
		await Promise.all([...this.resources.values()].map((record) => record.tail.catch(() => undefined)));
	}

	async close(): Promise<void> {
		this.closed = true;
		await this.drain();
		this.resources.clear();
	}

	private resource(resourceKey: string): ResourceRecord {
		let record = this.resources.get(resourceKey);
		if (!record) {
			record = { epoch: 0, tail: Promise.resolve() };
			this.resources.set(resourceKey, record);
		}
		return record;
	}

	private async enqueue<T>(resourceKey: string, work: (record: ResourceRecord) => Promise<T>): Promise<T> {
		if (this.closed) throw new Error("Computer-use session is shutting down.");
		const record = this.resource(resourceKey);
		const previous = record.tail;
		let release!: () => void;
		const next = new Promise<void>((resolve) => { release = resolve; });
		record.tail = previous.catch(() => undefined).then(() => next);
		await previous.catch(() => undefined);
		try {
			return await work(record);
		} finally {
			release();
		}
	}
}
