import * as vscode from 'vscode';
import { CliCommand } from './utils/command';
import { createPortForward, DevWorkspaceInfo, generateHostEntry, getDevWorkspaces, getExistingPortForwardEntry, getNameSpace, getOpenShiftApiURL, getPods, getPrivateKey, getUser, isCodeSSHDWorkspace, isPortAvailable, PodInfo, PortForwardInfo } from './utils/cluster';
import { getSavedPorts, readFile, rememberPorts, writeKeyFile } from './utils/io';
import { homedir } from 'os';
import path from 'path';
import { unlinkSync, writeFileSync } from 'fs';
import SSHConfig, { Line, LineType } from 'ssh-config';

export let extStoragePath: vscode.Uri;
export let channel : vscode.OutputChannel;

export async function activate(context: vscode.ExtensionContext) {

	extStoragePath = context.globalStorageUri;
	const remoteSSHExtension = getSSHExtension();
	if (remoteSSHExtension === undefined) {
		vscode.window.showErrorMessage(`The "Dev Spaces Local/Remote Support - SSH"
			extension requires the installation of either Remote - SSH (VS Code) OR
			Open Remote - SSH (Code-based editors). Without one of these installed,
			connecting to a cluster will not be possible.`);
		return;
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
			prompt: 'Please enter the landing webpage URL of the "VS Code (desktop) (SSH)" editor to be connected',
			placeHolder: 'https://devspaces.apps-crc.testing/developer/nodejs-web-app/3400/'
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
	if (channel === undefined) {
		channel = vscode.window.createOutputChannel('Red Hat OpenShift Dev Spaces');
	}
	return channel;
}

export function getSSHExtension() : string | undefined {
	if (vscode.extensions.getExtension('ms-vscode-remote.remote-ssh')) {
		return 'microsoft';
	} else if (vscode.extensions.getExtension('jeanp413.open-remote-ssh')) {
		return 'open';
	} else {
		return undefined;
	}
}
async function updateRemoteSSHTargets() {
	const sshdPods: PodInfo[] = (await getPods()).filter(async (p) => {
		return p.name !== undefined && await isCodeSSHDWorkspace(p.name);
	});

	// TODO: Expand for windows
	const sshConfigFile = path.join(homedir(), '.ssh', 'config');
	const devspacesConfigFile = path.join(homedir(), '.ssh', 'devspaces.conf');

	if (sshdPods.length === 0) {
		writeFileSync(devspacesConfigFile, '', { mode: 0o600 });
		updatePortForwarding();
		return;
	}

	const portForwardEntries: PortForwardInfo[] = [];
	let devspaceHostEntriesData = '';
	for (const pod of sshdPods) {
		if (pod.name !== undefined && pod.id !== undefined) {
			const privateKey = await getPrivateKey(pod.name);
			if (privateKey) {
				const privateKeyFile = writeKeyFile(`${pod.name}.key`, privateKey);

				const currPF = await getExistingPortForwardEntry(pod.name);
				const localPort = currPF ? currPF.port : Math.floor(((2**16 - 1) - 1024) * Math.random()) + 1024;
				const user = await getUser(pod.name);
				const namespace = await getNameSpace(pod.name);
				const devspaceHostEntry = await generateHostEntry(pod.name, pod.id, localPort, user, privateKeyFile);
				portForwardEntries.push({namespace: namespace, name: pod.name, port: localPort, pid: currPF ? currPF.pid : undefined});
				devspaceHostEntriesData += devspaceHostEntry;
			}
		}
	}

	if (devspaceHostEntriesData.length === 0) {
		writeFileSync(devspacesConfigFile, '', { mode: 0o600 });
		updatePortForwarding();
		return;
	}

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
		if (pf.namespace && pf.name && pf.port && !pf.pid) {
			const pfCmd: CliCommand = await createPortForward(pf.namespace, pf.name, pf.port);
			pf.pid = pfCmd.getPID();
		}
	}

	const availablePortForwardEntries: PortForwardInfo[] = [];
	for (const pf of portForwardEntries) {
		if (pf.port !== undefined) {
			const available = await isPortAvailable(pf.port, 1000);
			if (available) {
				availablePortForwardEntries.push(pf);
			}
		}
	}

	if (getSSHExtension() === 'microsoft') {
		vscode.commands.executeCommand('remote-explorer.refresh');
	} else if (getSSHExtension() === 'open') {
		vscode.commands.executeCommand('openremotessh.explorer.refresh');
	} else {
		// do nothing
	}

	updatePortForwarding(sshdPods, availablePortForwardEntries);

}

async function updatePortForwarding(sshdPods?: PodInfo[], availablePortForwardEntries?: PortForwardInfo[]) {
	const result: PortForwardInfo[] = [];
	if (availablePortForwardEntries) {
		result.push(...availablePortForwardEntries);
	}

	for (const pf of getSavedPorts()) {
		const entryExists = result.some(e => e.name === pf.name && e.namespace === pf.namespace && e.port === pf.port);
		const podRunning : boolean = sshdPods ? sshdPods.some(p => p.name === pf.name) : false;
		const portAvailable = await isPortAvailable(pf.port, 1000);
		if (portAvailable && podRunning && !entryExists) {
			result.push(pf);
		} else if (!(portAvailable && podRunning)) {
			unlinkSync(path.join(extStoragePath.fsPath, '.ssh', `${pf.name}.key`));
			// kill the oc port-forward process
			getDevSpacesOutputLog().appendLine(`Killing ${pf.pid} ${pf.name} ${pf.namespace} ${pf.port}`);
			if (pf.pid) {
				try {
					// process.kill(pf.pid, "SIGTERM");
				// eslint-disable-next-line @typescript-eslint/no-unused-vars
				} catch (err) {
					// continue
				}
			}
		}
	}

	rememberPorts(result);
}


export function deactivate() {
}
