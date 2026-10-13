// Lets `node --test` load the Angular sources, which import each other without file extensions
// (`import { x } from './checkbox-indent'`). Used by `npm run test:utils` via `node --import`.
import { register } from 'node:module';

register('./resolve-ts-imports-hooks.mjs', import.meta.url);
