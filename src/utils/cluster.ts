import * as vscode from 'vscode';
import { Socket } from "net";
import { getDevSpacesOutputLog, ocCmd } from "../extension";
import { CliCommand } from "./command";
import { platform } from 'os';
import { getSavedPorts } from "./io";
import http from 'http';
import https from 'https';

const isWindows = process.platform.indexOf('win') === 0;
// Need to preserve variables from being evaluated in the local shell
// Single quotes preserve on Linux, Double quotes preserve on Windows
const QUOTE = isWindows ? '"' : '\'';

export class DevWorkspaceInfo {
    project: string | undefined; // project
    id: string | undefined; // status.devworkspaceId
    url: string | undefined; // status.mainUrl
    status: string | undefined; // status.phase
}

export class PodInfo  {
    project: string | undefined; // project
    name: string | undefined; // metadata.name
    id: string | undefined; // metadata.labels.controller\.devfile\.io/devworkspace_name
    status: string | undefined; // status.phase
}

export class PortForwardInfo {
    namespace!: string;
    name!: string;
    port!: number;
    pid?: number;
}

export async function isLoggedIn() : Promise<boolean> {
    const whoami: CliCommand = new CliCommand();
	await whoami.spawn(`${ocCmd} whoami`);
	const isLoggedIn = whoami.getExiteCode();
    return isLoggedIn === 0;
}
export async function callOcLogin(apiURL : string) {
    const loginCmd: CliCommand = new CliCommand();
    await loginCmd.spawn(`${ocCmd} login --server=${apiURL} --web`);
}

export async function getDevWorkspaces(inputProjects?: string[]): Promise<DevWorkspaceInfo[]> {
    let projects: string[];
    if (!inputProjects) {
        projects = await getProjects();
    } else {
        projects = inputProjects;
    }
    const dwInfo: DevWorkspaceInfo[] = [];
    for (const project of projects) {
        const getWorkspacesCmd : CliCommand = new CliCommand();
        await getWorkspacesCmd.spawn(`${ocCmd} get devworkspace -n ${project} -o ${QUOTE}jsonpath={range .items[*]};{.metadata.name},{.status.mainUrl},{.status.phase}{end}${QUOTE}`);
        const output = getWorkspacesCmd.getOutput();
        if (output) {
            const devworkspacesEntries = output.substring(1).split(';');
            for (const dw of devworkspacesEntries) {
                const id = dw.split(',')[0];
                const url = dw.split(',')[1];
                const status = dw.split(',')[2];
                dwInfo.push({project: project, id: id, url: url, status: status});
            }
        }
    }
    return dwInfo;
}

export async function getPods(inputProjects?: string[]): Promise<PodInfo[]> {
    let projects: string[];
    if (!inputProjects) {
        projects = await getProjects();
    } else {
        projects = inputProjects;
    }
    const podInfo: PodInfo[] = [];

    for (const project of projects) {
        const getPodsCmd : CliCommand = new CliCommand();
        await getPodsCmd.spawn(`${ocCmd} get pods -n ${project} -o ${QUOTE}jsonpath={range .items[*]};{.metadata.name},{.metadata.labels.controller\\.devfile\\.io/devworkspace_name},{.status.phase}{end}${QUOTE}`);
        const output = getPodsCmd.getOutput();
        if (output) {
            const podEntries = output.substring(1).split(';');
            for (const podEntry of podEntries) {
                const name = podEntry.split(',')[0];
                const id = podEntry.split(',')[1];
                const status = podEntry.split(',')[2];
                const pod: PodInfo = { project: project, id: id, name: name, status: status };
                if (pod.name && await isCodeSSHDWorkspace(pod)) {
                    podInfo.push(pod);
                }
            }
        }
    }
    return podInfo;
}

