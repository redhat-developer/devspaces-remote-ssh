#!/usr/bin/env node

import { preparePreRelease } from './release.mjs';
import { pathToFileURL } from 'url';

async function main() {
    const command = process.argv[2];
    const args = process.argv.slice(3);

    switch (command) {
        // Release commands
        case 'prepare-pre-release':
            await preparePreRelease();
            break;

        default:
            console.log(`
Usage: node scripts/index.js <command> [options]

Commands:
  Release Management:
    prepare-pre-release                 Prepare pre-release version

Examples:
  node scripts/index.js prepare-pre-release
            `);
            process.exit(1);
    }
}

if (import.meta.url === pathToFileURL(process.argv[1]).toString()) {
    main().catch(console.error);
}

export {
    preparePreRelease
};
