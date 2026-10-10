// Called only after the Discord owner check; replies are ephemeral.
export function statusReply({ status, voice, token, queue }) {
  const d = status.authorizationDiagnostics;
  const registration = d ? `\nAudio registration: authenticated=${d.authenticated}; socket=${d.socketConnected}; identity=${d.identityPresent}\nAudio token checks: storage=${d.savedTokenMatches}; live=${d.liveTokenMatches}\nAudio restrictions: captcha=${d.captcha || d.hcaptcha}; restricted=${d.restricted}; registration error=${d.registrationError}` : '';
  const p = status.protocolDiagnostics;
  const protocol = p ? `\nNative register payload: token matches=${p.registrationPayloadObserved ? p.credentialMatches : 'not observed'}; field=${p.credentialField || 'not observed'}; registered reply=${p.registrationReplyObserved ? p.registrationSuccess : 'not observed'}\nNative search token: ${p.searchToken || 'not observed'}; captcha-request received=${!!p.captchaRequested}` : status.active ? '\nNative register payload: not observed\nNative search token: not observed' : '';
  const details = status.active ? `\nWebRTC: peers=${status.peers || 0}; connections=${(status.peerStates || []).join(',') || 'none'}; ICE=${(status.iceStates || []).join(',') || 'none'}\nRemote audio: track events=${status.trackEvents || 0}; captured tracks=${status.tracks || 0}; packets=${status.inboundPackets || 0}; bytes=${status.inboundBytes || 0}\nBrowser audio: ${status.audioState || 'unknown'}; relay delivery errors=${status.bindingErrors || 0}` : '';
  const promptText = status.promptInfo?.text || '';
  const prompt = status.promptInfo?.visible ? `\nWebsite prompt (${status.promptInfo.category}): ${(token ? promptText.split(token).join('[token]') : promptText).slice(0, 300)}` : '';
  const microphone = status.microphone ? `\nMicrophone: permission=${status.microphone.permission}; inputs=${status.microphone.inputs}; modern=${status.microphone.modernApi}; legacy=${status.microphone.legacyApi}; webkit=${status.microphone.webkitApi}` : '';
  const observation = status.observedStage ? `\nNative state observed: ${status.observedStage}; captcha=${!!d?.captcha}; hcaptcha=${!!d?.hcaptcha}; verification=${!!status.callState?.verification}` : '';
  const c = status.controlDiagnostics;
  const controls = c ? `\nControls: start visible=${c.startVisible}; enabled=${c.startEnabled}; cookies visible=${c.cookiesVisible}; enabled=${c.cookiesEnabled}` : '';
  const render = tokenLine => `Discord voice: ${voice}\nNekto: ${status.active ? status.callState?.phase || 'open; search state unknown' : 'stopped'}\nLast token authorization: ${status.authorization || 'unconfirmed'}\nToken: ${tokenLine}\nAudio frames received: ${queue.received}\nAudio frames containing sound: ${queue.nonSilent}${details}${registration}${protocol}${observation}${controls}${microphone}${prompt}\nLast failure: ${status.lastFailure ? `${status.lastFailure.code}: ${status.lastFailure.message}` : 'none'}\n${status.error || ''}`;
  const content = render(token || 'not set');
  if (content.length <= 2000) return { content, allowedMentions: { parse: [] } };
  // Discord limits message content to 2000 characters. Preserve the entire token.
  return { content: render('full token attached in nekto-token.txt'),
    files: [{ attachment: Buffer.from(token, 'utf8'), name: 'nekto-token.txt' }], allowedMentions: { parse: [] } };
}
