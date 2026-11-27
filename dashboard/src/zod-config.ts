import { z } from 'zod';

// The page's CSP has no 'unsafe-eval'. zod's JIT compiler probes `new Function()` and compiles validators with
// it, which the browser reports as a CSP violation even though zod recovers. Turn it off before any schema is
// built, so this module must be the first import of main.tsx.
z.config({ jitless: true });
