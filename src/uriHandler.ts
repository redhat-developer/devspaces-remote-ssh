import * as vscode from 'vscode';
import { getDevSpacesOutputLog, getSSHExtension } from './extension';
import { callOcLogin, createPortForward, generateHostEntry, getOpenShiftApiURL, PortForwardInfo } from './utils/cluster';
import { ensureExists, getSavedPorts, rememberPorts, writeKeyFile } from './utils/io';
import { CliCommand } from './utils/command';
import { appendFileSync } from 'fs';
import path from 'path';
import { homedir } from 'os';

export async function handleVSCodeURI(uri: vscode.Uri) {
    const qParams = new URLSearchParams(uri.query);
    const namespace = qParams.get('namespace');
    const podName = qParams.get('podName');
    const dwName = qParams.get('dwName');
    const userName = qParams.get('userName');
    let keyContent = qParams.get('key');
    let dashboardURL = qParams.get('url');
    getDevSpacesOutputLog().appendLine(`Connecting to dwName ${dwName}, namespace: ${namespace}, podName: ${podName}, userName: ${userName}, key ${keyContent}`);

    if (!namespace || !podName || !dwName || !userName || !keyContent || !dashboardURL) {
        return;
    }

    keyContent = Buffer.from(keyContent, 'base64').toString();
    dashboardURL = decodeURIComponent(dashboardURL);

    const apiURL = await getOpenShiftApiURL(dashboardURL);
    if (apiURL === undefined) {
        vscode.window.showErrorMessage(
            `The API URL does not appear to be valid, and a connection could not be established.`);
        return;
    }

    await callOcLogin(apiURL);

    const sshConfigDir = path.join(homedir(), '.ssh');
    const devspacesConfigFile = path.join(sshConfigDir, 'devspaces.conf');
    ensureExists(sshConfigDir);

    const localPort = Math.floor(((2 ** 16 - 1) - 1024) * Math.random()) + 1024;
    const privateKeyFile = writeKeyFile(`${podName}.key`, keyContent);
    const devspaceHostEntry = generateHostEntry(podName, dwName, localPort, userName, privateKeyFile);

    const pfCmd: CliCommand = await createPortForward(namespace, podName, localPort);
    const pf: PortForwardInfo = { namespace: namespace, name: podName, port: localPort, pid: pfCmd.getPID() };

    appendFileSync(devspacesConfigFile, devspaceHostEntry);

    const remoteSSHExtension = getSSHExtension();
    if (remoteSSHExtension === 'microsoft') {
        vscode.commands.executeCommand('remote-explorer.refresh');
    } else if (remoteSSHExtension === 'open') {
        vscode.commands.executeCommand('openremotessh.explorer.refresh');
    } else if (remoteSSHExtension === 'cursor') {
        vscode.commands.executeCommand('"opensshremotes.explorer.refresh"');
    } else {
        // do nothing
    }

    const result: PortForwardInfo[] = [];
    result.push(...getSavedPorts());
    result.push(pf);
    rememberPorts(result);

    await vscode.commands.executeCommand("vscode.newWindow", {
        remoteAuthority: `ssh-remote+${dwName}`,
        reuseWindow: false,
    });

}