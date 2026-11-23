import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateCharCounts,
  computeProjectDashboardStats,
  computeRevisionDiffSummary,
  isValidEntityId,
  parseAndValidateProjectBundle,
  serializeProjectBundle,
  validateCharacterInput,
  validateEpisodeInput,
  validateProjectInput,
  validateWorldbuildingInput,
} from './novelLogic';
import { createInitialSeedBundle } from './seedData';

test('calculateCharCounts accurately computes characters with and without spaces', () => {
  const sample = '검은 눈보라가 몰아친다.\n제1감시단 출격!';
  const metrics = calculateCharCounts(sample);
  assert.equal(metrics.withSpaces, sample.length);
  assert.equal(metrics.withoutSpaces, sample.replace(/\s+/g, '').length);
  assert.equal(metrics.lineCount, 2);
  assert.equal(metrics.paragraphCount, 2);
  assert.equal(metrics.manuscriptPages200, 1);
});

test('computeProjectDashboardStats aggregates episode counts and character totals', () => {
  const seed = createInitialSeedBundle('user_test_123');
  const stats = computeProjectDashboardStats(
    seed.episodes,
    seed.characters,
    seed.worldbuilding,
    seed.revisions
  );

  assert.equal(stats.totalEpisodes, 3);
  assert.equal(stats.confirmedEpisodes, 1);
  assert.equal(stats.reviewEpisodes, 1);
  assert.equal(stats.draftEpisodes, 1);
  assert.ok(stats.totalCharsWithSpaces > 800);
  assert.ok(stats.totalCharsWithoutSpaces > 600);
  assert.equal(stats.totalCharacters, 3);
  assert.equal(stats.confirmedCharacters, 2);
  assert.equal(stats.draftCharacters, 1);
  assert.equal(stats.totalWorldbuilding, 3);
  assert.equal(stats.confirmedWorldbuilding, 2);
  assert.equal(stats.draftWorldbuilding, 1);
});

test('input validators enforce required fields and blueprint length limits', () => {
  assert.equal(
    validateProjectInput({ title: '', genre: '판타지', synopsis: '', status: 'draft' }).valid,
    false
  );
  assert.equal(
    validateProjectInput({ title: '심연의 연대기', genre: '다크 판타지', synopsis: '설명', status: 'confirmed' }).valid,
    true
  );

  assert.equal(
    validateCharacterInput({
      name: '',
      role: '주인공',
      affiliation: '',
      appearance: '',
      personality: '',
      background: '',
      abilities: '',
      status: 'draft',
    }).valid,
    false
  );

  assert.equal(
    validateWorldbuildingInput({
      title: '마법 체계',
      category: '',
      summary: '',
      content: '',
      rules: '',
      status: 'draft',
    }).valid,
    false
  );

  assert.equal(
    validateEpisodeInput({
      episodeNumber: 0,
      title: '1화',
      content: '내용',
      synopsis: '',
      authorNote: '',
      status: 'draft',
    }).valid,
    false
  );
});

test('serializeProjectBundle and parseAndValidateProjectBundle round-trip cleanly', () => {
  const seed = createInitialSeedBundle('author_alpha');
  const json = serializeProjectBundle(
    seed.project,
    seed.characters,
    seed.worldbuilding,
    seed.episodes,
    seed.revisions
  );

  const parsed = parseAndValidateProjectBundle(json, 'author_beta');
  assert.equal(parsed.valid, true);
  if (parsed.valid) {
    assert.equal(parsed.bundle.project.ownerId, 'author_beta');
    assert.equal(parsed.bundle.project.title, seed.project.title);
    assert.equal(parsed.bundle.characters.length, 3);
    assert.equal(parsed.bundle.worldbuilding.length, 3);
    assert.equal(parsed.bundle.episodes.length, 3);
    assert.equal(parsed.bundle.revisions.length, 2);
  }
});

test('computeRevisionDiffSummary formats character delta accurately', () => {
  const diff = computeRevisionDiffSummary('가나다라', '가나다라마바사');
  assert.equal(diff.charDelta, 3);
  assert.equal(diff.formattedDelta, '+3자');
});

test('isValidEntityId blocks injection strings and accepts clean IDs', () => {
  assert.equal(isValidEntityId('proj_123-abc'), true);
  assert.equal(isValidEntityId('invalid$id!'), false);
  assert.equal(isValidEntityId(''), false);
});
