// The one place the version comes from: package.json, read once at start-up.

import { readFileSync } from 'node:fs';

export const VERSION: string = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
