import * as vscode from 'vscode';
import { CliCommand } from './utils/command';
import { callOcLogin, createPortForward, DevWorkspaceInfo, generateHostEntry, getDevWorkspaces, getExistingPortForwardEntry, getOpenShiftApiURL, getPods, getPrivateKey, getProjects, showSSHDLogs, getUser, isLoggedIn, isPortAvailable, PodInfo, PortForwardInfo, updateDefaultProject } from './utils/cluster';
import { getSavedPorts, readFile, rememberPorts, writeKeyFile } from './utils/io';
import { homedir } from 'os';
import path from 'path';
import { unlinkSync, writeFileSync } from 'fs';
import SSHConfig, { Line, LineType } from 'ssh-config';
import { getOcBinaryFilename, getOcCommand } from './utils/oc-binary';

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
	const remoteSSHExtension = getSSHExtension();
	if (remoteSSHExtension === undefined) {
		vscode.window.showErrorMessage(`The "Dev Spaces Local/Remote Support - SSH"
			extension requires the installation of either Remote - SSH (VS Code) OR
			Open Remote - SSH (Code-based editors). Without one of these installed,
			connecting to a cluster will not be possible.`);
		return;
	}

	if (await isLoggedIn()) {
		const projects: string[] = await getProjects();
		updateRemoteSSHTargets(projects);
	}

	const connectCmd = vscode.commands.registerCommand('devspaces.connect.cluster', async () => {
		const inputURL = await vscode.window.showInputBox({
			title: 'Cluster URL',
			prompt: 'Please enter the landing webpage URL of the "VS Code (desktop) (SSH)" editor to be connected',
			placeHolder: 'https://devspaces.apps-crc.testing/developer/nodejs-web-app/3400/'
		});

		if (inputURL) {
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
			const match : DevWorkspaceInfo | undefined = workspaceName
				? devspaces.find(d => d.id === workspaceName)
				: devspaces.find(d => d.url === inputURL);
			if (match) {
				const choice = await vscode.window.showQuickPick(
					['Current Window', 'New Window'],
					{ title: `Connect to ${match.id}`, placeHolder: 'Open connection in...' }
				);
				if (choice) {
					await vscode.commands.executeCommand("vscode.newWindow", {
						remoteAuthority: `ssh-remote+${match.id}`,
						reuseWindow: choice === 'Current Window',
					});
				}
			}
		}
	});

	const updateDefaultProjectCmd = vscode.commands.registerCommand('devspaces.update.project', async () => {
		updateDefaultProject();
	});

	const getSSHDLogsCmd = vscode.commands.registerCommand('devspaces.sshd.logs', async (element: SshItem) => {
		const label: string = element.label;
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
}

interface SshItem {
    label: string;
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

async function updateRemoteSSHTargets(inputProjects?: string[]) {
	const sshdPods: PodInfo[] = await getPods(inputProjects);

	// TODO: Create ssh config if not present
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
		if (pod.project !== undefined && pod.name !== undefined && pod.id !== undefined) {
			const privateKey = await getPrivateKey(pod);
			if (privateKey) {
				const privateKeyFile = writeKeyFile(`${pod.name}.key`, privateKey);

				const currPF = await getExistingPortForwardEntry(pod);
				const localPort = currPF ? currPF.port : Math.floor(((2**16 - 1) - 1024) * Math.random()) + 1024;
				const user = await getUser(pod);
				const devspaceHostEntry = await generateHostEntry(pod.name, pod.id, localPort, user, privateKeyFile);
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
		const podRunning : boolean = sshdPods ? sshdPods.some(p => p.name === pf.name && p.project === pf.namespace) : false;
		const portAvailable = await isPortAvailable(pf.port, 1000);
		getDevSpacesOutputLog().appendLine(`pid: ${pf.pid} name: ${pf.name} ${podRunning ? '(running)' : '(stopped)'} ns: ${pf.namespace} port: ${pf.port} ${portAvailable ? '(available)' : '(stopped)'}`);
		if (portAvailable && podRunning && !entryExists) {
			result.push(pf);
		} else if (!podRunning) {
			try {
				unlinkSync(path.join(extStoragePath.fsPath, '.ssh', `${pf.name}.key`));
			// eslint-disable-next-line @typescript-eslint/no-unused-vars
			} catch (err) {
				// continue
			}
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

