import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "fs";
import path from "path";
import { extStoragePath } from "../extension";
import { PortForwardInfo } from "./cluster";

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
    const privateKeyDir = path.join(extStoragePath.fsPath, '.ssh');
    ensureExists(privateKeyDir);
    const privateKeyPath = path.join(privateKeyDir, fileName);
    writeFileSync(privateKeyPath, data, { mode: 0o600 });
    return privateKeyPath;
}

export function rememberPorts(portForwardEntries: PortForwardInfo[]) {
    const portFile = path.join(extStoragePath.fsPath, 'ports');
    ensureExists(extStoragePath.fsPath);
    const portDataJson: PortForwardInfo[] = [];
    for (const pf of portForwardEntries) {
        portDataJson.push(pf);
    }
    const updatedPortData = JSON.stringify(portDataJson);
    writeFileSync(portFile, updatedPortData, { mode: 0o600 });
}

export function getSavedPorts() : PortForwardInfo[] {
    const portFile = path.join(extStoragePath.fsPath, 'ports');
    const portData = readFile(portFile);
    let portDataJson: PortForwardInfo[] = [];
    try {
        portDataJson = JSON.parse(portData);
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (err) {
        // continue
    }
    return portDataJson;
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

export function ensureExists(dir: string) {
    if (existsSync(dir)) {
        return;
    }
    ensureExists(path.dirname(dir));
    mkdirSync(dir);
}