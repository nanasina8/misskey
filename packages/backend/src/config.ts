/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import * as yaml from 'js-yaml';
import { type FastifyServerOptions } from 'fastify';
import type * as Sentry from '@sentry/node';
import type * as SentryVue from '@sentry/vue';
import type { RedisOptions } from 'ioredis';
import { validateHanamiCursorSigningKeys } from '@/core/hanami/HanamiFeedCodec.js';
import type { HanamiCursorSigningKey } from '@/core/hanami/HanamiFeedCodecTypes.js';

const HANAMI_CURSOR_SIGNING_KEYS_JSON_ENV = 'HANAMI_CURSOR_SIGNING_KEYS_JSON';
const MAX_SAFE_CONFIG_INT = 2_147_483_647;
const MAX_USER_HIBERNATION_DAYS = 100_000_000;

type HanamiCursorSigningKeySource = {
	id: string;
	secret: string;
};

type RedisOptionsSource = Partial<RedisOptions> & {
	host: string;
	port: number;
	family?: number;
	pass: string;
	db?: number;
	prefix?: string;
};

/**
 * 設定ファイルの型
 */
type Source = {
	url?: string;
	port?: number;
	socket?: string;
	trustProxy?: FastifyServerOptions['trustProxy'];
	chmodSocket?: string;
	disableHsts?: boolean;
	db: {
		host: string;
		port: number;
		db?: string;
		user?: string;
		pass?: string;
		disableCache?: boolean;
		extra?: { [x: string]: string };
	};
	dbReplications?: boolean;
	dbSlaves?: {
		host: string;
		port: number;
		db: string;
		user: string;
		pass: string;
	}[];
	redis: RedisOptionsSource;
	redisForPubsub?: RedisOptionsSource;
	redisForJobQueue?: RedisOptionsSource;
	redisForTimelines?: RedisOptionsSource;
	redisForReactions?: RedisOptionsSource;
	fulltextSearch?: {
		provider?: FulltextSearchProvider;
	};
	meilisearch?: {
		host: string;
		port: string;
		apiKey: string;
		ssl?: boolean;
		index: string;
		scope?: 'local' | 'global' | string[];
	};
	hanamisearch?: {
		host: string;
		port: string;
		apiKey: string;
		ssl?: boolean;
		index: string;
		scope?: 'local' | 'global' | string[];
	};
	sentryForBackend?: { options: Partial<Sentry.NodeOptions>; enableNodeProfiling: boolean; };
	sentryForFrontend?: {
		options: Partial<SentryVue.BrowserOptions> & { dsn: string };
		vueIntegration?: SentryVue.VueIntegrationOptions | null;
		browserTracingIntegration?: Parameters<typeof SentryVue.browserTracingIntegration>[0] | null;
		replayIntegration?: Parameters<typeof SentryVue.replayIntegration>[0] | null;
	};

	publishTarballInsteadOfProvideRepositoryUrl?: boolean;

	setupPassword?: string;

	proxy?: string;
	proxySmtp?: string;
	proxyBypassHosts?: string[];

	allowedPrivateNetworks?: string[];

	maxFileSize?: number;

	clusterLimit?: number;

	id: string;

	outgoingAddress?: string;
	outgoingAddressFamily?: 'ipv4' | 'ipv6' | 'dual';

	deliverJobConcurrency?: number;
	inboxJobConcurrency?: number;
	relationshipJobConcurrency?: number;
	deliverJobPerSec?: number;
	inboxJobPerSec?: number;
	relationshipJobPerSec?: number;
	deliverJobMaxAttempts?: number;
	inboxJobMaxAttempts?: number;

	mediaProxy?: string;
	videoThumbnailGenerator?: string;

	perChannelMaxNoteCacheCount?: number;
	perUserNotificationsMaxCount?: number;
	deactivateAntennaThreshold?: number;

	import?: {
		downloadTimeout: number;
		maxFileSize: number;
	};

	pidFile: string;

	logging?: {
		sql?: {
			disableQueryTruncation?: boolean,
			enableQueryParamLogging?: boolean,
		}
	};
	hanamiCursorSigningKeys?: HanamiCursorSigningKeySource[];
	hanamiGenerationSyncWaitMs?: number;
	userHibernationDays?: number;
	hanamiCommonGenerationIntervalMs?: number;
	hanamiGenerationWorkerTimeoutMs?: number;
	hanamiGenerationLeaseMs?: number;
	hanamiGenerationMaxAttempts?: number;
	hanamiGenerationReconcileIntervalMs?: number;
	hanamiGenerationQueueConcurrency?: number;
};

