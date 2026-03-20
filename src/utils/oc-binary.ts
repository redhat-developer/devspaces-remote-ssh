import * as path from 'path';
import * as fs from 'fs';

/**
 * Gets the filename of the 'oc' binary for the current platform
 * @returns The binary filename ('oc' or 'oc.exe')
 */
export function getOcBinaryFilename(): string {
    return process.platform === 'win32' ? 'oc.exe' : 'oc';
}

/**
 * Recursively searches for a file in a directory
 * @param dir - The directory to search in
 * @param filename - The filename to search for
 * @returns The full path to the file, or null if not found
 */
function findFile(dir: string, filename: string): string | null {
    if (!fs.existsSync(dir)) {
        return null;
    }

    const files = fs.readdirSync(dir, { withFileTypes: true });

    for (const file of files) {
        const fullPath = path.join(dir, file.name);

        if (file.isFile() && file.name === filename) {
            return fullPath;
        } else if (file.isDirectory()) {
            const result = findFile(fullPath, filename);
            if (result) {
                return result;
            }
        }
    }

    return null;
}

/**
 * Gets the full path to the embedded 'oc' binary
 * @param extensionPath - The extension root path from context.extensionPath
 * @returns The full path to the 'oc' binary or null
 */
function getOcBinaryPath(extensionPath: string): string | null {
    const filename = getOcBinaryFilename();
    const ocDir = path.join(extensionPath, 'out', 'oc');
    const binaryPath = findFile(ocDir, filename);
    return binaryPath;
}

/**
 * Gets the 'oc' command to use in shell commands
 * @param extensionPath - The extension root path from context.extensionPath
 * @returns The path to the 'oc' binary or null
 */
export function getOcCommand(extensionPath: string): string | null {
    return getOcBinaryPath(extensionPath);
}
