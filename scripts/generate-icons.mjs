// Generate PNG icons from the master SVG at all required sizes
// Usage: node scripts/generate-icons.mjs
import { execSync } from 'child_process';
import { readFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const svgPath = join(root, 'public', 'icon.svg');
const outDir = join(root, 'public', 'icons');

if (!existsSync(outDir)) {
  mkdirSync(outDir, { recursive: true });
}

const sizes = [16, 32, 48, 128];

for (const size of sizes) {
  const outPath = join(outDir, `icon-${size}.png`);
  execSync(
    `npx --yes sharp-cli -i "${svgPath}" -o "${outPath}" resize ${size} ${size} -- png`,
    { stdio: 'inherit' }
  );
  console.log(`Generated ${outPath}`);
}

console.log('Done! Icons generated in public/icons/');
