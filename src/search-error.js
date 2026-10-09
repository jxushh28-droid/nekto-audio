const failures = {
  load: ['NEKTO_PAGE_LOAD', 'Nekto page could not load from Railway. The site may be unavailable or rejecting connections.'],
  authorize: ['NEKTO_AUTH_FAILED', 'Nekto live token authorization failed.'],
  control: ['NEKTO_START_CONTROL', 'Nekto start control was not found. The site may still be loading, require verification, or use different controls.'],
  click: ['NEKTO_START_CLICK', 'Nekto start control could not be activated.'],
  confirm: ['NEKTO_SEARCH_UNCONFIRMED', 'Nekto did not confirm a search after starting. The token may be rejected or the site may need another step.'],
  attention: ['NEKTO_ATTENTION', 'Nekto is waiting for a response to a website prompt. Automatic search stopped.'],
  microphone: ['NEKTO_MICROPHONE', 'Nekto microphone permission or device initialization failed. Browser checks are shown in /status.'],
  'next-control': ['NEKTO_NEXT_CONTROL', 'Nekto end-call control was not found or was ambiguous. The current browser session was kept; check /status.'],
  'next-confirm': ['NEKTO_NEXT_UNCONFIRMED', 'Nekto did not confirm ending the previous call. The current browser session was kept; check /status.'],
};

export function searchError(stage) {
  const [code, message] = failures[stage] || ['NEKTO_SETUP', 'Nekto browser setup failed.'];
  return Object.assign(new Error(message), { code });
}
