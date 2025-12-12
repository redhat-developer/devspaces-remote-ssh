import { existsSync, lstatSync, readdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "fs";
import path from "path";
import { extStoragePath } from "../extension";

export function readFile(filePath: string) : string {
    let content = '';
    try {
        content = readFileSync(filePath, "utf8");
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (err) {
        // continue
    }
    return content;
}

export function writeKeyFile(fileName: string, data: string): string {
    const privateKeyPath = path.join(extStoragePath.fsPath, '.ssh', fileName);
    writeFileSync(privateKeyPath, data, { mode: 0o600 });
    return privateKeyPath;
}

export function deleteDirectory(dir: string) {
    if (existsSync(dir)) {
        readdirSync(dir).forEach((child) => {
            const entry = path.join(dir, child);
            if (lstatSync(entry).isDirectory()) {
                deleteDirectory(entry);
            } else {
                unlinkSync(entry);
            }
        });
        rmdirSync(dir);
    }
}