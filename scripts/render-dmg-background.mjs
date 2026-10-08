#!/usr/bin/env node
// Renders src-tauri/dmg/source/background.html to src-tauri/dmg/background.png.
// Finder shows DMG backgrounds at 1 image pixel per point, so render at 1x.
import { chromium } from 'playwright'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = path.join(root, 'src-tauri/dmg/source/background.html')
const output = path.join(root, 'src-tauri/dmg/background.png')

const browser = await chromium.launch()
try {
  const page = await browser.newPage({
    viewport: { width: 660, height: 400 },
    deviceScaleFactor: 1,
  })
  await page.goto(pathToFileURL(source).href)
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({ path: output })
  console.log(`Wrote ${path.relative(root, output)}`)
} finally {
  await browser.close()
}