export async function isCodeSSHDWorkspace(pod: PodInfo): Promise<boolean> {
    const isCodeSSHDWorkspaceCmd: CliCommand = new CliCommand();
    await isCodeSSHDWorkspaceCmd.spawn(`${ocCmd} set env -n ${pod.project} pod/${pod.name} --list`);
    const stdout = isCodeSSHDWorkspaceCmd.getOutput();
    return stdout.includes('DEVWORKSPACE_COMPONENT_NAME=che-code-sshd');
}

/**
 * Early versions of local/remote support (Dev Spaces 3.24 & 3.25)
 * had the SSHD service in a hard-coded 'che-code-sshd' container
 * that was not the main development container
 */
export async function isLegacyDevSpaces(pod: PodInfo): Promise<boolean> {
    const devspacesVersion: CliCommand = new CliCommand();
    await devspacesVersion.spawn(`${ocCmd} exec -n ${pod.project} pods/${pod.name} -c che-code-sshd -- /bin/bash -c "ls -1 /sshd"`);
    const exitCode = devspacesVersion.getExiteCode();
    return exitCode == 0;
}

export async function getDevWorkspaceMainPage(pod: PodInfo): Promise<string | undefined> {
    const mainContainerCmd: CliCommand = new CliCommand();
    await mainContainerCmd.spawn(`${ocCmd} get devworkspace -n ${pod.project} ${pod.id} -o "jsonpath={.spec.template.components[0].name}"`);
    const mainContainer = mainContainerCmd.getOutput();
    return mainContainer;
}

export async function createPortForward(namespace: string, podName: string, port: number): Promise<CliCommand> {
    const portForward: CliCommand = new CliCommand();
    // oc port-forward process is a child of the main editor
    // when using "connect in current window", child processes seem to be terminated
    // Use unref to ensure port-forward continues to operate
    portForward.spawn(`${ocCmd} port-forward -n ${namespace} ${podName} ${port}:2022`, true, true);
    return portForward;
}

export async function getPrivateKey(pod: PodInfo): Promise<string | undefined> {
    const privateKeyCmd: CliCommand = new CliCommand();
    let mainContainer = undefined;
    if (await isLegacyDevSpaces(pod)) {
        mainContainer = 'che-code-sshd';
        await privateKeyCmd.spawn(`${ocCmd} exec -n ${pod.project} pods/${pod.name} -c ${mainContainer} -- /bin/bash -c ${QUOTE}cat $HOME/.ssh/ssh_client_ed25519_key${QUOTE}`, false, false, true);
    } else {
        mainContainer = await getDevWorkspaceMainPage(pod);
        // Try pre-configured key first (from User Preferences), fall back to auto-generated key
        await privateKeyCmd.spawn(`${ocCmd} exec -n ${pod.project} pods/${pod.name} -c ${mainContainer} -- /bin/bash -c ${QUOTE}[ -e /etc/ssh/dwo_ssh_key ] && cat /etc/ssh/dwo_ssh_key || cat /sshd/ssh_client_*key${QUOTE}`, false, false, true);
    }
    if (mainContainer) {
        const privateKey = privateKeyCmd.getOutput();
        return privateKey;
    }
    return undefined;
}

export async function getUser(pod: PodInfo): Promise<string> {
    const whoamiCmd: CliCommand = new CliCommand();
    let mainContainer = undefined;
    if (await isLegacyDevSpaces(pod)) {
        mainContainer = 'che-code-sshd';
        await whoamiCmd.spawn(`${ocCmd} exec -n ${pod.project} pods/${pod.name} -c ${mainContainer} -- whoami`);
    } else {
        mainContainer = await getDevWorkspaceMainPage(pod);
        await whoamiCmd.spawn(`${ocCmd} exec -n ${pod.project} pods/${pod.name} -c ${mainContainer} -- cat /sshd/username`);
    }
    const whoami = whoamiCmd.getOutput().trim();
    return whoami;
}

