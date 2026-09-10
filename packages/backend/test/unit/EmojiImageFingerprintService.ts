/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { describe, expect, jest, test } from '@jest/globals';
import sharp from 'sharp';
import { EmojiImageFingerprintService } from '@/core/EmojiImageFingerprintService.js';

const fixture = (name: string) => readFile(new URL(`../resources/${name}`, import.meta.url));

async function animated(format: 'gif' | 'webp', options: { loop: number; delay: number[] }): Promise<Buffer> {
	return sharp(await fixture('anime.gif'), { animated: true, pages: -1 }).toFormat(format, options).toBuffer();
}

/** Swap the two complete GIF image blocks while preserving its header and loop extension. */
function reverseTwoFrameGif(input: Buffer): Buffer {
	const blocks: Array<{ start: number; end: number }> = [];
	for (let offset = 13 + ((input[10] & 0x80) === 0 ? 0 : 3 * (1 << ((input[10] & 0x07) + 1))); offset < input.length;) {
		const start = offset;
		if (input[offset] === 0x21) {
			const label = input[offset + 1];
			offset += 2;
			if (label === 0xf9) offset += 6;
			else while (input[offset] !== 0) offset += input[offset] + 1;
			if (label !== 0xf9) { offset++; continue; }
		}
		if (input[offset] !== 0x2c) { offset++; continue; }
		offset += 10;
		if ((input[offset - 1] & 0x80) !== 0) offset += 3 * (1 << ((input[offset - 1] & 0x07) + 1));
		offset++; // LZW minimum code size
		while (input[offset] !== 0) offset += input[offset] + 1;
		blocks.push({ start, end: offset + 1 });
		offset++;
	}
	expect(blocks).toHaveLength(2);
	return Buffer.concat([input.subarray(0, blocks[0].start), input.subarray(blocks[1].start, blocks[1].end), input.subarray(blocks[0].start, blocks[0].end), input.subarray(blocks[1].end)]);
}

type ApngFrame = { pixels: Buffer; width: number; height: number; left?: number; top?: number; delay?: number; dispose?: 0 | 1 | 2; blend?: 0 | 1 };

function crc32(input: Buffer): number {
	let crc = 0xffffffff;
	for (const byte of input) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
	const chunk = Buffer.allocUnsafe(data.length + 12);
	chunk.writeUInt32BE(data.length, 0); chunk.write(type, 4, 4, 'ascii'); data.copy(chunk, 8);
	chunk.writeUInt32BE(crc32(chunk.subarray(4, data.length + 8)), data.length + 8);
	return chunk;
}

function compressedRgba(frame: ApngFrame): Buffer {
	const rows = Buffer.allocUnsafe((frame.width * 4 + 1) * frame.height);
	for (let y = 0; y < frame.height; y++) {
		rows[y * (frame.width * 4 + 1)] = 0;
		frame.pixels.copy(rows, y * (frame.width * 4 + 1) + 1, y * frame.width * 4, (y + 1) * frame.width * 4);
	}
	return deflateSync(rows);
}

