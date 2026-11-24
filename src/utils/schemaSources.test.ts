import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test, type TestContext } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GenerateContentResponse } from '@google/genai';
import { build, preview } from 'vite';
import { syncSchemaAssets } from '../../scripts/schemaAssets';
import { MASTER_WRITING_RULES_V1_0_CONTENT } from '../schemas/masterWritingRulesV1';
import { assertCanonicalJsonSchema } from '../schemas/assertCanonicalJsonSchema';
import { buildDynamicWriterSystemInstruction, generateNovelSceneOnServer } from '../server/geminiWritingEngine';
import { LOCAL_BUNDLES_KEY, loadLocalBundles } from '../services/novelRepository';
import {
  createNewPromptProfile,
  ensureMasterWritingRulesRegistered,
  LEGACY_ADVANCED_WRITING_CONTROL_TITLE,
  NOVELFORGE_APP_RESULT_JSON_SCHEMA,
  NOVELFORGE_AUDIT_MODULE_GEMINI_RESPONSE_SCHEMA,
  NOVELFORGE_WRITER_GEMINI_RESPONSE_SCHEMA,
  NOVELFORGE_WRITER_RESPONSE_JSON_SCHEMA,
  NovelForgeAppResultSchema,
  NovelForgeWriterResponseSchema,
  restorePromptProfileToVersion,
  updatePromptProfileContent,
  validateAndNormalizeWriterResponse,
} from './aiEngineLogic';
import { buildEvaluationFixture, toActivePrompt } from './novelWritingEvaluationBenchmark';
import { createInitialSeedBundle } from './seedData';

const root = fileURLToPath(new URL('../../', import.meta.url));
const sources = ['novelforge_app_result.schema.json', 'novelforge_writer_response.schema.json'] as const;
const masterSource = 'src/schemas/masterWritingRulesV1.ts';
const script = 'scripts/schemaAssets.ts';
const downloads = '/assets/aistudio/';
// Captured from the Git blobs and evaluated Node.js runtime at 039ca0e.
const baseline = {
  masterRuntime: '0032d6a42a636e3516e657552605759477279be7f5243b97fea59e752d504725',
  appJson: 'c7e30324fcd08943e62fcac7709c88a4ef17b9ee347dc54434c83f5550aef1d9',
  writerJson: 'ae85b1c529f1b146a7e303d6b027ab79cf82927e427bbcb74b9c1e20be264adb',
  writerGemini: 'fb03d9f47714d1fdeeee42628429e82fec2dc351f8b57bb6294e49202bbdf5cc',
  auditGemini: 'a0ab4f6a719cecbbfca074382b2df25f4c73b6e80c8ce4bf18b50160a52c024a',
  writerSystem: '84cdd874b400a5a89a937fa4de88053ee00044623dc5a65801cf8ab38205fbd9',
  writerContents: 'f87e10eeb0db32dba41f19b97619d42aa1ad03721be9945e9edbc4ab62bf5567',
};
const masterAsset = 'NOVEL_FORGE_Master_Writing_Rules_v1.0_8eb8ffc7.md';
const appAsset = 'novelforge_app_result.schema_4c1c1864.json';
const writerAsset = 'novelforge_writer_response.schema_e579aaf5.json';
const legacyDigests = {
  [masterAsset]: '8eb8ffc752ff24c8d3799dcb5a8f06c7d17af7eb07a24735d5bd8596259c55e9',
  [appAsset]: '4c1c18649999f37da6c34d3d3cb8d9aee3b1001a929e0c26493b3ff0b11e3da0',
  [writerAsset]: 'e579aaf515a147dd469a364ea7a781ca8fa96cfbba9eb6b8ac7af6c23e4f8d92',
};
const modelId = 'ssot-fixture-model';
const writerReply = {
  manuscript_state: 'DRAFT_READY',
  manuscript: '세라는 등불을 내려놓았다. 카엘은 닫힌 문으로 시선을 돌렸다.',
  issues: [],
  proposals: [],
} as const;

