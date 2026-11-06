/** The personal macOS distribution uses its own profile and never consumes upstream updates. */
export function isHelmBuild(version: string | undefined): boolean {
  return version?.includes("-helm.") === true;
}