export type Config = {
	url: string;
	port: number;
	socket: string | undefined;
	trustProxy: FastifyServerOptions['trustProxy'];
	chmodSocket: string | undefined;
	disableHsts: boolean | undefined;
	db: {
		host: string;
		port: number;
		db: string;
		user: string;
		pass: string;
		disableCache?: boolean;
		extra?: { [x: string]: string };
	};
	dbReplications: boolean | undefined;
	dbSlaves: {
		host: string;
		port: number;
		db: string;
		user: string;
		pass: string;
	}[] | undefined;
	fulltextSearch?: {
		provider?: FulltextSearchProvider;
	};
	meilisearch: {
		host: string;
		port: string;
		apiKey: string;
		ssl?: boolean;
		index: string;
		scope?: 'local' | 'global' | string[];
	} | undefined;
	hanamisearch: {
		host: string;
		port: string;
		apiKey: string;
		ssl?: boolean;
		index: string;
		scope?: 'local' | 'global' | string[];
	} | undefined;
	proxy: string | undefined;
	proxySmtp: string | undefined;
	proxyBypassHosts: string[] | undefined;
	allowedPrivateNetworks: string[] | undefined;
	maxFileSize: number;
	clusterLimit: number | undefined;
	id: string;
	outgoingAddress: string | undefined;
	outgoingAddressFamily: 'ipv4' | 'ipv6' | 'dual' | undefined;
	deliverJobConcurrency: number | undefined;
	inboxJobConcurrency: number | undefined;
	relationshipJobConcurrency: number | undefined;
	deliverJobPerSec: number | undefined;
	inboxJobPerSec: number | undefined;
	relationshipJobPerSec: number | undefined;
	deliverJobMaxAttempts: number | undefined;
	inboxJobMaxAttempts: number | undefined;
	logging?: {
		sql?: {
			disableQueryTruncation?: boolean,
			enableQueryParamLogging?: boolean,
		}
	}

	version: string;
	publishTarballInsteadOfProvideRepositoryUrl: boolean;
	setupPassword: string | undefined;
	host: string;
	hostname: string;
	scheme: string;
	wsScheme: string;
	apiUrl: string;
	wsUrl: string;
	authUrl: string;
	driveUrl: string;
	userAgent: string;
	frontendEntry: { file: string | null };
	frontendManifestExists: boolean;
	frontendEmbedEntry: { file: string | null };
	frontendEmbedManifestExists: boolean;
	mediaProxy: string;
	externalMediaProxyEnabled: boolean;
	videoThumbnailGenerator: string | null;
	redis: RedisOptions & RedisOptionsSource;
	redisForPubsub: RedisOptions & RedisOptionsSource;
	redisForJobQueue: RedisOptions & RedisOptionsSource;
	redisForTimelines: RedisOptions & RedisOptionsSource;
	redisForReactions: RedisOptions & RedisOptionsSource;
	sentryForBackend: { options: Partial<Sentry.NodeOptions>; enableNodeProfiling: boolean; } | undefined;
	sentryForFrontend: {
		options: Partial<SentryVue.BrowserOptions> & { dsn: string };
		vueIntegration?: SentryVue.VueIntegrationOptions | null;
		browserTracingIntegration?: Parameters<typeof SentryVue.browserTracingIntegration>[0] | null;
		replayIntegration?: Parameters<typeof SentryVue.replayIntegration>[0] | null;
	} | undefined;
	perChannelMaxNoteCacheCount: number;
	perUserNotificationsMaxCount: number;
	deactivateAntennaThreshold: number;

	import: {
		downloadTimeout: number;
		maxFileSize: number;
	} | undefined;

	pidFile: string;
	hanamiCursorSigningKeys: HanamiCursorSigningKey[];
	hanamiGenerationSyncWaitMs: number;
	userHibernationDays: number;
	hanamiCommonGenerationIntervalMs: number;
	hanamiGenerationWorkerTimeoutMs: number;
	hanamiGenerationLeaseMs: number;
	hanamiGenerationMaxAttempts: number;
	hanamiGenerationReconcileIntervalMs: number;
	hanamiGenerationQueueConcurrency: number;
};

