import { passkeys } from "@clerk/electron/passkeys";
import { ClerkProvider } from "@clerk/electron/react";
import type { ReactNode } from "react";

import { APP_BASE_NAME } from "../../branding";
import { ManagedRelayAuthProvider } from "../../cloud/managedAuth";
import { clerkAppearance } from "./clerkAppearance";

// Helm shares T3's renderer origin, but its separate bundle owns neither T3's OAuth callback nor its passkey entitlement.
const desktopAuthProps =
  APP_BASE_NAME === "Helm"
    ? {
        appearance: {
          ...clerkAppearance,
          elements: {
            ...clerkAppearance.elements,
            socialButtonsRoot: "hidden!",
            dividerRow: "hidden!",
            footerAction__usePasskey: "hidden!",
          },
        },
      }
    : { appearance: clerkAppearance, passkeys };

/** Load only lazily inside desktop; clerk-js is statically bundled and would otherwise enter every
 * client's startup graph. */
export default function ElectronManagedAuthShell({
  publishableKey,
  children,
}: {
  readonly publishableKey: string;
  readonly children: ReactNode;
}) {
  return (
    <ClerkProvider {...desktopAuthProps} publishableKey={publishableKey}>
      <ManagedRelayAuthProvider>{children}</ManagedRelayAuthProvider>
    </ClerkProvider>
  );
}