function sha(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function publicAsset(file: string, base = root): string {
  return join(base, 'public', downloads, file);
}

function scratch(t: TestContext): string {
  const temp = mkdtempSync(join(tmpdir(), 'novelforge-ssot-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  return temp;
}

function schemaSandbox(t: TestContext): string {
  const temp = scratch(t);
  const sourcePaths = sources.map((name) => `src/schemas/${name}`);
  for (const relative of [...sourcePaths, masterSource, 'src/schemas/assertCanonicalJsonSchema.ts', script]) {
    const target = join(temp, relative);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(root, relative), target);
  }
  writeFileSync(join(temp, 'package.json'), '{"type":"module"}');
  return temp;
}

function runNode(cwd: string, ...args: string[]) {
  return spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), ...args], {
    cwd, encoding: 'utf8', timeout: 20_000,
  });
}

let buildFolder: string | undefined;
let siteBuild: Promise<unknown> | undefined;
function buildTestSite(): Promise<unknown> {
  if (!siteBuild) {
    buildFolder = mkdtempSync(join(tmpdir(), 'novelforge-ssot-build-'));
    siteBuild = build({
      root, envFile: false, logLevel: 'silent',
      build: { outDir: buildFolder, emptyOutDir: true },
    });
  }
  return siteBuild;
}
after(() => {
  if (buildFolder) rmSync(buildFolder, { recursive: true, force: true });
});

test('SSOT1: Master Writing Rules keep the exact baseline runtime bytes', () => {
  assert.equal(sha(MASTER_WRITING_RULES_V1_0_CONTENT), baseline.masterRuntime);
  assert.equal(Buffer.byteLength(MASTER_WRITING_RULES_V1_0_CONTENT), 20291);
  assert.deepEqual(readFileSync(publicAsset(masterAsset)), Buffer.from(MASTER_WRITING_RULES_V1_0_CONTENT + '\n'));
});

test('SSOT2: App Result preserves its structure and serialized contract', () => {
  assert.deepEqual(JSON.parse(readFileSync(publicAsset(appAsset), 'utf8')), NOVELFORGE_APP_RESULT_JSON_SCHEMA);
  assert.equal(sha(JSON.stringify(NOVELFORGE_APP_RESULT_JSON_SCHEMA)), baseline.appJson);
});

test('SSOT3: Writer Response and both Gemini schemas preserve their serialized contracts', () => {
  assert.deepEqual(JSON.parse(readFileSync(publicAsset(writerAsset), 'utf8')), NOVELFORGE_WRITER_RESPONSE_JSON_SCHEMA);
  assert.equal(sha(JSON.stringify(NOVELFORGE_WRITER_RESPONSE_JSON_SCHEMA)), baseline.writerJson);
  assert.equal(sha(JSON.stringify(NOVELFORGE_WRITER_GEMINI_RESPONSE_SCHEMA)), baseline.writerGemini);
  assert.equal(sha(JSON.stringify(NOVELFORGE_AUDIT_MODULE_GEMINI_RESPONSE_SCHEMA)), baseline.auditGemini);
});

test('SSOT4: Node.js with tsx loads runtime sources and checks assets from a different directory', (t) => {
  const elsewhere = scratch(t);
  const logicUrl = pathToFileURL(join(root, 'src/utils/aiEngineLogic.ts')).href;
  const imports = runNode(elsewhere, '--input-type=module', '-e',
    `const mod = await import(${JSON.stringify(logicUrl)}); console.log(JSON.stringify([` +
    'Buffer.byteLength(mod.NOVEL_FORGE_MASTER_WRITING_RULES_V1_CONTENT), ' +
    'mod.NOVELFORGE_APP_RESULT_JSON_SCHEMA.type, mod.NOVELFORGE_WRITER_RESPONSE_JSON_SCHEMA.type]));');
  assert.equal(imports.status, 0, imports.stderr);
  assert.deepEqual(JSON.parse(imports.stdout), [20291, 'object', 'object']);
  const check = runNode(elsewhere, join(root, script), 'check');
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /match canonical sources/);
});

