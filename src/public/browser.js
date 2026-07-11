import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

function firstExisting(paths) {
  return paths.find((candidate) => candidate && existsSync(candidate));
}

export function findChromiumBrowser(env = process.env, platform = process.platform) {
  if (platform === "win32") {
    const chrome = firstExisting([
      env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
      env.ProgramFiles && path.join(env.ProgramFiles, "Google", "Chrome", "Application", "chrome.exe"),
      env["ProgramFiles(x86)"] && path.join(env["ProgramFiles(x86)"], "Google", "Chrome", "Application", "chrome.exe"),
    ]);
    if (chrome) return { executable: chrome, name: "Chrome" };
    const edge = firstExisting([
      env.ProgramFiles && path.join(env.ProgramFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
      env["ProgramFiles(x86)"] && path.join(env["ProgramFiles(x86)"], "Microsoft", "Edge", "Application", "msedge.exe"),
    ]);
    if (edge) return { executable: edge, name: "Edge" };
  }
  if (platform === "darwin") {
    const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    if (existsSync(chrome)) return { executable: chrome, name: "Chrome" };
  }
  return null;
}

export function launchProxiedBrowser({ proxyPort, controlPort, logger = console } = {}) {
  const browser = findChromiumBrowser();
  if (!browser) {
    logger.warn?.("Chrome or Edge was not found; configure your browser manually with the printed proxy URL");
    return false;
  }
  const profileRoot = process.env.LOCALAPPDATA || process.env.HOME || process.cwd();
  const profile = path.join(profileRoot, "MeshHop", "PublicBrowser");
  const child = spawn(
    browser.executable,
    [
      `--user-data-dir=${profile}`,
      `--proxy-server=http://127.0.0.1:${proxyPort}`,
      "--disable-quic",
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
      "--no-first-run",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      `http://127.0.0.1:${controlPort}`,
    ],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
  logger.info?.(`Opened a dedicated ${browser.name} profile through MeshHop Public`);
  return true;
}