export type FulltextSearchProvider = 'sqlLike' | 'sqlPgroonga' | 'meilisearch';

export type HanamiConfigSource = Partial<Pick<Source,
	| 'hanamiCursorSigningKeys'
	| 'hanamiGenerationSyncWaitMs'
	| 'userHibernationDays'
	| 'hanamiCommonGenerationIntervalMs'
	| 'hanamiGenerationWorkerTimeoutMs'
	| 'hanamiGenerationLeaseMs'
	| 'hanamiGenerationMaxAttempts'
	| 'hanamiGenerationReconcileIntervalMs'
	| 'hanamiGenerationQueueConcurrency'
>>;

export type HanamiConfigValues = Pick<Config,
	| 'hanamiCursorSigningKeys'
	| 'hanamiGenerationSyncWaitMs'
	| 'userHibernationDays'
	| 'hanamiCommonGenerationIntervalMs'
	| 'hanamiGenerationWorkerTimeoutMs'
	| 'hanamiGenerationLeaseMs'
	| 'hanamiGenerationMaxAttempts'
	| 'hanamiGenerationReconcileIntervalMs'
	| 'hanamiGenerationQueueConcurrency'
>;

const _filename = fileURLToPath(import.meta.url);
const _dirname = dirname(_filename);

/**
 * Path of configuration directory
 */
const dir = `${_dirname}/../../../.config`;

/**
 * Path of configuration file
 */
export const path = process.env.MISSKEY_CONFIG_YML
	? resolve(dir, process.env.MISSKEY_CONFIG_YML)
	: process.env.NODE_ENV === 'test'
		? resolve(dir, 'test.yml')
		: resolve(dir, 'default.yml');

export type LoadConfigOptions = {
	/**
	 * サーバー実行時にしか使わない秘密（cursor署名鍵）の検証を要求するか。既定はtrue。
	 *
	 * migrationやCLIはDB接続情報しか使わないため、鍵が未設定でも動かせる必要がある。
	 * ここをtrueに固定すると `pnpm migrate` が鍵未設定のデプロイでスキーマ適用すらできなくなる。
	 * falseのときは鍵を空配列にするが、HanamiFeedCodec側が空配列を拒否するため、
	 * 万一この設定でAPIを動かしても署名なしcursorが発行されることはない。
	 */
	requireRuntimeSecrets?: boolean;
};