/** A deliberately tiny, Node-only APNG writer: RGBA8 PNG chunks, zlib, and CRC-32. */
function apng(options: { width: number; height: number; frames: ApngFrame[]; loop?: number; defaultImage?: Buffer }): Buffer {
	const chunks: Buffer[] = [Buffer.from('\x89PNG\r\n\x1a\n', 'binary')];
	const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(options.width, 0); ihdr.writeUInt32BE(options.height, 4); ihdr[8] = 8; ihdr[9] = 6;
	chunks.push(pngChunk('IHDR', ihdr));
	const control = Buffer.alloc(8); control.writeUInt32BE(options.frames.length, 0); control.writeUInt32BE(options.loop ?? 0, 4);
	chunks.push(pngChunk('acTL', control));
	const defaultImage = options.defaultImage;
	let sequence = 0;
	const frameControl = (frame: ApngFrame): Buffer => {
		const data = Buffer.alloc(26); data.writeUInt32BE(sequence++, 0); data.writeUInt32BE(frame.width, 4); data.writeUInt32BE(frame.height, 8);
		data.writeUInt32BE(frame.left ?? 0, 12); data.writeUInt32BE(frame.top ?? 0, 16); data.writeUInt16BE(frame.delay ?? 10, 20); data.writeUInt16BE(1000, 22); data[24] = frame.dispose ?? 0; data[25] = frame.blend ?? 0;
		return pngChunk('fcTL', data);
	};
	if (defaultImage !== undefined) {
		chunks.push(pngChunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: options.height }, (_, y) => Buffer.concat([Buffer.from([0]), defaultImage.subarray(y * options.width * 4, (y + 1) * options.width * 4)]))))));
		for (const frame of options.frames) { chunks.push(frameControl(frame)); const data = compressedRgba(frame); const fdAT = Buffer.alloc(data.length + 4); fdAT.writeUInt32BE(sequence++, 0); data.copy(fdAT, 4); chunks.push(pngChunk('fdAT', fdAT)); }
	} else {
		const [first, ...rest] = options.frames;
		chunks.push(frameControl(first), pngChunk('IDAT', compressedRgba(first)));
		for (const frame of rest) { chunks.push(frameControl(frame)); const data = compressedRgba(frame); const fdAT = Buffer.alloc(data.length + 4); fdAT.writeUInt32BE(sequence++, 0); data.copy(fdAT, 4); chunks.push(pngChunk('fdAT', fdAT)); }
	}
	chunks.push(pngChunk('IEND', Buffer.alloc(0)));
	return Buffer.concat(chunks);
}

const pixel = (...rgba: number[]) => Buffer.from(rgba);

