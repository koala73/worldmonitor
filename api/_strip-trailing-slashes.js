/**
 * A value that is only slashes stays "/".
 * Legacy api/*.js stays inside api/.
 */
export function stripTrailingSlashes(value) {
  let end = value.length;
  while (end > 1 && value.charCodeAt(end - 1) === 47) end -= 1;
  return end === value.length ? value : value.slice(0, end);
}
