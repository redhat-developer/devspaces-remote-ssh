#!/usr/bin/env node

import { preparePreRelease } from './release.mjs';
import { packageOc } from './oc.mjs';
import { pathToFileURL } from 'url';

async function main() {
    const command = process.argv[2];
    const args = process.argv.slice(3);

    switch (command) {
        // Release commands
        case 'prepare-pre-release':
            await preparePreRelease();
            break;

        // Binary packaging commands
        case 'package-oc':
            if (!args[0]) {
                console.error('Error: platform argument required');
                console.log('Usage: node scripts/index.mjs package-oc <platform> [version]');
                process.exit(1);
            }
            await packageOc(args[0], args[1]);
            break;

        default:
            console.log(`
Usage: node scripts/index.js <command> [options]

Commands:
  Release Management:
    prepare-pre-release                 Prepare pre-release version

  Binary Packaging:
    package-oc <platform> [version]     Package 'oc' binary for a specific platform
                                        Platforms: win32-x64, win32-arm64, linux-x64,
                                                   linux-arm64, darwin-x64, darwin-arm64
                                        Version: defaults to 4.21.5

Examples:
  node scripts/index.js prepare-pre-release
  node scripts/index.js package-oc linux-x64
  node scripts/index.js package-oc linux-x64 4.21.5
            `);
            process.exit(1);
    }
}

if (import.meta.url === pathToFileURL(process.argv[1]).toString()) {
    main().catch(console.error);
}

export {
    preparePreRelease,
    packageOc
};
