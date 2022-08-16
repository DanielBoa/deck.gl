/* global document */
import TinySDF from '@mapbox/tiny-sdf';

import {log} from '@deck.gl/core';

import {buildMapping, CharacterMapping, nextPowOfTwo, resizeCanvas} from './utils';
import LRUCache from './lru-cache';

import type {Texture} from '@deck.gl/core';

function getDefaultCharacterSet() {
  const charSet: string[] = [];
  for (let i = 32; i < 128; i++) {
    charSet.push(String.fromCharCode(i));
  }
  return charSet;
}

export type FontSettings = {
  /** CSS font family
   * @default 'Monaco, monospace'
   */
  fontFamily?: string;
  /** CSS font weight
   * @default 'normal'
   */
  fontWeight?: string | number;
  /** Specifies a list of characters to include in the font.
   * @default (ASCII characters 32-128)
   */
  characterSet?: Set<string> | string[] | string;
  /** Font size in pixels. This option is only applied for generating `fontAtlas`, it does not impact the size of displayed text labels. Larger `fontSize` will give you a sharper look when rendering text labels with very large font sizes. But larger `fontSize` requires more time and space to generate the `fontAtlas`.
   * @default 64
   */
  fontSize?: number;
  /** Whitespace buffer around each side of the character. In general, bigger `fontSize` requires bigger `buffer`. Increase `buffer` will add more space between each character when layout `characterSet` in `fontAtlas`. This option could be tuned to provide sufficient space for drawing each character and avoiding overlapping of neighboring characters.
   * @default 4
   */
  buffer?: number;
  /** Flag to enable / disable `sdf`. [`sdf` (Signed Distance Fields)](http://cs.brown.edu/people/pfelzens/papers/dt-final.pdf) will provide a sharper look when rendering with very large or small font sizes. `TextLayer` integrates with [`TinySDF`](https://github.com/mapbox/tiny-sdf) which implements the `sdf` algorithm.
   * @default false
   */
  sdf?: boolean;
  /** How much of the radius (relative) is used for the inside part the glyph. Bigger `cutoff` makes character thinner. Smaller `cutoff` makes character look thicker. Only applies when `sdf: true`.
   * @default 0.25
   */
  cutoff?: number;
  /** How many pixels around the glyph shape to use for encoding distance. Bigger radius yields higher quality outcome. Only applies when `sdf: true`.
   * @default 12
   */
  radius?: number;
  /** How much smoothing to apply to the text edges. Only applies when `sdf: true`.
   * @default 0.1
   */
  smoothing?: number;
};

export const DEFAULT_FONT_SETTINGS: Required<FontSettings> = {
  fontFamily: 'Monaco, monospace',
  fontWeight: 'normal',
  characterSet: getDefaultCharacterSet(),
  fontSize: 64,
  buffer: 4,
  sdf: false,
  cutoff: 0.25,
  radius: 12,
  smoothing: 0.1
};

const MAX_CANVAS_WIDTH = 1024;

const BASELINE_SCALE = 0.9;
const HEIGHT_SCALE = 1.2;

// only preserve latest three fontAtlas
const CACHE_LIMIT = 3;

type FontAtlas = {
  /** x position of last character in mapping */
  xOffset: number;
  /** y position of last character in mapping */
  yOffset: number;
  /** bounding box of each character in the texture */
  mapping: CharacterMapping;
  /** packed texture */
  data: HTMLCanvasElement;
  /** texture width */
  width: number;
  /** texture height */
  height: number;
  /** base row height for font in pixels (multiplied by line-height property) */
  rowHeight: number;
  /** as the scaling of each icon is impacted by it's bounding box (returned by IconLayer.getInstanceIconFrame) we must correct the texture scaling as the buffer increases the size of each characters texture */
  textureScale: number;
};

let cache = new LRUCache<FontAtlas>(CACHE_LIMIT);

/**
 * get all the chars not in cache
 * @returns chars not in cache
 */
function getNewChars(cacheKey: string, characterSet: Set<string> | string[] | string): Set<string> {
  let newCharSet: Set<string>;
  if (typeof characterSet === 'string') {
    newCharSet = new Set(Array.from(characterSet));
  } else {
    newCharSet = new Set(characterSet);
  }

  const cachedFontAtlas = cache.get(cacheKey);
  if (!cachedFontAtlas) {
    return newCharSet;
  }

  for (const char in cachedFontAtlas.mapping) {
    if (newCharSet.has(char)) {
      newCharSet.delete(char);
    }
  }
  return newCharSet;
}

function populateAlphaChannel(alphaChannel: Uint8ClampedArray, imageData: ImageData): void {
  // populate distance value from tinySDF to image alpha channel
  for (let i = 0; i < alphaChannel.length; i++) {
    imageData.data[4 * i + 3] = alphaChannel[i];
  }
}

function setTextStyle(
  ctx: CanvasRenderingContext2D,
  fontFamily: string,
  fontSize: number,
  fontWeight: string | number
): void {
  ctx.font = `${fontWeight} ${fontSize}px ${fontFamily}`;
  ctx.fillStyle = '#000';
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
}

/**
 * Sets the Font Atlas LRU Cache Limit
 * @param {number} limit LRU Cache limit
 */
export function setFontAtlasCacheLimit(limit: number): void {
  log.assert(Number.isFinite(limit) && limit >= CACHE_LIMIT, 'Invalid cache limit');

  cache = new LRUCache(limit);
}

export default class FontAtlasManager {
  /** Font settings */
  props: Required<FontSettings> = {...DEFAULT_FONT_SETTINGS};

  /** Cache key of the current font atlas */
  private _key?: string;
  /** The current font atlas */
  private _atlas?: FontAtlas;

