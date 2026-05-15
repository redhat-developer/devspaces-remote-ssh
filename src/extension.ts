import * as vscode from 'vscode';
import { CliCommand } from './utils/command';
import { callOcLogin, createPortForward, DevWorkspaceInfo, generateHostEntry, getDevWorkspaces, getExistingPortForwardEntry, getOpenShiftApiURL, getPods, getPrivateKey, getProjects, showSSHDLogs, getUser, isLoggedIn, isPortAvailable, PodInfo, PortForwardInfo, updateDefaultProject, getDevWorkspaceMainPage, isLegacyDevSpaces, updatePortForwarding } from './utils/cluster';
import { ensureDevspacesConfigIncluded, ensureExists, writeKeyFile } from './utils/io';
import { homedir } from 'os';
import path from 'path';
import { writeFileSync } from 'fs';
import { getOcBinaryFilename, getOcCommand } from './utils/oc-binary';
import { handleVSCodeURI } from './uri-handler';

export let extStoragePath: vscode.Uri;
export let channel: vscode.OutputChannel;
export let ocCmd: string | null;

export async function activate(context: vscode.ExtensionContext) {

	ocCmd = getOcCommand(context.extensionPath);
	if (!ocCmd) {
		vscode.window.showWarningMessage(`
			The embedded 'oc' binary could not be located. If you are using the
			universal version of the extension (which does not container 'oc'),
			it is necessary to have oc installed onto the system.`);
		ocCmd = getOcBinaryFilename();
	}

	extStoragePath = context.globalStorageUri;

	const devspacesUriHandler = vscode.window.registerUriHandler({
		async handleUri(uri: vscode.Uri) {
			await handleVSCodeURI(uri);
		}
	});

	const connectCmd = vscode.commands.registerCommand('devspaces.connect.cluster', async () => {
		if (!validateSSHExtension()) {
			return;
		}

		const inputURL = await vscode.window.showInputBox({
			title: 'Cluster URL',
			prompt: 'Please enter the landing webpage URL of the "VS Code (desktop) (SSH)" editor to be connected',
			placeHolder: 'https://devspaces.apps-crc.testing/developer/nodejs-web-app/3400/',
			ignoreFocusOut: true
		});

		updateRemoteSSHPlatform();

		if (inputURL) {
			if (inputURL.startsWith('vscode://redhat.devspaces-remote-ssh')) {
				await handleVSCodeURI(vscode.Uri.parse(inputURL));
			} else {
				await legacyConnectCommand(inputURL);
			}
		}

	});

	const updateDefaultProjectCmd = vscode.commands.registerCommand('devspaces.update.project', async () => {
		updateDefaultProject();
	});

	const getSSHDLogsCmd = vscode.commands.registerCommand('devspaces.sshd.logs', async (element: SshItem) => {
		if (!validateSSHExtension()) {
			return;
		}

		const label = element.label ?? element.hostname;
		const sshdPods: PodInfo[] = await getPods();
		const match : PodInfo | undefined = sshdPods.find(p => p.id === label);

		if (match) {
			const terminal = vscode.window.createTerminal(`${match.id} Logs`);
			showSSHDLogs(match, terminal);
		}
	});

	context.subscriptions.push(connectCmd);
	context.subscriptions.push(updateDefaultProjectCmd);
	context.subscriptions.push(getSSHDLogsCmd);
	context.subscriptions.push(devspacesUriHandler);

	if (!validateSSHExtension()) {
		return;
	}

	if (await isLoggedIn()) {
		const projects: string[] = await getProjects();
		updateRemoteSSHTargets(projects);
	}
}

interface SshItem {
    label?: string | undefined; // VS Code & Code
    hostname?: string | undefined; // Cursor
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
	} else if (vscode.extensions.getExtension('anysphere.remote-ssh')) {
		return 'cursor';
	} else {
		return undefined;
	}
}

export function validateSSHExtension(): boolean {
	const remoteSSHExtension = getSSHExtension();
	if (remoteSSHExtension === undefined) {
		vscode.window.showErrorMessage(`The "Dev Spaces Local/Remote Support - SSH"
			extension requires the installation of either Remote - SSH (VS Code) OR
			Open Remote - SSH (Code-based editors). Without one of these installed,
			connecting to a cluster will not be possible.`);
		return false;
	}
	return true;
}

