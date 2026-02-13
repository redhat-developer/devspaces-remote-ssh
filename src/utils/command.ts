import * as cp from 'child_process';
import { getDevSpacesOutputLog } from '../extension';
import { Disposable } from 'vscode';

export class CliCommand implements Disposable {
    private static channel = getDevSpacesOutputLog();
    private stdout = "";
    private stderr = "";
    private exiteCode: number | null = null;
    private proc: cp.ChildProcess | undefined = undefined;

    async spawn(command: string, logRealTime?: boolean, detached?: boolean) {
        return new Promise((resolve, _reject) => {
            let options: cp.SpawnOptions = { shell: true };
            if (detached) {
                options = { shell: true, detached: true, stdio: 'ignore' };
            }
            const proc = cp.spawn(command, options);
            if (detached) {
                proc.unref();
            }
            this.proc = proc;
            if (logRealTime) {
                CliCommand.channel.appendLine(command);
            }
            proc.stdout?.on('data', (data) => {
                this.stdout += data;
                if (logRealTime) {
                    CliCommand.channel.append(data.toString());
                }
            });
            proc.stderr?.on('data', (data) => {
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

    dispose() {
        this.proc?.kill();
    }

}