import { readFileSync } from "fs";

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