/**
 * Resolves the OpenShift API URL from a DevSpaces workspace URL.
 *
 * Hits the /oauth/start endpoint on the DevSpaces host (unauthenticated) which
 * redirects to oauth-openshift.apps.<cluster-domain>. The cluster domain is
 * extracted and the API URL is derived as https://api.<cluster-domain>:6443.
 * If this approach fails, falls back to extracting host directly from the
 * original URL.
 *
 * Works for both standard (.apps.) and custom domain URLs.
 * Uses Node.js https module instead of curl for cross-platform compatibility.
 */
export async function getOpenShiftApiURL(inputURL: string): Promise<string | undefined> {
    try {
        const host = new URL(inputURL);
        const oauthStartURL = `${host.protocol}//${host.host}/oauth/start`;

        getDevSpacesOutputLog().appendLine(`Discovering cluster API URL via ${oauthStartURL}`);

        // Follow the /oauth/start redirect to discover the real cluster hostname
        const redirectURL = await new Promise<string | undefined>((resolve) => {
            const mod = host.protocol === 'https:' ? https : http;
            const req = mod.get(oauthStartURL, { rejectUnauthorized: false }, (res: http.IncomingMessage) => {
                if (res.statusCode === 302 && res.headers.location) {
                    resolve(res.headers.location);
                } else {
                    resolve(undefined);
                }
            });
            req.on('error', () => resolve(undefined));
            req.setTimeout(10000, () => { req.destroy(); resolve(undefined); });
        });

        if (redirectURL) {
            // Redirect URL is: https://oauth-openshift.apps.<cluster-domain>/oauth/authorize?...
            // Strip "oauth-openshift.apps." prefix to get the cluster domain
            const oauthHost = new URL(redirectURL).hostname;
            const prefix = 'oauth-openshift.apps.';
            if (oauthHost.startsWith(prefix)) {
                const clusterDomain = oauthHost.substring(prefix.length);
                const apiURL = `https://api.${clusterDomain}:6443`;
                getDevSpacesOutputLog().appendLine(`Resolved API URL: ${apiURL}`);
                return apiURL;
            } else {
                getDevSpacesOutputLog().appendLine(`Unexpected OAuth hostname: ${oauthHost}`);
            }
        } else {
            getDevSpacesOutputLog().appendLine('No redirect received from /oauth/start');
        }

        // Fall back to basic approach
        let key = '';
        if (host.host.indexOf('.apps-') > 0) {
            key = '.apps-';
        } else if (host.host.indexOf('.apps.') > 0) {
            key = '.apps.';
        } else {
            return undefined;
        }

        const hostTLD = `${host.host.substring(host.host.indexOf(key) + key.length)}`;
        return `${host.protocol}//api.${hostTLD}:6443`;
    } catch (err) {
        getDevSpacesOutputLog().appendLine(String(err));
        return undefined;
    }
}

export async function generateHostEntry(podName: string, devworkspaceId: string, port : number, userName: string, identityPath: string): Promise<string> {
    return`
Host ${devworkspaceId}
  HostName 127.0.0.1
  Port ${port}
  User ${userName}
  IdentityFile "${identityPath}"
  UserKnownHostsFile ${platform() == 'win32' ? 'nul' : '/dev/null'}`;
}

export async function getExistingPortForwardEntry(pod: PodInfo): Promise<PortForwardInfo | undefined> {
    const savedPorts: PortForwardInfo[] = getSavedPorts();
    const match = savedPorts.find(pf => pf.name === pod.name && pf.namespace === pod.project);
    if (match?.port && await isPortAvailable(match?.port, 1000)) {
        return match;
    }
}

export async function isPortAvailable(port: number, timeout: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        try {
            await new Promise((resolve, reject) => {
                const socket = new Socket();
                socket.on("connect", () => {
                    socket.destroy();
                    resolve(true);
                });
                socket.on("error", (err: Error) => {
                    socket.destroy();
                    reject(err);
                });
                socket.connect(port);
            });
            return true;
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        } catch (e) {
            await new Promise(r => setTimeout(r, 100));
        }
    }
    return false;
}

