/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import apngPackage from 'apng-js';
import sharp from 'sharp';

const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const MAX_DIMENSION = 4096;
const MAX_EXPANDED_PIXELS = 64 * 1024 * 1024;
const MAX_FRAMES = 256;
const DEADLINE_MS = 10_000;

type ApngFrame = {
	left: number;
	top: number;
	width: number;
	height: number;
	disposeOp: number;
	blendOp: number;
	imageData: Blob | null;
};

type ParsedApng = {
	width: number;
	height: number;
	numPlays: number;
	frames: ApngFrame[];
};

type Delay = { numerator: number; denominator: number };

/**
 * デコード済みフレームの受け口。全フレームを配列に溜めると1画像あたり最大 MAX_EXPANDED_PIXELS * 4 バイト
 * (=256MiB) を同時に保持することになるため、デコーダはフレームを1枚ずつここへ流し込む。
 */
type FrameSink = {
	begin(width: number, height: number, frameCount: number, loop: number): void;
	frame(delay: Delay, rgba: Buffer): void;
};

/** A stable, machine-readable reason that an image was deliberately not fingerprinted. */
export class EmojiImageFingerprintError extends Error {
	public constructor(
		public readonly code: 'INPUT_TOO_LARGE' | 'INVALID_IMAGE' | 'LIMIT_EXCEEDED' | 'DEADLINE_EXCEEDED',
		message: string,
		public readonly warnings: readonly string[] = [],
	) {
		super(message);
		this.name = 'EmojiImageFingerprintError';
	}
}

/** Injectable pix-v1 codec for queue processors. `compute` returns `pix-v1:<sha256 hex>`. */
@Injectable()
export class EmojiImageFingerprintService {
	public async compute(buffer: Buffer): Promise<string> {
		if (buffer.length > MAX_INPUT_BYTES) throw new EmojiImageFingerprintError('INPUT_TOO_LARGE', 'Image exceeds the 16 MiB fingerprint input limit');

		return this.withDeadline(this.computeUnchecked(buffer));
	}

	private async computeUnchecked(buffer: Buffer): Promise<string> {
		try {
			const apng = this.parseApng(buffer);
			const hash = createHash('sha256');
			const sink: FrameSink = {
				begin: (width, height, frameCount, loop) => {
					this.assertLimits(width, height, frameCount);
					hash.update('pix-v1\0');
					this.writeU32(hash, width);
					this.writeU32(hash, height);
					this.writeU32(hash, frameCount);
					this.writeU32(hash, loop);
				},
				frame: (delay, rgba) => {
					this.writeU32(hash, delay.numerator);
					this.writeU32(hash, delay.denominator);
					hash.update(this.zeroTransparentRgb(rgba));
				},
			};

			if (apng === null) await this.decodeWithSharp(buffer, sink);
			else await this.decodeApng(apng, buffer, sink);

			return `pix-v1:${hash.digest('hex')}`;
		} catch (error) {
			if (error instanceof EmojiImageFingerprintError) throw error;
			throw new EmojiImageFingerprintError('INVALID_IMAGE', 'Image cannot be decoded for fingerprinting', [error instanceof Error ? error.message : 'Unknown decoder error']);
		}
	}

	private parseApng(buffer: Buffer): ParsedApng | null {
		if (!this.hasApngControlChunk(buffer)) return null;
		const parser = (apngPackage as unknown as { default: (input: ArrayBuffer) => ParsedApng | Error }).default;
		const input = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
		const parsed = parser(input);
		if (parsed instanceof Error) throw new EmojiImageFingerprintError('INVALID_IMAGE', parsed.message);
		return parsed;
	}

