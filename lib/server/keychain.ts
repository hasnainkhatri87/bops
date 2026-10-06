import "server-only";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const SERVICE = "Bops Vault";
const q = (s: string) => `"${s.replace(/["\\]/g, "")}"`;
const windows = process.platform === "win32";
const vaultFile = () => join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "Bops", "vault.json");

function readVault(): Record<string, string> {
  try { return JSON.parse(readFileSync(vaultFile(), "utf8")) as Record<string, string>; } catch { return {}; }
}
function writeVault(v: Record<string, string>) {
  mkdirSync(dirname(vaultFile()), { recursive: true });
  writeFileSync(vaultFile(), JSON.stringify(v), { mode: 0o600 });
}
function ps(script: string, input = "") {
  return new Promise<string>((resolve, reject) => {
    const p = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += String(d)));
    p.stderr.on("data", (d) => (err += String(d)));
    p.on("error", reject);
    p.on("close", (code) => code === 0 ? resolve(out.trim()) : reject(new Error(err.trim() || `PowerShell exited ${code}`)));
    p.stdin.end(input);
  });
}
async function protect(value: string) {
  return ps(
    "$v=[Console]::In.ReadToEnd();$b=[Text.Encoding]::UTF8.GetBytes($v);$e=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Convert]::ToBase64String($e)",
    value,
  );
}
async function unprotect(value: string) {
  return ps(
    "$v=[Console]::In.ReadToEnd();$b=[Convert]::FromBase64String($v);$d=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Text.Encoding]::UTF8.GetString($d)",
    value,
  );
}

export async function setSecret(account: string, value: string) {
  if (windows) {
    const all = readVault();
    all[account] = await protect(value);
    writeVault(all);
    return;
  }
  return new Promise<void>((resolve, reject) => {
    const p = spawn("security", ["-i"], { stdio: ["pipe", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => (code === 0 && !err.trim() ? resolve() : reject(new Error(`Keychain refused it: ${err.trim() || code}`))));
    p.stdin.end(`add-generic-password -U -s ${q(SERVICE)} -a ${q(account)} -X ${Buffer.from(value, "utf8").toString("hex")}\n`);
  });
}

export async function getSecret(account: string) {
  if (windows) {
    const value = readVault()[account];
    if (!value) return null;
    return unprotect(value).catch(() => null);
  }
  return new Promise<string | null>((resolve) =>
    execFile("security", ["find-generic-password", "-s", SERVICE, "-a", account, "-w"], (e, out) => resolve(e ? null : out.replace(/\n$/, ""))),
  );
}

export async function deleteSecret(account: string) {
  if (windows) {
    const all = readVault();
    delete all[account];
    if (Object.keys(all).length) writeVault(all);
    else if (existsSync(vaultFile())) writeFileSync(vaultFile(), "{}", { mode: 0o600 });
    return;
  }
  return new Promise<void>((resolve) => execFile("security", ["delete-generic-password", "-s", SERVICE, "-a", account], () => resolve()));
}
