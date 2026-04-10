#!/usr/bin/env node

import { getProjectPath, handleError } from './utils.mjs';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { createWriteStream } from 'fs';
import { x as tarx } from 'tar';

/**
 * Platform mapping from VS Code platform to 'oc' platform name
 */
const PLATFORM_MAP = {
    'win32-x64': 'windows',
    'win32-arm64': 'windows',
    'linux-x64': 'linux',
    'linux-arm64': 'linux-arm64',
    'darwin-x64': 'mac',
    'darwin-arm64': 'mac-arm64'
};

function getArchiveExtension(vscodePlatform) {
    return vscodePlatform.startsWith('win32') ? '.zip' : '.tar.gz';
}

function getBinaryFilename(vscodePlatform) {
    return vscodePlatform.startsWith('win32') ? 'oc.exe' : 'oc';
}

/**
 * Downloads a file from a URL
 * @param {string} url - The URL to download from
 * @param {string} destPath - The destination file path
 */
async function downloadFile(url, destPath) {
    console.log(`Downloading from ${url}...`);

    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to download: ${response.status} ${response.statusText}`);
    }

    const fileStream = createWriteStream(destPath);
    await pipeline(response.body, fileStream);

    console.log(`Downloaded to ${destPath}`);
}

/**
 * Extracts a file from a .tar.gz archive
 * @param {string} archivePath - Path to the .tar.gz archive
 * @param {string} filename - Name of the file to extract
 * @param {string} destPath - Destination path for the extracted file
 */
async function extractFromTarGz(archivePath, filename, destPath) {
    console.log(`Extracting ${filename} from ${archivePath}...`);

    const destDir = path.dirname(destPath);

    // Extract files matching the filename
    await tarx({
        file: archivePath,
        cwd: destDir,
        filter: (path) => path === filename || path.endsWith(`/${filename}`)
    });

    // Find the extracted file (it might be in a subdirectory)
    const files = fs.readdirSync(destDir, { recursive: true, withFileTypes: true });
    const extractedFile = files.find(f => f.isFile() && f.name === filename);

    if (!extractedFile) {
        throw new Error(`File ${filename} not found in archive`);
    }

    const extractedPath = path.join(extractedFile.parentPath || extractedFile.path, extractedFile.name);

    // Move to destination if not already there
    if (extractedPath !== destPath) {
        fs.renameSync(extractedPath, destPath);
    }

    // Set executable permissions
    fs.chmodSync(destPath, 0o755);

    console.log(`Extracted ${filename} to ${destPath}`);
}

/**
 * Extracts a file from a .zip archive
 * @param {string} archivePath - Path to the .zip archive
 * @param {string} filename - Name of the file to extract
 * @param {string} destPath - Destination path for the extracted file
 */
async function extractFromZip(archivePath, filename, destPath) {
    console.log(`Extracting ${filename} from ${archivePath}...`);

    // Use AdmZip for zip extraction
    const AdmZip = (await import('adm-zip')).default;
    const zip = new AdmZip(archivePath);
    const zipEntries = zip.getEntries();

    const entry = zipEntries.find(e => e.entryName === filename || e.entryName.endsWith(`/${filename}`));
    if (!entry) {
        throw new Error(`File ${filename} not found in archive`);
    }

    zip.extractEntryTo(entry, path.dirname(destPath), false, true, false, filename);
    fs.chmodSync(destPath, 0o755);

    console.log(`Extracted ${filename} to ${destPath}`);
}

/**
 * Downloads and packages the 'oc' binary for a specific platform
 * @param {string} vscodePlatform - The VS Code platform identifier
 * @param {string} version - The OpenShift client version (default: '4.21.5')
 */
async function packageOc(vscodePlatform, version = '4.21.5') {
    // Validate platform
    const ocPlatform = PLATFORM_MAP[vscodePlatform];
    if (!ocPlatform) {
        throw new Error(`Unsupported platform: ${vscodePlatform}. Supported platforms: ${Object.keys(PLATFORM_MAP).join(', ')}`);
    }

    const archiveExt = getArchiveExtension(vscodePlatform);
    const binaryFilename = getBinaryFilename(vscodePlatform);
    const isLinux = vscodePlatform.includes('linux');
    const isArm64 = vscodePlatform.includes('arm64');

    // Construct download URL
    // Pattern: openshift-client-${ocPlatform}[-rhel9]-${version}${archiveExt}
    // -rhel9 suffix is only present for linux-arm64 architectures
    const rhel9Suffix = isLinux && isArm64 ? '-rhel9' : '';
    const url = `https://mirror.openshift.com/pub/openshift-v4/clients/ocp/${version}/openshift-client-${ocPlatform}${rhel9Suffix}-${version}${archiveExt}`;

    // Setup paths
    const outDir = getProjectPath('out', 'oc');
    const platformOutDir = path.join(outDir, vscodePlatform);
    const archivePath = path.join(platformOutDir, `openshift-client${archiveExt}`);
    const binaryPath = path.join(platformOutDir, binaryFilename);

    // Create output directory
    fs.mkdirSync(platformOutDir, { recursive: true });

    // Download archive
    await downloadFile(url, archivePath);

    // Extract binary
    if (archiveExt === '.tar.gz') {
        await extractFromTarGz(archivePath, binaryFilename, binaryPath);
    } else {
        await extractFromZip(archivePath, binaryFilename, binaryPath);
    }

    // Clean up archive
    fs.unlinkSync(archivePath);

    console.log(`\nSuccessfully packaged 'oc' binary for ${vscodePlatform}`);
    console.log(`Binary location: ${binaryPath}`);
}

/**
 * Main function
 */
async function main() {
    const platform = process.argv[2];
    const version = process.argv[3];

    if (!platform) {
        console.log(`
Usage: node scripts/oc.mjs <vscode-platform> [version]

Supported platforms:
  ${Object.keys(PLATFORM_MAP).join('\n  ')}

Arguments:
  vscode-platform   The VS Code platform identifier (required)
  version           OpenShift client version (optional, default: 4.21.5)

Examples:
  node scripts/oc.mjs linux-x64
  node scripts/oc.mjs linux-x64 4.21.5
  node scripts/oc.mjs darwin-arm64 4.20.0
        `);
        process.exit(1);
    }

    try {
        await packageOc(platform, version);
    } catch (error) {
        handleError(error, 'packaging oc binary');
    }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
    main();
}

export { packageOc };