	private async decodeWithSharp(buffer: Buffer, sink: FrameSink): Promise<void> {
		const metadata = await sharp(buffer, { animated: true, pages: -1, limitInputPixels: MAX_EXPANDED_PIXELS }).metadata();
		const pages = metadata.pages ?? 1;
		const width = metadata.width;
		const height = metadata.pageHeight ?? metadata.height;
		if (width === undefined || height === undefined) throw new EmojiImageFingerprintError('INVALID_IMAGE', 'Image has no dimensions');
		this.assertLimits(width, height, pages);
		const orientation = metadata.orientation ?? 1;
		const outputWidth = orientation >= 5 && orientation <= 8 ? height : width;
		const outputHeight = orientation >= 5 && orientation <= 8 ? width : height;
		sink.begin(outputWidth, outputHeight, pages, metadata.loop ?? 0);
		// ページは逐次デコードする。並列化すると sharp のデコードコンテキストと raw バッファが
		// フレーム数ぶん同時に生存してしまう。
		for (let page = 0; page < pages; page++) {
			const result = await sharp(buffer, { animated: true, pages: 1, page, limitInputPixels: MAX_EXPANDED_PIXELS })
				.rotate().toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
			if (result.info.width !== outputWidth || result.info.height !== outputHeight || result.data.length !== outputWidth * outputHeight * 4) {
				throw new EmojiImageFingerprintError('INVALID_IMAGE', 'Animated frame dimensions are inconsistent');
			}
			sink.frame(this.millisecondDelay(metadata.delay?.[page] ?? 0), result.data);
		}
	}

	private async decodeApng(apng: ParsedApng, source: Buffer, sink: FrameSink): Promise<void> {
		this.assertLimits(apng.width, apng.height, apng.frames.length);
		const delays = this.apngDelays(source);
		if (delays.length !== apng.frames.length) throw new EmojiImageFingerprintError('INVALID_IMAGE', 'APNG frame controls do not match parsed frames');
		const orientation = (await sharp(source, { limitInputPixels: MAX_EXPANDED_PIXELS }).metadata()).orientation ?? 1;
		const swapped = orientation >= 5 && orientation <= 8;
		sink.begin(swapped ? apng.height : apng.width, swapped ? apng.width : apng.height, apng.frames.length, apng.numPlays);
		let canvas = Buffer.alloc(apng.width * apng.height * 4);
		for (let index = 0; index < apng.frames.length; index++) {
			const frame = apng.frames[index];
			if (frame.imageData === null) throw new EmojiImageFingerprintError('INVALID_IMAGE', 'APNG frame has no image data');
			this.assertLimits(frame.width, frame.height, 1);
			if (frame.left + frame.width > apng.width || frame.top + frame.height > apng.height) throw new EmojiImageFingerprintError('INVALID_IMAGE', 'APNG frame exceeds its canvas');
			const image = Buffer.from(await frame.imageData.arrayBuffer());
			const decoded = await sharp(image, { limitInputPixels: MAX_EXPANDED_PIXELS }).toColourspace('srgb').ensureAlpha().raw().toBuffer();
			if (decoded.length !== frame.width * frame.height * 4) throw new EmojiImageFingerprintError('INVALID_IMAGE', 'APNG frame dimensions are inconsistent');
			const previous = frame.disposeOp === 2 ? Buffer.from(canvas) : null;
			this.composite(canvas, apng.width, frame, decoded);
			sink.frame(delays[index], this.orient(canvas, apng.width, apng.height, orientation));
			if (frame.disposeOp === 1) this.clear(canvas, apng.width, frame);
			else if (previous !== null) canvas = previous;
		}
	}

	private composite(canvas: Buffer, canvasWidth: number, frame: ApngFrame, pixels: Buffer): void {
		for (let y = 0; y < frame.height; y++) for (let x = 0; x < frame.width; x++) {
			const destination = ((frame.top + y) * canvasWidth + frame.left + x) * 4;
			const source = (y * frame.width + x) * 4;
			if (frame.blendOp === 0) pixels.copy(canvas, destination, source, source + 4);
			else {
				const sa = pixels[source + 3]; const da = canvas[destination + 3]; const oa = sa + Math.round(da * (255 - sa) / 255);
				for (let channel = 0; channel < 3; channel++) canvas[destination + channel] = oa === 0 ? 0 : Math.round((pixels[source + channel] * sa * 255 + canvas[destination + channel] * da * (255 - sa)) / (oa * 255));
				canvas[destination + 3] = oa;
			}
		}
	}

