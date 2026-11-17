const assert = require('node:assert/strict');
const test = require('node:test');
const { resolveOpenShiftApiURL } = require('../out/utils/api-url');

const devspaces = 'https://devspaces.apps.cluster.example.com';
const defaultOAuth = 'https://oauth-openshift.apps.cluster.example.com/oauth/authorize?client_id=openshift-cli-client';
const api = 'https://api.cluster.example.com:6443';

test('default OAuth route and Dev Spaces route agree', () => {
    assert.equal(resolveOpenShiftApiURL(devspaces, defaultOAuth), api);
});

test('custom componentRoutes hostname is not used as the cluster domain', () => {
    const custom = 'https://oauth.company.com/oauth/authorize?client_id=devspaces';
    assert.equal(resolveOpenShiftApiURL(devspaces, custom), api);
});

test('custom hostname that still starts with oauth-openshift.apps is not the API domain', () => {
    const renamed = 'https://oauth-openshift.apps.other.example.com/oauth/authorize';
    assert.equal(resolveOpenShiftApiURL(devspaces, renamed), api);
});

test('custom Dev Spaces domain still uses the default OAuth route', () => {
    const customDevSpaces = 'https://workspaces.customer.com/dashboard';
    assert.equal(resolveOpenShiftApiURL(customDevSpaces, defaultOAuth), api);
});

test('CRC apps- hostnames resolve to the CRC API server', () => {
    const crcDevSpaces = 'https://devspaces.apps-crc.testing';
    const crcOAuth = 'https://oauth-openshift.apps-crc.testing/oauth/authorize';
    assert.equal(resolveOpenShiftApiURL(crcDevSpaces, crcOAuth), 'https://api.crc.testing:6443');
});

test('custom OAuth route on CRC still uses the Dev Spaces apps domain', () => {
    const crcDevSpaces = 'https://devspaces.apps-crc.testing';
    const custom = 'https://login.example.com/oauth/authorize';
    assert.equal(resolveOpenShiftApiURL(crcDevSpaces, custom), 'https://api.crc.testing:6443');
});

test('missing redirect still uses a Dev Spaces apps hostname', () => {
    assert.equal(resolveOpenShiftApiURL(devspaces), api);
});

test('relative redirect is resolved against the Dev Spaces origin', () => {
    assert.equal(resolveOpenShiftApiURL(devspaces, '/oauth/authorize?client_id=x'), api);
});

test('malformed redirect does not hide a usable Dev Spaces host', () => {
    assert.equal(resolveOpenShiftApiURL(devspaces, 'http://'), api);
});

test('Dev Spaces apps domain wins when it disagrees with a default-shaped OAuth host', () => {
    // A componentRoutes hostname can still begin with oauth-openshift.apps.
    // The same shape occurs when the Dev Spaces host contains .apps. and the
    // OAuth route is still the real default. Prefer the Dev Spaces route so a
    // renamed OAuth route cannot send oc login to the wrong API server.
    assert.equal(
        resolveOpenShiftApiURL(
            'https://workspaces.apps.customer.com',
            'https://oauth-openshift.apps.cluster.example.com/oauth/authorize'
        ),
        'https://api.customer.com:6443'
    );
});

test('custom OAuth route and custom Dev Spaces domain cannot be resolved', () => {
    assert.equal(
        resolveOpenShiftApiURL('https://workspaces.customer.com', 'https://oauth.company.com/oauth/authorize'),
        undefined
    );
});

test('a port on the Dev Spaces URL is not copied into the API server', () => {
    assert.equal(
        resolveOpenShiftApiURL('https://devspaces.apps.cluster.example.com:8443', defaultOAuth),
        api
    );
});
