import { getDevSpacesOutputLog } from "../extension";
import { CliCommand } from "./command";
import { platform } from 'os';

export class DevWorkspaceInfo {
    id: string | undefined; // status.devworkspaceId
    url: string | undefined; // status.mainUrl
    status: string | undefined; // status.phase
}

export class PodInfo  {
    name: string | undefined; // metadata.name
    id: string | undefined; // metadata.labels.controller\.devfile\.io/devworkspace_name
    status: string | undefined; // status.phase
}

export async function getDevWorkspaces(): Promise<DevWorkspaceInfo[]> {
    const getWorkspacesCmd : CliCommand = new CliCommand();
    await getWorkspacesCmd.spawn(`oc get devworkspace -o 'jsonpath={range .items[*]}{",{"}"id":"{.status.devworkspaceId}","url":"{.status.mainUrl}","status":"{.status.phase}"{"}"}{end}'`);
    const output = getWorkspacesCmd.getOutput();
    const jsonString = `[ ${output.substring(1)} ]`;
    return JSON.parse(jsonString);
}

export async function getPods(): Promise<PodInfo[]> {
    const getPodsCmd : CliCommand = new CliCommand();
    await getPodsCmd.spawn(`oc get pods -o 'jsonpath={range .items[*]}{",{"}"name":"{.metadata.name}","id":"{.metadata.labels.controller\\.devfile\\.io/devworkspace_name}","status":"{.status.phase}"{"}"}{end}'`);
    const output = getPodsCmd.getOutput();
    const jsonString = `[ ${output.substring(1)} ]`;
    return JSON.parse(jsonString);
}

export async function isCodeSSHDWorkspace(podName: string): Promise<boolean> {
    const isCodeSSHDWorkspaceCmd: CliCommand = new CliCommand();
    await isCodeSSHDWorkspaceCmd.spawn(`oc set env pod/${podName} --list`);
    const stdout = isCodeSSHDWorkspaceCmd.getOutput();
    if (await isDevSpaces324(podName)) {
        return stdout.includes('DEVWORKSPACE_COMPONENT_NAME=che-code-sshd');
    } else {
        return stdout.includes('DEVWORKSPACE_COMPONENT_NAME=che-code-sshd-page');
    }
    // TODO: Check the main url
}

export async function isDevSpaces324(podName: string): Promise<boolean> {
    const devspacesVersion: CliCommand = new CliCommand();
    await devspacesVersion.spawn(`oc exec pods/${podName} -c che-code-sshd -- /bin/bash -c 'ls -1 /sshd'`);
    const exitCode = devspacesVersion.getExiteCode();
    return exitCode == 0;
}

export async function getDevWorkspaceMainPage(podName: string): Promise<string | undefined> {
    const pods: PodInfo[] = await getPods();
    const match : PodInfo | undefined = pods.find(p => p.name === podName);
    if (match) {
        const mainContainerCmd: CliCommand = new CliCommand();
        await mainContainerCmd.spawn(`oc get devworkspace ${match.id} -o 'jsonpath={.spec.template.components[0].name}'`);
        const mainContainer = mainContainerCmd.getOutput();
        return mainContainer;
    }
    return undefined;
}

export async function getPortForwardingCommand(podName: string): Promise<string> {
    const namespaceCmd: CliCommand = new CliCommand();
    let sshdPageContainer = undefined;
    if (await isDevSpaces324(podName)) {
        sshdPageContainer = 'che-code-sshd';
    } else {
        sshdPageContainer = 'che-code-sshd-page';
    }
    await namespaceCmd.spawn(`oc exec pods/${podName} -c ${sshdPageContainer} -- /bin/bash -c 'echo -n $DEVWORKSPACE_NAMESPACE'`);
    const namespace = namespaceCmd.getOutput();
    return `oc port-forward -n ${namespace} ${podName} 2022:2022`;
}

export async function getPrivateKey(podName: string): Promise<string | undefined> {
    const privateKeyCmd: CliCommand = new CliCommand();
    let mainContainer = undefined;
    if (await isDevSpaces324(podName)) {
        mainContainer = 'che-code-sshd';
        await privateKeyCmd.spawn(`oc exec pods/${podName} -c ${mainContainer} -- /bin/bash -c 'cat $HOME/.ssh/ssh_client_ed25519_key'`);
    } else {
        mainContainer = await getDevWorkspaceMainPage(podName);
        await privateKeyCmd.spawn(`oc exec pods/${podName} -c ${mainContainer} -- /bin/bash -c 'cat /sshd/ssh_client_ed25519_key'`);
    }
    if (mainContainer) {
        const privateKey = privateKeyCmd.getOutput();
        return privateKey;
    }
    return undefined;
}

export async function getUser(podName: string): Promise<string> {
    const whoamiCmd: CliCommand = new CliCommand();
    let mainContainer = undefined;
    if (await isDevSpaces324(podName)) {
        mainContainer = 'che-code-sshd';
    } else {
        mainContainer = await getDevWorkspaceMainPage(podName);
    }
    await whoamiCmd.spawn(`oc exec pods/${podName} -c ${mainContainer} -- whoami`);
    const whoami = whoamiCmd.getOutput().trim();
    return whoami;
}

export function getOpenShiftApiURL(inputURL: string) {
    try {
        const host = new URL(inputURL);
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
    const namespaceCmd: CliCommand = new CliCommand();
    let sshdPageContainer = undefined;
    if (await isDevSpaces324(podName)) {
        sshdPageContainer = 'che-code-sshd';
    } else {
        sshdPageContainer = 'che-code-sshd-page';
    }
    await namespaceCmd.spawn(`oc exec pods/${podName} -c ${sshdPageContainer} -- /bin/bash -c 'echo -n $DEVWORKSPACE_NAMESPACE'`);
    const namespace = namespaceCmd.getOutput();
    return`
Host ${devworkspaceId}
  HostName 127.0.0.1
  Port ${port}
  User ${userName}
  IdentityFile ${identityPath}
  UserKnownHostsFile ${platform() == 'win32' ? 'nul' : '/dev/null'}
  ProxyCommand sh -c "oc port-forward -n ${namespace} ${podName} ${port}:${port} & sleep 1s; nc -w 5 127.0.0.1 ${port}"`;
  // TODO: We can support multiple connections by specifying a different local port
  // TODO: ProxyCommand may not be ideal for Windows
}