	private clear(canvas: Buffer, canvasWidth: number, frame: ApngFrame): void { for (let y = 0; y < frame.height; y++) canvas.fill(0, ((frame.top + y) * canvasWidth + frame.left) * 4, ((frame.top + y) * canvasWidth + frame.left + frame.width) * 4); }

	private orient(input: Buffer, width: number, height: number, orientation: number): Buffer {
		if (orientation < 2 || orientation > 8) return Buffer.from(input);
		const swapped = orientation >= 5; const output = Buffer.alloc(input.length); const outputWidth = swapped ? height : width;
		for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
			const [dx, dy] = orientation === 2 ? [width - 1 - x, y] : orientation === 3 ? [width - 1 - x, height - 1 - y] : orientation === 4 ? [x, height - 1 - y] : orientation === 5 ? [y, x] : orientation === 6 ? [height - 1 - y, x] : orientation === 7 ? [height - 1 - y, width - 1 - x] : [y, width - 1 - x];
			input.copy(output, (dy * outputWidth + dx) * 4, (y * width + x) * 4, (y * width + x + 1) * 4);
		}
		return output;
	}

	private apngDelays(buffer: Buffer): Delay[] { const result: Delay[] = []; for (let offset = 8; offset + 12 <= buffer.length;) { const length = buffer.readUInt32BE(offset); if (offset + length + 12 > buffer.length) throw new EmojiImageFingerprintError('INVALID_IMAGE', 'Truncated PNG chunk'); if (buffer.toString('ascii', offset + 4, offset + 8) === 'fcTL') { const denominator = buffer.readUInt16BE(offset + 30) || 100; result.push(this.reduce(buffer.readUInt16BE(offset + 28), denominator)); } offset += length + 12; } return result; }
	private hasApngControlChunk(buffer: Buffer): boolean { for (let offset = 8; offset + 12 <= buffer.length;) { const length = buffer.readUInt32BE(offset); if (offset + length + 12 > buffer.length) return false; if (buffer.toString('ascii', offset + 4, offset + 8) === 'acTL') return true; offset += length + 12; } return false; }
	private millisecondDelay(milliseconds: number): Delay { return this.reduce(milliseconds, 1000); }
	private reduce(numerator: number, denominator: number): Delay { const gcd = (a: number, b: number): number => b === 0 ? a : gcd(b, a % b); const divisor = gcd(numerator, denominator); return { numerator: numerator / divisor, denominator: denominator / divisor }; }
	private zeroTransparentRgb(rgba: Buffer): Buffer { const result = Buffer.from(rgba); for (let offset = 0; offset < result.length; offset += 4) if (result[offset + 3] === 0) result.fill(0, offset, offset + 3); return result; }
	private writeU32(hash: ReturnType<typeof createHash>, value: number): void { const bytes = Buffer.allocUnsafe(4); bytes.writeUInt32BE(value); hash.update(bytes); }
	private assertLimits(width: number, height: number, frames: number): void { if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new EmojiImageFingerprintError('INVALID_IMAGE', 'Image dimensions are invalid'); if (width > MAX_DIMENSION || height > MAX_DIMENSION || frames > MAX_FRAMES || width * height * frames > MAX_EXPANDED_PIXELS) throw new EmojiImageFingerprintError('LIMIT_EXCEEDED', 'Image exceeds fingerprint decoding limits'); }
	/** Protected solely so deterministic unit tests can exercise the deadline path. */
	protected deadlineMs(): number { return DEADLINE_MS; }
	private async withDeadline<T>(work: Promise<T>): Promise<T> { let timer: NodeJS.Timeout | undefined; const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new EmojiImageFingerprintError('DEADLINE_EXCEEDED', 'Fingerprinting exceeded the 10 second deadline', ['Fingerprint computation timed out and was rejected'])), this.deadlineMs()); }); try { return await Promise.race([work, timeout]); } finally { if (timer !== undefined) clearTimeout(timer); } }
}