test('SSOT5: Vite includes the rules in the browser bundle without a Node filesystem shim', async () => {
  await buildTestSite();
  assert.ok(buildFolder);
  const assets = join(buildFolder, 'assets');
  const scripts = readdirSync(assets).filter((file) => file.endsWith('.js'));
  const bundle = scripts.map((file) => readFileSync(join(assets, file), 'utf8')).join('\n');
  assert.match(bundle, /Master Writing & Engine Control Rules/);
  assert.doesNotMatch(bundle, /Module ["'](?:node:)?fs["'] has been externalized/);
  assert.doesNotMatch(bundle, /Cannot read canonical schema/);
});

test('SSOT6: unchanged legacy paths serve the baseline bytes from the Vite build', async () => {
  await buildTestSite();
  assert.ok(buildFolder);
  const server = await preview({
    root, envFile: false, logLevel: 'silent', build: { outDir: buildFolder },
    preview: { host: '127.0.0.1', port: 0, strictPort: true },
  });
  try {
    const address = server.httpServer.address();
    assert.ok(address && typeof address !== 'string');
    for (const [file, expected] of Object.entries(legacyDigests)) {
      const response: Response = await fetch(`http://127.0.0.1:${address.port}${downloads}${file}`, {
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(response.status, 200, file);
      assert.equal(sha(new Uint8Array(await response.arrayBuffer())), expected, file);
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.httpServer.close((error) => error ? reject(error) : resolve()));
  }
});

test('SSOT7: authored v1 rules survive load, selection, and version restoration', () => {
  const bundle = createInitialSeedBundle('ssot_author');
  const owner = bundle.project.ownerId;
  const project = bundle.project.id;
  const content = '이 작품에서만 사용하는 작가 규칙.\n[기본 테스트 지침 — 작가가 전용 프롬프트를 등록하면 즉시 교체됩니다]';
  const custom = createNewPromptProfile({
    ownerId: owner, projectId: project, promptType: 'CORE_WRITING_RULES',
    title: LEGACY_ADVANCED_WRITING_CONTROL_TITLE, description: '작가 정의', content,
  });
  const seeded = bundle.writingPromptProfiles?.find((profile) => profile.promptType === 'CORE_WRITING_RULES');
  assert.ok(seeded);
  const imported = { ...seeded, content: '기존 프로젝트에 저장한 별도 규칙' };
  const profileAt = (profile: typeof custom) => ensureMasterWritingRulesRegistered([profile], owner, project)[0];
  assert.deepEqual(profileAt(custom), custom);
  assert.deepEqual(profileAt(imported), imported);

  const stored = JSON.stringify([{ ...bundle, writingPromptProfiles: [custom, imported] }]);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true, value: { getItem: (key: string) => key === LOCAL_BUNDLES_KEY ? stored : null },
  });
  try {
    assert.deepEqual(loadLocalBundles(owner)[0].writingPromptProfiles, JSON.parse(stored)[0].writingPromptProfiles);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }

  const approved = updatePromptProfileContent(custom, { content: '두 번째 승인 규칙' });
  const restored = restorePromptProfileToVersion(approved, custom.currentVersionId);
  assert.deepEqual(profileAt(restored), restored);
  assert.equal(restored.currentVersionNumber, 3);
  assert.equal(restored.content, content);
  assert.deepEqual(restored.versions.slice(1), approved.versions);

  const { context } = buildEvaluationFixture('NW8', modelId);
  const instruction = buildDynamicWriterSystemInstruction({ ...context, activePrompts: [toActivePrompt(profileAt(custom))] });
  assert.ok(instruction.endsWith(content));
});

test('SSOT8: check exits nonzero for a drifted file and leaves bytes untouched', (t) => {
  const temp = schemaSandbox(t);
  syncSchemaAssets(temp, 'generate');
  const path = publicAsset(appAsset, temp);
  writeFileSync(path, '{}');
  const check = runNode(root, join(temp, script), 'check');
  assert.equal(check.status, 1, check.stderr);
  assert.ok(check.stderr.includes(appAsset));
  assert.equal(readFileSync(path, 'utf8'), '{}');
});

test('SSOT9: repeated generation produces baseline bytes with LF or CRLF inputs', (t) => {
  const temp = schemaSandbox(t);
  syncSchemaAssets(temp, 'generate');
  for (const source of sources) {
    const path = join(temp, 'src/schemas', source);
    const lf = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
    writeFileSync(path, lf.replace(/\n/g, '\r\n'));
  }
  syncSchemaAssets(temp, 'generate');
  syncSchemaAssets(temp, 'check');
  for (const [file, expected] of Object.entries(legacyDigests)) {
    assert.equal(sha(readFileSync(publicAsset(file, temp))), expected);
  }
});

test('SSOT10: missing, blank or malformed canonical sources fail before generating assets', (t) => {
  const temp = schemaSandbox(t);
  const master = join(temp, masterSource);
  rmSync(master);
  const missingMaster = runNode(root, join(temp, script), 'generate');
  assert.equal(missingMaster.status, 1);
  assert.match(missingMaster.stderr, /masterWritingRulesV1/);
  writeFileSync(master, "export const MASTER_WRITING_RULES_V1_0_CONTENT = '';");
  const blankMaster = runNode(root, join(temp, script), 'generate');
  assert.equal(blankMaster.status, 1);
  assert.match(blankMaster.stderr, /Missing canonical Master Writing Rules/);

  copyFileSync(join(root, masterSource), master);
  const writer = join(temp, 'src/schemas', sources[1]);
  rmSync(writer);
  assert.throws(() => syncSchemaAssets(temp, 'generate'), /Cannot read canonical schema.*novelforge_writer_response/);
  writeFileSync(writer, '{');
  assert.throws(() => syncSchemaAssets(temp, 'generate'), /Cannot read canonical schema.*novelforge_writer_response/);
  writeFileSync(writer, '{}');
  assert.throws(() => syncSchemaAssets(temp, 'generate'), /Cannot read canonical schema.*novelforge_writer_response/);
  assert.throws(() => assertCanonicalJsonSchema({}, sources[1]), /Invalid canonical schema/);
  for (const file of Object.keys(legacyDigests)) {
    assert.throws(() => readFileSync(publicAsset(file, temp)), { code: 'ENOENT' });
  }
});

test('SSOT11: strict and legacy response validators retain their baseline decisions', () => {
  const app = { ...writerReply, canon_status: 'CANON_CANDIDATE',
    audit_execution_state: { continuity_checker: 'NOT_RUN', style_editor: 'NOT_RUN' } };
  assert.deepEqual(NovelForgeWriterResponseSchema.parse(writerReply), writerReply);
  assert.deepEqual(NovelForgeAppResultSchema.parse(app), app);
  assert.equal(NovelForgeWriterResponseSchema.safeParse({ ...writerReply, manuscript_state: 'APPROVED' }).success, false);
  assert.equal(NovelForgeWriterResponseSchema.safeParse({ ...writerReply, issues: undefined }).success, false);
  assert.equal(NovelForgeAppResultSchema.safeParse({ ...app, proposals: undefined }).success, false);
  assert.equal(NovelForgeAppResultSchema.safeParse({ ...app, unexpected: true }).success, false);
  assert.deepEqual(validateAndNormalizeWriterResponse({
    executionState: 'DRAFT_READY', manuscript: writerReply.manuscript,
  }), writerReply);
  assert.throws(() => validateAndNormalizeWriterResponse({ manuscript: 12 }));
});

test('SSOT12: production Writer request assembly and applied version match the baseline fixture', async () => {
  const { context, plan } = buildEvaluationFixture('NW8', modelId);
  let calls = 0;
  const result = await generateNovelSceneOnServer({
    runId: 'ssot_contract_run', ownerId: context.ownerId, context, plan, targetSceneNumber: 1,
    evaluation: { modelId, generate: async ({ model, config, contents }) => {
      calls++;
      assert.equal(model, modelId);
      assert.equal(config?.responseMimeType, 'application/json');
      assert.equal(sha(JSON.stringify(config?.systemInstruction)), baseline.writerSystem);
      assert.equal(sha(JSON.stringify(contents)), baseline.writerContents);
      assert.equal(sha(JSON.stringify(config?.responseSchema)), baseline.writerGemini);
      const reply = new GenerateContentResponse();
      reply.candidates = [{ content: { role: 'model', parts: [{ text: JSON.stringify(writerReply) }] } }];
      return reply;
    } },
  });
  assert.equal(calls, 1);
  assert.equal(result.executionState, 'DRAFT_READY');
  assert.equal(result.manuscript, writerReply.manuscript);
  assert.equal(result.appliedMasterRulesVersion?.profileId, 'prompt_novel_eval_nw8_core_advanced_control');
  assert.equal(result.appliedMasterRulesVersion?.versionId, 'pver_init_1');
  assert.equal(result.appliedMasterRulesVersion?.versionLabel, '1.0');
});
