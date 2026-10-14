import test from 'node:test';
import assert from 'node:assert/strict';
import { installWebglSpoof, DEFAULT_GL_RENDERER, DEFAULT_GL_VENDOR } from '../src/webgl-spoof.js';

// Build a fake WebGL context prototype with a getParameter that returns a
// sentinel for everything, then run the browser-side spoof against it.
function fakeContexts() {
  const real = function getParameter(p) { return `real:${p}`; };
  class WebGLRenderingContext {}
  class WebGL2RenderingContext {}
  WebGLRenderingContext.prototype.getParameter = real;
  WebGL2RenderingContext.prototype.getParameter = real;
  return { WebGLRenderingContext, WebGL2RenderingContext, real };
}

test('spoofs UNMASKED vendor/renderer and forwards every other parameter', () => {
  const g = fakeContexts();
  const saved = globalThis.WebGLRenderingContext;
  const saved2 = globalThis.WebGL2RenderingContext;
  globalThis.WebGLRenderingContext = g.WebGLRenderingContext;
  globalThis.WebGL2RenderingContext = g.WebGL2RenderingContext;
  try {
    installWebglSpoof({ renderer: DEFAULT_GL_RENDERER, vendor: DEFAULT_GL_VENDOR });
    const ctx = new g.WebGLRenderingContext();
    assert.equal(ctx.getParameter(0x9245), DEFAULT_GL_VENDOR);   // UNMASKED_VENDOR
    assert.equal(ctx.getParameter(0x9246), DEFAULT_GL_RENDERER); // UNMASKED_RENDERER
    assert.equal(ctx.getParameter(0x1F00), 'real:7936');         // VENDOR forwarded
    assert.equal(ctx.getParameter(0x0D33), 'real:3379');         // MAX_TEXTURE_SIZE forwarded
    const ctx2 = new g.WebGL2RenderingContext();
    assert.equal(ctx2.getParameter(0x9246), DEFAULT_GL_RENDERER);
  } finally {
    globalThis.WebGLRenderingContext = saved;
    globalThis.WebGL2RenderingContext = saved2;
  }
});

test('the patched getParameter is a Proxy of the native fn (toString forwards to target)', () => {
  const g = fakeContexts();
  const saved = globalThis.WebGLRenderingContext;
  globalThis.WebGLRenderingContext = g.WebGLRenderingContext;
  globalThis.WebGL2RenderingContext = undefined;
  try {
    installWebglSpoof({ renderer: 'R', vendor: 'V' });
    // A Proxy of a function reports as native code — toString yields
    // "function () { [native code] }" — so nekto's /\[native code\]/ tamper
    // check passes, unlike a plain JS override that would expose its source.
    const patched = g.WebGLRenderingContext.prototype.getParameter;
    assert.match(Function.prototype.toString.call(patched), /\[native code\]/);
  } finally {
    globalThis.WebGLRenderingContext = saved;
  }
});

test('the defaults describe a Windows Direct3D11 GPU', () => {
  assert.match(DEFAULT_GL_RENDERER, /Direct3D11/);
  assert.match(DEFAULT_GL_VENDOR, /Google Inc\./);
});
