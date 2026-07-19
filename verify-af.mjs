// Parse every generated .af with the real target decoder (af.js) and confirm it
// agrees with the manifest: glyph count, every assigned codepoint resolves, and
// the string of all glyph chars measures to a positive advance.
//
//   node verify-af.mjs
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { afParse, afMeasure } from './af.js';

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, 'dist');

const src = readFileSync(resolve(dist, 'fonts.js'), 'utf8');
const fonts = JSON.parse(src.replace(/^window\.AF_FONTS\s*=\s*/, '').replace(/;\s*$/, ''));

let ok = true;
let glyphTotal = 0;

for (const font of fonts) {
  // Each category ships the filled default and the outline set; check both.
  const targets = [font.file];
  if (font.outline) targets.push(font.outline.file);

  for (const file of targets) {
    const bytes = readFileSync(resolve(dist, file));
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const problems = [];

    let parsed;
    try {
      parsed = afParse(buf);
    } catch (e) {
      console.log(`FAIL  ${file}  did not parse: ${e.message}`);
      ok = false;
      continue;
    }

    if (parsed.glyphCount !== font.count)
      problems.push(`glyphCount ${parsed.glyphCount} != ${font.count}`);
    for (const g of font.glyphs) {
      if (!parsed.cpMap.has(parseInt(g.code, 16)))
        problems.push(`codepoint U+${g.code} (${g.name}) missing`);
    }
    // Every glyph must carry at least one path with usable points.
    const empty = parsed.glyphs.filter(g => g.nPaths === 0 ||
      g.paths.every(p => p.pc < 2)).length;
    if (empty) problems.push(`${empty} glyphs have no drawable contour`);

    const text = font.glyphs.map(g => g.char).join('');
    if (afMeasure(parsed, text, 128) <= 0) problems.push('measured zero width');

    glyphTotal += parsed.glyphCount;
    if (problems.length) {
      ok = false;
      console.log(`FAIL  ${file}  ${problems.join('; ')}`);
    } else {
      console.log(`PASS  ${file.padEnd(24)} ${parsed.glyphCount} glyphs`);
    }
  }
}

const files = fonts.length + fonts.filter(f => f.outline).length;
console.log(ok
  ? `\nALL PASS - ${files} font files (${fonts.length} categories x2 sets), ${glyphTotal} glyphs decode via af.js`
  : '\nFAILURES DETECTED');
process.exit(ok ? 0 : 1);