export function loadConfig(options: LoadConfigOptions = {}): Config {
	const meta = JSON.parse(fs.readFileSync(`${_dirname}/../../../built/meta.json`, 'utf-8'));

	const frontendManifestExists = fs.existsSync(_dirname + '/../../../built/_frontend_vite_/manifest.json');
	const frontendEmbedManifestExists = fs.existsSync(_dirname + '/../../../built/_frontend_embed_vite_/manifest.json');
	const frontendManifest = frontendManifestExists ?
		JSON.parse(fs.readFileSync(`${_dirname}/../../../built/_frontend_vite_/manifest.json`, 'utf-8'))
		: { 'src/_boot_.ts': { file: null } };
	const frontendEmbedManifest = frontendEmbedManifestExists ?
		JSON.parse(fs.readFileSync(`${_dirname}/../../../built/_frontend_embed_vite_/manifest.json`, 'utf-8'))
		: { 'src/boot.ts': { file: null } };

	const config = yaml.load(fs.readFileSync(path, 'utf-8')) as Source;
	const hanamiConfig = resolveHanamiConfig(config, process.env, options.requireRuntimeSecrets ?? true);

	const url = tryCreateUrl(config.url ?? process.env.MISSKEY_URL ?? '');
	const version = meta.version;
	const host = url.host;
	const hostname = url.hostname;
	const scheme = url.protocol.replace(/:$/, '');
	const wsScheme = scheme.replace('http', 'ws');

	const dbDb = config.db.db ?? process.env.DATABASE_DB ?? '';
	const dbUser = config.db.user ?? process.env.DATABASE_USER ?? '';
	const dbPass = config.db.pass ?? process.env.DATABASE_PASSWORD ?? '';

	const externalMediaProxy = config.mediaProxy ?
		config.mediaProxy.endsWith('/') ? config.mediaProxy.substring(0, config.mediaProxy.length - 1) : config.mediaProxy
		: null;
	const internalMediaProxy = `${scheme}://${host}/proxy`;
	const redis = convertRedisOptions(config.redis, host);

	const fulltextSearch = config.fulltextSearch ?? {};
	fulltextSearch.provider = fulltextSearch.provider ?? 'meilisearch';

	return {
		version,
		publishTarballInsteadOfProvideRepositoryUrl: !!config.publishTarballInsteadOfProvideRepositoryUrl,
		setupPassword: config.setupPassword,
		url: url.origin,
		port: config.port ?? parseInt(process.env.PORT ?? '', 10),
		socket: config.socket,
		trustProxy: config.trustProxy,
		chmodSocket: config.chmodSocket,
		disableHsts: config.disableHsts,
		host,
		hostname,
		scheme,
		wsScheme,
		wsUrl: `${wsScheme}://${host}`,
		apiUrl: `${scheme}://${host}/api`,
		authUrl: `${scheme}://${host}/auth`,
		driveUrl: `${scheme}://${host}/files`,
		db: { ...config.db, db: dbDb, user: dbUser, pass: dbPass },
		dbReplications: config.dbReplications,
		dbSlaves: config.dbSlaves,
		fulltextSearch,
		meilisearch: config.meilisearch,
		hanamisearch: config.hanamisearch,
		redis,
		redisForPubsub: config.redisForPubsub ? convertRedisOptions(config.redisForPubsub, host) : redis,
		redisForJobQueue: config.redisForJobQueue ? convertRedisOptions(config.redisForJobQueue, host) : redis,
		redisForTimelines: config.redisForTimelines ? convertRedisOptions(config.redisForTimelines, host) : redis,
		redisForReactions: config.redisForReactions ? convertRedisOptions(config.redisForReactions, host) : redis,
		sentryForBackend: config.sentryForBackend,
		sentryForFrontend: config.sentryForFrontend,
		id: config.id,
		proxy: config.proxy,
		proxySmtp: config.proxySmtp,
		proxyBypassHosts: config.proxyBypassHosts,
		allowedPrivateNetworks: config.allowedPrivateNetworks,
		maxFileSize: config.maxFileSize ?? 262144000,
		clusterLimit: config.clusterLimit,
		outgoingAddress: config.outgoingAddress,
		outgoingAddressFamily: config.outgoingAddressFamily,
		deliverJobConcurrency: config.deliverJobConcurrency,
		inboxJobConcurrency: config.inboxJobConcurrency,
		relationshipJobConcurrency: config.relationshipJobConcurrency,
		deliverJobPerSec: config.deliverJobPerSec,
		inboxJobPerSec: config.inboxJobPerSec,
		relationshipJobPerSec: config.relationshipJobPerSec,
		deliverJobMaxAttempts: config.deliverJobMaxAttempts,
		inboxJobMaxAttempts: config.inboxJobMaxAttempts,
		mediaProxy: externalMediaProxy ?? internalMediaProxy,
		externalMediaProxyEnabled: externalMediaProxy !== null && externalMediaProxy !== internalMediaProxy,
		videoThumbnailGenerator: config.videoThumbnailGenerator ?
			config.videoThumbnailGenerator.endsWith('/') ? config.videoThumbnailGenerator.substring(0, config.videoThumbnailGenerator.length - 1) : config.videoThumbnailGenerator
			: null,
		userAgent: `Misskey/${version} (${config.url})`,
		frontendEntry: frontendManifest['src/_boot_.ts'],
		frontendManifestExists: frontendManifestExists,
		frontendEmbedEntry: frontendEmbedManifest['src/boot.ts'],
		frontendEmbedManifestExists: frontendEmbedManifestExists,
		perChannelMaxNoteCacheCount: config.perChannelMaxNoteCacheCount ?? 1000,
		perUserNotificationsMaxCount: config.perUserNotificationsMaxCount ?? 500,
		deactivateAntennaThreshold: config.deactivateAntennaThreshold ?? (1000 * 60 * 60 * 24 * 7),
		import: config.import,
		pidFile: config.pidFile,
		logging: config.logging,
		...hanamiConfig,
	};
}

