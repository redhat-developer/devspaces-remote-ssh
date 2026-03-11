#!/usr/bin/env node

import { fileURLToPath } from 'url';
import path from 'path';

/**
 * Gets the directory name of the current script (ESM equivalent of __dirname)
 * @returns {string} The directory path of the current script
 */
function getScriptDir() {
    const filename = fileURLToPath(import.meta.url);
    return path.dirname(filename);
}

/**
 * Creates a path relative to the project root (parent of scripts directory)
 * @param {...string} pathSegments - Path segments to join
 * @returns {string} The constructed path
 */
function getProjectPath(...pathSegments) {
    const scriptDir = getScriptDir();
    const projectRoot = path.join(scriptDir, '..');
    return path.join(projectRoot, ...pathSegments);
}

/**
 * Handles errors with consistent logging and exit behavior
 * @param {Error} error - The error to handle
 * @param {string} context - Context description for the error
 * @param {boolean} shouldExit - Whether to exit the process (default: true)
 */
function handleError(error, context, shouldExit = true) {
    console.error(`Error ${context}:`, error.message);
    if (shouldExit) {
        process.exit(1);
    }
}

/**
 * Sets up the main execution pattern for scripts
 * @param {Function} mainFunction - The main function to execute
 */
function setupMainExecution(mainFunction) {
    if (import.meta.url === `file://${process.argv[1]}`) {
        mainFunction().catch(console.error);
    }
}

export {
    getScriptDir,
    getProjectPath,
    handleError,
    setupMainExecution
};
