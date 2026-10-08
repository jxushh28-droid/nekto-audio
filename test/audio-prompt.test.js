import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readAudioPrompt, respondToAudioPrompt, promptMessage } from '../src/audio-prompt.js';

function read({ text = 'Укажите ваш возраст.', field = 'number', system = {}, captcha = false, ban = false } = {}) {
  const shown = extra => ({ isConnected: true, checkVisibility: () => true, ...extra });
  const input = field ? shown({ type: field, tagName: field === 'select' ? 'SELECT' : 'INPUT', options: [{ textContent: 'Male' }, { textContent: 'Female' }] }) : null;
  const popup = shown({ textContent: text, classList: { contains: () => ban },
    querySelector: selector => selector === '.swal2-title' ? { textContent: text } :
      selector === '.swal2-confirm' ? shown({ textContent: 'Продолжить', disabled: false }) :
      selector.includes('iframe') && captcha ? {} : null,
    querySelectorAll: () => input ? [input] : [],
  });
  return vm.runInNewContext(`(${readAudioPrompt.toString()})()`, {
    document: { querySelectorAll: selector => selector === '.swal2-popup' ? [popup] : [{ __vue__: { $store: { state: { system, user: {} } } } }] },
  });
}

function page(prompt) {
  const actions = [];
  const locator = { filter() { return this; }, locator() { return this; },
    fill: async value => actions.push(['fill', value]), selectOption: async value => actions.push(['select', value.label]),
    click: async () => actions.push(['click']) };
  return { actions, evaluate: async () => prompt, locator: () => locator };
}

test('modal inspection identifies the actual question, input and displayed options', () => {
  const age = read(); assert.equal(age.category, 'age'); assert.equal(age.inputType, 'number');
  assert.equal(age.text, 'Укажите ваш возраст.'); assert.equal(age.fieldCount, 1);
  const gender = read({ text: 'Choose your gender', field: 'select' });
  assert.equal(gender.category, 'gender'); assert.deepEqual(Array.from(gender.options), ['Male', 'Female']);
});

test('age is never fabricated or automatically confirmed', async () => {
  const p = page(read());
  assert.equal((await respondToAudioPrompt(p, { automatic: true })).handled, false);
  assert.equal((await respondToAudioPrompt(p)).handled, false); assert.equal(p.actions.length, 0);
  assert.equal((await respondToAudioPrompt(p, { value: '35' })).handled, true);
  assert.deepEqual(p.actions, [['fill', '35'], ['click']]);
});

test('explicit select answers use native options and routine confirmations can proceed', async () => {
  const gender = page(read({ text: 'Choose your gender', field: 'select' }));
  assert.equal((await respondToAudioPrompt(gender, { value: 'Female' })).handled, true);
  assert.deepEqual(gender.actions, [['select', 'Female'], ['click']]);
  const ordinary = page(read({ text: 'Начать разговор?', field: null }));
  assert.equal((await respondToAudioPrompt(ordinary, { automatic: true })).handled, true);
  assert.deepEqual(ordinary.actions, [['click']]);
});

test('verification, restrictions, missing microphone and unknown prompts are not clicked', async () => {
  for (const options of [{ text: 'Allow microphone; verify you are human', field: null },
    { text: 'Начать разговор?', field: null, system: { captchaRequired: true } },
    { text: 'Начать разговор?', field: null, captcha: true },
    { text: 'Начать разговор?', field: null, ban: true },
    { text: 'Микрофон не обнаружен', field: null }, { text: 'An unknown setting', field: 'text' }]) {
    const p = page(read(options));
    assert.equal((await respondToAudioPrompt(p, { automatic: true })).handled, false);
    assert.equal((await respondToAudioPrompt(p, { value: 'value' })).handled, false);
    assert.equal(p.actions.length, 0);
  }
});

test('prompt summaries redact the configured token', () => {
  assert(!promptMessage({ category: 'unknown', text: 'token private-test-token' }, 'private-test-token').includes('private-test-token'));
});
