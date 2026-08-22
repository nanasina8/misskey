/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as fs from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from '@jest/globals';

const chartRoot = resolve(process.cwd(), '../../chart');
const defaultConfig = fs.readFileSync(resolve(chartRoot, 'files/default.yml'), 'utf-8');
const deploymentTemplate = fs.readFileSync(resolve(chartRoot, 'templates/Deployment.yml'), 'utf-8');
const configMapTemplate = fs.readFileSync(resolve(chartRoot, 'templates/ConfigMap.yml'), 'utf-8');

describe('Hanami Helm chart contracts', () => {
	test('does not ship a live signing key placeholder in the default config', () => {
		expect(defaultConfig).not.toMatch(/^hanamiCursorSigningKeys:/m);
		expect(defaultConfig).toContain('Helm injects HANAMI_CURSOR_SIGNING_KEYS_JSON from a Secret instead');
	});

	test('deployment wires HANAMI_CURSOR_SIGNING_KEYS_JSON from a required Secret reference', () => {
		expect(deploymentTemplate).toContain('required "Set .Values.hanami.cursorSigningKeysSecret.existingSecretName');
		expect(deploymentTemplate).toContain('required "Set .Values.hanami.cursorSigningKeysSecret.secretKey');
		expect(deploymentTemplate).toContain('name: HANAMI_CURSOR_SIGNING_KEYS_JSON');
		expect(deploymentTemplate).toContain('secretKeyRef:');
	});

	test('ConfigMap does not render signing secrets', () => {
		expect(configMapTemplate).not.toContain('HANAMI_CURSOR_SIGNING_KEYS_JSON');
		expect(configMapTemplate).not.toContain('hanamiCursorSigningKeys:');
	});
});
