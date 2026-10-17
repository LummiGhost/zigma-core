/** Static launcher code; command and arguments are data, never interpolated shell text. */
export const WINDOWS_FLOW_LAUNCHER = `
const { execa } = await import(process.argv[1]);
const [command, ...args] = process.argv.slice(2);
try {
  const child = await execa(command, args, { stdio: "inherit", reject: false, windowsHide: true });
  process.exitCode = child.exitCode ?? 1;
} catch (error) {
  process.stderr.write(String(error.message ?? error) + "\\n");
  process.exitCode = 1;
}
`;
