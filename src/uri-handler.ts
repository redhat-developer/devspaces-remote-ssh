import * as vscode from 'vscode';
import { getDevSpacesOutputLog, getSSHExtension } from './extension';
import { callOcLogin, createPortForward, generateHostEntry, getExistingPortForwardEntry, getOpenShiftApiURL, isPortAvailable, PodInfo, PortForwardInfo, updatePortForwarding } from './utils/cluster';
import { ensureDevspacesConfigIncluded, ensureExists, writeKeyFile } from './utils/io';
import { CliCommand } from './utils/command';
import { appendFileSync } from 'fs';
import path from 'path';
import { homedir } from 'os';

// https://kubernetes.io/docs/concepts/overview/working-with-objects/names/#dns-label-names
const KB_NAME_PATTERN = '^(([a-z0-9][-a-z0-9]*)?[a-z0-9])?$';
// https://github.com/eclipse-che/che-dashboard/blob/main/packages/dashboard-frontend/src/pages/WorkspaceDetails/OverviewTab/WorkspaceName/index.tsx
const DW_NAME_PATTERN = '^(([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9])?$';
const USERNAME_PATTERN = '^[a-zA-Z0-9_.-]+$';

export async function handleVSCodeURI(uri: vscode.Uri) {
    const qParams = new URLSearchParams(uri.query);
    const namespace = qParams.get('namespace');
    const podName = qParams.get('podName');
    const dwName = qParams.get('dwName');
    const userName = qParams.get('userName');
    let keyContent = qParams.get('key');
    let dashboardURL = qParams.get('url');
    getDevSpacesOutputLog().appendLine(`Connecting to dwName: ${dwName}, namespace: ${namespace}, podName: ${podName}, userName: ${userName}, dashboardURL: ${dashboardURL}`);

    if (!namespace || !podName || !dwName || !userName || !dashboardURL) {
        return;
    }

    if (!hasValidParameters(namespace, podName, dwName, userName)) {
        return;
    }

    if (keyContent) {
        keyContent = Buffer.from(keyContent, 'base64').toString();
    }
    dashboardURL = decodeURIComponent(dashboardURL);

    const apiURL = await getOpenShiftApiURL(dashboardURL);
    if (apiURL === undefined) {
        vscode.window.showErrorMessage(
            `The API URL does not appear to be valid, and a connection could not be established.`);
        return;
    }

    await callOcLogin(apiURL);

    const sshConfigDir = path.join(homedir(), '.ssh');
    const sshConfigFile = path.join(sshConfigDir, 'config');
    const devspacesConfigFile = path.join(sshConfigDir, 'devspaces.conf');
    ensureExists(sshConfigDir);

    const pod: PodInfo = { name: podName, project: namespace, id: dwName, status: 'Running' };
    const currPF = await getExistingPortForwardEntry(pod);
    const localPort = currPF ? currPF.port : Math.floor(((2 ** 16 - 1) - 1024) * Math.random()) + 1024;

    let privateKeyFile;
    if (keyContent) {
        privateKeyFile = writeKeyFile(`${podName}.key`, keyContent);
    }
    const devspaceHostEntry = generateHostEntry(podName, dwName, localPort, userName, privateKeyFile);

    appendFileSync(devspacesConfigFile, devspaceHostEntry);
    ensureDevspacesConfigIncluded(sshConfigFile, devspacesConfigFile);

    let currPID = undefined;
    if (currPF && currPF.pid) {
        currPID = currPF.pid;
    } else {
        const pfCmd: CliCommand = await createPortForward(namespace, podName, localPort);
        currPID = pfCmd.getPID();
    }

    const pf: PortForwardInfo = { namespace: namespace, name: podName, port: localPort, pid: currPID };

    await isPortAvailable(pf.port, 1000);

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

    updatePortForwarding([pod], [pf]);

    await vscode.commands.executeCommand("vscode.newWindow", {
        remoteAuthority: `ssh-remote+${dwName}`,
        reuseWindow: false,
    });

}

function hasValidParameters(namespace: string, podName: string, dwName: string, userName: string) : boolean {
    let message = '';
    if (!namespace.match(KB_NAME_PATTERN)) {
        message += `, ${namespace}`;
    }

    if (!podName.match(KB_NAME_PATTERN)) {
        message += `, ${podName}`;
    }

    if (!dwName.match(DW_NAME_PATTERN)) {
        message += `, ${dwName}`;
    }

    if (!userName.match(USERNAME_PATTERN)) {
        message += `, ${userName}`;
    }

    if (message.length > 0) {
        vscode.window.showErrorMessage(
            `The following parameters are not valid : ${message.substring(1)}`);
        return false;
    }

    return true;
}
