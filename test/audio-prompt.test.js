import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readAudioPrompt } from '../src/audio-prompt.js';

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

test('the reported Russian permission-denied popup is classified as a microphone error', () => {
  const prompt = read({ text: '!Доступ к микрофону запрещен Пожалуйста разрешите доступ к микрофону.', field: null });
  assert.equal(prompt.category, 'microphone-denied'); assert.equal(prompt.visible, true);
});

test('verification and restriction flags take precedence over microphone wording', () => {
  for (const options of [{ system: { captchaRequired: true } }, { captcha: true }]) {
    assert.equal(read({ text: 'Allow microphone', ...options }).category, 'verification');
  }
  assert.equal(read({ text: 'Allow microphone', ban: true }).category, 'restriction');
});

test('unrelated popup text is preserved for private diagnostics', () => {
  const prompt = read({ text: 'Укажите ваш возраст.' });
  assert.equal(prompt.category, 'age'); assert.equal(prompt.text, 'Укажите ваш возраст.');
});