async function updateRemoteSSHTargets(inputProjects?: string[]) {
	const sshdPods: PodInfo[] = await getPods(inputProjects);

	const sshConfigDir = path.join(homedir(), '.ssh');
	const sshConfigFile = path.join(sshConfigDir, 'config');
	const devspacesConfigFile = path.join(sshConfigDir, 'devspaces.conf');
	ensureExists(sshConfigDir);

	if (sshdPods.length === 0) {
		writeFileSync(devspacesConfigFile, '', { mode: 0o600 });
		updatePortForwarding();
		return;
	}

	const portForwardEntries: PortForwardInfo[] = [];
	let devspaceHostEntriesData = '';
	for (const pod of sshdPods) {
		if (pod.project !== undefined && pod.name !== undefined && pod.id !== undefined) {
			const isLegacyPod = await isLegacyDevSpaces(pod);
			let mainContainer = undefined;
			if (isLegacyPod) {
				mainContainer = 'che-code-sshd';
			} else {
				mainContainer = await getDevWorkspaceMainPage(pod);
			}
			const privateKey = await getPrivateKey(pod, mainContainer);
			if (privateKey) {
				const privateKeyFile = writeKeyFile(`${pod.name}.key`, privateKey);

				const currPF = await getExistingPortForwardEntry(pod);
				const localPort = currPF ? currPF.port : Math.floor(((2**16 - 1) - 1024) * Math.random()) + 1024;
				const user = await getUser(pod, mainContainer);
				const devspaceHostEntry = generateHostEntry(pod.name, pod.id, localPort, user, privateKeyFile);
				portForwardEntries.push({namespace: pod.project, name: pod.name, port: localPort, pid: currPF ? currPF.pid : undefined});
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

	ensureDevspacesConfigIncluded(sshConfigFile, devspacesConfigFile);

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

	const remoteSSHExtension = getSSHExtension();
	if (remoteSSHExtension === 'microsoft') {
		vscode.commands.executeCommand('remote-explorer.refresh');
	} else if (remoteSSHExtension === 'open') {
		vscode.commands.executeCommand('openremotessh.explorer.refresh');
	} else if (remoteSSHExtension === 'cursor') {
		vscode.commands.executeCommand('opensshremotes.explorer.refresh');
	} else {
		// do nothing
	}

	updatePortForwarding(sshdPods, availablePortForwardEntries);
	updateRemoteSSHPlatform();

}

/**
 * Disable 'Select the platform of the remote host "${host}"' prompt
 * All remote hosts are Linux containers
 */
async function updateRemoteSSHPlatform() {
	const remotePlatformMap = vscode.workspace.getConfiguration('remote.SSH').get<Record<string, string>>('remotePlatform');
	if (!remotePlatformMap || !remotePlatformMap['*']) {
		vscode.workspace.getConfiguration().update('remote.SSH.remotePlatform', {'*': 'linux'}, vscode.ConfigurationTarget.Global);
	}
}

async function legacyConnectCommand(inputURL: string) {
	const apiURL = await getOpenShiftApiURL(inputURL);
	if (apiURL === undefined) {
		vscode.window.showErrorMessage(
			`The URL does not appear to be valid, and a connection could not be established.`);
		return;
	}

	await callOcLogin(apiURL);

	const projects: string[] = await getProjects();
	await updateRemoteSSHTargets(projects);

	const devspaces: DevWorkspaceInfo[] = await getDevWorkspaces(projects);
	// Match by workspace name from URL path (second segment) instead of full URL
	// to support custom domains where the input URL differs from the DevWorkspace mainUrl
	const inputPath = new URL(inputURL).pathname.split('/').filter(p => p !== '');
	const workspaceName = inputPath.length >= 2 ? inputPath[1] : undefined;
	const match: DevWorkspaceInfo | undefined = workspaceName
		? devspaces.find(d => d.id === workspaceName)
		: devspaces.find(d => d.url === inputURL);
	if (match) {
		const windowStrategy = vscode.workspace.getConfiguration().get('devspaces.ssh.window.strategy');
		let choice;
		if (windowStrategy === 'prompt') {
			choice = await vscode.window.showQuickPick(
				['Current Window', 'New Window'],
				{ title: `Connect to ${match.id}`, placeHolder: 'Open connection in...' });
		} else {
			switch (windowStrategy) {
				case 'current':
					choice = 'Current Window';
					break;
				case 'new':
					choice = 'New Window';
					break;
				default:
					choice = 'Current Window';
					break;
			}
		}

		if (choice) {
			await vscode.commands.executeCommand("vscode.newWindow", {
				remoteAuthority: `ssh-remote+${match.id}`,
				reuseWindow: choice === 'Current Window',
			});
		}
	}
}

export function deactivate() {
}

