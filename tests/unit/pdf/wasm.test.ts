import { afterEach, describe, expect, it, vi } from 'vitest';
import { isWasmAllowed } from '../../../lib/pdf/wasm';

afterEach(() => vi.unstubAllGlobals());

describe('isWasmAllowed', () => {
  it('is true when WebAssembly compiles', () => {
    expect(isWasmAllowed()).toBe(true);
  });

  it('is false when the CSP makes compilation throw (MV3 default: script-src self)', () => {
    vi.stubGlobal('WebAssembly', {
      Module: class {
        constructor() {
          throw new Error(
            "violates the following Content Security policy directive: script-src 'self'",
          );
        }
      },
    });
    expect(isWasmAllowed()).toBe(false);
  });

  it('is false when WebAssembly does not exist', () => {
    vi.stubGlobal('WebAssembly', undefined);
    expect(isWasmAllowed()).toBe(false);
  });
});
