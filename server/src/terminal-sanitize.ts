export function sanitizeTerminalOutput(input: string): string {
  let text = input;

  // OSC: ESC ] ... BEL or ST
  text = text.replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "");
  text = text.replace(/\u241B\][^\u0007]*(?:\u0007|\u241B\\)/g, "");

  // DCS/SOS/PM/APC: ESC P|X|^|_ ... ST
  text = text.replace(/\u001B[PX^_].*?\u001B\\/gs, "");
  text = text.replace(/\u241B[PX^_].*?\u241B\\/gs, "");

  // CSI sequences: ESC [ ...
  text = text.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
  text = text.replace(/\u241B\[[0-?]*[ -/]*[@-~]/g, "");

  // Single-character escapes.
  text = text.replace(/\u001B[@-_]/g, "");
  text = text.replace(/\u241B[@-_]/g, "");

  // Normalize carriage returns used for in-place terminal updates.
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Remove non-printable control characters except tab/newline.
  text = text.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, "");

  return text;
}
