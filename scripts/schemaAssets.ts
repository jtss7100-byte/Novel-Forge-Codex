import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MASTER_WRITING_RULES_V1_0_CONTENT } from '../src/schemas/masterWritingRulesV1';
import { assertCanonicalJsonSchema } from '../src/schemas/assertCanonicalJsonSchema';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const publicDirectory = 'public/assets/aistudio';
const legacySchemas = [
  ['novelforge_app_result.schema.json', 'novelforge_app_result.schema_4c1c1864.json'],
  ['novelforge_writer_response.schema.json', 'novelforge_writer_response.schema_e579aaf5.json'],
] as const;

function readSchemaForDownload(root: string, name: string): string {
  const source = `src/schemas/${name}`;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(resolve(root, source)));
    assertCanonicalJsonSchema(JSON.parse(text), source);
    // Preserve the legacy download's formatting and key order.
    return text.replace(/\r\n/g, '\n').replace(/\n$/, '');
  } catch (cause) {
    throw new Error(`Cannot read canonical schema ${source}`, { cause });
  }
}

export function syncSchemaAssets(root: string, mode: 'generate' | 'check'): void {
  if (typeof MASTER_WRITING_RULES_V1_0_CONTENT !== 'string' ||
      !MASTER_WRITING_RULES_V1_0_CONTENT.trim()) {
    throw new Error('Missing canonical Master Writing Rules content in src/schemas/masterWritingRulesV1.ts');
  }

  // Resolve and validate every source before touching any downloads.
  const assets = new Map<string, string>([
    [`${publicDirectory}/NOVEL_FORGE_Master_Writing_Rules_v1.0_8eb8ffc7.md`,
      `${MASTER_WRITING_RULES_V1_0_CONTENT}\n`],
  ]);
  for (const [source, download] of legacySchemas) {
    assets.set(`${publicDirectory}/${download}`, readSchemaForDownload(root, source));
  }

  const drift: string[] = [];
  for (const [path, text] of assets) {
    const file = resolve(root, path);
    const expected = Buffer.from(text, 'utf8');
    if (existsSync(file) && readFileSync(file).equals(expected)) continue;
    if (mode === 'check') {
      drift.push(path);
    } else {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, expected);
    }
  }

  if (drift.length) {
    throw new Error(`Missing or outdated schema assets:\n${drift.join('\n')}\nRun bun run schemas:generate.`);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const mode = process.argv[2];
  if (mode !== 'generate' && mode !== 'check') {
    console.error('Usage: node --import tsx scripts/schemaAssets.ts <generate|check>');
    process.exitCode = 1;
  } else {
    try {
      syncSchemaAssets(repositoryRoot, mode);
      console.log(mode === 'check' ? 'Schema assets match canonical sources.' : 'Schema assets synchronized.');
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
