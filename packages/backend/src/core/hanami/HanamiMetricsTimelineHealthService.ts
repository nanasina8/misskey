/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { DI } from '@/di-symbols.js';
import type { OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import type { DataSource } from 'typeorm';

const jstYesterday = () => new Date(Date.now() + 9 * 60 * 60 * 1000 - 86_400_000).toISOString().slice(0, 10);

/** Durable coverage evidence, not a retry queue for counters (which are not idempotent). */
@Injectable()
export class HanamiMetricsTimelineHealthService implements OnModuleInit, OnApplicationShutdown {
	private readonly id = randomUUID();
	private readonly inFlight = new Map<string, number>();
	private readonly failedDays = new Set<string>();
	private failureRevision = 0;
	private ready?: Promise<void>;
	private initialized = false;
	private stopping = false;
	private timer?: ReturnType<typeof setInterval>;
	private flushing?: Promise<void>;

	constructor(@Inject(DI.db) private readonly db: DataSource) {}

	public onModuleInit(): Promise<void> {
		this.ready ??= this.initialize();
		return this.ready;
	}

	private async initialize(): Promise<void> {
		try {
			await this.db.query(`
				INSERT INTO "hanami_metrics_collector" ("id", "startedAt", "lastSeenAt", "verifiedThrough", "stoppedAt")
				VALUES ($1::uuid, now(), now(), $2::date, NULL)
			`, [this.id, jstYesterday()]);
		} catch {
			// Startup MUST fail; never include driver errors, credentials or identifiers.
			throw new Error('Timeline metrics collector registration failed');
		}
		this.initialized = true;
		if (!this.stopping) {
			this.timer = setInterval(() => { void this.heartbeat(); }, 30_000);
			this.timer.unref();
		}
	}

	/** Synchronous: call with the captured JST day before the counter's first await. */
	public begin(day: string): void {
		this.inFlight.set(day, (this.inFlight.get(day) ?? 0) + 1);
		// Nest awaits onModuleInit before serving. Misordered callers cannot prove coverage.
		if (!this.initialized || this.stopping) this.markFailed(day);
	}

	public finish(day: string, ok: boolean): void {
		const remaining = (this.inFlight.get(day) ?? 1) - 1;
		if (remaining === 0) this.inFlight.delete(day);
		else this.inFlight.set(day, remaining);
		if (!ok) this.markFailed(day);
	}

	private markFailed(day: string): void {
		this.failedDays.add(day);
		this.failureRevision++;
	}

	public heartbeat(): Promise<void> {
		if (!this.initialized || this.stopping) return Promise.resolve();
		// Coalesce overlapping ticks; never run two snapshots/transactions concurrently.
		this.flushing ??= this.flush(false).finally(() => { this.flushing = undefined; });
		return this.flushing;
	}

	private async flush(stop: boolean): Promise<void> {
		const days = [...this.failedDays];
		const revision = this.failureRevision;
		// Freeze before any await: new requests belong to today, not this watermark.
		const yesterday = jstYesterday();
		const verified = [...this.inFlight.keys()].some(day => day <= yesterday) ? null : yesterday;
		try {
			await this.db.transaction(async manager => {
				await manager.query(`
					INSERT INTO "hanami_metrics_gap" ("day", "metric")
					SELECT day, 'timeline' FROM unnest($1::date[]) AS days(day)
					ON CONFLICT ("day", "metric") DO NOTHING
				`, [days]);
				// Closing abandoned sessions alone would lose uncertainty when they resume.
				// Materialize the entire uncertain interval atomically, excluding this UUID.
				await manager.query(`
					WITH stale AS (
						UPDATE "hanami_metrics_collector" SET "stoppedAt" = now()
						WHERE "id" <> $1::uuid AND "stoppedAt" IS NULL
						AND "lastSeenAt" < now() - interval '2 minutes'
						RETURNING "verifiedThrough"
					)
					INSERT INTO "hanami_metrics_gap" ("day", "metric")
					SELECT DISTINCT day::date, 'timeline' FROM stale
					CROSS JOIN LATERAL generate_series("verifiedThrough" + 1,
						(now() AT TIME ZONE 'Asia/Tokyo')::date, interval '1 day') AS days(day)
					ON CONFLICT ("day", "metric") DO NOTHING
				`, [this.id]);
				await manager.query(`
					UPDATE "hanami_metrics_collector"
					SET "lastSeenAt" = now(),
						"verifiedThrough" = GREATEST("verifiedThrough", COALESCE($2::date, "verifiedThrough")),
						"stoppedAt" = CASE WHEN $3::boolean THEN now() ELSE NULL END
					WHERE "id" = $1::uuid
				`, [this.id, verified, stop]);
			});
			// A failure arriving during COMMIT (even for the same day) must survive.
			if (revision === this.failureRevision) for (const day of days) this.failedDays.delete(day);
		} catch {
			// Keep all failed days until a later successful transaction. An unclosed row
			// with an old watermark remains fail-closed after a crash or DB outage.
		}
	}

	public async onApplicationShutdown(): Promise<void> {
		this.stopping = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		await this.ready?.catch(() => {});
		await this.flushing;
		if (!this.initialized) return;
		// Normally HTTP has drained. Treat remaining attempts as gaps rather than
		// claiming a clean stop while their eventual outcome is still unknown.
		for (const day of this.inFlight.keys()) this.markFailed(day);
		await this.flush(true);
	}
}
