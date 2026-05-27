const INVALID_TEXT_CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function cleanDisplayText(value: string) {
  return value.replace(INVALID_TEXT_CONTROLS, "");
}