export async function hasDefaultProject() : Promise<boolean> {
    const currProjectCmd: CliCommand = new CliCommand();
	await currProjectCmd.spawn(`${ocCmd} project -q`);
    const code = currProjectCmd.getExiteCode();
    return code === 0;
}

/**
 * Returns only the DevSpaces workspace namespaces that belong to the current user.
 *
 * Queries OpenShift Projects (not Namespaces, to avoid cluster-scope permission issues)
 * using the `app.kubernetes.io/component=workspaces-namespace` label set by the
 * DevSpaces operator on every user namespace. Filters client-side by the
 * `che.eclipse.org/username` annotation using case-insensitive exact matching.
 *
 * Returns all matching namespaces (a user may have more than one).
 */
export async function getProjects(): Promise<string[]> {
    // 1. Get the current username
    const whoamiCmd: CliCommand = new CliCommand();
    await whoamiCmd.spawn(`${ocCmd} whoami`);
    const username = whoamiCmd.getOutput().trim();
    if (!username) {
        getDevSpacesOutputLog().appendLine('Could not determine current user via oc whoami');
        return [];
    }

    // 2. Query projects with the DevSpaces workspace label
    //    Uses the Project API (user-scoped) instead of Namespace API (cluster-scoped)
    //    to avoid "cannot list namespaces at cluster scope" errors for regular users
    const projCmd: CliCommand = new CliCommand();
    await projCmd.spawn(
        `${ocCmd} get projects -l app.kubernetes.io/component=workspaces-namespace -o ${QUOTE}jsonpath={range .items[*]};{.metadata.name},{.metadata.annotations.che\\.eclipse\\.org/username}{end}${QUOTE}`
    );
    if (projCmd.getExiteCode() !== 0) {
        getDevSpacesOutputLog().appendLine('Failed to query DevSpaces projects by label');
        return [];
    }

    const output = projCmd.getOutput();
    if (!output) {
        return [];
    }

    // 3. Filter by che.eclipse.org/username annotation (case-insensitive exact match)
    const projects: string[] = [];
    const entries = output.substring(1).split(';');
    const usernameLower = username.toLowerCase();
    for (const entry of entries) {
        const [ns, owner] = entry.split(',');
        if (ns && owner && owner.toLowerCase() === usernameLower) {
            projects.push(ns);
            getDevSpacesOutputLog().appendLine(`Found DevSpaces namespace: ${ns} (owner: ${owner})`);
        }
    }

    if (projects.length === 0) {
        getDevSpacesOutputLog().appendLine(`No DevSpaces namespace found for user: ${username}`);
    }

    return projects;
}

export async function updateDefaultProject() {
    const projList: string[] = await getProjects();
    if (projList.length > 0) {
        const inputProject = await vscode.window.showQuickPick(projList, { title: 'No project configured. Select a default project' });
        getDevSpacesOutputLog().appendLine(`Setting project to : ${inputProject}`);
        const setProjCmd: CliCommand = new CliCommand();
        await setProjCmd.spawn(`${ocCmd} project ${inputProject}`);
    } else {
        getDevSpacesOutputLog().appendLine(`No projects were detected for the current user.`);
    }
}

export async function showSSHDLogs(pod: PodInfo, terminal: vscode.Terminal) {
    let mainContainer = undefined;
    if (await isLegacyDevSpaces(pod)) {
        mainContainer = 'che-code-sshd';
        terminal.sendText(`${ocCmd} exec -n ${pod.project} pods/${pod.name} -c ${mainContainer} -- /bin/bash -c ${QUOTE}cat /tmp/sshd.log${QUOTE}`);
    } else {
        mainContainer = await getDevWorkspaceMainPage(pod);
        terminal.sendText(`${ocCmd} exec -n ${pod.project} pods/${pod.name} -c ${mainContainer} -- /bin/bash -c ${QUOTE}cat /tmp/sshd.log${QUOTE}`);
    }
    terminal.show();
}
