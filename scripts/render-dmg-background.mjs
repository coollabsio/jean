#!/usr/bin/env node
// Renders src-tauri/dmg/source/background.html to src-tauri/dmg/background.tiff.
// Finder shows DMG backgrounds at 1 image pixel per point, so a 1x PNG looks
// blurry on Retina screens. A HiDPI TIFF holds a 72 dpi 1x image and a 144 dpi
// 2x image (the layout `tiffutil -cathidpicheck` writes); Finder picks the
// sharp one for the screen.
// The page.evaluate callback runs in the browser, not in Node.js.
/* global document: readonly, Image: readonly */
import { chromium } from 'playwright'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { writeFileSync } from 'node:fs'
import path from 'node:path'

const WIDTH = 660
const HEIGHT = 400

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = path.join(root, 'src-tauri/dmg/source/background.html')
const output = path.join(root, 'src-tauri/dmg/background.tiff')

async function renderRgb(browser, scale) {
  const page = await browser.newPage({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: scale,
  })
  await page.goto(pathToFileURL(source).href)
  await page.evaluate(() => document.fonts.ready)
  const png = await page.screenshot()
  const rgba = await page.evaluate(async base64 => {
    const image = new Image()
    image.src = `data:image/png;base64,${base64}`
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = image.width
    canvas.height = image.height
    const context = canvas.getContext('2d')
    context.drawImage(image, 0, 0)
    return Array.from(
      context.getImageData(0, 0, image.width, image.height).data
    )
  }, png.toString('base64'))
  await page.close()

  const width = WIDTH * scale
  const height = HEIGHT * scale
  const rgb = Buffer.alloc(width * height * 3)
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    rgb[j] = rgba[i]
    rgb[j + 1] = rgba[i + 1]
    rgb[j + 2] = rgba[i + 2]
  }
  return { width, height, dpi: 72 * scale, rgb }
}

// PackBits (TIFF compression 32773), one row at a time.
function packBits(rgb, rowBytes) {
  const out = []
  for (let row = 0; row < rgb.length; row += rowBytes) {
    const end = row + rowBytes
    let i = row
    while (i < end) {
      let run = 1
      while (i + run < end && run < 128 && rgb[i + run] === rgb[i]) run++
      if (run > 1) {
        out.push(257 - run, rgb[i])
        i += run
        continue
      }
      let literal = 1
      while (
        i + literal < end &&
        literal < 128 &&
        rgb[i + literal] !== rgb[i + literal + 1]
      ) {
        literal++
      }
      out.push(literal - 1, ...rgb.subarray(i, i + literal))
      i += literal
    }
  }
  return Buffer.from(out)
}

// Little-endian baseline RGB TIFF with one IFD per image.
function encodeTiff(images) {
  const ENTRY_COUNT = 12
  const ifdSize = 2 + ENTRY_COUNT * 12 + 4
  const extraSize = 6 + 8 + 8 // BitsPerSample, XResolution, YResolution
  const parts = images.map(image => ({
    image,
    strip: packBits(image.rgb, image.width * 3),
  }))

  let offset = 8
  for (const part of parts) {
    part.stripOffset = offset
    offset += part.strip.length + (part.strip.length % 2)
    part.ifdOffset = offset
    offset += ifdSize + extraSize
  }

  const file = Buffer.alloc(offset)
  file.write('II', 0, 'latin1')
  file.writeUInt16LE(42, 2)
  file.writeUInt32LE(parts[0].ifdOffset, 4)

  parts.forEach((part, index) => {
    const { image, strip, stripOffset, ifdOffset } = part
    strip.copy(file, stripOffset)

    const extra = ifdOffset + ifdSize
    file.writeUInt16LE(8, extra)
    file.writeUInt16LE(8, extra + 2)
    file.writeUInt16LE(8, extra + 4)
    for (const at of [extra + 6, extra + 14]) {
      file.writeUInt32LE(image.dpi, at)
      file.writeUInt32LE(1, at + 4)
    }

    const SHORT = 3
    const LONG = 4
    const RATIONAL = 5
    const entries = [
      [256, LONG, 1, image.width], // ImageWidth
      [257, LONG, 1, image.height], // ImageLength
      [258, SHORT, 3, extra], // BitsPerSample
      [259, SHORT, 1, 32773], // Compression: PackBits
      [262, SHORT, 1, 2], // PhotometricInterpretation: RGB
      [273, LONG, 1, stripOffset], // StripOffsets
      [277, SHORT, 1, 3], // SamplesPerPixel
      [278, LONG, 1, image.height], // RowsPerStrip
      [279, LONG, 1, strip.length], // StripByteCounts
      [282, RATIONAL, 1, extra + 6], // XResolution
      [283, RATIONAL, 1, extra + 14], // YResolution
      [296, SHORT, 1, 2], // ResolutionUnit: inch
    ]
    file.writeUInt16LE(entries.length, ifdOffset)
    entries.forEach(([tag, type, count, value], i) => {
      const at = ifdOffset + 2 + i * 12
      file.writeUInt16LE(tag, at)
      file.writeUInt16LE(type, at + 2)
      file.writeUInt32LE(count, at + 4)
      if (type === SHORT && count === 1) file.writeUInt16LE(value, at + 8)
      else file.writeUInt32LE(value, at + 8)
    })
    const next = parts[index + 1]?.ifdOffset ?? 0
    file.writeUInt32LE(next, ifdOffset + 2 + entries.length * 12)
  })

  return file
}

const browser = await chromium.launch()
try {
  const images = [await renderRgb(browser, 1), await renderRgb(browser, 2)]
  writeFileSync(output, encodeTiff(images))
  console.log(`Wrote ${path.relative(root, output)}`)
} finally {
  await browser.close()
}