  get texture(): Texture | undefined {
    return this._atlas;
  }

  get mapping(): CharacterMapping | undefined {
    return this._atlas && this._atlas.mapping;
  }

  get scale(): number {
    const textureScale = this._atlas?.textureScale ?? 1;
    return HEIGHT_SCALE * textureScale;
  }

  get rowHeight(): number | undefined {
    return this._atlas && this._atlas.rowHeight;
  }

  setProps(props: FontSettings = {}) {
    Object.assign(this.props, props);

    // update cache key
    const oldKey = this._key;
    this._key = this._getKey();

    const charSet = getNewChars(this._key, this.props.characterSet);
    const cachedFontAtlas = cache.get(this._key);

    // if a fontAtlas associated with the new settings is cached and
    // there are no new chars
    if (cachedFontAtlas && charSet.size === 0) {
      // update texture with cached fontAtlas
      if (this._key !== oldKey) {
        this._atlas = cachedFontAtlas;
      }
      return;
    }

    // update fontAtlas with new settings
    const fontAtlas = this._generateFontAtlas(charSet, cachedFontAtlas);
    this._atlas = fontAtlas;

    // update cache
    cache.set(this._key, fontAtlas);
  }

  private _generateFontAtlas(characterSet: Set<string>, cachedFontAtlas?: FontAtlas): FontAtlas {
    let canvas = cachedFontAtlas && cachedFontAtlas.data;
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.width = MAX_CANVAS_WIDTH;
    }

    const ctx = canvas.getContext('2d')!;

    return this.props.sdf
      ? this._generateSDFFontAtlas(canvas, ctx, characterSet)
      : this._generateRegularFontAtlas(canvas, ctx, characterSet, cachedFontAtlas);
  }

  private _generateSDFFontAtlas(
    canvas: HTMLCanvasElement,
    ctx: CanvasRenderingContext2D,
    characterSet: Set<string>
  ): FontAtlas {
    const {fontFamily, fontWeight, fontSize, buffer, radius, cutoff} = this.props;
    const mapping: CharacterMapping = {};
    const tinySDF = new TinySDF({
      fontSize,
      buffer,
      radius,
      cutoff,
      fontFamily,
      fontWeight: `${fontWeight}`
    });
    const cellSize = fontSize + buffer * 2;
    const layoutRowHeight = fontSize * HEIGHT_SCALE;
    const columns = Math.floor(canvas.width / cellSize);
    const rows = Math.ceil(characterSet.size / columns);
    const requiredCanvasHeight = nextPowOfTwo(rows * cellSize);

    if (canvas.height !== requiredCanvasHeight) {
      resizeCanvas(ctx, canvas.width, requiredCanvasHeight);
    }

    let x = 0;
    let y = 0;
    for (const char of characterSet) {
      const {data, width, height, glyphTop, glyphAdvance} = tinySDF.draw(char);

      const imageData = ctx.createImageData(width, height);
      populateAlphaChannel(data, imageData);
      ctx.putImageData(imageData, x, y);

      mapping[char] = {
        x,
        y,
        // use glyphAdvance over glyphWidth due to whitespace characters
        width: glyphAdvance,
        height: cellSize,
        textureWidth: width,
        textureOffsetY: fontSize - glyphTop
      };

      x += width;
      if (x + cellSize >= canvas.width) {
        y += cellSize;
        x = 0;
      }
    }

    return {
      xOffset: 0,
      yOffset: 0,
      mapping,
      data: canvas,
      width: canvas.width,
      height: canvas.height,
      rowHeight: layoutRowHeight,
      textureScale: cellSize / layoutRowHeight,
    };
  }

  private _generateRegularFontAtlas(
    canvas: HTMLCanvasElement,
    ctx: CanvasRenderingContext2D,
    characterSet: Set<string>,
    cachedFontAtlas?: FontAtlas
  ): FontAtlas {
    const {fontFamily, fontWeight, fontSize, buffer} = this.props;

    setTextStyle(ctx, fontFamily, fontSize, fontWeight);

    // 1. build mapping
    const {mapping, canvasHeight, xOffset, yOffset} = buildMapping({
      getFontWidth: char => ctx.measureText(char).width,
      fontHeight: fontSize * HEIGHT_SCALE,
      buffer,
      characterSet,
      maxCanvasWidth: MAX_CANVAS_WIDTH,
      ...(cachedFontAtlas && {
        mapping: cachedFontAtlas.mapping,
        xOffset: cachedFontAtlas.xOffset,
        yOffset: cachedFontAtlas.yOffset
      })
    });

    // 2. update canvas
    // copy old canvas data to new canvas only when height changed
    if (canvas.height !== canvasHeight) {
      resizeCanvas(ctx, canvas.width, canvasHeight);
    }

    // 3. layout characters
    setTextStyle(ctx, fontFamily, fontSize, fontWeight);
    for (const char of characterSet) {
      ctx.fillText(char, mapping[char].x, mapping[char].y + fontSize * BASELINE_SCALE);
    }

    return {
      xOffset,
      yOffset,
      mapping,
      data: canvas,
      width: canvas.width,
      height: canvas.height,
      rowHeight: fontSize * HEIGHT_SCALE,
      textureScale: 1,
    };
  }

  private _getKey(): string {
    const {fontFamily, fontWeight, fontSize, buffer, sdf, radius, cutoff} = this.props;
    if (sdf) {
      return `${fontFamily} ${fontWeight} ${fontSize} ${buffer} ${radius} ${cutoff}`;
    }
    return `${fontFamily} ${fontWeight} ${fontSize} ${buffer}`;
  }
}
