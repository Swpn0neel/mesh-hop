export const GITHUB_REPOSITORY = "Swpn0neel/mesh-hop";
export const GITHUB_REPOSITORY_URL = `https://github.com/${GITHUB_REPOSITORY}`;

// Keep this value synchronized from the root package.json with npm run version:sync.
export const RELEASE_VERSION = "0.3.3";
export const RELEASE_TAG = `v${RELEASE_VERSION}`;
export const LATEST_RELEASE_URL = `${GITHUB_REPOSITORY_URL}/releases/latest`;
export const RELEASE_MANIFEST_URL = `${LATEST_RELEASE_URL}/download/meshhop-release.json`;
export const WINDOWS_INSTALLER_URL = `${LATEST_RELEASE_URL}/download/MeshHop-windows-x64-setup.exe`;
export const WINDOWS_MSI_URL = `${LATEST_RELEASE_URL}/download/MeshHop-windows-x64.msi`;