function tryCreateUrl(url: string) {
	try {
		return new URL(url);
	} catch (e) {
		throw new Error(`url="${url}" is not a valid URL.`);
	}
}

function convertRedisOptions(options: RedisOptionsSource, host: string): RedisOptions & RedisOptionsSource {
	return {
		...options,
		password: options.pass,
		prefix: options.prefix ?? host,
		family: options.family ?? 0,
		keyPrefix: `${options.prefix ?? host}:`,
		db: options.db ?? 0,
		reconnectOnError(err: any) {
			const targetError = 'READONLY';
			if (err.message.includes(targetError)) {
				return 2; // 再接続を行った後にクエリを実行する、そこでエラーがなければアプリケーション側にはエラーを伝えない。
			}
			return false;
		},
	};
}

export function resolveHanamiConfig(config: HanamiConfigSource, env: NodeJS.ProcessEnv = process.env, requireRuntimeSecrets = true): HanamiConfigValues {
	const hanamiCursorSigningKeys = readHanamiCursorSigningKeys(config.hanamiCursorSigningKeys, env[HANAMI_CURSOR_SIGNING_KEYS_JSON_ENV], requireRuntimeSecrets);
	const hanamiGenerationSyncWaitMs = readConfigInt('hanamiGenerationSyncWaitMs', config.hanamiGenerationSyncWaitMs, 2000, { min: 0 });
	const userHibernationDays = readConfigInt('userHibernationDays', config.userHibernationDays, 50, { min: 1, max: MAX_USER_HIBERNATION_DAYS });
	const hanamiCommonGenerationIntervalMs = readConfigInt('hanamiCommonGenerationIntervalMs', config.hanamiCommonGenerationIntervalMs, 600000, { min: 1 });
	const hanamiGenerationWorkerTimeoutMs = readConfigInt('hanamiGenerationWorkerTimeoutMs', config.hanamiGenerationWorkerTimeoutMs, 60000, { min: 1 });
	const hanamiGenerationLeaseMs = readConfigInt('hanamiGenerationLeaseMs', config.hanamiGenerationLeaseMs, 75000, { min: 1 });
	const hanamiGenerationMaxAttempts = readConfigInt('hanamiGenerationMaxAttempts', config.hanamiGenerationMaxAttempts, 3, { min: 1 });
	const hanamiGenerationReconcileIntervalMs = readConfigInt('hanamiGenerationReconcileIntervalMs', config.hanamiGenerationReconcileIntervalMs, 5000, { min: 1 });
	const hanamiGenerationQueueConcurrency = readConfigInt('hanamiGenerationQueueConcurrency', config.hanamiGenerationQueueConcurrency, 4, { min: 1 });

	if (hanamiGenerationLeaseMs <= hanamiGenerationWorkerTimeoutMs) {
		throw new Error(`Invalid config: hanamiGenerationLeaseMs (${hanamiGenerationLeaseMs}) must be greater than hanamiGenerationWorkerTimeoutMs (${hanamiGenerationWorkerTimeoutMs}).`);
	}

	return {
		hanamiCursorSigningKeys,
		hanamiGenerationSyncWaitMs,
		userHibernationDays,
		hanamiCommonGenerationIntervalMs,
		hanamiGenerationWorkerTimeoutMs,
		hanamiGenerationLeaseMs,
		hanamiGenerationMaxAttempts,
		hanamiGenerationReconcileIntervalMs,
		hanamiGenerationQueueConcurrency,
	};
}

