/**
 * Derives https://api.<cluster-domain>:6443 from a Dev Spaces URL and the
 * Location of an unauthenticated GET /oauth/start.
 *
 * On a default OpenShift install that Location is the OAuth route
 * oauth-openshift.apps.<cluster-domain> (oauth-openshift.apps-<cluster-domain>
 * on CRC). Ingress spec.componentRoutes can replace that hostname. The
 * replacement is not the cluster domain, so it must not be rewritten into
 * the API server URL. oc login --web discovers the customized OAuth endpoints
 * from the API server after this URL is known.
 *
 * The Dev Spaces route is used when it is still on the cluster apps domain.
 * The default OAuth hostname is used only when the Dev Spaces host itself is
 * not an apps route, which is how a custom Dev Spaces domain still reaches
 * the cluster.
 */

const APPS_DOT = '.apps.';
const APPS_DASH = '.apps-';

/** Suffix beginning at `.apps.` or `.apps-`, for example `.apps.cluster.example.com`. */
export function ingressSuffix(hostname: string): string | undefined {
    const dash = hostname.indexOf(APPS_DASH);
    const dot = hostname.indexOf(APPS_DOT);
    if (dash > 0 && (dot < 0 || dash < dot)) {
        return hostname.substring(dash);
    }
    if (dot > 0) {
        return hostname.substring(dot);
    }
    return undefined;
}

function clusterDomainFromIngressHost(hostname: string): string | undefined {
    const suffix = ingressSuffix(hostname);
    if (!suffix) {
        return undefined;
    }
    const domain = suffix.startsWith(APPS_DASH)
        ? suffix.substring(APPS_DASH.length)
        : suffix.substring(APPS_DOT.length);
    return domain || undefined;
}

function clusterDomainFromDefaultOAuthHost(oauthHost: string): string | undefined {
    const dashPrefix = 'oauth-openshift.apps-';
    const dotPrefix = 'oauth-openshift.apps.';
    if (oauthHost.startsWith(dashPrefix)) {
        return oauthHost.substring(dashPrefix.length) || undefined;
    }
    if (oauthHost.startsWith(dotPrefix)) {
        return oauthHost.substring(dotPrefix.length) || undefined;
    }
    return undefined;
}

function apiURLForDomain(domain: string): string {
    return `https://api.${domain}:6443`;
}

function redirectHostname(redirectURL: string, baseURL: string): string | undefined {
    try {
        return new URL(redirectURL, baseURL).hostname;
    } catch {
        return undefined;
    }
}

/**
 * @param devspacesURL Dev Spaces dashboard or workspace URL.
 * @param oauthRedirectURL Location header from GET /oauth/start, if any.
 *        Relative locations are resolved against devspacesURL.
 */
export function resolveOpenShiftApiURL(devspacesURL: string, oauthRedirectURL?: string): string | undefined {
    let devspacesHost: string;
    try {
        devspacesHost = new URL(devspacesURL).hostname;
    } catch {
        return undefined;
    }

    const devspacesDomain = clusterDomainFromIngressHost(devspacesHost);
    const devspacesSuffix = ingressSuffix(devspacesHost);
    const oauthHost = oauthRedirectURL ? redirectHostname(oauthRedirectURL, devspacesURL) : undefined;
    const oauthIsDefaultForDevSpaces = !!devspacesSuffix && oauthHost === `oauth-openshift${devspacesSuffix}`;

    if (oauthIsDefaultForDevSpaces && devspacesDomain) {
        return apiURLForDomain(devspacesDomain);
    }

    // Dev Spaces is published on a hostname that is not the cluster apps
    // domain. Trust the redirect only while it is still a default OAuth route.
    if (!devspacesDomain && oauthHost) {
        const oauthDomain = clusterDomainFromDefaultOAuthHost(oauthHost);
        if (oauthDomain) {
            return apiURLForDomain(oauthDomain);
        }
    }

    // The OAuth route hostname was changed with componentRoutes, or there was
    // no usable redirect. A Dev Spaces route on the apps domain still names
    // the cluster.
    if (devspacesDomain) {
        return apiURLForDomain(devspacesDomain);
    }

    return undefined;
}
