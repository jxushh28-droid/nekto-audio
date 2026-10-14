// Build a coherent Windows identity for CDP Emulation.setUserAgentOverride from
// the browser's REAL user-agent. Only the OS tokens are swapped (Linux/mac -> Win),
// so the Chrome major/full version stays truthful and matches the real engine —
// a mismatched version is itself a fingerprint tell. Returns the exact params
// object CDP expects: userAgent, acceptLanguage, platform, and userAgentMetadata
// (which drives navigator.userAgentData and the Sec-CH-UA* request headers).
// Kept free of any browser dependency so it can be unit-tested on its own.
export function windowsUserAgentOverride(realUserAgent, acceptLanguage = 'en-US,en;q=0.9') {
  const ua = String(realUserAgent || '');
  // Normalise any headless marker and the OS token to a Windows 10/11 desktop.
  const userAgent = ua
    .replace('HeadlessChrome', 'Chrome')
    .replace(/\((X11; [^)]*Linux[^)]*|Macintosh;[^)]*|Windows[^)]*)\)/, '(Windows NT 10.0; Win64; x64)');
  const majorMatch = /Chrome\/(\d+)/.exec(userAgent);
  const fullMatch = /Chrome\/([\d.]+)/.exec(userAgent);
  const major = majorMatch ? majorMatch[1] : '140';
  const full = fullMatch ? fullMatch[1] : `${major}.0.0.0`;
  // Chrome's GREASE brand list: a fixed greasey entry + Chromium + Google Chrome.
  const brands = [
    { brand: 'Not;A=Brand', version: '99' },
    { brand: 'Chromium', version: major },
    { brand: 'Google Chrome', version: major },
  ];
  const fullVersionList = [
    { brand: 'Not;A=Brand', version: '99.0.0.0' },
    { brand: 'Chromium', version: full },
    { brand: 'Google Chrome', version: full },
  ];
  return {
    userAgent,
    acceptLanguage,
    platform: 'Win32',
    userAgentMetadata: {
      brands,
      fullVersionList,
      fullVersion: full,
      platform: 'Windows',
      platformVersion: '15.0.0',
      architecture: 'x86',
      bitness: '64',
      model: '',
      mobile: false,
      wow64: false,
    },
  };
}
