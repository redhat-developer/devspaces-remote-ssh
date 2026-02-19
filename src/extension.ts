import * as vscode from 'vscode';
import { CliCommand } from './utils/command';
import { createPortForward, DevWorkspaceInfo, generateHostEntry, getDevWorkspaces, getNameSpace, getOpenShiftApiURL, getPods, getPrivateKey, getUser, isCodeSSHDWorkspace, isPortAvailable, PodInfo, PortForwardInfo } from './utils/cluster';
import { readFile, writeKeyFile } from './utils/io';
import { homedir } from 'os';
import path from 'path';
import { writeFileSync } from 'fs';
import SSHConfig, { Line, LineType } from 'ssh-config';

export let extStoragePath: vscode.Uri;

export async function activate(context: vscode.ExtensionContext) {

	extStoragePath = context.globalStorageUri;
	const remoteSSHExtension = getSSHExtension();
	if (remoteSSHExtension === undefined) {
		// handle
	}

	const whoami: CliCommand = new CliCommand();
	await whoami.spawn('oc whoami');
	const isLoggedIn = whoami.getExiteCode();
	if (isLoggedIn === 0) {
		updateRemoteSSHTargets();
	}

	const connectCmd = vscode.commands.registerCommand('devspaces.connect.cluster', async () => {
		const inputURL = await vscode.window.showInputBox({
			title: 'Cluster URL',
			prompt: 'Please enter **ANY** URL from the OpenShift cluster'
		});

		if (inputURL) {
			const apiURL = getOpenShiftApiURL(inputURL);
			if (apiURL === undefined) {
				vscode.window.showErrorMessage(
					`The URL does not appear to be valid, and a connection could not be established.`);
			}
			const loginCmd: CliCommand = new CliCommand();
			await loginCmd.spawn(`oc login --server=${apiURL} --web`);

			await updateRemoteSSHTargets();

			const devspaces: DevWorkspaceInfo[] = await getDevWorkspaces();
			const match : DevWorkspaceInfo | undefined = devspaces.find(d => d.url === inputURL);
			if (match) {
				await vscode.commands.executeCommand("vscode.newWindow", {
					remoteAuthority: `ssh-remote+${match.id}`,
					reuseWindow: true,
				});
			}
		}
	});

	context.subscriptions.push(connectCmd);
}

export function getDevSpacesOutputLog() : vscode.OutputChannel {
	return vscode.window.createOutputChannel('Red Hat OpenShift Dev Spaces');
}

export function getSSHExtension() : string | undefined {
	if (vscode.extensions.getExtension('ms-vscode-remote.remote-ssh')) {
		return 'microsoft';
	} else if (vscode.extensions.getExtension('jeanp413.open-remote-ssh')) {
		return 'openvsx';
	} else {
		return undefined;
	}
}
async function updateRemoteSSHTargets() {
	const sshdPods: PodInfo[] = (await getPods()).filter(async (p) => {
		return p.name !== undefined && await isCodeSSHDWorkspace(p.name);
	});

	if (sshdPods.length === 0) {
		return;
	}

	const portForwardEntries: PortForwardInfo[] = [];
	let devspaceHostEntriesData = '';
	for (const pod of sshdPods) {
		if (pod.name !== undefined && pod.id !== undefined) {
			const privateKey = await getPrivateKey(pod.name);
			if (privateKey) {
				const privateKeyFile = writeKeyFile(`${pod.name}.key`, privateKey);

				const localPort = Math.floor(((2**16 - 1) - 1024) * Math.random()) + 1024;
				const user = await getUser(pod.name);
				const namespace = await getNameSpace(pod.name);
				const devspaceHostEntry = await generateHostEntry(pod.name, pod.id, localPort, user, privateKeyFile);
				portForwardEntries.push({namespace: namespace, name: pod.name, port: localPort});
				devspaceHostEntriesData += devspaceHostEntry;
			}
		}
	}

	if (devspaceHostEntriesData.length === 0) {
		return;
	}

	// TODO: Expand for windows
	const sshConfigFile = path.join(homedir(), '.ssh', 'config');
	const devspacesConfigFile = path.join(homedir(), '.ssh', 'devspaces.conf');

	writeFileSync(devspacesConfigFile, devspaceHostEntriesData, { mode: 0o600 });

	const sshData = readFile(sshConfigFile);
	const sshConfig = SSHConfig.parse(sshData);

	const hasConfig = sshConfig.find((line: Line, _index: number, _config: Line[]) => {
		return line.type == LineType.DIRECTIVE
			&& line.param == 'Include'
			&& typeof line.value == 'string'
			&& line.value.includes('devspaces.conf');
	});

	if (!hasConfig) {
		sshConfig.prepend({
			Include: `${path.join(homedir(), '.ssh', 'devspaces.conf')}`
		});
	}

	const newSSHData = SSHConfig.stringify(sshConfig);
	writeFileSync(sshConfigFile, newSSHData, { mode: 0o600 });

	for (const pf of portForwardEntries) {
		if (pf.namespace && pf.name && pf.port) {
			await createPortForward(pf.namespace, pf.name, pf.port);
		}
	}
	for (const pf of portForwardEntries) {
		if (pf.port !== undefined) {
			await isPortAvailable(pf.port, 2000);
		}
	}

	vscode.commands.executeCommand('remote-explorer.refresh');
}

export function deactivate() {
	console.log(path.join(extStoragePath.fsPath, '.ssh'));
}
