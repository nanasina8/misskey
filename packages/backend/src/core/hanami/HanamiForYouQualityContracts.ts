/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/** Privacy-safe, versioned shadow data for later ranking experiments. */
export const HANAMI_QUALITY_SHADOW_RULE_VERSION = 'quality-shadow-rules-v1';
export const HANAMI_QUALITY_SHADOW_MODEL_VERSION = 'quality-shadow-model-v1';

export type HanamiRelationshipClass = 'directFollow' | 'known' | 'unknown';

export type HanamiQualityShadow = Readonly<{
	relationshipClass: HanamiRelationshipClass;
	standaloneValue: boolean | null;
	socialOnly: boolean | null;
	ruleVersion: string;
	modelVersion: string;
}>;

/**
 * Persistence-safe reason metadata. Deliberately no original text, normalized
 * text, exact fingerprint, or bot-template fingerprint may be attached here.
 */
export type HanamiQualityReasonMetadata = Readonly<{
	qualityShadow: HanamiQualityShadow;
}>;

export type CreateHanamiQualityShadowInput = Readonly<{
	relationshipClass: HanamiRelationshipClass;
	standaloneValue: boolean | null;
	socialOnly: boolean | null;
	ruleVersion?: string;
	modelVersion?: string;
}>;

/** Builds metadata only. It performs neither ranking nor hard filtering. */
export function createHanamiQualityShadow(input: CreateHanamiQualityShadowInput): HanamiQualityShadow {
	return {
		relationshipClass: input.relationshipClass,
		standaloneValue: input.standaloneValue,
		socialOnly: input.socialOnly,
		ruleVersion: input.ruleVersion ?? HANAMI_QUALITY_SHADOW_RULE_VERSION,
		modelVersion: input.modelVersion ?? HANAMI_QUALITY_SHADOW_MODEL_VERSION,
	};
}

export function createHanamiQualityReasonMetadata(input: CreateHanamiQualityShadowInput): HanamiQualityReasonMetadata {
	return { qualityShadow: createHanamiQualityShadow(input) };
}