export function readHanamiCursorSigningKeys(
	yamlValue: Source['hanamiCursorSigningKeys'],
	envValue = process.env[HANAMI_CURSOR_SIGNING_KEYS_JSON_ENV],
	requireRuntimeSecrets = true,
): HanamiCursorSigningKey[] {
	if (envValue != null) {
		return parseHanamiCursorSigningKeysJson(envValue);
	}

	// 未設定のまま起動を許すのはmigration/CLIだけ。設定されていれば常に検証する。
	if (!requireRuntimeSecrets && yamlValue === undefined) return [];

	return validateHanamiCursorSigningKeysSource(yamlValue, 'hanamiCursorSigningKeys is required and must be a YAML list with 1 or 2 entries. Generate one with `node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"` and add it to your .config yml as `hanamiCursorSigningKeys: [{ id: current, secret: <value> }]`, or set the HANAMI_CURSOR_SIGNING_KEYS_JSON env var.');
}

function parseHanamiCursorSigningKeysJson(value: string): HanamiCursorSigningKey[] {
	let parsed: unknown;

	try {
		parsed = JSON.parse(value);
	} catch {
		throw new Error(`Invalid config: ${HANAMI_CURSOR_SIGNING_KEYS_JSON_ENV} must be valid JSON containing a 1-2 item signing-key array.`);
	}

	if (!Array.isArray(parsed) || parsed.some((entry) => (
		typeof entry !== 'object'
		|| entry === null
		|| typeof (entry as Record<string, unknown>).id !== 'string'
		|| typeof (entry as Record<string, unknown>).secret !== 'string'
	))) {
		throw new Error(`Invalid config: ${HANAMI_CURSOR_SIGNING_KEYS_JSON_ENV} must be a JSON array of 1 or 2 {id,secret} objects.`);
	}

	return validateHanamiCursorSigningKeysSource(parsed as HanamiCursorSigningKeySource[], `${HANAMI_CURSOR_SIGNING_KEYS_JSON_ENV} failed validation`);
}

function validateHanamiCursorSigningKeysSource(value: Source['hanamiCursorSigningKeys'], missingMessage: string): HanamiCursorSigningKey[] {
	if (!Array.isArray(value)) {
		throw new Error(`Invalid config: ${missingMessage}`);
	}

	try {
		validateHanamiCursorSigningKeys(value);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Invalid config: ${message}.`);
	}

	return value.map((key) => ({ id: key.id, secret: key.secret }));
}

export function readConfigInt(name: string, value: number | undefined, defaultValue: number, opts: {
	min?: number;
	max?: number;
}): number {
	const resolved = value ?? defaultValue;

	if (!Number.isFinite(resolved) || !Number.isSafeInteger(resolved)) {
		throw new Error(`Invalid config: ${name} must be a finite safe integer (received ${String(resolved)}).`);
	}

	const max = opts.max ?? MAX_SAFE_CONFIG_INT;

	if (opts.min != null && resolved < opts.min) {
		throw new Error(`Invalid config: ${name} must be >= ${opts.min} (received ${resolved}).`);
	}

	if (resolved > max) {
		throw new Error(`Invalid config: ${name} must be <= ${max} (received ${resolved}).`);
	}

	return resolved;
}
