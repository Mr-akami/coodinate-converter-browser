export function createProjApi(Module) {
  if (!Module) {
    throw new Error('Module is required');
  }

  const ccall = Module.ccall;
  const malloc = Module._malloc;
  const free = Module._free;
  const heapF64 = Module.HEAPF64;

  function transform(src, dst, x, y, z = 0) {
    if (!src || !dst) {
      throw new Error('src and dst are required');
    }

    const bytes = 3 * 8;
    const ptr = malloc(bytes);
    if (!ptr) {
      throw new Error('malloc failed');
    }

    try {
      const base = ptr >> 3;
      heapF64[base] = x;
      heapF64[base + 1] = y;
      heapF64[base + 2] = z;

      const rc = ccall(
        'pw_transform',
        'number',
        ['string', 'string', 'number', 'number', 'number'],
        [src, dst, ptr, ptr + 8, ptr + 16]
      );
      if (rc !== 0) {
        throw new Error(`proj_transform failed: ${rc}`);
      }

      return {
        x: heapF64[base],
        y: heapF64[base + 1],
        z: heapF64[base + 2],
      };
    } finally {
      free(ptr);
    }
  }

  return { transform };
}
