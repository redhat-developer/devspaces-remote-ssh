import * as cp from 'child_process';
import { getDevSpacesOutputLog } from '../extension';

export class CliCommand {

    private static channel = getDevSpacesOutputLog();
    private stdout = "";
    private stderr = "";
    private exiteCode: number | null = null;

    async spawn(command: string, logRealTime?: boolean) {
        return new Promise((resolve, _reject) => {
            const proc = cp.spawn(command, { shell: true });
            if (logRealTime) {
                CliCommand.channel.appendLine(command);
            }
            proc.stdout.on('data', (data) => {
                this.stdout += data;
                if (logRealTime) {
                    CliCommand.channel.append(data.toString());
                }
            });
            proc.stderr.on('data', (data) => {
                this.stderr += data;
                if (logRealTime) {
                    CliCommand.channel.append(data.toString());
                }
            });

            proc.on('error', (_error) => {
                if (!logRealTime) {
                    CliCommand.channel.appendLine(command);
                    CliCommand.channel.append(this.stderr);
                }
                resolve(undefined);
            });
            proc.on('close', (code) => {
                if (code != null) {
                    this.exiteCode = code;
                }
                if (!logRealTime) {
                    CliCommand.channel.appendLine(command);
                    CliCommand.channel.append(this.stdout);
                }
                resolve(undefined);
            });
        });
    }

    getOutput() : string {
        return this.stdout;
    }

    getError(): string {
        return this.stderr;
    }

    getExiteCode(): number | null {
        return this.exiteCode;
    }

}