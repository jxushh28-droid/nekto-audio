// Default Windows GPU identity to report. These are the exact strings a real
// Windows Chrome returns for an Intel integrated GPU through ANGLE/Direct3D11 —
// coherent with the Windows UA the CDP override reports.
export const DEFAULT_GL_VENDOR = 'Google Inc. (Intel)';
export const DEFAULT_GL_RENDERER =
  'ANGLE (Intel, Intel(R) UHD Graphics 630 (0x00003E9B) Direct3D11 vs_5_0 ps_5_0, D3D11)';

// Browser-side init script (serialized by Playwright, runs at document_start in
// every frame BEFORE nekto's scripts). It replaces WebGL getParameter with a
// Proxy of the real native function so that:
//   - Function.prototype.toString.call(getParameter) still returns "[native
//     code]" (a Proxy forwards toString to its target) -> nekto's native-code
//     tamper check ($()) sees nothing wrong, unlike a plain function override.
//   - only the two UNMASKED_* renderer/vendor params are swapped; every other
//     getParameter call is forwarded untouched via Reflect.apply.
// This is the one stealthy way to change the renderer string without a GPU;
// whether it also beats nekto's pristine-realm iframe comparison is empirical.
export function installWebglSpoof({ renderer, vendor }) {
  const UNMASKED_VENDOR = 0x9245;   // 37445
  const UNMASKED_RENDERER = 0x9246; // 37446
  const handler = {
    apply(target, thisArg, args) {
      const p = args[0];
      if (p === UNMASKED_VENDOR) return vendor;
      if (p === UNMASKED_RENDERER) return renderer;
      // Some sites read the plain VENDOR/RENDERER (0x1F00/0x1F01) too; leave real.
      return Reflect.apply(target, thisArg, args);
    },
  };
  const patch = (proto) => {
    if (!proto || !proto.getParameter) return;
    try {
      proto.getParameter = new Proxy(proto.getParameter, handler);
    } catch {}
  };
  const g = typeof globalThis !== 'undefined' ? globalThis : self;
  try { patch(g.WebGLRenderingContext && g.WebGLRenderingContext.prototype); } catch {}
  try { patch(g.WebGL2RenderingContext && g.WebGL2RenderingContext.prototype); } catch {}
}