describe('EmojiImageFingerprintService', () => {
	test('uses normalized pixels rather than source bytes', async () => {
		const codec = new EmojiImageFingerprintService();
		const pixels = Buffer.from([255, 0, 0, 255, 0, 0, 0, 0]);
		const png = await sharp(pixels, { raw: { width: 2, height: 1, channels: 4 } }).png().withMetadata({ density: 72 }).toBuffer();
		const pngWithOtherMetadata = await sharp(pixels, { raw: { width: 2, height: 1, channels: 4 } }).png().withMetadata({ density: 144 }).toBuffer();
		const changed = await sharp(Buffer.from([254, 0, 0, 255, 0, 0, 0, 0]), { raw: { width: 2, height: 1, channels: 4 } }).png().toBuffer();
		assert.notDeepEqual(png, pngWithOtherMetadata);
		expect(await codec.compute(png)).toBe(await codec.compute(pngWithOtherMetadata));
		expect(await codec.compute(png)).not.toBe(await codec.compute(changed));
	});

	test('gives PNG and lossless WebP with identical RGBA pixels the same fingerprint', async () => {
		const codec = new EmojiImageFingerprintService();
		const pixels = Buffer.from([10, 20, 30, 255, 0, 0, 0, 0, 40, 50, 60, 127, 70, 80, 90, 255]);
		const image = sharp(pixels, { raw: { width: 2, height: 2, channels: 4 } });
		const png = await image.clone().png().toBuffer();
		const webp = await image.clone().webp({ lossless: true }).toBuffer();
		expect(png).not.toEqual(webp);
		expect(await codec.compute(png)).toBe(await codec.compute(webp));
	});

	test('ignores metadata and RGB under fully transparent pixels, but preserves visible pixels and dimensions', async () => {
		const codec = new EmojiImageFingerprintService();
		const pixels = Buffer.from([0, 0, 0, 0, 20, 30, 40, 255]);
		const metadata72 = await sharp(pixels, { raw: { width: 2, height: 1, channels: 4 } }).png().withMetadata({ density: 72 }).toBuffer();
		const metadata144 = await sharp(pixels, { raw: { width: 2, height: 1, channels: 4 } }).png().withMetadata({ density: 144 }).toBuffer();
		const transparentRgbChanged = await sharp(Buffer.from([255, 255, 255, 0, 20, 30, 40, 255]), { raw: { width: 2, height: 1, channels: 4 } }).png().toBuffer();
		const visiblePixelChanged = await sharp(Buffer.from([0, 0, 0, 0, 21, 30, 40, 255]), { raw: { width: 2, height: 1, channels: 4 } }).png().toBuffer();
		const dimensionsChanged = await sharp(pixels, { raw: { width: 1, height: 2, channels: 4 } }).png().toBuffer();
		expect(await codec.compute(metadata72)).toBe(await codec.compute(metadata144));
		expect(await codec.compute(metadata72)).toBe(await codec.compute(transparentRgbChanged));
		expect(await codec.compute(metadata72)).not.toBe(await codec.compute(visiblePixelChanged));
		expect(await codec.compute(metadata72)).not.toBe(await codec.compute(dimensionsChanged));
	});

	test.each(['gif', 'webp'] as const)('includes GIF/WebP animation frame order, delays, and loop count (%s)', async (format) => {
		const codec = new EmojiImageFingerprintService();
		const baseline = await animated(format, { loop: 2, delay: [70, 130] });
		const differentDelay = await animated(format, { loop: 2, delay: [130, 70] });
		const differentLoop = await animated(format, { loop: 3, delay: [70, 130] });
		const reversedGif = reverseTwoFrameGif(await animated('gif', { loop: 2, delay: [70, 130] }));
		const reversed = format === 'gif' ? reversedGif : await sharp(reversedGif, { animated: true, pages: -1 }).webp({ loop: 2, delay: [70, 130] }).toBuffer();
		const metadata = await sharp(baseline, { animated: true, pages: -1 }).metadata();
		expect(metadata).toMatchObject({ pages: 2, loop: 2, delay: [70, 130] });
		expect(await codec.compute(baseline)).not.toBe(await codec.compute(differentDelay));
		expect(await codec.compute(baseline)).not.toBe(await codec.compute(differentLoop));
		expect(await codec.compute(baseline)).not.toBe(await codec.compute(reversed));
	});

	test.each(['gif', 'webp'] as const)('streams exactly one canonical raw frame per GIF/WebP page without retaining them (%s)', async (format) => {
		const codec = new EmojiImageFingerprintService();
		const source = await animated(format, { loop: 2, delay: [70, 130] });
		let header: { width: number; height: number; frameCount: number; loop: number } | null = null;
		const frames: Buffer[] = [];
		await (codec as any).decodeWithSharp(source, {
			begin: (width: number, height: number, frameCount: number, loop: number) => { header = { width, height, frameCount, loop }; },
			frame: (_delay: unknown, rgba: Buffer) => { frames.push(rgba); },
		});

		expect(header).toEqual({ width: expect.any(Number), height: expect.any(Number), frameCount: 2, loop: 2 });
		expect(frames).toHaveLength(2);
		for (const rgba of frames) expect(rgba).toHaveLength(header!.width * header!.height * 4);
		expect(frames[0]).not.toEqual(frames[1]);
	});

	test('rejects malformed input and enforces the pre-decode input-size limit', async () => {
		const codec = new EmojiImageFingerprintService();
		await expect(codec.compute(Buffer.from('not an image'))).rejects.toMatchObject({ code: 'INVALID_IMAGE' });
		await expect(codec.compute(Buffer.alloc(16 * 1024 * 1024 + 1))).rejects.toMatchObject({ code: 'INPUT_TOO_LARGE' });
	});

	test('enforces its deadline deterministically through the protected clock seam', async () => {
		class TestCodec extends EmojiImageFingerprintService { protected override deadlineMs(): number { return 1; } }
		jest.useFakeTimers();
		try {
			const codec = new TestCodec();
			const pending = expect((codec as any).withDeadline(new Promise(() => {}))).rejects.toMatchObject({ code: 'DEADLINE_EXCEEDED' });
			await jest.advanceTimersByTimeAsync(1);
			await pending;
		} finally { jest.useRealTimers(); }
	});

	test('composites partial-alpha APNG SOURCE and OVER frames into their displayed canvases', async () => {
		const codec = new EmojiImageFingerprintService();
		const first = { pixels: pixel(255, 0, 0, 255, 255, 0, 0, 255), width: 2, height: 1 };
		const partialBlue = { pixels: pixel(0, 0, 255, 128), width: 1, height: 1 };
		const source = apng({ width: 2, height: 1, frames: [first, { ...partialBlue, blend: 0 }] });
		const sourceReference = apng({ width: 2, height: 1, frames: [first, { pixels: pixel(0, 0, 255, 128, 255, 0, 0, 255), width: 2, height: 1 }] });
		const over = apng({ width: 2, height: 1, frames: [first, { ...partialBlue, blend: 1 }] });
		const overReference = apng({ width: 2, height: 1, frames: [first, { pixels: pixel(127, 0, 128, 255, 255, 0, 0, 255), width: 2, height: 1 }] });
		expect(await codec.compute(source)).toBe(await codec.compute(sourceReference));
		expect(await codec.compute(over)).toBe(await codec.compute(overReference));
		expect(await codec.compute(source)).not.toBe(await codec.compute(over));
	});

	test('applies APNG NONE, BACKGROUND, and PREVIOUS disposal before the next frame', async () => {
		const codec = new EmojiImageFingerprintService();
		const first = { pixels: pixel(255, 0, 0, 255, 255, 0, 0, 255), width: 2, height: 1 };
		const middle = { pixels: pixel(0, 0, 255, 255), width: 1, height: 1 };
		const last = { pixels: pixel(0, 255, 0, 255), width: 1, height: 1, left: 1 };
		for (const [dispose, expected] of [[0, pixel(0, 0, 255, 255, 0, 255, 0, 255)], [1, pixel(0, 0, 0, 0, 0, 255, 0, 255)], [2, pixel(255, 0, 0, 255, 0, 255, 0, 255)]] as const) {
			const actual = apng({ width: 2, height: 1, frames: [first, { ...middle, dispose }, last] });
			const reference = apng({ width: 2, height: 1, frames: [first, { pixels: pixel(0, 0, 255, 255, 255, 0, 0, 255), width: 2, height: 1 }, { pixels: expected, width: 2, height: 1 }] });
			expect(await codec.compute(actual)).toBe(await codec.compute(reference));
		}
	});

	test('does not treat an APNG default image as an animation frame', async () => {
		const codec = new EmojiImageFingerprintService();
		const frame = { pixels: pixel(255, 0, 0, 255), width: 1, height: 1 };
		const animation = apng({ width: 1, height: 1, frames: [frame] });
		const withBlueDefault = apng({ width: 1, height: 1, defaultImage: pixel(0, 0, 255, 255), frames: [frame] });
		const withGreenDefault = apng({ width: 1, height: 1, defaultImage: pixel(0, 255, 0, 255), frames: [frame] });
		expect(await codec.compute(withBlueDefault)).toBe(await codec.compute(animation));
		expect(await codec.compute(withGreenDefault)).toBe(await codec.compute(animation));
	});

	test('enforces APNG width, height, frame-count, and expanded-pixel header limits', async () => {
		const codec = new EmojiImageFingerprintService();
		const one = { pixels: pixel(0, 0, 0, 0), width: 1, height: 1 };
		const oversizedWidth = apng({ width: 4097, height: 1, defaultImage: one.pixels, frames: [one] });
		const oversizedHeight = apng({ width: 1, height: 4097, defaultImage: one.pixels, frames: [one] });
		const tooManyFrames = apng({ width: 1, height: 1, defaultImage: one.pixels, frames: Array.from({ length: 257 }, () => one) });
		const tooManyPixels = apng({ width: 4096, height: 4096, defaultImage: one.pixels, frames: Array.from({ length: 5 }, () => one) });
		for (const image of [oversizedWidth, oversizedHeight, tooManyFrames, tooManyPixels]) await expect(codec.compute(image)).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
	});
});
