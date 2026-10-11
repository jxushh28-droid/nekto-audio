import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readAudioPrompt } from '../src/audio-prompt.js';

function read({ text = 'Укажите ваш возраст.', field = 'number', system = {}, captcha = false, ban = false, classes = [] } = {}) {
  const shown = extra => ({ isConnected: true, checkVisibility: () => true, ...extra });
  const input = field ? shown({ type: field, tagName: field === 'select' ? 'SELECT' : 'INPUT', options: [{ textContent: 'Male' }, { textContent: 'Female' }] }) : null;
  const popup = shown({ textContent: text, classList: { contains: name => classes.includes(name) || (ban && name === 'banPopup') },
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

test('current Nekto End prompt is recognized while a report confirmation stays unanswered', () => {
  assert.equal(read({ text: 'У вас есть активный разговор.\nЗавершить?', field: null,
    classes: ['closeDialogPopup'] }).category, 'end-confirm');
  assert.equal(read({ text: 'У вас есть активный разговор.\nЗавершить?', field: null }).category, 'end-confirm');
  assert.equal(read({ text: 'Вы уверены, что хотите завершить разговор и пожаловаться на собеседника?',
    field: null, classes: ['reportConfirm'] }).category, 'report');
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

test('ordinary End confirmations and partner-left notices are distinguished', () => {
  for (const text of ['Вы действительно хотите закончить разговор?', 'Are you sure you want to end this call?',
    'Do you want to end the conversation?', 'Сіз әңгімені аяқтағыңыз келетініне сенімдісіз бе?',
    'Сіз сөйлесуді аяқтағыңыз келе ме?']) {
    assert.equal(read({ text, field: null }).category, 'end-confirm', text);
  }
  for (const text of ['Ваш собеседник завершил разговор.', 'Разговор завершён', 'Your partner has disconnected.',
    'Әңгімелесуші әңгімені аяқтады.']) {
    assert.equal(read({ text, field: null }).category, 'call-ended', text);
  }
  assert.equal(read({ text: 'Ваш собеседник завершил разговор. Verify you are human.', field: null }).category, 'verification');
});
