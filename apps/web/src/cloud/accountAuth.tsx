import { AccountAuthProvider, useAccountAuth } from "@t3tools/client-runtime/account-auth-react";
import type { AccountCredentialStore } from "@t3tools/client-runtime/account-auth";
import type { ReactNode } from "react";
import { resolveCloudPublicConfig } from "./publicConfig";
import { ManagedRelayAuthProvider } from "./managedAuth";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../components/ui/dialog";
const store: AccountCredentialStore = {
  read: async () => {
    const relayUrl = resolveCloudPublicConfig().relayUrl;
    if (window.desktopBridge) {
      if (!window.desktopBridge.readAccountCredential || !relayUrl)
        throw new Error("Desktop account storage is unavailable.");
      return window.desktopBridge.readAccountCredential(relayUrl);
    }
    return window.sessionStorage.getItem("t3-account-session");
  },
  write: async (value) => {
    const relayUrl = resolveCloudPublicConfig().relayUrl;
    if (window.desktopBridge) {
      if (!window.desktopBridge.writeAccountCredential || !relayUrl)
        throw new Error("Desktop account storage is unavailable.");
      return window.desktopBridge.writeAccountCredential(relayUrl, value);
    }
    if (value === null) window.sessionStorage.removeItem("t3-account-session");
    else window.sessionStorage.setItem("t3-account-session", value);
  },
};
function openBrowser(url: string) {
  if (window.desktopBridge) return window.desktopBridge.openExternal(url);
  window.open(url, "_blank", "noopener,noreferrer");
}
function AccountApproval() {
  const { device, error, cancelSignIn } = useAccountAuth();
  return (
    <Dialog
      open={device !== null || error !== null}
      onOpenChange={(open) => {
        if (!open) cancelSignIn();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Approve T3 Connect sign-in</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">Confirm this code in your browser.</p>
        <p className="font-mono text-xl">{device?.user_code}</p>
        {device ? (
          <Button
            onClick={() => openBrowser(device.verification_uri_complete ?? device.verification_uri)}
          >
            Open approval page
          </Button>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <Button variant="outline" onClick={cancelSignIn}>
          Cancel
        </Button>
      </DialogContent>
    </Dialog>
  );
}
export default function AccountAuthShell({ children }: { readonly children: ReactNode }) {
  const relayUrl = resolveCloudPublicConfig().relayUrl;
  if (!relayUrl) return children;
  return (
    <AccountAuthProvider
      relayUrl={relayUrl}
      clientId="t3-web"
      store={store}
      openBrowser={openBrowser}
    >
      <ManagedRelayAuthProvider>
        {children}
        <AccountApproval />
      </ManagedRelayAuthProvider>
    </AccountAuthProvider>
  );
}
